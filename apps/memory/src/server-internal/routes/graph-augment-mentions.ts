/**
 * routes/graph-augment-mentions.ts — 블록 1(글↔개념/글↔사람 mention) + 블록 1.7
 * (프로젝트 → 글 owns_memory 허브).
 *
 * routes/graph-augment.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 블록 번호·순서·상한·주석은
 * 옛 파일 그대로(동작 불변) — 배선은 graph-augment.ts 파사드의 augmentWithEntities
 * 가 진다. 읽기 전용 — nodeById·edgeSet 만 in-place 변형.
 */

import {
  CONCEPTS_PER_NODE,
  PERSONS_PER_NODE,
  ENTITY_EDGE_WEIGHT,
  OWNS_MEMORY_EDGE_TYPE,
  PROJECT_OWNS_WEIGHT,
  PROJECT_MEMBER_NODES_LIMIT,
  nodeKey,
  conceptKey,
  personKey,
  projectKey,
  toGraphNode,
  conceptToGraphNode,
  personToDetailedGraphNode,
  projectToDetailedGraphNode,
} from "./graph-nodes-shared.ts";
import {
  addEntityEdge,
  isKindCategoryConcept,
  type AugmentContext,
} from "./graph-augment-shared.ts";

/** 1) 글↔개념 / 글↔사람 */
export async function collectMentionEdges(ctx: AugmentContext): Promise<void> {
  const { store, nodeById, edgeSet } = ctx;
  for (const mid of ctx.memoryNodeIds) {
    const fromKey = nodeKey(mid);

    const conceptEdges = (await store.listNodeConceptEdges({ nodeId: mid })).slice(0, CONCEPTS_PER_NODE);
    for (const ce of conceptEdges) {
      const cKey = conceptKey(ce.conceptId);
      if (!nodeById.has(cKey)) {
        const concept = await store.getConcept(ce.conceptId);
        if (!concept) continue;
        // "종류"(KIND_CATEGORY) 메타 키 개념은 그래프에서 제외한다(2026-06-28 허브 버그 수정·
        // spec §4.4·세부 결정 2 — 합류 단계 skip). continue 가 노드 생성뿐 아니라 conceptIds·
        // mentioners 합류·엣지까지 전부 건너뛰게 둬, 그 개념이 위계선·identity 역조회·상위
        // 거슬러 올라가기 어디에도 안 닿게 한다(잔존·폼 폴백 "종류" 꼬리표 확실 방어). 콜론
        // 위계 분류 키(작품·장소 유리조각)는 이름이 "종류" 가 아니라 그대로 합류한다(과삭제
        // 0·함정 1). 노드가 이미 집합에 있는 경우는 이 가드가 애초에 합류를 막았으므로 발생
        // 안 하지만(첫 등장에 skip), nodeById.has 분기 밖에 둬 어느 등장 순서에도 안전하다.
        if (isKindCategoryConcept(concept)) continue;
        nodeById.set(cKey, conceptToGraphNode(concept));
      }
      ctx.conceptIds.add(ce.conceptId);
      addEntityEdge(edgeSet, fromKey, cKey, ce.role, ENTITY_EDGE_WEIGHT);
      let mentioners = ctx.conceptMentioners.get(ce.conceptId);
      if (!mentioners) { mentioners = new Set<string>(); ctx.conceptMentioners.set(ce.conceptId, mentioners); }
      mentioners.add(fromKey);
    }

    const personEdges = (await store.listNodePersonEdges({ nodeId: mid })).slice(0, PERSONS_PER_NODE);
    for (const pe of personEdges) {
      const pKey = personKey(pe.personId);
      if (!nodeById.has(pKey)) {
        const person = await store.getPerson(pe.personId);
        if (!person) continue;
        nodeById.set(pKey, await personToDetailedGraphNode(store, person));
      }
      ctx.collectedPersonRefs.add(pe.personId);
      addEntityEdge(edgeSet, fromKey, pKey, pe.relation, ENTITY_EDGE_WEIGHT);
      ctx.personSubjectNodes.add(fromKey); // G4 — 이 글은 사람 주체 글(글→person mention 보유).
    }
  }
}

