/**
 * routes/graph-augment-hierarchy.ts — 위계·identity 합류 블록 묶음: 1.6(개념 경유
 * 프로젝트) · 1.55(위계 잎 행) · 1.5b(identity 역조회 노드 합류) · 1.6b(상위 거슬러
 * 올라가기) · 2(parent_of 위계선).
 *
 * routes/graph-augment.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 블록 번호·순서·상한·주석은
 * 옛 파일 그대로(동작 불변) — 배선은 graph-augment.ts 파사드의 augmentWithEntities
 * 가 진다. 읽기 전용 — nodeById·edgeSet 만 in-place 변형.
 */

import {
  ENTITY_TYPE_METAS,
} from "../../db/store-internal/entity-type-registry.ts";
import {
  CONCEPTS_PER_NODE,
  PERSONS_PER_NODE,
  ENTITIES_PER_NODE,
  PROJECTS_PER_NODE,
  ENTITY_NODE_EDGE_WEIGHT,
  conceptKey,
  personKey,
  entityKey,
  projectKey,
  conceptToGraphNode,
  entityToGraphNode,
  scheduleOccurrenceRowsForEntity,
  personToDetailedGraphNode,
  projectToDetailedGraphNode,
  getEntityRowById,
} from "./graph-nodes-shared.ts";
import {
  addEntityEdge,
  entityRefForId,
  hierEndpointKey,
  isKindCategoryConcept,
  type AugmentContext,
} from "./graph-augment-shared.ts";

/**
 * 1.6) 프로젝트 — 글에 이어진 개념을 getProjectsByConceptId 로 역조회해 합류.
 *   getProjectsByConceptId(project-repository.ts)는 통합 entity_concept_edges 를
 *   entities 와 JOIN 해 type_name='project' 끝점만 거른다(옛 프로젝트 전용 개념 엣지
 *   테이블은 단계4 T4 통합으로 폐기됐다). role 인자 없이 호출하므로 그 개념에 이어진 프로젝트
 *   전체를 역조회한다(role 무관 — classification·tag 둘 다 의미 있는 연결).
 *   개념 노드가 집합 안일 때만 그 개념에서 프로젝트를 끌어온다(양끝 집합 안 불변식).
 *   프로젝트 노드 id 는 project:<projectId> — 글/개념/사람/엔티티 키와 충돌 없음.
 *   합류 여부는 collectedProjectRefs 하나로만 판정한다(노드 생성·엣지·상한 일원화).
 */
export async function attachProjectsByConcept(
  ctx: AugmentContext,
  conceptIdList: string[],
): Promise<void> {
  const { store, nodeById, edgeSet } = ctx;
  const projectCap = PROJECTS_PER_NODE * Math.max(1, ctx.memoryNodeIds.length);
  for (const cid of conceptIdList) {
    if (ctx.collectedProjectRefs.size >= projectCap) break;
    const cKey = conceptKey(cid);
    if (!nodeById.has(cKey)) continue; // 개념 노드가 집합 안일 때만(불변식).
    const projectEdges = store.getProjectsByConceptId(cid);
    for (const pe of projectEdges) {
      const pKey = projectKey(pe.projectId);
      if (!ctx.collectedProjectRefs.has(pe.projectId)) {
        // 아직 안 본 프로젝트 — 상한 안이면 노드를 1회 만든다.
        if (ctx.collectedProjectRefs.size >= projectCap) break;
        const project = await store.getProject(pe.projectId);
        if (!project) continue;
        nodeById.set(pKey, await projectToDetailedGraphNode(store, project));
        ctx.collectedProjectRefs.add(pe.projectId);
      }
      // 집합 안 프로젝트에는 개념마다 연결선을 더한다(엣지는 addEntityEdge 가 중복 제거).
      addEntityEdge(edgeSet, pKey, cKey, pe.role, ENTITY_NODE_EDGE_WEIGHT);
    }
  }
}

