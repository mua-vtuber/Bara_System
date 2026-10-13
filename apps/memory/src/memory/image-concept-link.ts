/**
 * image-concept-link.ts — image-search-foundation Task 5 (b-B3).
 *
 * 이미지를 업로드할 때, 그 이미지의 SigLIP 임베딩과 *기존* 개념들의 SigLIP
 * 임베딩(`concept_siglip_vec`, Task 3 신설)을 cosine 비교해, 닮음이 threshold
 * 이상인 기존 개념과 `node_concept_edges(role='visual')` 로 자동 연결한다.
 * 이러면 "노란후드" 이미지가 "노란색"·"후드"·"옷" 개념(A1 실측 cosine
 * 0.143/0.122/0.111)에 자동 연결돼, 그 개념이 글·해시태그로 검색될 때 이미지도
 * 연결검색(getNodesByConcepts·graph)으로 합류한다(spec §8.5 외톨이 노드 갭 해소).
 *
 * 사용자 확정 정책(spec §17 U3 / DCL-1):
 *  - *기존* 개념에서만 연결한다 — threshold 를 넘는 기존 개념이 없으면 엣지 0.
 *    새 개념을 절대 만들지 않는다(자동 추정 새 개념 생성 위험 차단).
 *  - 연결 시점은 업로드 동기뿐 — 1회 backfill 소급·주기 스케줄러는 안 만든다
 *    (D-B2b). 이 모듈은 호출되는 한 번의 업로드만 처리한다.
 *  - 연결 엣지 role 은 'visual' 신규(D-B3) — 사용자 손 태그('tag')와 갈래를 나눠
 *    추적·되돌리기가 가능하다. role TEXT 무제약이라 DB 변경 0.
 *
 * 개념 SigLIP 임베딩은 "lazy 멱등 backfill" 로 채운다(spec 설계):
 *  개념 생성 코어(concept-repository.ts)는 bge-m3 `concept_vec` 만 inline 으로
 *  채우고 SigLIP `concept_siglip_vec` 는 안 채운다. SigLIP 개념 임베딩의 소비자는
 *  이 자동 연결뿐이라(글자·의미 검색은 bge-m3 concept_vec 사용), 비교 직전에
 *  `backfillConceptSiglipEmbeddings`(Task 4, 멱등)를 한 번 호출해 빠진 개념만
 *  그 자리에서 채운다. 개념 생성 코어·봇 글 통로는 건드리지 않는다(spec 불변식).
 *
 *  이 lazy 방식의 약점(사실 진술): 새 개념이 많이 쌓인 뒤 첫 업로드가 빠진
 *  개념을 한꺼번에 임베딩해 잠깐 느려질 수 있다. 테스트 규모라 무시 가능하고,
 *  주기 재스캔은 spec §2 Deferred 다. 운영 규모가 커지면 부팅 시 backfill 1회 +
 *  주기 재스캔으로 옮기는 후속 단계가 자연 후보다.
 *
 * graceful (No-mock / No-fallback 정합):
 *  - 이미지 SigLIP 임베딩이 없으면(임베딩 skip 된 이미지 — image_vec 행 없음)
 *    자동 연결을 건너뛰고 warn(node_id 포함). 가짜 엣지 0.
 *  - SigLIP text encoder 미가용(backfill 이 채울 수 없음)이면 backfill 이 0 을
 *    반환 + warn 하고, 비교할 개념 SigLIP 임베딩이 없으면 자연히 0 연결.
 *    가짜 임베딩·가짜 엣지 0.
 *  - threshold 를 넘는 기존 개념이 0건이면 엣지 0 — "맞는 개념 없음" 의 정직한
 *    빈 상태(실패 아님).
 *  - 임베딩/KNN 호출이 예외면 실패다 — 빈 엣지 목록으로 세탁하지 않고 node_id 와
 *    함께 상위로 전파한다. 단 ingest 호출 측이 이 함수를 best-effort 로 감싸
 *    이미지 저장 코어(이미 끝남)를 깨지 않는다(spec §3 / concept-repository
 *    detectAndSaveAliasSuggestions best-effort 양식 정합).
 */

import type { Database } from "bun:sqlite";
import {
  backfillConceptSiglipEmbeddings,
  defaultSiglipTextEmbedder,
  type SiglipTextEmbedder,
} from "../db/store-internal/concept-siglip-backfill.ts";
import { SIGLIP2_DIM } from "../embedding/siglip2.ts";

/**
 * SigLIP 임베딩 차원(image_vec / concept_siglip_vec 둘 다 768-dim cosine).
 *
 * embedding 계층 `siglip2.ts` 의 `SIGLIP2_DIM`(SigLIP 2 vision tower 출력 차원)
 * 을 단일출처로 참조한다 — image_vec 는 vision tower 로, concept_siglip_vec 는
 * text tower(`siglip2-text.ts` SIGLIP2_TEXT_DIM)로 채우지만 둘은 한 모델의 공유
 * 임베딩 공간이라 같은 768 차원이다. memory 계층 별칭 이름(`SIGLIP_DIM`)은
 * 이 모듈·테스트 계약을 위해 유지하되, 리터럴 중복은 제거했다. memory→embedding
 * import 는 `image-asset.ts` 가 이미 쓰는 방향이라 새 의존을 만들지 않는다.
 */
