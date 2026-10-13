/**
 * store-internal/bm25-cross.ts — 단일-doc BM25 cross-score (1.1b T4).
 *
 * 확장 query 와 후보 nodeId 목록을 받아, 각 노드 글 내용의 FTS5 bm25() 점수를
 * RRF-like rank 방식으로 정규화해 반환한다.
 *
 * ## 정규화 방식 — RRF-like rank (T4 진단 결론)
 *
 * FTS5 bm25() raw 는 음수(낮을수록 더 관련 있음). sigmoid / min-max 정규화는
 * 절대값이 RRF 점수(~0.016)보다 수십 배 크게 나와 blend weight 0.7/0.3 이
 * 의미를 잃는다(BM25 cross 가 순위를 지배).
 *
 * RRF-like rank:
 *   1. 후보 nodeId 중 MATCH 된 노드를 raw ASC(더 음수 = 더 관련) 정렬.
 *   2. 매치 노드에 `1 / (BM25_RRF_K + rank + 1)` 부여 — RRF 와 동일 스케일.
 *   3. 매치 없는 노드는 0.
 *
 * 결과: BM25 cross 1위 = 1/61 ≈ 0.0164 — vectorRRF 1위와 같은 스케일.
 * blend weight 0.7/0.3 이 균형 있게 작동한다.
 *
 * 동작 요약:
 *   - 후보 0개 → 빈 Map 반환(에러 없음, 정당한 빈 결과).
 *   - sanitize 결과 빈 문자열 → 전 후보 0 반환.
 *   - FTS5 매치 없는 노드 → 0.
 *   - LLM 호출 0 — 결정적 연산만.
 */

import type { Database } from "bun:sqlite";
import { sanitizeFtsQuery } from "./fts.ts";
import { BM25_RRF_K } from "../../memory/search-tuning.ts";

/**
 * 후보 nodeId 목록에 대해 확장 query 와의 단일-doc BM25 점수를 계산한다.
 *
 * @param db            bun:sqlite Database 핸들.
 * @param expandedQuery 확장 완료된 검색 query(synonym·project expansion 적용 후).
 * @param nodeIds       RRF 후보 nodeId 배열.
 * @returns             nodeId → RRF-like 점수 Map.
 *                      후보 0개 = 빈 Map. 매치 없는 nodeId = 0.
 */
export async function computeBM25Cross(
  db: Database,
  expandedQuery: string,
  nodeIds: readonly number[],
): Promise<Map<number, number>> {
  if (nodeIds.length === 0) return new Map();

  const sanitized = sanitizeFtsQuery(expandedQuery);

  // sanitize 결과가 빈 문자열이면 모든 후보가 매치 없음 → 0 으로 채워 반환.
  if (!sanitized) {
    const out = new Map<number, number>();
    for (const id of nodeIds) out.set(id, 0);
    return out;
  }

  // 1. 후보 nodeId 중 FTS5 MATCH 된 노드와 raw bm25 점수를 한 쿼리로 수집한다.
  //    WHERE MATCH ? AND rowid IN (?,?,...) — 후보당 개별 조회 대신 단일 batched
  //    조회(런타임 성능 / FTS 진입 1회). 매치 안 된 노드는 결과 행에 없으므로
  //    후속 단계에서 0 으로 채운다.
  const placeholders = nodeIds.map(() => "?").join(",");
  // dynamic SQL: placeholder count varies, keep prepare()
  const rows = db
    .prepare(
      `SELECT rowid, bm25(knowledge_nodes_fts) AS raw_score
       FROM knowledge_nodes_fts
       WHERE knowledge_nodes_fts MATCH ? AND rowid IN (${placeholders})`,
    )
    .all(sanitized, ...nodeIds) as Array<{ rowid: number; raw_score: number }>;

  // nodeId → raw bm25 수집 (매치 없으면 Map 에 기록 X → 후속 단계에서 0).
  const rawMap = new Map<number, number>();
  for (const row of rows) {
    if (row.raw_score !== null) {
      rawMap.set(row.rowid, row.raw_score);
    }
  }

  // 2. raw ASC 정렬 — 더 음수일수록 더 관련 있음.
  //    정렬된 순서로 RRF-like rank 를 부여한다.
  const sorted = [...rawMap.entries()].sort((a, b) => a[1] - b[1]);

  // 3. RRF-like rank 점수 계산 후 결과 Map 조립.
  //    매치 없는 nodeId 는 0 으로 채운다.
  const rankMap = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const [id] = sorted[i]!;
    rankMap.set(id, 1 / (BM25_RRF_K + i + 1));
  }

  const out = new Map<number, number>();
  for (const id of nodeIds) {
    out.set(id, rankMap.get(id) ?? 0);
  }

  return out;
}
