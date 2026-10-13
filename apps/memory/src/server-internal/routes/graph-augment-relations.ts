/**
 * routes/graph-augment-relations.ts — 블록 3(개념끼리 llm_relation) + 블록 4(엔티티
 * 끼리 관계선 entity_relation_edges).
 *
 * routes/graph-augment.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 블록 번호·순서·상한·주석은
 * 옛 파일 그대로(동작 불변) — 배선은 graph-augment.ts 파사드의 augmentWithEntities
 * 가 진다. 읽기 전용 — edgeSet 만 in-place 변형(새 노드 미추가).
 */

import type { PlacementTypeName } from "../../memory/concept-type-vocabulary.ts";
import type { MemoryApiDeps } from "../types.ts";
import {
  type GraphNode,
  type GraphEdge,
  CONCEPT_RELATION_WEIGHT,
  RELATION_EDGES_LIMIT,
  ENTITY_RELATION_WEIGHT,
  conceptKey,
  refNodeKey,
} from "./graph-nodes-shared.ts";
import { listGraphRelationsFromSource } from "./graph-relation-reader.ts";
import { addEntityEdge, type AugmentContext } from "./graph-augment-shared.ts";

/** 3) 개념끼리 llm_relation 관계 — 집합 안 개념끼리만 (새 노드 미추가) */
export function drawConceptRelationEdges(ctx: AugmentContext): void {
  const { store, nodeById, edgeSet } = ctx;
  for (const cid of ctx.conceptIds) {
    const relIds = store.getLlmRelationNeighborConceptIds(cid);
    for (const rid of relIds) {
      const toK = conceptKey(rid);
      if (nodeById.has(toK)) {
        addEntityEdge(edgeSet, conceptKey(cid), toK, "llm_relation", CONCEPT_RELATION_WEIGHT);
      }
    }
  }
}

/**
 * 4) 엔티티끼리 관계선 — entity_relation_edges (spec 3.5 · Task 4).
 *   양끝 노드가 둘 다 집합 안일 때만 추가(불변식). relation 을 type 으로 실어
 *   web(Task 7) 이 글 연결선과 구별한다. 한 화면 상한 RELATION_EDGES_LIMIT.
 *
 *   user 종류 제외(plan 2026-06-28 G2 범위) — collectedEntityRefs 에 user 종류 행도
 *   들어오지만(묶음 노드용), user 종류 관계 엣지는 단계4/T7·G4 몫이라 G2 는 만들지
 *   않는다(plan "관계 엣지는 단계4/T7 몫"). user 종류는 entity_relation_edges 에 행이
 *   없어 getRelationsFromSource 가 어차피 빈 배열이지만, 정적 종류(PlacementTypeName)만
 *   소스로 추려 관계선 통로의 타입 계약을 지킨다(userTypeNames 에 든 종류 제외).
 */
export function drawEntityRelationEdges(ctx: AugmentContext): void {
  drawEntityRelationEdgesFromRefs(
    ctx.store,
    ctx.nodeById,
    ctx.edgeSet,
    ctx.collectedEntityRefs,
    ctx.collectedPersonRefs,
    ctx.collectedProjectRefs,
    ctx.userTypeNames,
  );
}

/**
 * 4)의 몸체를 명시적 소스로 그리는 순수 변형 — AugmentContext 대신 관계 소스 묶음을
 * 직접 받는다. augmentWithEntities 안(검색 뷰 경로)은 위 파사드 drawEntityRelationEdges
 * 로 그대로 돌고, /graph/overview 는 addStandaloneEntitySeeds 로 모든 노드가 모인 *뒤*
 * merge 된 소스로 이 함수를 한 번 더 불러 관계선을 마저 긋는다(멱등 — addEntityEdge 가
 * `edge:from->to:type` id 로 중복을 막아 두 번 그려도 중복 0).
 *
 * 불변식 유지 — 새 노드를 만들지 않는다. fromKey·toKey 가 둘 다 nodeById 안일 때만 엣지를
 * 긋는다. entityRefs 는 user 종류(userTypeNames)를 제외한 정적 종류만 소스로 추려 관계선
 * 통로의 타입 계약(PlacementTypeName)을 지킨다. personRefs·projectRefs 는 Set·배열 둘 다
 * 스프레드되므로 ctx.collectedPersonRefs/collectedProjectRefs(Set)와 overview 의 merge
 * 배열 소스 모두 처리된다. projectRefs 를 소스에 넣는 이유 — participated_by(프로젝트 →
 * 사람·project-entity-mixin)는 source_type='project' 라, 나가는 방향만 읽는 이 패스
 * (listGraphRelationsFromSource)에서 project 가 소스로 돌지 않으면 그 관계선이 어느
 * 소스에서도 안 나와 overview 에서 전부 누락된다.
 */
export function drawEntityRelationEdgesFromRefs(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  entityRefs: readonly { type: string; id: string }[],
  personRefs: Iterable<string>,
  projectRefs: Iterable<string>,
  userTypeNames: readonly string[],
): void {
  const userTypeNameSet = new Set(userTypeNames);
  let relationEdgesAdded = 0;
  const relationSources: { type: PlacementTypeName; id: string }[] = [
    ...entityRefs
      .filter((r) => !userTypeNameSet.has(r.type))
      .map((r) => ({ type: r.type as PlacementTypeName, id: r.id })),
    ...[...personRefs].map((pid) => ({ type: "person" as const, id: pid })),
    ...[...projectRefs].map((pid) => ({ type: "project" as const, id: pid })),
  ];
  const relationDb = store.getRawDb();
  for (const ref of relationSources) {
    if (relationEdgesAdded >= RELATION_EDGES_LIMIT) break;
    const fromKey = refNodeKey(ref.type, ref.id);
    if (!nodeById.has(fromKey)) continue;
    const rels = listGraphRelationsFromSource(relationDb, ref.type, ref.id);
    for (const rel of rels) {
      const toKey = refNodeKey(rel.targetType, rel.targetId);
      if (nodeById.has(toKey)) {
        addEntityEdge(edgeSet, fromKey, toKey, rel.relation, ENTITY_RELATION_WEIGHT, {
          edgeKind: "entity_relation",
          source: "entity_relation_edges",
        });
        relationEdgesAdded++;
        if (relationEdgesAdded >= RELATION_EDGES_LIMIT) break;
      }
    }
  }
}