export const SIGLIP_DIM = SIGLIP2_DIM;

/** 자동 연결된 개념 한 건 — 로깅·테스트·디버깅용. */
export interface VisualConceptLink {
  /** 연결한 기존 개념의 concept_id. */
  conceptId: string;
  /** 이미지↔개념 cosine 닮음(= 1 − vec0 distance). threshold 이상. */
  cosine: number;
  /** 이번 호출에서 엣지가 새로 생겼으면 true(이미 있던 엣지면 false). */
  inserted: boolean;
}

/** linkImageToConceptsBySiglip 인자. */
export interface LinkImageToConceptsArgs {
  /** 열린 bun:sqlite Database (concept_siglip_vec·image_vec·node_concept_edges 보유). */
  db: Database;
  /** 연결 대상 image_asset 노드의 knowledge_nodes.id. */
  nodeId: number;
  /** cosine ≥ threshold 인 개념만 연결. settings images.autoConceptLink.threshold. */
  threshold: number;
  /**
   * 이미지의 SigLIP 임베딩(768-dim). 미지정이면 image_vec 에서 node_id 로 읽는다.
   * ingest 흐름은 임베딩을 image_vec 에 이미 저장하므로 보통 미지정으로 호출하고,
   * 테스트는 데이터 fixture(순수 Float32Array)를 직접 주입한다.
   */
  imageEmbedding?: Float32Array | null;
  /**
   * lazy backfill 에 쓸 SigLIP text 임베더. 기본 = 실제 모듈 어댑터.
   * 테스트는 fixture 임베더를 주입한다(mock 클래스 아님).
   */
  embedder?: SiglipTextEmbedder;
  /**
   * 후보로 검토할 개념 KNN 개수 상한. cosine 컷 *전* 단계의 후보 수다 — 너무
   * 작으면 닮은 개념을 놓칠 수 있다. default 50(테스트·운영 규모 모두 충분).
   */
  knnK?: number;
}

/**
 * 이미지의 SigLIP 임베딩으로 기존 개념들(concept_siglip_vec)과 cosine 비교해
 * threshold 이상 닮은 *기존* 개념과 role='visual' 엣지를 잇는다. 연결된 개념
 * 목록(cosine·신규 여부)을 반환한다.
 *
 * 동작 순서:
 *  1. lazy 멱등 backfill — SigLIP 임베딩이 없던 기존 개념을 그 자리에서 채운다.
 *  2. 이미지 SigLIP 임베딩 확보(인자 주입 또는 image_vec SELECT). 없으면 skip+warn.
 *  3. concept_siglip_vec vec0 KNN → cosine ≥ threshold 인 기존 개념.
 *  4. 각 개념에 addNodeConceptEdge(nodeId, conceptId, 'visual') (멱등 INSERT OR IGNORE).
 *
 * @returns 연결된 개념 목록(cosine 내림차순). 닮은 개념 0건이면 빈 배열(정직한 빈 상태).
 */
