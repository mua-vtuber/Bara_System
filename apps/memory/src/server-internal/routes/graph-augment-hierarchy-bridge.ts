/**
 * routes/graph-augment-hierarchy-bridge.ts — standalone 시드 위계 다리 복원(Task 4).
 *
 * 배경 — Task 1 이 분류 값 개념(예 "둘째")이 해시태그 줄 안 평문에 우연히 나타났을 때
 * mention 엣지를 자동으로 잇던 결함을 고쳤다(그 mention 이 진짜 언급 없는 오연결의 원인
 * 이었다). 그런데 그 mention 엣지가 그동안 `/graph/overview` 에서 위계 사슬을 거슬러
 * 올라가는 유일한 시작 훅이기도 했다 — addStandaloneEntitySeeds 가 뒤늦게 넣는 독립
 * 엔티티(잎)는 글 mention 이 하나도 없어, walkHierarchyUpward 의 시작점(구조 seed)에
 * 못 들어가고 상위 분류 사슬("동물"·"고양이" 등 가운데 다리)이 화면에서 빠졌다. 그
 * 결과 잎이 타입 묶음("고양이 (전체)" 같은 group:<type>) 바로 아래 직결로 보여, 실제
 * 저장된 hierarchy_edges 사슬(생물→동물→고양이→얼룩이)과 다르게 렌더링됐다.
 *
 * 이 파일은 entity_relation_edges 쪽에서 이미 겪은 같은 모양의 결함
 * (routes/graph-augment-relations.ts 의 drawEntityRelationEdgesFromRefs — standalone 시드가
 * 늦게 들어와 관계선 첫 패스가 양끝을 못 본 문제)과 정확히 같은 해법을 위계 쪽에 적용한다:
 * 모든 노드(late-arriving standalone 시드 포함)가 nodeById 에 다 모인 *뒤*, 이미 있는
 * walkHierarchyUpward(부모 방향 BFS)·drawHierarchyEdges(집합 안 parent_of 그리기) 두
 * 블록을 *한 번 더* 돌리는 두 번째 패스다. 새 로직을 발명하지 않는다 — 순수 재사용·배선.
 *
 * 멱등성 — walkHierarchyUpward 는 이미 nodeById 에 있는 노드를 건너뛰고(visited·
 * nodeById.has 가드), drawHierarchyEdges 가 부르는 addEntityEdge 는 `edge:from->to:type`
 * id 로 중복을 막는다. 그래서 augmentWithEntities 안의 이른 패스(검색 뷰용)가 이미 일부
 * 사슬을 그려 놨어도, 이 두 번째 패스를 겹쳐 불러 중복 노드·중복 엣지 0 — 안전하게
 * drawEntityRelationEdgesFromRefs 뒤·buildGroupNodes 앞에 끼워 넣을 수 있다(buildGroupNodes
 * 가 읽는 parent_of 사슬이 이 시점엔 이미 완결돼 있어야 member_of 추이 감축이 가운데
 * 다리를 건너뛰지 않는다).
 *
 * refs(AugmentResult)의 entityRefs·personRefs·projectRefs 를 시작점(구조 seed)으로 삼아
 * 최소 AugmentContext 를 구성한다 — conceptIdList 인자로 []를 넘기는 것은 의도된 선택이다.
 * walkHierarchyUpward 는 구조 seed(project/person/엔티티 행)를 항상 conceptIdList 보다
 * 먼저 큐에 넣으므로, 이 패스의 목적(standalone 엔티티/사람 잎에서 위로 거슬러 올라가기)에는
 * conceptIdList 추가 시드가 필요 없다.
 */

import type { MemoryApiDeps } from "../types.ts";
import { type GraphNode, type GraphEdge, type AugmentResult } from "./graph-nodes-shared.ts";
import { type AugmentContext } from "./graph-augment-shared.ts";
import { walkHierarchyUpward, drawHierarchyEdges } from "./graph-augment-hierarchy.ts";

/**
 * standalone 시드(늦게 합류한 독립 엔티티·사람)에서 위계 상위 개념을 거슬러 올라가 노드로
 * 합류시키고, 집합 안이 된 양끝끼리 parent_of 위계선을 마저 긋는다.
 *
 * refs 로 넘어온 엔티티/사람/프로젝트 식별자를 AugmentContext 의 collected* 시작점으로
 * 심어 walkHierarchyUpward(빈 conceptIdList) → drawHierarchyEdges 순서로 재사용한다.
 * nodeById·edgeSet 을 in-place 변형한다(새 아키텍처 0 — 기존 두 블록의 조합일 뿐).
 */
