/**
 * routes/graph-search-relation-reveal.ts — 검색 뷰(/graph/search) 전용 관계선 펼침(pull-in).
 *
 * overview 는 addStandaloneEntitySeeds 로 사람·작품 노드가 이미 다 모여, 양끝이 모두 있을
 * 때 관계선을 마저 긋는 것으로 고쳤다(drawEntityRelationEdgesFromRefs·건드리지 않음). 하지만
 * 검색 뷰는 사용자가 *이름으로 검색*하므로 문제가 다르다:
 *   1) addMatchingEntitySearchSeeds 가 이름 맞는 사람 노드를 augmentWithEntities *뒤에* 넣어,
 *      augment 안의 이른 관계선 패스는 그 사람 노드가 없어 work→person 관계선을 건너뛴다.
 *      사람 노드가 나중에 들어와도 다시 긋는 패스가 없어 관계선이 0개로 남는다.
 *   2) 작가 이름 검색은 그 작가의 작품(관계 상대)을 retriever 결과에 안 담을 수 있어, 상대
 *      작품 노드가 아예 없다(getNeighbors 는 knowledge_edges 만 봐 관계선 상대를 이웃으로도
 *      안 잡는다).
 *
 * 그래서 이 함수는 *모든 시드가 모인 뒤* 검색 뷰에서만 관계 상대를 *새로 끌어온다*. 앵커
 * (검색으로 도달한 엔티티/사람/프로젝트)마다 양방향 관계(listGraphRelationsForNode)를 읽어,
 * 양끝 노드가 nodeById 에 없으면 그 끝의 GraphNode 를 빌드해 합류시키고(pull-in), 두 끝이
 * 모두 존재하게 됐을 때만 관계선(점선)을 긋는다. 새로 끌어온 노드 수는 SEARCH_RELATION_PULL_LIMIT,
 * 엣지 수는 RELATION_EDGES_LIMIT 로 폭발을 막는다.
 *
 * 불변식 — 이 함수만 검색 뷰에서 새 노드를 끌어온다(overview 는 여전히 새 노드 미추가).
 * 행 조회가 null 이면 그 엣지를 정직하게 건너뛴다(가짜 노드·silent fallback 금지). RRF
 * 점수식·retriever 무접촉 — 표시용 그래프 조립 한정.
 */

import type { MemoryApiDeps } from "../types.ts";
import {
  type GraphNode,
  type GraphEdge,
  type AugmentResult,
  SEARCH_RELATION_PULL_LIMIT,
  RELATION_EDGES_LIMIT,
  ENTITY_RELATION_WEIGHT,
  refNodeKey,
  personToDetailedGraphNode,
  projectToDetailedGraphNode,
  entityToGraphNode,
  scheduleOccurrenceRowsForEntity,
} from "./graph-nodes-shared.ts";
import { listGraphRelationsForNode } from "./graph-relation-reader.ts";
import { addEntityEdge } from "./graph-augment-shared.ts";

// SEARCH_RELATION_PULL_LIMIT 를 이 모듈 경로에서도 노출한다 — 상한은 graph-nodes-shared 단일
// 출처이고(하드코딩 분산 금지), 소비처·테스트가 관계 펼침 모듈 경로에서 함께 가져갈 수 있게 한다.
export { SEARCH_RELATION_PULL_LIMIT } from "./graph-nodes-shared.ts";

/** 관계 앵커 한 점(타입 + id). person·project·8타입 엔티티 모두 이 형태로 추린다. */
interface RelationAnchor {
  type: string;
  id: string;
}

function emptyAugmentResult(): AugmentResult {
  return { entityRefs: [], personRefs: [], projectRefs: [] };
}

/**
 * merged AugmentResult 를 관계 앵커 목록으로 편다. entityRefs 는 userTypeNames 제외
 * (drawEntityRelationEdgesFromRefs 와 같은 소스 계약 — user 종류 관계는 단계4 몫)한 정적
 * 종류만, person·project 는 그대로 앵커로 쓴다. 중복 (type,id) 는 한 번만 담는다.
 */
function buildAnchors(
  merged: AugmentResult,
  userTypeNames: readonly string[],
): RelationAnchor[] {
  const userTypeNameSet = new Set(userTypeNames);
  const anchors: RelationAnchor[] = [];
  const seen = new Set<string>();
  const push = (type: string, id: string): void => {
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push({ type, id });
  };
  for (const ref of merged.entityRefs) {
    if (userTypeNameSet.has(ref.type)) continue;
    push(ref.type, ref.id);
  }
  for (const personId of merged.personRefs) push("person", personId);
  for (const projectId of merged.projectRefs) push("project", projectId);
  return anchors;
}