/**
 * 1.55) 위계 잎 행 합류(S1-T3 person·S2-T3 8 타입) — 집합 안 개념을 부모로 가진
 *   hierarchy_edges 자식 행(person 또는 8 타입 엔티티)을 노드로 끌어온다. 글이 직접
 *   언급 안 한 사슬 잎(성춘향 person·한빛의원 place 등)도 위계선이 닿게 한다(블록 2 가
 *   양끝 집합 안일 때만 긋는 불변식 — 이 합류가 잎 끝점을 집합에 넣어 닭-달걀을 푼다).
 *   자식 종류는 entityRefForId(id prefix 단일 출처)로 가른다 — person 이면 personToGraph
 *   Node, 8 타입이면 getEntityRowById + entityKey(블록 1.6b 8 타입 합류 양식 재사용·
 *   드리프트 0). 개념 자식(cpt_)은 이 단계 대상이 아니다(위계 자식이 개념이면 블록 2 가
 *   개념끼리 직접 긋는다). 상한 = 글 수에 비례(과밀 방어). getRow null 이면 가짜 노드 0.
 */
export async function attachLeafHierarchyRows(
  ctx: AugmentContext,
  conceptIdList: string[],
): Promise<void> {
  const { store, nodeById } = ctx;
  let leafHierAdded = 0;
  const leafHierCap = Math.max(PERSONS_PER_NODE, ENTITIES_PER_NODE) * Math.max(1, ctx.memoryNodeIds.length);
  for (const cid of conceptIdList) {
    if (leafHierAdded >= leafHierCap) break;
    if (!nodeById.has(conceptKey(cid))) continue; // 부모 개념이 집합 안일 때만(불변식).
    for (const childId of store.getHierarchyDirectChildren(cid)) {
      if (leafHierAdded >= leafHierCap) break;
      // userPrefixToType 로 user 종류 행 자식(ldg_ 등)도 가른다 — 8 타입과 같은 ref.type
      //   !=="concept" 갈래로 떨어져 entityKey 노드로 합류한다(묶음 노드 자식 끝점).
      const ref = entityRefForId(childId, ctx.userPrefixToType);
      if (ref.type === "person") {
        const pKey = personKey(ref.id);
        if (nodeById.has(pKey)) continue; // 이미 집합 안이면 건너뜀(중복 방어).
        const person = await store.getPerson(ref.id);
        if (!person) continue; // 없는 사람이면 가짜 노드 안 만든다.
        nodeById.set(pKey, await personToDetailedGraphNode(store, person));
        ctx.collectedPersonRefs.add(ref.id);
        leafHierAdded++;
      } else if (ref.type === "project") {
        // project 끝 실체(디롱) 위계 잎 합류 — 단계4 source wiring 후 project 가
        //   hierarchy_edges 끝점(target_type='project')이 됐다. 8 타입과 동형으로 노드에
        //   합류시켜 '코딩→디롱' parent_of 위계선의 자식 끝이 노드 집합에 들어오게 한다
        //   (블록 2 의 양끝 집합 안 불변식). 옛 명시 skip(continue)은 project 가 위계 끝점
        //   이 아니던 단계3 이전 가정이라 폐기 — skip 이 디롱을 위계 자식에서 빼 코딩 사슬과
        //   분리시켰다(프로젝트→디롱 member_of 직결로 갈라져 보이던 결함의 1차 원인).
        //
        //   노드 키·Set 공유로 중복 0 — 1.6(getProjectsByConceptId)·1.7(project_id glob)
        //   허브와 같은 projectKey(=project:<id>) 노드 키 + 같은 collectedProjectRefs Set 을
        //   쓴다. 1.7 이 먼저 디롱을 합류했으면 nodeById.has(pKey) 로 건너뛰어 한 노드를
        //   공유한다(8 타입 통로의 entity:project:<id> 키는 만들지 않는다 — 이중 처리 0).
        const pKey = projectKey(ref.id);
        if (nodeById.has(pKey)) continue; // 이미 집합 안(1.6/1.7 허브 또는 중복)이면 건너뜀.
        const project = await store.getProject(ref.id);
        if (!project) continue; // 없는 프로젝트면 가짜 노드 안 만든다.
        nodeById.set(pKey, await projectToDetailedGraphNode(store, project));
        ctx.collectedProjectRefs.add(ref.id);
        leafHierAdded++;
      } else if (ref.type !== "concept") {
        // 8 타입 엔티티 행 잎 — 행을 노드로 직접 합류(블록 1.6b 8 타입 양식 재사용).
        const eKey = entityKey(ref.type, ref.id);
        if (nodeById.has(eKey)) continue; // 이미 집합 안이면 건너뜀(중복 방어).
        const row = await getEntityRowById(store, ref.type, ref.id);
        if (!row) continue; // 없는 행이면 가짜 노드 안 만든다.
        nodeById.set(
          eKey,
          entityToGraphNode(
            row,
            store.entitiesRepo.listAttributes(row.id),
            scheduleOccurrenceRowsForEntity(store, row),
          ),
        );
        ctx.collectedEntityRefs.push({ type: ref.type, id: ref.id });
        leafHierAdded++;
      }
      // 개념 자식(cpt_)은 합류 대상 아님 — 블록 2 가 개념끼리 직접 위계선을 긋는다.
    }
  }
}

