/**
 * memory/migration/re-embed-images.ts — Phase 11b T3.
 *
 * settings 안 이미지 임베딩 모델 변경 시점에 옛 자산을 새 모델로 다시 임베딩하는
 * 헬퍼. SigLIP 2 base-256 (dim 768) → SigLIP 2 large-384 또는 So400m (dim 1152)
 * 같이 차원이 달라지는 갈래까지 한 함수로 정합. 옛 임베딩 차원 전환 단축
 * 흐름과 같은 정신이지만, 본 helper
 * 는 자산 파일은 그대로 둔 채 `image_vec` 가상 테이블만 새 차원으로 다시 만든다.
 *
 * 흐름:
 *  1. `knowledge_nodes` 에서 `source_type='image_asset'` 노드를 한 번에 회수해
 *     `(nodeId, assetSha256, mime)` 한 가지 한 가지 회수한다 (T3 11a 안 metadata.asset_sha256
 *     양식 정합 — JSON 추출).
 *  2. 옛 `image_vec` 가상 테이블의 차원을 `sqlite_master` 에서 추출 (CREATE SQL
 *     안 `float[N]`). 새 임베더 차원과 다르면 가상 테이블 DROP + 새 차원으로 다시
 *     만들기 + 옛 `image_vec_delete` 트리거 다시 만들기 (schema v7 정합 — knowledge_nodes
 *     삭제 시 image_vec 동기 삭제).
 *  3. 자산을 한 가지 한 가지 `AssetStore.read(sha256, ext)` 로 회수 → embedder
 *     호출 (비동기 — 트랜잭션 밖). 계산 통과분은 pending 묶음에 쌓았다가
 *     `RE_EMBED_WRITE_BATCH_SIZE` 개마다 한 트랜잭션 안 DELETE+INSERT 로 일괄
 *     반영 (vec0 는 UPSERT 미지원 — DELETE→INSERT 두 단계). 자산 N 개당
 *     auto-commit 2N 회(fsync 2N 회)가 트랜잭션 N/배치크기 회로 줄어든다.
 *  4. 한 자산 실패 (파일 없음·embedder null·차원 불일치·개별 row 쓰기 실패) =
 *     `console.warn` + 다음 자산 자연 진행 — silent skip 금지 (모든 실패는
 *     `result.failed` 누적 + warn 한 줄 추적 가능). batch 전체 멈춤 금지.
 *     한 묶음의 트랜잭션 자체가 실패해도 그 묶음만 failed 처리 — 이미 커밋된
 *     앞 묶음은 보존된다.
 *
 * 회귀 0 불변식:
 *  - RRF 코어 + 봇 글 통로 + 14a/14b 흐름 + 11a 저장 흐름 무수정.
 *  - 본 helper 는 *재 임베딩 추가* 한 한 — `images` 테이블 row·`asset_files`·
 *    `knowledge_nodes` 행은 건드리지 않는다 (image_vec 만 갱신).
 *  - embedder.embedImage null 분기 = silent skip 금지 (failed 누적 + warn).
 *
 * 권위: docs/decisions/2026-05-28-phase11b-plan(...).md § Task 3 (11.11).
 */

import type { Database, Statement } from "bun:sqlite";
import type { AssetStore } from "../../assets/asset-store.ts";
import { runImmediateTransaction } from "../../db/baseline-schema.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ─────────────────────────────────────────────────────────────────────────────

export interface ReEmbedDeps {
  /** raw bun:sqlite handle. store.getRawDb() 또는 openMemoryDatabase 산출. */
  db: Database;
  /** 자산 파일 회수 (AssetStore.read(sha256, ext)). */
  assetStore: AssetStore;
  /** 새 모델 embedder — 차원이 옛 image_vec 과 다르면 가상 테이블 다시 만들기. */
  embedder: ImageEmbedder;
}

export interface ReEmbedResult {
  /** 옛 image_asset 노드 전체 수. */
  total: number;
  /** image_vec INSERT OR REPLACE 까지 통과한 수. */
  succeeded: number;
  /** 자산 부재·embedder null·차원 불일치 한 가지 한 가지 console.warn 후 누적. */
  failed: number;
}

/** CLI / 라우트 양쪽 진행 신호용 콜백. current=1-based, total=전체 수. */
export type ProgressCallback = (
  current: number,
  total: number,
  sha256: string,
) => void;