/**
 * 관계 끝점 한 점을 GraphNode 로 빌드한다 — person 은 getPerson→personToDetailedGraphNode,
 * project 는 getProject→projectToDetailedGraphNode, 그 밖 엔티티 타입은 entitiesRepo.get→
 * entityToGraphNode. 행 조회가 null 이면 null 을 돌린다(가짜 노드 금지 — 호출부가 그 엣지를
 * 정직하게 건너뛴다).
 */
async function buildEndpointNode(
  store: MemoryApiDeps["store"],
  type: string,
  id: string,
): Promise<GraphNode | null> {
  if (type === "person") {
    const person = await store.getPerson(id);
    return person ? await personToDetailedGraphNode(store, person) : null;
  }
  if (type === "project") {
    const project = await store.getProject(id);
    return project ? await projectToDetailedGraphNode(store, project) : null;
  }
  const entity = await store.entitiesRepo.get(id);
  if (!entity) return null;
  return entityToGraphNode(
    entity,
    store.entitiesRepo.listAttributes(entity.id),
    scheduleOccurrenceRowsForEntity(store, entity),
  );
}

/**
 * 검색 뷰 관계선 펼침. anchors(merged refs)에 걸린 양방향 관계 상대를 상한 안에서 nodeById 로
 * 끌어와 점선 관계선을 긋고, 끌어온 refs 를 AugmentResult 로 돌려 buildGroupNodes 가 묶음
 * 노드에 반영하게 한다.
 *
 * 반환은 mergeAugmentResults 로 합칠 수 있는 형태(끌어온 entity/person/project ref). 중복은
 * 무방하다 — buildGroupNodes 가 처리한다.
 */
export async function revealSearchRelationEdges(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  merged: AugmentResult,
  userTypeNames: readonly string[],
): Promise<AugmentResult> {
  const result = emptyAugmentResult();
  const anchors = buildAnchors(merged, userTypeNames);
  const relationDb = store.getRawDb();

  // 새로 끌어온 노드 수(pull 카운트) — 이미 집합 안 노드는 세지 않는다.
  let pulledNodeCount = 0;
  let relationEdgesAdded = 0;

  // 끝점 ref 를 result 에 담는다(묶음 노드 반영용). person/project/그 밖 엔티티로 가른다.
  const pushRef = (type: string, id: string): void => {
    if (type === "person") result.personRefs.push(id);
    else if (type === "project") result.projectRefs.push(id);
    else result.entityRefs.push({ type, id });
  };

  // 끝점 노드가 없으면 빌드해 합류시킨다. 이미 있으면 true(카운트 증가 없음). pull 상한 초과 +
  // 부재면 false(그 엣지 스킵). 행 조회 null 이면 false(가짜 노드 금지).
  const ensureEndpointNode = async (
    type: string,
    id: string,
    key: string,
  ): Promise<boolean> => {
    if (nodeById.has(key)) return true;
    if (pulledNodeCount >= SEARCH_RELATION_PULL_LIMIT) return false;
    const node = await buildEndpointNode(store, type, id);
    if (!node) return false;
    if (!nodeById.has(node.id)) {
      nodeById.set(node.id, node);
      pulledNodeCount++;
    }
    return true;
  };

  for (const anchor of anchors) {
    if (relationEdgesAdded >= RELATION_EDGES_LIMIT) break;
    const anchorKey = refNodeKey(anchor.type, anchor.id);
    // 앵커 노드가 집합 안일 때만 그 관계를 펼친다(검색으로 실제 도달한 엔티티 한정).
    if (!nodeById.has(anchorKey)) continue;

    const rels = listGraphRelationsForNode(relationDb, anchor.type, anchor.id);
    for (const rel of rels) {
      if (relationEdgesAdded >= RELATION_EDGES_LIMIT) break;

      const fromKey = refNodeKey(rel.sourceType, rel.sourceId);
      const toKey = refNodeKey(rel.targetType, rel.targetId);

      // 양끝 각각을 존재하게 만든다(부재면 상한 안에서 끌어온다). 하나라도 못 만들면 스킵.
      const fromOk = await ensureEndpointNode(rel.sourceType, rel.sourceId, fromKey);
      if (!fromOk) continue;
      const toOk = await ensureEndpointNode(rel.targetType, rel.targetId, toKey);
      if (!toOk) continue;

      addEntityEdge(edgeSet, fromKey, toKey, rel.relation, ENTITY_RELATION_WEIGHT, {
        edgeKind: "entity_relation",
        source: "entity_relation_edges",
      });
      relationEdgesAdded++;

      // 끌어온 끝점 ref 를 담는다(중복 무방 — buildGroupNodes 가 처리).
      pushRef(rel.sourceType, rel.sourceId);
      pushRef(rel.targetType, rel.targetId);
    }
  }

  return result;
}
