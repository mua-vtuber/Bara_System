/**
 * image-vec-channel.ts — Phase 11b T5.
 *
 * 검색어 → SigLIP text encoder → image_vec vec0 cosine KNN → 후보 노드 id 목록.
 * retriever 의 step5_imageVec 단계가 호출해서 RRF 합산 입력 채널 한 묶음을
 * 더한다 — RRF 코어(rrf.ts 의 `reciprocalRankFusion` + `RRF_K`) 시그니처 0 변경.
 *
 * 가용성 분기:
 *   - queryEmbedding=null (모델 미가용 / 빈 검색어) = 빈 후보 → RRF 안 0 기여.
 *     graceful degrade (disabled-state 양식 / silent fallback X — null 회신
 *     자체가 명시 신호).
 *   - vec0 호출 자체가 throw (schema 없음 등) = 가리지 않고 상위 전파.
 *     (옛 vec0 호출 양식 정합 — silent catch 금지.)
 *
 * 결과 score 변환: vec0 distance (0 = 동일) → score (1 = 동일) = `1 - distance`.
 * cosine 정합. retriever step5 는 rank 한 한 쓰지만 (RRF 는 rank 합산), score
 * 칸은 디버깅 / 후속 sweep 위해 보존.
 */

import type { SqliteMemoryStore } from "../db/store.ts";

/** image_vec 한 후보 — RRF 합류 위 한 가지 정보. */
export interface ImageVecCandidate {
  /** image_asset 노드의 knowledge_nodes.id (image_vec.node_id 와 같다). */
  nodeId: number;
  /** cosine 정합 score (1 - distance) — 디버깅 / sweep 위 보존. */
  score: number;
  /** vec0 ORDER BY distance 결과 안 위치 (1-based — RRF 계약 정합). */
  rank: number;
}

/**
 * image_vec KNN 채널 호출. queryEmbedding 이 null 이면 빈 배열 즉시 반환
 * (graceful degrade — 모델 미로드 + 빈 검색어 두 분기 모두 본 위치 합류).
 *
 * 옛 vec0 KNN 양식 정합 (`search-repository.ts:88-92` 의 vec_nodes 양식과 동일
 * 양식 — `WHERE embedding MATCH ? ORDER BY distance LIMIT ?` + `.all(queryVec,
 * k)`). image_vec 도 같은 sqlite-vec 가상 테이블이라 호출 양식이 정합.
 */
export async function getImageVecCandidates(
  store: SqliteMemoryStore,
  queryEmbedding: Float32Array | null,
  topK: number,
): Promise<ImageVecCandidate[]> {
  if (!queryEmbedding) return [];
  if (topK <= 0) return [];
  const rows = await store.searchImageVec(queryEmbedding, topK);
  return rows.map((r, i) => ({
    nodeId: r.nodeId,
    score: 1 - r.distance,
    rank: i + 1,
  }));
}