/**
 * 한 트랜잭션에 묶는 image_vec DELETE+INSERT 쌍 수.
 *
 * 전체 한 트랜잭션 vs 분할 커밋 선택 근거: 전체를 한 트랜잭션으로 묶으면
 * 마지막 자산에서 실패할 때 몇 시간치 임베딩 쓰기가 통째 롤백되고, pending
 * 벡터가 자산 수만큼 메모리에 상주한다. 200 단위 분할이면 커밋(fsync) 횟수는
 * 자산당 2회 → 200자산당 1회로 줄면서, 실패 시 손실 범위와 메모리 상주량
 * (200 × 1152 float ≈ 0.9MB, 최대 dim 기준)이 묶음 하나로 제한된다.
 * 옛 마이그레이션 v31 backfill 의 db.transaction 분할 커밋 선례와 같은 양식.
 */
export const RE_EMBED_WRITE_BATCH_SIZE = 200;

// ─────────────────────────────────────────────────────────────────────────────
// 내부 helper
// ─────────────────────────────────────────────────────────────────────────────

interface ImageAssetRow {
  nodeId: number;
  assetSha256: string;
  mime: string;
}

/** 임베딩 계산이 끝나 DB 반영만 남은 쌍 — flush 시 한 트랜잭션 안 일괄 쓰기. */
interface PendingVecWrite {
  nodeId: number;
  assetSha256: string;
  vec: Float32Array;
}

/**
 * 계산 끝난 임베딩 묶음을 한 트랜잭션 안 DELETE+INSERT 로 반영한다.
 *
 * bun:sqlite 트랜잭션은 동기 한정 — embedder 호출(비동기)은 호출자가 트랜잭션
 * 밖에서 끝내고, 여기서는 DB 쓰기만 수행한다. 쌍 하나의 쓰기 실패는 그 쌍만
 * failed (warn + 누적) — try/catch 로 잡아 트랜잭션은 계속 진행하므로 같은
 * 묶음의 나머지 쌍은 정상 커밋된다 (자산 하나가 묶음 전체를 버리지 않는다,
 * 옛 자산별 실패 granularity 보존). 트랜잭션 자체의 실패(BEGIN/COMMIT 계층)는
 * 여기서 잡지 않고 던진다 — 호출자가 그 묶음 전체를 failed 처리.
 */
