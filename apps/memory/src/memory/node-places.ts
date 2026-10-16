/**
 * memory/node-places.ts — 한 기억에 붙은 장소 이름 읽기.
 *
 * 장소는 두 경로로 붙는다(metadata-infer-cycle 의 has_place 와 같은 판정):
 *   (1) 옛 concept→concept 위계 — 추론 addClassificationTag 가 만든 '장소' 분류 키 아래 값 개념.
 *   (2) place-엔티티 — 직접 입력·콜론 #장소가 만든 place 엔티티의 잎 개념(identity 엣지).
 * 대시보드 검토 화면이 "현재 값"을 보이려고 읽는다. 쓰기는 하지 않는다.
 */

import type { Database } from "bun:sqlite";

/** 노드에 붙은 장소 이름 전부(두 경로 합집합, 이름 순). 없으면 빈 배열. */
export function listNodePlaces(db: Database, nodeId: number): string[] {
  const rows = db
    .query(
      `SELECT cval.name AS name FROM node_concept_edges nce
         JOIN hierarchy_edges he
           ON he.target_id = nce.concept_id AND he.relation = 'parent_of'
         JOIN concept_nodes ckey
           ON ckey.concept_id = he.source_id
          AND ckey.is_classification_key = 1
          AND ckey.name = '장소'
         JOIN concept_nodes cval ON cval.concept_id = nce.concept_id
        WHERE nce.node_id = ?1 AND nce.role = 'classification'
       UNION
       SELECT cval.name AS name FROM node_concept_edges nce
         JOIN entity_concept_edges pce
           ON pce.concept_id = nce.concept_id AND pce.role = 'identity'
         JOIN entities pe
           ON pe.entity_id = pce.entity_id AND pe.type_name = 'place'
         JOIN concept_nodes cval ON cval.concept_id = nce.concept_id
        WHERE nce.node_id = ?1 AND nce.role = 'classification'
       ORDER BY name`,
    )
    .all(nodeId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
