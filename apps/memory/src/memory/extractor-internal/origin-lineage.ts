/**
 * origin-lineage.ts — 추출 원문의 계보(merged_into·parent_of)를 읽어 충돌 검사에서 뺄 노드를 정한다
 * (WP-B1-20T T3, 설계 5.9·3.6.1).
 *
 * 원문을 먼저 저장하고 추출하면(설계 5.9) 원문에서 뽑은 자식의 충돌 검사가 그 원문을 후보로 본다. 자식은
 * 원문 본문의 일부라 둘의 유사도가 보통 충돌 범위(bge-m3 실측 0.80~0.83)에 들어, 자식이 자기 원문과
 * contradicts 로 이어지고 disputed 가 된다(백필은 원문이 먼저 있어 이 결함이 이미 있었다). 같은 계보의
 * 두 노드는 한 글에서 나온 같은 내용이라 서로 반대 주장이 아니다:
 *   - 자식의 충돌 검사는 추출 원문과 그 계보 조상을 뺀다.
 *   - 자기 주장(원문이 새 주장, 설계 3.6.1)의 충돌 검사는 원문의 계보 조상과 자손을 뺀다.
 * 형제 자식끼리는 지금처럼 비교한다 — 한 글 안의 두 주장은 서로 어긋날 수 있다.
 *
 * 걷기는 계보 엣지만 따라가는 재귀 질의 한 번이다(idx_ke_source·idx_ke_target). 계보는 보통 깊이 2
 * 이하(원문 → 청크 → 주장)라 읽는 행 수는 그 노드의 계보 크기에 비례한다. UNION 이 방문한 id 를 다시
 * 넣지 않아 순환이 있어도 끝난다.
 */

import type { Database } from "bun:sqlite";
import { SHARED_MEMORY_LINEAGE_RELATIONS } from "../shared-memory-contract.ts";

const LINEAGE_RELATIONS_SQL = SHARED_MEMORY_LINEAGE_RELATIONS.map(() => "?").join(", ");

/** id 자신과, 계보 엣지를 자식 → 부모로 따라가 닿는 조상. */
const SELF_AND_ANCESTORS_SQL = `WITH RECURSIVE lineage(id) AS (
    SELECT ?
    UNION SELECT e.target_id FROM knowledge_edges e JOIN lineage l ON e.source_id = l.id
      WHERE e.relation IN (${LINEAGE_RELATIONS_SQL})
  ) SELECT id FROM lineage`;

/** id 에서 계보 엣지를 부모 → 자식으로 따라가 닿는 자손(id 자신 제외). */
const DESCENDANTS_SQL = `WITH RECURSIVE lineage(id) AS (
    SELECT e.source_id FROM knowledge_edges e WHERE e.target_id = ? AND e.relation IN (${LINEAGE_RELATIONS_SQL})
    UNION SELECT e.source_id FROM knowledge_edges e JOIN lineage l ON e.target_id = l.id
      WHERE e.relation IN (${LINEAGE_RELATIONS_SQL})
  ) SELECT id FROM lineage`;

function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map((row) => row.id);
}

/** 추출 원문과 그 계보 조상 — 원문에서 뽑은 자식의 충돌 후보에서 뺀다. */
export function originAndAncestorsSync(db: Database, originId: number): ReadonlySet<number> {
  return new Set(idsOf(db.query(SELF_AND_ANCESTORS_SQL).all(originId, ...SHARED_MEMORY_LINEAGE_RELATIONS)));
}

/**
 * 추출 원문의 계보 전체(자신·조상·자손) — 원문이 자기 주장으로 충돌 검사를 받을 때 후보에서 뺀다.
 * 자손은 검사 시점의 것을 읽는다(이번 추출이 방금 만든 자식 포함).
 */
export function originWholeLineageSync(db: Database, originId: number): ReadonlySet<number> {
  const ids = new Set(originAndAncestorsSync(db, originId));
  const descendants = db.query(DESCENDANTS_SQL)
    .all(originId, ...SHARED_MEMORY_LINEAGE_RELATIONS, ...SHARED_MEMORY_LINEAGE_RELATIONS);
  for (const id of idsOf(descendants)) ids.add(id);
  return ids;
}
