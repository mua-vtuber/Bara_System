import type { Database } from "bun:sqlite";
import { REGEX_ATOM_SOURCE, SHARED_MEMORY_DERIVED_SOURCE_TYPES, SHARED_MEMORY_LINEAGE_RELATIONS } from "../shared-memory-contract.ts";

const LINEAGE_RELATIONS_SQL = SHARED_MEMORY_LINEAGE_RELATIONS.map((relation) => `'${relation}'`).join(", ");
const DERIVED_SOURCE_TYPES_SQL = SHARED_MEMORY_DERIVED_SOURCE_TYPES.map((type) => `'${type}'`).join(", ");

/**
 * AI가 프로젝트에 저장한 기억은 정리 대상으로 쓰지 않는다. 개인 MCP 메모와 사용자가 직접 쓴
 * 프로젝트 메모는 유지한다. 태그는 저장 시 소문자로 정규화되며, 가져온 옛 기록의 # 표기도 받는다.
 * 파생 청크/추출 조각만 계보를 따라 같은 정책을 받는다. 독립적인 사용자 원문이 AI 추출 결과를
 * 흡수해 계보 엣지를 얻어도 그 원문까지 제외하지 않는다. UNION은 순환 계보에서도 끝난다.
 * nodeIdExpression은 호출부가 정한 SQL 식만 받는다(외부 입력을 이어 붙이지 않는다).
 */
export function cleanupEligibleNodeSql(nodeIdExpression: string): string {
  return `NOT EXISTS (
    WITH RECURSIVE cleanup_lineage(id) AS (
      SELECT ${nodeIdExpression}
      UNION
      SELECT edge.target_id FROM knowledge_edges edge
        JOIN cleanup_lineage lineage ON edge.source_id = lineage.id
        JOIN knowledge_nodes child ON child.id = lineage.id
        WHERE edge.relation IN (${LINEAGE_RELATIONS_SQL})
          AND (child.source_type IN (${DERIVED_SOURCE_TYPES_SQL})
            OR (CASE WHEN json_valid(child.metadata_json) THEN child.metadata_json ELSE '{}' END) ->> '$.source' = '${REGEX_ATOM_SOURCE}')
    )
    SELECT 1 FROM cleanup_lineage lineage
      JOIN knowledge_nodes ancestor ON ancestor.id = lineage.id
      WHERE length(trim(COALESCE(ancestor.project_id, ''))) > 0
        AND (
          ancestor.platform = 'mcp'
          OR EXISTS (
            SELECT 1 FROM json_each(
              CASE WHEN json_valid(ancestor.metadata_json) THEN ancestor.metadata_json ELSE '{}' END,
              '$.tags'
            ) tag
            WHERE tag.type = 'text' AND lower(ltrim(tag.value, '#')) = 'ai기록'
          )
          OR EXISTS (
            SELECT 1 FROM node_concept_edges tagged
              JOIN concept_nodes concept ON concept.concept_id = tagged.concept_id
              WHERE tagged.node_id = ancestor.id AND tagged.role = 'tag'
                AND lower(ltrim(concept.name, '#')) = 'ai기록'
          )
        )
  )`;
}

/** 후보 목록 밖의 오래된 제안/직접 제출도 현재 DB 상태로 다시 검사한다. 기억은 수정하지 않는다. */
export function isCleanupExcludedNode(db: Database, nodeId: number): boolean {
  const row = db.query(`SELECT NOT (${cleanupEligibleNodeSql("?")}) AS excluded`).get(nodeId) as { excluded: number };
  return row.excluded === 1;
}