/**
 * 1.7) 프로젝트 → 글 owns_memory 허브 — 집합 안 글의 projectId(길 A) 를 모아
 *   프로젝트 노드를 합류시키고, 같은 프로젝트의 다른 글을 getProjectMemberNodes 로
 *   끌어와 노드로 더하며 프로젝트 → 글 방향 owns_memory 엣지를 그린다.
 *   읽기 전용(SELECT 만)·양끝 불변식(글은 방금 더했고 프로젝트는 이 단계가 합류).
 *
 *   배치 — 개념·사람 1) 블록 *뒤*, conceptIds 빈-집합 early-return *앞*. spec/plan 의
 *   "1.6 뒤" 문구는 이 early-return 을 고려 못 한 줄번호 기준이었다. 프로젝트 소속
 *   글이 자기 개념 엣지가 0건이면(흔한 경우) early-return 이 1.7 을 건너뛰어 허브가
 *   안 생긴다. 그래서 1.7 을 early-return 앞에 둬 *개념 유무와 무관하게* 항상 돈다.
 *   1.6(개념 경유 프로젝트 합류)은 conceptIds>0 일 때만 1.7 뒤에서 도는데, 둘 다
 *   collectedProjectRefs 한 Set 을 공유해 같은 projectKey 는 노드 하나(중복 0).
 *
 *   전역 안전 상한 — 프로젝트당 cap 없음. 한 화면에서 *새로* 더해지는 글 총수가
 *   PROJECT_MEMBER_NODES_LIMIT 에 닿으면 멈춘다. 잔여분을 limit 로 넘긴다.
 *   이미 집합 안 글(중복)은 새 글 카운트에 안 센다.
 */
export async function attachProjectHubs(ctx: AugmentContext): Promise<void> {
  const { store, nodeById, edgeSet } = ctx;
  // (a) 집합 안 글 노드의 projectId 수집(null/undefined 는 건너뜀·중복 제거).
  const projectIdsInSet = new Set<string>();
  for (const n of nodeById.values()) {
    if (n.id.startsWith("node:") && n.projectId) {
      projectIdsInSet.add(n.projectId);
    }
  }

  let memoryNodesAdded = 0; // owns_memory 로 새로 더한 글 총수(전역 상한 대상).
  for (const pid of projectIdsInSet) {
    if (memoryNodesAdded >= PROJECT_MEMBER_NODES_LIMIT) break;
    const pKey = projectKey(pid);

    // (b) 아직 안 본 프로젝트면 노드를 1회 만든다(1.6 과 collectedProjectRefs 공유).
    if (!ctx.collectedProjectRefs.has(pid)) {
      const project = await store.getProject(pid);
      if (!project) continue; // 없는 프로젝트면 허브 생략(가짜 노드 0).
      nodeById.set(pKey, await projectToDetailedGraphNode(store, project));
      ctx.collectedProjectRefs.add(pid);
    }

    // (c) 같은 프로젝트 글을 잔여분만큼 끌어와 노드로 더하고 owns_memory 엣지를 그린다.
    const remaining = PROJECT_MEMBER_NODES_LIMIT - memoryNodesAdded;
    if (remaining <= 0) break;
    const members = await store.getProjectMemberNodes(pid, remaining);
    for (const m of members) {
      const mKey = nodeKey(m.id);
      if (!nodeById.has(mKey)) {
        // (d) 새 글만 전역 상한 카운트에 센다(이미 집합 안 글은 안 셈).
        if (memoryNodesAdded >= PROJECT_MEMBER_NODES_LIMIT) break;
        nodeById.set(mKey, toGraphNode(m));
        memoryNodesAdded++;
      }
      // 방향 = 프로젝트 → 글(부모 → 자식 컨벤션). addEntityEdge 가 중복 id 차단.
      addEntityEdge(edgeSet, pKey, mKey, OWNS_MEMORY_EDGE_TYPE, PROJECT_OWNS_WEIGHT);
    }
  }
}