/**
 * 1.5b) identity 역조회 노드 합류(S2-T4·S2-LIVE 보강·spec §6.3.5) — 단일 배치
 *   (#일정:장터당번 한 줄)는 글이 잎 개념('장터당번')에만 mention 을 단다. 그 잎 개념은
 *   위계 사슬 *밖*이고(행과 identity 로만 옆 연결·위계엔 타입 루트 일정 → schedule 행
 *   한 단만 선다), 행의 부모인 타입 루트('일정')도 글이 직접 mention 하지 않는다. 그래서
 *   블록 1.55(집합 안 개념을 부모로 가진 행)도, 블록 1.6b(집합 안 개념에서 부모 거슬러)도
 *   둘 다 schedule 행에 못 닿는다 — 글 mention 개념('장터당번')이 위계에 안 걸려 양쪽
 *   경로의 시작점이 못 된다. 옛 흡수가 잎 개념 노드와 행을 한 노드로 합쳐 가렸던 결함이
 *   흡수 폐기로 드러났다.
 *
 *   해법 — 집합 안 개념의 identity 8 타입 행을 역조회해 노드로 *직접 합류*한다(합치기 0).
 *   conceptToEntityKey 맵·absorbConceptsIntoEntities 호출은 부활하지 않는다(과흡수 회귀의
 *   뿌리). 행을 노드 집합에 *추가*만 하고 잎 개념 노드와 *합치지 않는다* — 직접 add 라
 *   라벨 일치 섞임이 없다(과흡수 0). 노드 생성은 블록 1.55/1.6b 8 타입 합류 양식
 *   (getEntityRowById + entityKey + label·sourceType)을 그대로 재사용한다(드리프트 0).
 *
 *   배치 — 블록 1.6b(상위 합류) *앞*에 둬, 행이 먼저 노드로 합류돼야 1.6b 시작점
 *   (collectedEntityRefs)에 들어가 부모(타입 루트 '일정')를 거슬러 올라간다. 그러면
 *   '일정 → schedule 행' 위계선이 블록 2 에서 그어진다. 상한은 블록 1.55 cap 패턴 재사용
 *   (글 수 비례). 이미 nodeById 에 있으면 add 안 함·collectedEntityRefs 도 종류·id 기준
 *   중복 push 안 함(다단계는 1.55 가 이미 합류한 행을 또 잡아도 한 노드). getRow null
 *   가짜 노드 0. person 은 identity 통로가 아니라 이 단계 대상이 아니다(영향 0).
 */