export async function attachStandaloneHierarchyBridges(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  refs: AugmentResult,
): Promise<void> {
  const memoryNodeIds: number[] = [];
  for (const n of nodeById.values()) {
    if (typeof n.sourceId === "number" && n.id.startsWith("node:")) {
      memoryNodeIds.push(n.sourceId);
    }
  }

  // 명부 캐싱 — graph-augment.ts augmentWithEntities 와 같은 양식(요청당 1회 조회).
  const userTypeViews = store.entityTypeRegistryDb.listUserEntityTypes();
  const userPrefixToType = new Map<string, string>();
  const userTypeNames: string[] = [];
  for (const v of userTypeViews) {
    userTypeNames.push(v.typeName);
    if (v.idPrefix) userPrefixToType.set(v.idPrefix, v.typeName);
  }

  // 결함 1 수정(코드 리뷰 지적) — 이 패스는 매 호출마다 빈 conceptIds Set 으로 시작해
  // walkHierarchyUpward 의 climb 가드(`if (!nodeById.has(cKey))`, graph-augment-hierarchy.ts
  // :269)를 만난다. 그 가드는 부모 개념이 *이미* nodeById 에 있으면(예: 다른 최근 글이
  // 그 개념을 직접 mention 해 첫 augment 패스가 이미 노드를 만들어 놓은 경우) 방문·
  // 큐잉·더 위로 올라가는 것은 계속하되 `ctx.conceptIds.add(parentId)` 만 건너뛴다. 그
  // 결과 drawHierarchyEdges 가 읽는 hierWithinIds(graph-augment-hierarchy.ts:372-377)에
  // 그 개념 id 가 빠져, getHierarchyEdgesWithin 의 "양끝이 모두 입력 집합 안" 조건을
  // 못 맞춰 그 개념을 낀 위계선(부모·자식 양쪽)이 둘 다 걸러진다 — "생물→동물→고양이"
  // 사슬에서 "동물"이 겹치는 공용 분류어라 이미 nodeById 에 있으면 "생물→동물"·
  // "동물→고양이" 두 엣지가 통째로 빠지는 식(graph-hierarchy-bridge.test.ts "결함 1
  // 재현" red 로 확증).
  //
  // 수정 — nodeById 에 *이미* 들어있는 concept 노드들의 원본 concept id 를 미리
  // conceptIds 에 시딩한다. GraphNode.id 가 concept 노드일 때 정확히 `concept:${id}`
  // 형태(conceptKey, graph-nodes-shared.ts:287-289)이고 concept id 자체는 콜론을
  // 포함하지 않으므로("cpt_" + crypto.randomUUID(), concept-repository.ts) 접두어
  // 역파싱이 안전하다. 이 시딩은 walkHierarchyUpward 의 BFS 시작점(structuralStartIds,
  // graph-augment-hierarchy.ts:249)에는 영향이 없다 — 그건 별도 로컬 변수라 오직
  // 나중에 drawHierarchyEdges 가 읽는 conceptIds(따라서 hierWithinIds)에만 영향을
  // 준다. "종류"(KIND_CATEGORY) 메타 키 개념은 이 시딩 대상이 될 수 없다 — 그 개념을
  // nodeById 에 넣는 두 진입점(graph-augment-mentions.ts:52·graph-augment-hierarchy.ts
  // :277) 모두 생성 *전에* isKindCategoryConcept 가드로 걸러 애초에 nodeById 에 들어갈
  // 수 없다(불변식). 그래서 이미 있는 concept 노드에서 id 를 뽑는 이 시딩이 "종류"
  // 메타 키를 conceptIds 로 새롭게 들여보낼 여지는 없다.
  const existingConceptIds = new Set<string>();
  for (const n of nodeById.values()) {
    if (n.id.startsWith("concept:")) {
      existingConceptIds.add(n.id.slice("concept:".length));
    }
  }

  const ctx: AugmentContext = {
    store,
    nodeById,
    edgeSet,
    memoryNodeIds,
    userPrefixToType,
    userTypeNames,
    conceptIds: existingConceptIds,
    collectedEntityRefs: [...refs.entityRefs],
    collectedPersonRefs: new Set<string>(refs.personRefs),
    collectedProjectRefs: new Set<string>(refs.projectRefs),
    conceptMentioners: new Map<string, Set<string>>(),
    personSubjectNodes: new Set<string>(),
  };

  // 1.6b 재사용 — standalone 구조 seed(엔티티/사람/프로젝트)에서 부모 방향으로 거슬러
  //   올라가며 사슬 가운데 다리(개념)를 노드로 합류시킨다. conceptIdList=[] — 이 패스는
  //   라벨 개념 시드가 필요 없다(구조 seed 만으로 충분·주석 참고).
  await walkHierarchyUpward(ctx, []);
  // 2 재사용 — 방금 합류한 상위 개념 + 기존 집합 안 끝점끼리 parent_of 위계선을 긋는다.
  //   addEntityEdge 멱등이라 이미 그려진 사슬과 겹쳐도 중복 0.
  drawHierarchyEdges(ctx);
}