export async function linkImageToConceptsBySiglip(
  args: LinkImageToConceptsArgs,
): Promise<VisualConceptLink[]> {
  const { db, nodeId, threshold } = args;
  const embedder = args.embedder ?? defaultSiglipTextEmbedder;
  const knnK = args.knnK ?? 50;

  // ── 1) lazy 멱등 backfill — 비교 직전 빠진 개념 SigLIP 임베딩 채움 ──────────
  // backfill 은 멱등이라 이미 채운 개념은 건너뛴다. SigLIP text encoder 미가용이면
  // 0 반환 + warn(가짜 임베딩 0) — 이 경우 concept_siglip_vec 가 비어 KNN 이
  // 자연히 0 후보 → 0 연결(정직한 비활성).
  await backfillConceptSiglipEmbeddings(db, embedder);

  // ── 2) 이미지 SigLIP 임베딩 확보 ─────────────────────────────────────────
  const imageEmbedding =
    args.imageEmbedding ?? readImageVecEmbedding(db, nodeId);
  if (imageEmbedding === null) {
    // 임베딩 skip 된 이미지(image_vec 행 없음) — 자동 연결 건너뜀. 실패가 아니라
    // "이 이미지엔 SigLIP 임베딩이 없음" 의 정직한 신호. 가짜 엣지 0.
    console.warn(
      `[image-concept-link] node_id=${nodeId} SigLIP 임베딩 없음 — 자동 개념 연결 skip ` +
        `(가짜 엣지 만들지 않음; 이미지는 손 태그·VLM 캡션으로만 검색됨)`,
    );
    return [];
  }
  if (imageEmbedding.length !== SIGLIP_DIM) {
    // 길이 불일치 = 데이터 무결성 위반 — silent fallback 금지, 구체 에러.
    throw new Error(
      `linkImageToConceptsBySiglip: image embedding dim mismatch ` +
        `(node_id=${nodeId}, got ${imageEmbedding.length}, expected ${SIGLIP_DIM})`,
    );
  }

  // ── 3) concept_siglip_vec KNN → cosine ≥ threshold 인 기존 개념 ──────────
  // vec0 KNN 은 단일 가상 테이블 조회에 LIMIT(=k) 를 직접 받는다(findSimilarConcepts
  // 와 같은 패턴 — JOIN 으로 감싸면 sqlite-vec 제약 에러). cosine = 1 − distance 라
  // cosine ≥ threshold ⇔ distance ≤ 1 − threshold. distance 오름차순(가장 닮음 먼저).
  const knn = db
    .prepare(
      `SELECT concept_rowid, distance FROM concept_siglip_vec
       WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(imageEmbedding, Math.max(1, knnK)) as Array<{
    concept_rowid: number;
    distance: number;
  }>;
  if (knn.length === 0) return [];

  // cosine 컷 — threshold 미달 후보 제거. distance 정렬이라 첫 미달에서 멈춰도
  // 되지만, vec0 distance 가 0~2 범위라 방어적으로 전체를 거른다.
  const passed = knn
    .map((r) => ({ conceptRowid: r.concept_rowid, cosine: 1 - r.distance }))
    .filter((r) => r.cosine >= threshold);
  if (passed.length === 0) return [];

  // concept_rowid → concept_id 풀이(findSimilarConcepts 양식 정합).
  // 엔티티 identity 개념(예: 고양이 개체명 '얼룩이'·'까망이')은 자동 시각 후보에서
  // 제외한다. 이름만 text-embedding 한 identity 개념은 이미지 의미와 쉽게 엇갈리고,
  // 한번 붙으면 그래프상 실제 개체 하위에 자산이 매달려 보인다. 사용자가 명시적으로
  // 태그/분류한 경우는 다른 wiring 통로가 처리하므로 visual 자동 링크만 막는다.
  const placeholders = passed.map(() => "?").join(",");
  const idRows = db
    .prepare(
      `SELECT cn.rowid, cn.concept_id,
              EXISTS (
                SELECT 1 FROM entity_concept_edges ece
                 WHERE ece.concept_id = cn.concept_id
                   AND ece.role = 'identity'
              ) AS is_identity_concept
         FROM concept_nodes cn
        WHERE cn.rowid IN (${placeholders})`,
    )
    .all(...passed.map((p) => p.conceptRowid)) as Array<{
    rowid: number;
    concept_id: string;
    is_identity_concept: number;
  }>;
  const candidateByRowid = new Map(
    idRows.map((r) => [
      r.rowid,
      {
        conceptId: r.concept_id,
        isIdentityConcept: r.is_identity_concept === 1,
      },
    ]),
  );

  // ── 4) role='visual' 엣지 연결(멱등 INSERT OR IGNORE) ────────────────────
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO node_concept_edges
       (node_id, concept_id, role, provenance, source_node_id, created_at)
     VALUES (?, ?, 'visual', 'image', ?, ?)`,
  );
  const now = new Date().toISOString();
  const linked: VisualConceptLink[] = [];
  for (const p of passed) {
    const candidate = candidateByRowid.get(p.conceptRowid);
    if (candidate === undefined) {
      // concept_siglip_vec 에 행이 있는데 concept_nodes 에 없음 = 고아 — 트리거가
      // 삭제 시 정리하므로 정상 운영에선 안 생긴다. 발생하면 건너뛰되(가짜 연결 0)
      // 구체 식별자로 warn 해 추적 가능하게 남긴다(silent skip 아님).
      console.warn(
        `[image-concept-link] concept_siglip_vec rowid=${p.conceptRowid} 에 대응하는 ` +
          `concept_nodes 행 없음 — 이 후보 건너뜀 (node_id=${nodeId})`,
      );
      continue;
    }
    if (candidate.isIdentityConcept) continue;
    const conceptId = candidate.conceptId;
    const res = insertEdge.run(nodeId, conceptId, nodeId, now);
    linked.push({
      conceptId,
      cosine: p.cosine,
      inserted: res.changes > 0,
    });
  }
  // cosine 내림차순 — 가장 닮은 개념이 먼저.
  linked.sort((a, b) => b.cosine - a.cosine);
  return linked;
}

/**
 * image_vec 가상 테이블에서 node_id 의 SigLIP 임베딩(768-dim)을 읽는다. 행이
 * 없으면(임베딩 skip 된 이미지) null. vec0 가상 테이블의 embedding 칸은 raw bytes
 * (Float32 little-endian)로 보관되므로 그대로 Float32Array 로 본다.
 */
function readImageVecEmbedding(
  db: Database,
  nodeId: number,
): Float32Array | null {
  const row = db
    .prepare("SELECT embedding FROM image_vec WHERE node_id = ?")
    .get(nodeId) as { embedding: Uint8Array } | null;
  if (!row) return null;
  const buf = row.embedding;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
