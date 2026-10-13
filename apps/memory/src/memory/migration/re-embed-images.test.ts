/**
 * re-embed-images.test.ts — Phase 11b T3 단위 테스트.
 *
 * fixture 만 사용 — mock 클래스 0 (CLAUDE.md "Mock 객체 금지"). embedder 와
 * AssetStore 는 *인터페이스* 양식 만족하는 *데이터 fixture* (순수 함수 회신).
 * sharp 가족 baseline 함정 (Phase 11a image-preserve 의존 sharp linux-x64
 * 바이너리 부재 — T1 이전부터 기존 환경 조건) 회피를 위해 transformers·
 * image-asset.ts·addImageAssetNode import 0 — `SIGLIP2_DIM` 도 옛 siglip2 안
 * import 가 transformers top-level 가동을 끌어오므로 본 테스트는 dim 숫자를
 * fixture 안 상수로 직접 두고 (768 = SigLIP 2 base-256 권위), image_asset 노드
 * 합류도 raw SQL 직접 양식 (image-asset.ts 안 INSERT SQL 과 같은 양식 — 단일
 * 권위는 image-asset.ts 가 갖고 본 테스트는 그 양식을 *재현*).
 *
 * 5 + 2 case (plan acceptance 정합):
 *   1. 전체 호출 — 3 자산 모두 image_vec 갱신 통과
 *   2. 한 자산 파일 부재 — 그 한 가지만 failed + 나머지 진행
 *   3. 차원 변경 (768 → 1024) — image_vec 가상 테이블 다시 만들기
 *   4. 자산 0 개 — total 0 + 빈 결과
 *   5. 차원 1152 (So400m) — 가상 테이블 다시 만들기 + 3 자산 통과
 *   6. embedder null 반환 — silent skip 금지 (failed 누적)
 *   7. onProgress 콜백 N/M 호출 양식 검증
 *
 * 배치 트랜잭션 4 case (audit High — 자산당 auto-commit 2회 → 묶음당 1회):
 *   8. 배치 경계 초과 (BATCH+5) — 전 자산 커밋 + 값 정합
 *   9. 배치 1·2 흩어진 자산 실패 — 실패 쌍만 failed, 나머지 커밋
 *  10. 두 번째 배치 쓰기 전체 실패 — 첫 배치 커밋 결과 보존 (query_only 재현)
 *  11. applyVecWrites 한 쌍 실패 — 같은 묶음 나머지 커밋 (per-pair granularity)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import type { AssetStore } from "../../assets/asset-store.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import {
  reEmbedAllImages,
  RE_EMBED_WRITE_BATCH_SIZE,
  __internals,
} from "./re-embed-images.ts";

// SigLIP 2 base-256 권위 차원 — image-asset.ts·siglip2.ts 안 SIGLIP2_DIM 정합.
// 본 테스트가 그 모듈을 import 하면 transformers 가족 top-level 가동 → sharp
// 함정 — 회피를 위해 상수만 재현 (양식 어긋남 시 본 한 줄 갱신).
const OLD_DIM = 768;

// ─────────────────────────────────────────────────────────────────────────────
// fixture — ImageEmbedder 인터페이스 만족 (순수 함수, 결정적 출력)
// ─────────────────────────────────────────────────────────────────────────────

function fixedDimEmbedder(dim: number): ImageEmbedder {
  return {
    dim,
    modelId: `fixture-dim-${dim}`,
    async embedImage(_input) {
      // 결정적 출력 — 길이 + 갱신 흐름 검증이 핵심. 같은 0.1 벡터.
      return new Float32Array(dim).fill(0.1);
    },
  };
}

function nullEmbedder(dim: number = OLD_DIM): ImageEmbedder {
  return {
    dim,
    modelId: "fixture-null",
    async embedImage(_input) {
      return null;
    },
  };
}

/**
 * flipAtCall 번째 embedImage 호출 시점에 PRAGMA query_only = ON 을 켜는
 * fixture — 그 이후 배치의 DB 쓰기가 전부 실패하는 상황을 결정적으로 재현
 * (앞 배치는 이미 커밋 → 배치 실패 시 이전 커밋 보존 검증). 순수 fixture
 * 양식 유지 — 인터페이스 구현체가 아닌 결정적 출력 + 호출 횟수 closure.
 */
