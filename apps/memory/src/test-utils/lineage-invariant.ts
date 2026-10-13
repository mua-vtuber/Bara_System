/**
 * test-utils/lineage-invariant.ts — 살아 있는 노드 불변식 검사 도우미(WP-B1-20U 설계 17.0·17.11).
 *
 * 불변식: 살아 있는 노드(knowledge_nodes)는 모두 자기 출처 행(memory_node_sources)이나, 자기 자신이 아닌
 * 계보 부모 엣지(merged_into·parent_of, 자식 → 부모)를 가진다. 메시지 삭제는 출처 행으로만 뿌리를 찾으므로
 * 이 불변식이 깨진 노드는 메시지 삭제로 영영 찾을 수 없다. 계보 엣지는 부모가 지워지거나 휴지통으로 가면
 * ON DELETE CASCADE 로 끊기므로, 남은 엣지의 부모는 늘 살아 있는 노드다.
 *
 * 모든 제거 동작(메시지 삭제·휴지통 이동·자동 정리·단건 영구 삭제·정리 스크립트) 뒤 테스트가 부르고 빈
 * 목록을 단언한다. 운영 코드는 import 하지 않는다.
 */

import type { Database } from "bun:sqlite";
import { SHARED_MEMORY_LINEAGE_RELATIONS } from "../memory/shared-memory-contract.ts";

export interface LineageOrphan {
  id: number;
  content: string;
  sourceType: string;
}

/** 자기 출처 행도, 자기 자신이 아닌 계보 부모 엣지도 없는 살아 있는 노드(id 오름차순). */
export function lineageOrphans(db: Database): LineageOrphan[] {
  const relations = SHARED_MEMORY_LINEAGE_RELATIONS.map(() => "?").join(", ");
  // dynamic SQL: relation placeholder count follows the shared lineage relation list
  return db
    .prepare(
      `SELECT n.id AS id, n.content AS content, n.source_type AS sourceType FROM knowledge_nodes n
       WHERE NOT EXISTS (SELECT 1 FROM memory_node_sources s WHERE s.node_id = n.id)
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_edges e
           WHERE e.source_id = n.id AND e.target_id <> n.id AND e.relation IN (${relations})
         )
       ORDER BY n.id`,
    )
    .all(...SHARED_MEMORY_LINEAGE_RELATIONS) as LineageOrphan[];
}