export async function attachIdentityRows(
  ctx: AugmentContext,
  conceptIdList: string[],
): Promise<void> {
  const { store, nodeById } = ctx;
  let identityAdded = 0;
  const identityCap = ENTITIES_PER_NODE * Math.max(1, ctx.memoryNodeIds.length);
  // 종류 순회 = 정적 8 타입 + user 새 종류(plan 2026-06-28 G2·RC2). 옛날엔
  //   ENTITY_TYPE_METAS(8 타입)만 돌아 user 행의 identity 역조회가 빠져 단일 배치 user
  //   행이 노드로 안 떠 묶음 노드가 안 떴다. userTypeNames(요청당 1회 캐싱)를 더해
  //   getEntitiesByConcept(JOIN type_name) 가 user 종류 행도 역조회한다.
  const identityTypeNames = [
    ...ENTITY_TYPE_METAS.map((m) => m.typeName as string),
    ...ctx.userTypeNames,
  ];
  for (const cid of conceptIdList) {
    if (identityAdded >= identityCap) break;
    if (!nodeById.has(conceptKey(cid))) continue; // 잎 개념이 집합 안일 때만(불변식).
    for (const typeName of identityTypeNames) {
      if (identityAdded >= identityCap) break;
      for (const e of store.getEntitiesByConcept(typeName, cid, "identity")) {
        if (identityAdded >= identityCap) break;
        const eKey = entityKey(typeName, e.entityId);
        if (nodeById.has(eKey)) continue; // 이미 집합 안이면 건너뜀(중복 방어).
        const row = await getEntityRowById(store, typeName, e.entityId);
        if (!row) continue; // 없는 행이면 가짜 노드 안 만든다.
        nodeById.set(
          eKey,
          entityToGraphNode(
            row,
            store.entitiesRepo.listAttributes(row.id),
            scheduleOccurrenceRowsForEntity(store, row),
          ),
        );
        ctx.collectedEntityRefs.push({ type: typeName, id: e.entityId });
        identityAdded++;
      }
    }
  }
}

/**
 * 1.6b) 위계 상위 개념 합류(S1-T3b) — 블록 1.55(잎 자식 합류)의 *부모 방향 거울*.
 *   글이 직접 언급한 잎·person 끝점에서 getHierarchyDirectParents 를 *재귀로 거슬러*
 *   상위 개념(글이 언급 안 한 "사람"·"관계" 등)을 노드로 합류시킨다. 이게 없으면
 *   사슬 상위가 노드 집합에서 빠져 블록 2 의 "양끝 집합 안일 때만 긋는다" 불변식
 *   때문에 사람→가족 위계선이 누락되고, 그 빈자리에서 글→잎(1급 mention prio 60)이
 *   parent_of(prio 40)를 이겨 buildHierarchy 가 사슬을 뒤집는다(S1-LIVE 실측 회귀).
 *
 *   끝점 종류 무관(1급 일반 원칙·spec §6.3) — 시작점이 개념·person·8 타입 어느
 *   종류든 같은 BFS 로 부모를 거슬러 올라간다. 부모 종류는 id prefix(entityRefForId
 *   단일 출처)로 갈라 개념이면 conceptKey·person 이면 personKey·8 타입이면 entityKey
 *   로 합류한다. 현재 hierarchy_edges 의 부모(source)는 개념뿐이라 실제로 도는 건
 *   개념 갈래이나, Stage 2 에서 8 타입이 잎이 돼도 같은 결함이 재발하지 않게 일반으로 둔다.
 *
 *   상한·중복 방어 — 블록 1.55 cap 패턴 재사용(글 수 비례). visited Set 으로 같은
 *   상위 개념 재방문·무한 루프 0. 합류는 부모 방향 한 줄기라 자식 fan-out 보다 폭이 좁다.
 *   합류한 상위 개념을 conceptIds 에 모아 블록 2 within-set 입력에 더한다 —
 *   그래야 사람→가족 위계선의 두 끝이 집합 안에 들어와 위계선이 그어진다.
 */