function pragmaFlipEmbedder(
  dim: number,
  db: Database,
  flipAtCall: number,
): ImageEmbedder {
  let calls = 0;
  return {
    dim,
    modelId: "fixture-pragma-flip",
    async embedImage(_input) {
      calls += 1;
      if (calls === flipAtCall) {
        db.run("PRAGMA query_only = ON");
      }
      return new Float32Array(dim).fill(0.1);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fixture — AssetStore 인터페이스 만족 (in-memory Map, sharp 가족 회피)
//
// 옛 AssetStore = baseDir + content/ + write/read/path. 본 fixture 는 같은
// 메서드 시그니처 만족 한 한 — sha256 → bytes 매핑 in-memory. AssetStore 클래스
// 자체를 import 하면 node:fs 가족만 끌어오니 sharp 함정 무관이지만, *file 부재*
// 시뮬레이션 (테스트 2) 을 결정적으로 표현하려고 in-memory 양식 선택.
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureAssetStore extends AssetStore {
  /** 자산 파일 삭제 시뮬레이션 — 테스트 2 안 한 자산 read 실패 분기 검증. */
  removeAsset(sha256: string): void;
}

function createFixtureAssetStore(baseDir: string): FixtureAssetStore {
  const map = new Map<string, Uint8Array>();
  return {
    path(sha256, ext) {
      return join(baseDir, "content", `${sha256}.${ext}`);
    },
    write(bytes, ext) {
      // 결정적 sha256 — bytes 마지막 byte 를 hex 두 자로 prefix (테스트는
      // 어떤 sha 든 무관, 다르기만 하면 충분 / asset_files PK 정합).
      const stamp = bytes[bytes.length - 1] ?? 0;
      const sha = `${stamp.toString(16).padStart(2, "0")}${"0".repeat(62)}`;
      const cacheHit = map.has(sha);
      if (!cacheHit) {
        map.set(sha, new Uint8Array(bytes));
      }
      // ext 무관 — fixture 안 한 곳 보존.
      void ext;
      return { sha256: sha, cacheHit };
    },
    read(sha256, _ext) {
      const bytes = map.get(sha256);
      if (!bytes) {
        throw new Error(`asset 없음: ${sha256}`);
      }
      return bytes;
    },
    removeAsset(sha256) {
      map.delete(sha256);
    },
  } as FixtureAssetStore;
}

// ─────────────────────────────────────────────────────────────────────────────
// fixture — image_asset 노드 + image_vec 옛 row 합류 (raw SQL)
//
// image-asset.ts 안 INSERT SQL 과 같은 양식을 *재현* 한다. 단일 권위는 옛
// addImageAssetNode 가 갖고, 본 fixture 는 그 양식을 *변경 안 함* 정합으로
// 따라간다 — 옛 INSERT SQL 갱신 시 본 fixture 도 같이 갱신 (의존 자취).
// ─────────────────────────────────────────────────────────────────────────────

function seedImageAsset(
  db: Database,
  args: { sha256: string; mime: string; oldEmbedding: Float32Array | null },
): number {
  // asset_files row.
  db.prepare(
    `INSERT OR IGNORE INTO asset_files
       (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, 'image', ?, ?, ?, ?, ?)`,
  ).run(args.sha256, `fixture://${args.sha256}`, 64, args.mime, null, Date.now());

  // images row — re-embed 가 mime 회수에 사용.
  db.prepare(
    `INSERT INTO images
       (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated, warnings_json)
     VALUES (?, ?, 1, 1, ?, 'smart', 0, '[]')`,
  ).run(args.sha256, args.sha256, args.mime);

  // image_asset 노드 (image-asset.ts INSERT 양식 정합).
  const metadataJson = JSON.stringify({ asset_sha256: args.sha256 });
  db.prepare(
    `INSERT INTO knowledge_nodes
       (content, memory_type, source_type, importance, confidence,
        platform, author, metadata_json, embedding_text)
     VALUES (?, 'fact', 'image_asset', 0.5, 0.7, 'test', 'test', ?, NULL)`,
  ).run(`이미지 자산 ${args.sha256.slice(0, 12)}`, metadataJson);
  const idRow = db
    .prepare("SELECT last_insert_rowid() AS id")
    .get() as { id: number };

  // 옛 image_vec row (옛 차원 768) — 차원 변경 분기에서는 DROP 으로 자연 비워짐.
  if (args.oldEmbedding) {
    db.prepare(
      "INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)",
    ).run(idRow.id, args.oldEmbedding);
  }
  return idRow.id;
}

function seedMany(
  db: Database,
  assets: FixtureAssetStore,
  count: number,
): Array<{ sha: string; nodeId: number }> {
  if (count > 256) {
    // fixture write() 의 sha 는 bytes 마지막 byte 한 자리에서 나온다 — 256 초과
    // 시 sha 충돌로 자산 수가 어긋난다 (명시 신호).
    throw new Error(`seedMany: fixture sha 는 256 종 한정 (요청 ${count})`);
  }
  const out: Array<{ sha: string; nodeId: number }> = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, i]); // 변체 한 byte
    const w = assets.write(bytes, "png");
    const oldEmbedding = new Float32Array(OLD_DIM).fill(0.05);
    const nodeId = seedImageAsset(db, {
      sha256: w.sha256,
      mime: "image/png",
      oldEmbedding,
    });
    out.push({ sha: w.sha256, nodeId });
  }
  return out;
}

