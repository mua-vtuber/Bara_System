import type { Database } from "bun:sqlite";
import { listRelationEdges } from "../../memory/relation-reader.ts";

export interface GraphRelationEdge {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
  weight: number | null;
}

/** UnifiedRelationEdge → GraphRelationEdge 축약 map (source·양방향 조회가 공유). */
function toGraphRelationEdge(edge: {
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  relation: string;
  weight: number | null;
}): GraphRelationEdge {
  return {
    sourceType: edge.sourceKind,
    sourceId: edge.sourceId,
    targetType: edge.targetKind,
    targetId: edge.targetId,
    relation: edge.relation,
    weight: edge.weight,
  };
}

export function listGraphRelationsFromSource(
  db: Database,
  sourceType: string,
  sourceId: string,
): GraphRelationEdge[] {
  return listRelationEdges(db, {
    tableName: "entity_relation_edges",
    source: { kind: sourceType, id: sourceId },
  }).map(toGraphRelationEdge);
}

/**
 * 한 엔티티 노드에 걸린 관계 엣지를 *양방향*으로 모은다 — 나가는 관계(source=앵커)와
 * 들어오는 관계(target=앵커) 둘 다. 검색 뷰 펼침(revealSearchRelationEdges)이 쓴다.
 *
 * 왜 양방향인가 — 작가는 created_by 관계의 *도착점*(work→person)이다. 작가 이름으로
 * 검색해 앵커가 person 이면 나가는 관계(source 방향)만 봐서는 그 작가의 작품(source=work)이
 * 안 잡힌다. target 방향(들어오는 관계)까지 봐야 work→person 을 거꾸로 따라 작품을 끌어온다.
 *
 * 각 원소는 실제 source/target 을 그대로 담는다(앵커가 source 인지 target 인지는 호출부가
 * 판단). 관계가 없으면 빈 배열(정직한 빈 결과 — 실패가 아니라 진짜 없음).
 */
export function listGraphRelationsForNode(
  db: Database,
  type: string,
  id: string,
): GraphRelationEdge[] {
  const outgoing = listRelationEdges(db, {
    tableName: "entity_relation_edges",
    source: { kind: type, id },
  });
  const incoming = listRelationEdges(db, {
    tableName: "entity_relation_edges",
    target: { kind: type, id },
  });
  return [...outgoing, ...incoming].map(toGraphRelationEdge);
}