export async function walkHierarchyUpward(
  ctx: AugmentContext,
  conceptIdList: string[],
): Promise<void> {
  const { store, nodeById } = ctx;
  let upwardAdded = 0;
  const upwardCap = CONCEPTS_PER_NODE * Math.max(1, ctx.memoryNodeIds.length);
  // 시작점 = 합류된 project/person/8 타입 행 끝점 먼저, 그 뒤 집합 안 개념 전부.
  // 구조 leaf 에서 타입 루트까지 거슬러 올라가는 길이 라벨 개념 부모보다 중요하다.
  // `#프로젝트:코딩 #코딩:앱 #앱:디롱 #언어:...` 처럼 라벨이 많은 글에서 라벨 부모
  // 6개가 upwardCap 을 먼저 써버리면 `앱→디롱` 만 보이고 `프로젝트→코딩→앱` 이
  // 화면에서 잘린다. 그래서 project/person/entity 끝점을 큐 앞에 두어 구조 사슬을
  // 먼저 복원하고, 남은 한도로 일반 라벨 부모를 보강한다.
  const entityRefIds = ctx.collectedEntityRefs.map((r) => r.id);
  const projectRefIds = [...ctx.collectedProjectRefs];
  const structuralStartIds = [
    ...projectRefIds,
    ...ctx.collectedPersonRefs,
    ...entityRefIds,
  ];
  const visited = new Set<string>(structuralStartIds);
  const walkUp = async (starts: string[]): Promise<void> => {
    const queue = [...starts];
    let head = 0;
    while (head < queue.length && upwardAdded < upwardCap) {
      const childId = queue[head++]!;
      for (const parentId of store.getHierarchyDirectParents(childId)) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        // userPrefixToType 로 user 종류 행 부모도 가른다 — 8 타입과 같은 else 갈래로
        //   떨어져 entityKey 노드로 합류한다(user 종류가 사슬 중간 마디인 경우 대비).
        const ref = entityRefForId(parentId, ctx.userPrefixToType);
        if (ref.type === "concept") {
          // 개념 부모 — 노드로 합류(getConcept null 이면 가짜 노드 0·불변식).
          const cKey = conceptKey(parentId);
          if (!nodeById.has(cKey)) {
            if (upwardAdded >= upwardCap) break;
            const concept = await store.getConcept(parentId);
            if (!concept) continue;
            // "종류"(KIND_CATEGORY) 메타 키 부모는 합류하지 않는다(2026-06-28 허브 버그 수정·
            // spec §4.4·세부 결정 2). 잔존 "종류"→값 위계가 있어도 그 메타 키가 상위 합류로
            // 그래프에 새지 않게 한다(콜론 위계 분류 키는 이름이 "종류" 가 아니라 그대로 합류).
            // conceptIds 에도 안 넣어 블록 2 위계선·블록 3 관계선이 그 메타 키를 안 본다.
            if (isKindCategoryConcept(concept)) continue;
            nodeById.set(cKey, conceptToGraphNode(concept));
            ctx.conceptIds.add(parentId);
            upwardAdded++;
          }
        } else if (ref.type === "person") {
          // person 부모(현재 위계엔 없으나 1급 일반) — 합류.
          const pKey = personKey(ref.id);
          if (!nodeById.has(pKey)) {
            if (upwardAdded >= upwardCap) break;
            const person = await store.getPerson(ref.id);
            if (!person) continue;
            nodeById.set(pKey, await personToDetailedGraphNode(store, person));
            ctx.collectedPersonRefs.add(ref.id);
            upwardAdded++;
          }
        } else if (ref.type === "project") {
          // project 부모 합류(블록 1.55 project 잎 합류의 부모 방향 거울) — 단계4 source
          //   wiring 후 project 가 hierarchy_edges 끝점이 됐다. 부모가 project 인 사슬
          //   (project 가 중간 마디)에서도 그 project 노드를 집합에 넣어 위계선 양끝이
          //   집합 안에 들게 한다. 8 타입 통로(entity:project:<id>)로 새지 않고 1.6/1.7
          //   허브와 같은 projectKey 노드 키 + 같은 collectedProjectRefs Set 을 공유한다
          //   (중복 0). 거슬러 올라가기 큐에도 넣어 project 위 개념 부모까지 닿게 둔다.
          const pKey = projectKey(ref.id);
          if (!nodeById.has(pKey)) {
            if (upwardAdded >= upwardCap) break;
            const project = await store.getProject(ref.id);
            if (!project) continue;
            nodeById.set(pKey, await projectToDetailedGraphNode(store, project));
            ctx.collectedProjectRefs.add(ref.id);
            upwardAdded++;
          }
        } else {
          // 8 타입 엔티티 부모(Stage 2 연동) — 행을 노드로 합류.
          const eKey = entityKey(ref.type, ref.id);
          if (!nodeById.has(eKey)) {
            if (upwardAdded >= upwardCap) break;
            const row = await getEntityRowById(store, ref.type, ref.id);
            if (!row) continue;
            nodeById.set(
              eKey,
              entityToGraphNode(
                row,
                store.entitiesRepo.listAttributes(row.id),
                scheduleOccurrenceRowsForEntity(store, row),
              ),
            );
            ctx.collectedEntityRefs.push({ type: ref.type, id: ref.id });
            upwardAdded++;
          }
        }
        // 거슬러 올라가기 — 이 부모를 다음 BFS 단계의 자식으로 큐에 넣는다.
        queue.push(parentId);
      }
    }
  };
  await walkUp(structuralStartIds);
  const labelStartIds: string[] = [];
  for (const cid of conceptIdList) {
    if (visited.has(cid)) continue;
    visited.add(cid);
    labelStartIds.push(cid);
  }
  await walkUp(labelStartIds);
}