function seedThree(
  db: Database,
  assets: FixtureAssetStore,
): Array<{ sha: string; nodeId: number }> {
  return seedMany(db, assets, 3);
}

/** image_vec 안 한 node 의 embedding blob 을 Float32Array 로 회수. */
function readVec(db: Database, nodeId: number): Float32Array {
  const row = db
    .prepare("SELECT embedding FROM image_vec WHERE node_id = ?")
    .get(nodeId) as { embedding: Uint8Array } | null;
  if (!row) {
    throw new Error(`image_vec row 없음: node ${nodeId}`);
  }
  return new Float32Array(
    row.embedding.buffer,
    row.embedding.byteOffset,
    row.embedding.byteLength / 4,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// suite
// ─────────────────────────────────────────────────────────────────────────────

describe("reEmbedAllImages (Phase 11b T3)", () => {
  let db: Database;
  let assets: FixtureAssetStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bara-re-embed-"));
    db = openMemoryDatabase(join(tmpDir, "bara.sqlite"));
    assets = createFixtureAssetStore(tmpDir);
  });

  afterEach(() => {
    // sqlite-vec extension 안 vec0 가상 테이블(image_vec)은 mmap 양식으로
    // 디스크 ↔ 메모리 직접 매핑을 잡는다. Bun 안 db.close() 가 일반 SQLite
    // file handle 은 즉시 닫지만 vec0 가상 테이블의 mmap handle 은
    // cascade 해제가 즉시 안 일어나는 흐름이 발견됨 (Linux fs /tmp 위치
    // 에서도 동일 EBUSY — Windows fs 한정이 아닌 라이브러리 가족 흐름).
    // 명시 DROP TABLE 로 vec0 destructor 호출 신호 후 close — mmap handle
    // 자연 정리 유도. 그래도 잠금 잔존 시 cleanup 실패는 test 검증 fail
    // 아니므로 warn 후 지나간다 (OS 안 임시 폴더는 별 정리 흐름이 가져감).
    try {
      db.run("DROP TABLE IF EXISTS image_vec");
    } catch (err) {
      // DROP 실패도 cleanup 단계 — test 안 assertion 영향 0. warn 만 남김.
      console.warn(
        `[test cleanup] DROP image_vec 실패 — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[test cleanup] rmSync(${tmpDir}) 잠금 잔존 — ${err instanceof Error ? err.message : String(err)}. OS 임시 폴더 정리 흐름에 위임.`,
      );
    }
  });

  test("전체 호출 — 3 자산 모두 image_vec 갱신 통과", async () => {
    seedThree(db, assets);
    const embedder = fixedDimEmbedder(OLD_DIM);

    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);

    // image_vec 새 값 (0.1) 으로 갱신 확인 — 같은 0.1 query 시 distance ≈ 0.
    const queryVec = new Float32Array(OLD_DIM).fill(0.1);
    const rows = db
      .prepare(
        "SELECT node_id, distance FROM image_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 10",
      )
      .all(queryVec) as Array<{ node_id: number; distance: number }>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.distance).toBeLessThan(0.01);
    }
  });

  test("한 자산 파일 부재 — 그 한 가지만 failed + 나머지 진행", async () => {
    const seeded = seedThree(db, assets);
    // 두 번째 자산 파일 직접 삭제.
    assets.removeAsset(seeded[1]!.sha);

    const embedder = fixedDimEmbedder(OLD_DIM);
    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
  });

  test("차원 변경 768 → 1024 — image_vec 가상 테이블 다시 만들기", async () => {
    seedThree(db, assets);

    // 옛 dim = 768.
    expect(__internals.getCurrentImageVecDim(db)).toBe(OLD_DIM);

    const embedder = fixedDimEmbedder(1024);
    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);

    // image_vec 가상 테이블 CREATE SQL 안 float[1024] 확인.
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='image_vec'")
      .get() as { sql: string };
    expect(row.sql).toContain("float[1024]");

    // image_vec_delete 트리거 다시 만들기 검증 (DROP TABLE 가 트리거 떼어 감).
    const trig = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='image_vec_delete'",
      )
      .get();
    expect(trig).not.toBeNull();
  });

  test("자산 0 개 — total 0 + 빈 결과", async () => {
    const embedder = fixedDimEmbedder(OLD_DIM);
    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
  });

  test("차원 1152 (SigLIP 2 So400m) — 가상 테이블 다시 만들기 + 3 자산 통과", async () => {
    seedThree(db, assets);

    const embedder = fixedDimEmbedder(1152);
    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='image_vec'")
      .get() as { sql: string };
    expect(row.sql).toContain("float[1152]");
  });

  test("embedder null 반환 — silent skip 금지 (failed 누적)", async () => {
    seedThree(db, assets);
    const embedder = nullEmbedder(OLD_DIM);

    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(3);
  });

  test("onProgress 콜백 — N/M sha256 한 가지 한 가지 호출", async () => {
    seedThree(db, assets);
    const embedder = fixedDimEmbedder(OLD_DIM);

    const calls: Array<{ current: number; total: number; sha: string }> = [];
    await reEmbedAllImages(
      { db, assetStore: assets, embedder },
      (current, total, sha256) => {
        calls.push({ current, total, sha: sha256 });
      },
    );

    expect(calls.length).toBe(3);
    expect(calls[0]!.current).toBe(1);
    expect(calls[2]!.current).toBe(3);
    expect(calls.every((c) => c.total === 3)).toBe(true);
  });

  // ── 배치 트랜잭션 쓰기 (audit High — 자산당 auto-commit 2회 → 묶음당 1회) ──

  test("배치 경계 초과 (BATCH+5 자산) — 전 자산 커밋 + 값 정합", async () => {
    const n = RE_EMBED_WRITE_BATCH_SIZE + 5;
    const seeded = seedMany(db, assets, n);
    const embedder = fixedDimEmbedder(OLD_DIM);

    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.total).toBe(n);
    expect(result.succeeded).toBe(n);
    expect(result.failed).toBe(0);

    // row 수 + 값 정합 — 첫/마지막 자산 (배치 1·배치 2 각각) 새 값 0.1 확인.
    const cnt = db
      .prepare("SELECT COUNT(*) AS c FROM image_vec")
      .get() as { c: number };
    expect(cnt.c).toBe(n);
    expect(readVec(db, seeded[0]!.nodeId)[0]).toBeCloseTo(0.1, 5);
    expect(readVec(db, seeded[n - 1]!.nodeId)[0]).toBeCloseTo(0.1, 5);
  });

  test("배치 1·2 에 흩어진 자산 실패 — 실패 쌍만 failed, 나머지 커밋", async () => {
    const n = RE_EMBED_WRITE_BATCH_SIZE + 5;
    const seeded = seedMany(db, assets, n);
    // 배치 1 안 한 개 + 배치 2 안 한 개 자산 파일 삭제.
    assets.removeAsset(seeded[0]!.sha);
    assets.removeAsset(seeded[n - 1]!.sha);

    const embedder = fixedDimEmbedder(OLD_DIM);
    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });

    expect(result.total).toBe(n);
    expect(result.succeeded).toBe(n - 2);
    expect(result.failed).toBe(2);

    // 성공 자산 (배치 1·2 각각) 새 값 0.1, 실패 자산은 옛 값 0.05 보존.
    expect(readVec(db, seeded[1]!.nodeId)[0]).toBeCloseTo(0.1, 5);
    expect(readVec(db, seeded[n - 2]!.nodeId)[0]).toBeCloseTo(0.1, 5);
    expect(readVec(db, seeded[0]!.nodeId)[0]).toBeCloseTo(0.05, 5);
    expect(readVec(db, seeded[n - 1]!.nodeId)[0]).toBeCloseTo(0.05, 5);
  });

  test("두 번째 배치 쓰기 전체 실패 — 첫 배치 커밋 결과 보존", async () => {
    const n = RE_EMBED_WRITE_BATCH_SIZE + 5;
    const seeded = seedMany(db, assets, n);
    // 배치 1 flush (자산 BATCH 개째) 직후, 자산 BATCH+1 개째 embed 시점에
    // query_only ON — 배치 2 의 DELETE+INSERT 전부 실패.
    const embedder = pragmaFlipEmbedder(
      OLD_DIM,
      db,
      RE_EMBED_WRITE_BATCH_SIZE + 1,
    );

    const result = await reEmbedAllImages({ db, assetStore: assets, embedder });
    db.run("PRAGMA query_only = OFF"); // afterEach cleanup (DROP) 복원

    expect(result.total).toBe(n);
    expect(result.succeeded).toBe(RE_EMBED_WRITE_BATCH_SIZE);
    expect(result.failed).toBe(5);

    // 배치 1 커밋 보존 (새 값 0.1) + 배치 2 는 옛 값 0.05 그대로.
    expect(readVec(db, seeded[0]!.nodeId)[0]).toBeCloseTo(0.1, 5);
    expect(
      readVec(db, seeded[RE_EMBED_WRITE_BATCH_SIZE - 1]!.nodeId)[0],
    ).toBeCloseTo(0.1, 5);
    expect(
      readVec(db, seeded[RE_EMBED_WRITE_BATCH_SIZE]!.nodeId)[0],
    ).toBeCloseTo(0.05, 5);
    expect(readVec(db, seeded[n - 1]!.nodeId)[0]).toBeCloseTo(0.05, 5);
  });

  test("applyVecWrites — 한 쌍 실패는 그 쌍만, 같은 묶음 나머지 커밋", () => {
    const seeded = seedThree(db, assets);
    const deleteVec = db.prepare("DELETE FROM image_vec WHERE node_id = ?");
    const insertVec = db.prepare(
      "INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)",
    );

    // 가운데 쌍은 table dim (768) 과 다른 길이 4 — INSERT 가 SQL 계층에서 실패.
    const good = new Float32Array(OLD_DIM).fill(0.2);
    const badVec = new Float32Array(4).fill(0.2);
    const { ok, bad } = __internals.applyVecWrites(db, deleteVec, insertVec, [
      { nodeId: seeded[0]!.nodeId, assetSha256: seeded[0]!.sha, vec: good },
      { nodeId: seeded[1]!.nodeId, assetSha256: seeded[1]!.sha, vec: badVec },
      { nodeId: seeded[2]!.nodeId, assetSha256: seeded[2]!.sha, vec: good },
    ]);

    expect(ok).toBe(2);
    expect(bad).toBe(1);
    expect(readVec(db, seeded[0]!.nodeId)[0]).toBeCloseTo(0.2, 5);
    expect(readVec(db, seeded[2]!.nodeId)[0]).toBeCloseTo(0.2, 5);
    // 실패 쌍은 DELETE 만 통과했을 수 있음 — INSERT 실패 시 row 부재가 정상.
    // (실제 흐름에서는 사전 dim 검증이 이 상황을 pending 이전에 차단하고,
    //  applyVecWrites 계층은 배치가 통째로 버려지지 않는 것만 보증한다.)
    const midRow = db
      .prepare("SELECT node_id FROM image_vec WHERE node_id = ?")
      .get(seeded[1]!.nodeId);
    expect(midRow).toBeNull();
  });
});

// ── extOfMime — mime → 자산 확장자 매핑 (Phase 11d D6: avif 합류) ──
// ingest-image.ts·assets.ts 와 같은 가족 (SUPPORTED_IMAGE_MIMES 권위 정합).
// 이 테스트는 transformers 함정 회피를 위해 ingest-image.ts 를 import 하지 않고
// 기대 매핑을 직접 재현한다 (OLD_DIM 과 같은 재현 양식). 묶음 자체의 단일 권위
// 대조는 dispatcher.test.ts·ingest-form.test.ts 가 코어 import 로 수행.
describe("extOfMime — 자산 확장자 매핑", () => {
  test("6 종 mime 모두 매핑 + avif → 'avif'", () => {
    const expected: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/apng": "apng",
      "image/avif": "avif",
    };
    for (const [mime, ext] of Object.entries(expected)) {
      expect(__internals.extOfMime(mime)).toBe(ext);
    }
  });

  test("알 수 없는 mime 은 명시 throw (silent fallback 금지)", () => {
    expect(() => __internals.extOfMime("image/heic")).toThrow();
    expect(() => __internals.extOfMime("application/pdf")).toThrow();
  });
});