function applyVecWrites(
  db: Database,
  deleteVec: Statement,
  insertVec: Statement,
  pending: PendingVecWrite[],
): { ok: number; bad: number } {
  const txn = db.transaction((batch: PendingVecWrite[]) => {
    let ok = 0;
    let bad = 0;
    for (const p of batch) {
      try {
        // DELETE + INSERT — vec0 가상 테이블 UPSERT 미지원 양식 (호출자 주석 참조).
        deleteVec.run(p.nodeId);
        insertVec.run(p.nodeId, p.vec);
        ok += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[re-embed] ${p.assetSha256} — image_vec 갱신 실패: ${reason}`,
        );
        bad += 1;
      }
    }
    return { ok, bad };
  });
  return txn(pending);
}

/**
 * mime → AssetStore 파일 확장자. ingest-image.ts 의 `extOfMime` 와 같은 가족
 * (SUPPORTED_IMAGE_MIMES 권위 정합). mime 묶음 자체는 SUPPORTED_IMAGE_MIMES 한
 * 곳이 권위이고, 확장자 매핑은 migration 계층 분리를 위해 인라인 (image mime 가
 * 늘면 세 곳 다 갱신 — extOfMime 정합 테스트가 대조). Phase 11d D6: avif 합류.
 */
function extOfMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/apng":
      return "apng";
    case "image/avif":
      return "avif";
    default:
      throw new Error(
        `re-embed: 알 수 없는 image mime '${mime}' — SUPPORTED_IMAGE_MIMES 한정`,
      );
  }
}

/**
 * 옛 image_vec 가상 테이블의 차원을 sqlite_master 의 CREATE SQL 에서 추출.
 * 없으면 -1 (호출자가 새로 만들기 흐름 분기). vec0 가상 테이블이 보존하는
 * `float[N]` 양식이 안정 권위라 정규식 한 줄로 추출 (sqlite-vec 가 dim 메타를
 * 별 함수로 노출 안 함 — 차원 검증 INSERT 시도 흐름과 같은
 * 한계 회피용).
 */
function getCurrentImageVecDim(db: Database): number {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='image_vec'",
    )
    .get() as { sql: string } | null;
  if (!row || !row.sql) return -1;
  const m = /float\[(\d+)\]/.exec(row.sql);
  if (!m || !m[1]) return -1;
  return Number.parseInt(m[1], 10);
}

/**
 * image_vec 가상 테이블 + image_vec_delete 트리거를 새 차원으로 다시 만들기.
 * 기준 스키마(db/schema/04-assets-cleanup.sql) 의 image_vec 양식 정합 — knowledge_nodes
 * 삭제 시 image_vec 동기 삭제 트리거도 같이 다시 만들기 (DROP TABLE 가 트리거도
 * 같이 떼어 가므로 명시 재생성).
 *
 * DROP + CREATE 세 문장은 한 IMMEDIATE 트랜잭션이다 — 중간(예: vec0 가 차원을 거부)에서 실패하면
 * 전부 되돌려져 DB 에 image_vec 이 없는 채로 남지 않는다. 이미 트랜잭션 안에서는 부를 수 없다.
 */
function recreateImageVecTable(db: Database, newDim: number): void {
  if (!Number.isInteger(newDim) || newDim <= 0) {
    throw new Error(`recreateImageVecTable: invalid dim ${newDim}`);
  }
  runImmediateTransaction(db, () => {
    db.run("DROP TABLE IF EXISTS image_vec");
    db.run(
      `CREATE VIRTUAL TABLE image_vec USING vec0(
         node_id INTEGER PRIMARY KEY,
         embedding float[${newDim}] distance_metric=cosine
       )`,
    );
    db.run(
      `CREATE TRIGGER IF NOT EXISTS image_vec_delete AFTER DELETE ON knowledge_nodes BEGIN
         DELETE FROM image_vec WHERE node_id = old.id;
       END`,
    );
  });
}

/**
 * 옛 image_asset 노드 한 번에 회수. metadata_json 안 asset_sha256 + mime 를
 * SQLite JSON1 (json_extract) 로 추출 — bun:sqlite 가 JSON1 함수를 default 로 로드.
 * mime 부재 노드 (옛 11a 이전 — 실제 운영 0) 는 skip (warn).
 */
function listImageAssets(db: Database): ImageAssetRow[] {
  // images 테이블과 join — mime 권위 한 곳. ingest-image.ts 가 images.mime 에
  // 보존 모드 통과 후 outMime 을 쓴다 (원본 mime 과 다를 수 있음 — smart 모드 안
  // jpeg 사본). image_vec 갱신은 그 *실 저장 자산* mime 정합.
  const rows = db
    .prepare(
      `SELECT kn.id AS node_id,
              json_extract(kn.metadata_json, '$.asset_sha256') AS sha256,
              img.mime AS mime
         FROM knowledge_nodes kn
         JOIN images img
           ON img.asset_sha256 = json_extract(kn.metadata_json, '$.asset_sha256')
        WHERE kn.source_type = 'image_asset'
        ORDER BY kn.id`,
    )
    .all() as Array<{
    node_id: number;
    sha256: string | null;
    mime: string | null;
  }>;

  const out: ImageAssetRow[] = [];
  for (const row of rows) {
    if (!row.sha256 || !row.mime) {
      // image_asset 노드인데 metadata.asset_sha256 또는 images.mime 부재 —
      // 옛 데이터 손상. 명시 warn + skip (silent fallback 금지).
      console.warn(
        `[re-embed] image_asset 노드 ${row.node_id} — metadata.asset_sha256 또는 mime 부재, skip`,
      );
      continue;
    }
    out.push({
      nodeId: row.node_id,
      assetSha256: row.sha256,
      mime: row.mime,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 함수
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 옛 image_asset 한 가지 한 가지 새 embedder 로 다시 임베딩한다.
 *
 * 차원 변경 검출 = `image_vec` 의 옛 dim 과 `embedder.dim` 비교. 다르면 가상
 * 테이블 DROP + 새 차원으로 다시 만들기 (옛 데이터는 자연 비워짐 — DROP 의
 * 자연 정합). 같으면 가상 테이블 보존 + INSERT OR REPLACE 로 한 가지 한 가지
 * 갱신.
 *
 * 한 자산 실패 = `console.warn` + `failed` 누적 + 다음 자산 자연 진행
 * (batch 전체 멈춤 금지 — plan 권위). embedder.embedImage 가 `null` 반환 시
 * 도 같은 분기 — silent skip 금지 (failed 누적 + warn 한 줄).
 *
 * DB 쓰기는 `RE_EMBED_WRITE_BATCH_SIZE` 개 단위로 한 트랜잭션에 일괄 반영
 * (자산당 auto-commit 2회 → 묶음당 1회, fsync 절감). onProgress 는 자산의
 * 임베딩 계산 완료 시점(1-based 순서 보존)에 호출 — DB 커밋은 묶음 경계에서
 * 뒤따를 수 있다.
 *
 * @param deps     db + assetStore + embedder
 * @param onProgress 선택 콜백 — CLI 가 N/M (sha256) stdout 한 줄 한 줄 출력
 * @returns        { total, succeeded, failed }
 */
export async function reEmbedAllImages(
  deps: ReEmbedDeps,
  onProgress?: ProgressCallback,
): Promise<ReEmbedResult> {
  const { db, assetStore, embedder } = deps;

  // ── 1) 옛 image_asset 노드 회수 ─────────────────────────────────────────
  const targets = listImageAssets(db);
  const total = targets.length;

  if (total === 0) {
    return { total: 0, succeeded: 0, failed: 0 };
  }

  // ── 2) 차원 변경 검출 + image_vec 가상 테이블 다시 만들기 ───────────────
  const currentDim = getCurrentImageVecDim(db);
  if (currentDim !== embedder.dim) {
    console.warn(
      `[re-embed] 차원 변경 ${currentDim} → ${embedder.dim} — image_vec 가상 테이블 다시 만들기`,
    );
    recreateImageVecTable(db, embedder.dim);
  }

  // ── 3) 한 가지 한 가지 다시 임베딩 ──────────────────────────────────────
  // vec0 가상 테이블은 INSERT OR REPLACE 양식 지원 안 함 (sqlite-vec 0.1.x
  // 한계 — UNIQUE constraint 발생). DELETE 후 INSERT 두 단계 양식 정합.
  // 차원 변경 분기에서는 DROP 으로 가상 테이블이 비워졌으니 DELETE 가 무해
  // (0 row 영향). 같은 차원 분기에서는 옛 row 명시 삭제 후 새 row INSERT.
  const deleteVec = db.prepare(
    "DELETE FROM image_vec WHERE node_id = ?",
  );
  const insertVec = db.prepare(
    "INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)",
  );

  let succeeded = 0;
  let failed = 0;

  // 임베딩 계산(비동기)은 트랜잭션 밖에서 수행하고, 계산 통과분을 pending 에
  // 쌓았다가 RE_EMBED_WRITE_BATCH_SIZE 개마다 한 트랜잭션으로 flush.
  let pending: PendingVecWrite[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      const { ok, bad } = applyVecWrites(db, deleteVec, insertVec, batch);
      succeeded += ok;
      failed += bad;
    } catch (err) {
      // 트랜잭션 계층 실패 (BEGIN/COMMIT 자체) — 이 묶음 전체 롤백·failed 처리.
      // 이미 커밋된 앞 묶음은 보존된다 (silent skip 금지 — warn + failed 누적).
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[re-embed] 묶음 ${batch.length}건 트랜잭션 실패 — 전체 롤백: ${reason}`,
      );
      failed += batch.length;
    }
  };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    try {
      const ext = extOfMime(t.mime);
      const bytes = assetStore.read(t.assetSha256, ext);
      // Phase 11d 후보 B: @jsquash 디코드가 mime 으로 디코더를 고른다 →
      // images.mime (보존 후 양식 — png 또는 jpeg) 을 함께 넘긴다.
      const vec = await embedder.embedImage(bytes, t.mime);
      if (!vec) {
        // embedder 안 null 반환 = 모델 미로드 또는 영벡터 출력. silent skip 금지 —
        // 실패로 누적 + warn 한 줄 (호출자가 모델 로드 실패 신호 받음).
        console.warn(
          `[re-embed] ${t.assetSha256} — embedder.embedImage null 반환 (모델 미로드 또는 이상 출력)`,
        );
        failed += 1;
        onProgress?.(i + 1, total, t.assetSha256);
        continue;
      }
      if (vec.length !== embedder.dim) {
        // embedder 가 contract 안 dim 과 다른 길이 반환 — 명시 신호 (silent
        // truncate / pad 금지).
        console.warn(
          `[re-embed] ${t.assetSha256} — embedding dim 불일치: got ${vec.length}, expected ${embedder.dim}`,
        );
        failed += 1;
        onProgress?.(i + 1, total, t.assetSha256);
        continue;
      }
      pending.push({ nodeId: t.nodeId, assetSha256: t.assetSha256, vec });
      if (pending.length >= RE_EMBED_WRITE_BATCH_SIZE) {
        flush();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[re-embed] ${t.assetSha256} 실패 — ${reason}`,
      );
      failed += 1;
    }
    onProgress?.(i + 1, total, t.assetSha256);
  }
  flush();

  return { total, succeeded, failed };
}

// 내부 helper 노출 (테스트가 차원 검출 + 다시 만들기 단독 검증할 때 사용).
export const __internals = {
  getCurrentImageVecDim,
  recreateImageVecTable,
  listImageAssets,
  extOfMime,
  applyVecWrites,
};