/**
 * 2) parent_of 위계선 — 집합 안 개념·person 끝점끼리.
 * S0-T4(위계 단일 출처) — 옛 getParentOfEdgesWithin(concept_edges)에서
 * hierarchy_edges 짝 getHierarchyEdgesWithin 으로 옮긴다. 그래프는 새 테이블에서
 * 위계선을 긋는다.
 *
 * S1-T3 — person 행이 위계 잎이 됐으므로 within-set 입력에 합류된 person id 도
 * 넣어야 엄마→psn_성춘향 엣지가 회신된다(getHierarchyEdgesWithin 은 양끝이 입력
 * 집합 안일 때만 회신).
 *
 * S1-T3b — 블록 1.6b 가 상위 개념(conceptIds 에 추가)·person 부모(collectedPersonRefs
 * 에 추가)를 합류시켰으므로, within-set 입력이 사슬 양 끝을 모두 담는다. conceptIds
 * 는 상위 합류분을 이미 포함한 최신 집합이라 그대로 펼친다(conceptIdList 는 합류 전
 * 스냅샷이라 안 쓴다). 끝점 매핑은 종류별로 — person 이면 personKey, 8 타입이면
 * entityKey, 아니면 conceptKey(entityRefForId 단일 출처).
 *
 * S2-T3 — 8 타입 엔티티 행이 위계 잎이 됐으므로 within-set 입력에 합류된 엔티티 행
 * id(collectedEntityRefs)도 넣어야 피부과→plc_한빛의원 같은 위계선의 양끝이 입력
 * 집합 안에 들어와 회신된다. collectedEntityRefs 는 {type,id}[] 라 id 만 뽑는다.
 *
 * 단계4 project 끝점 — project 끝 실체(디롱)가 hierarchy_edges 끝점(target_type=
 * 'project')이 됐으므로 합류된 project id(collectedProjectRefs)도 넣어야 '코딩→디롱'
 * 위계선의 자식 끝(prj_ id)이 source_id IN·target_id IN 양쪽 절에 들어와 그 행이
 * 회신된다. 빠지면 getHierarchyEdgesWithin 이 코딩→디롱 행을 아예 안 돌려줘 위계선이
 * 누락되고, member_of 추이 감축(graph-group-nodes)이 디롱을 위계 미도달로 봐
 * 프로젝트→디롱 직결 member_of 를 그린다(갈라져 보이던 결함의 연쇄 뿌리).
 */
export function drawHierarchyEdges(ctx: AugmentContext): void {
  const { store, nodeById, edgeSet } = ctx;
  const hierWithinIds = [
    ...ctx.conceptIds,
    ...ctx.collectedPersonRefs,
    ...ctx.collectedEntityRefs.map((r) => r.id),
    ...ctx.collectedProjectRefs,
  ];
  const hierarchy = store.getHierarchyEdgesWithin(hierWithinIds);
  for (const e of hierarchy) {
    const fromK = hierEndpointKey(e.sourceType, e.sourceId);
    const toK = hierEndpointKey(e.targetType, e.targetId);
    if (nodeById.has(fromK) && nodeById.has(toK)) {
      addEntityEdge(edgeSet, fromK, toK, e.relation, e.weight);
    }
  }
}
