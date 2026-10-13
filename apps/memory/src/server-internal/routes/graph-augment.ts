/**
 * server-internal/routes/graph-augment.ts — 엔티티·개념·위계 노드 합류 엔진 (파사드).
 *
 * 이미 조립된 메모리 노드 집합에 개념·사람·엔티티·프로젝트 노드와 연결선을 더하는
 * augmentWithEntities 와, 노드 키 재지정 엔진(remap+rebuild) absorbConceptsIntoEntities
 * 를 담는다. 옛 8 타입 identity 역조회 흡수는 S2-T3(위계 단일 출처)에서 폐기됐고, 이제
 * 8 타입 엔티티 행은 hierarchy_edges 위계 잎으로 직접 노드에 합류한다(흡수 0). remap
 * 엔진 absorbConceptsIntoEntities 는 ⑧ 같은-이름 흡수(graph-absorb-same-label.ts)가
 * 단일 출처로 재사용하므로 남긴다. graph.ts 에서 책임 단위로 옮겨 왔다(CLAUDE.md "파일
 * 작게·책임 경계로 분리").
 *
 * P3 G5-a 분할(docs/decisions/2026-07-03-structure-cleanup-spec.md) — 옛 846줄
 * 단일 파일을 책임 경계로 나눴다. 이 파일은 블록 순서를 배선하는 파사드로 남고
 * (export augmentWithEntities·absorbConceptsIntoEntities·entityRefForId 이름 그대로 —
 * entityRefForId 는 graph-augment-shared.ts 로 옮기고 재노출), 블록 몸체는:
 *   · 공용 상태 묶음(AugmentContext)·키 판정·사슬 헬퍼 → graph-augment-shared.ts
 *   · 블록 1(mention)·1.7(프로젝트 허브) → graph-augment-mentions.ts
 *   · 블록 1.6·1.55·1.5b·1.6b·2(위계·identity 합류) → graph-augment-hierarchy.ts
 *   · 블록 1.5c(승격 적용 — 판정은 종전 graph-augment-promote.ts) → graph-augment-promote-apply.ts
 *   · 블록 3·4(관계선) → graph-augment-relations.ts
 * 블록 실행 순서·상한·조기 반환은 옛 단일 함수와 동일하다(동작 불변·코드 이동만).
 *
 * 공유 토대(타입·키 빌더·상수·노드 변환)는 graph-nodes-shared.ts 에 의존한다.
 * 읽기 전용 — nodeById·edgeSet 만 in-place 변형. 쓰기 0 / 스키마 변경 0 / RRF 코어 0.
 */

import type { MemoryApiDeps } from "../types.ts";
import {
  type GraphNode,
  type GraphEdge,
  type AugmentResult,
} from "./graph-nodes-shared.ts";
import type { AugmentContext } from "./graph-augment-shared.ts";
import {
  collectMentionEdges,
  attachProjectHubs,
} from "./graph-augment-mentions.ts";
import {
  attachProjectsByConcept,
  attachLeafHierarchyRows,
  attachIdentityRows,
  walkHierarchyUpward,
  drawHierarchyEdges,
} from "./graph-augment-hierarchy.ts";
import { applyMentionPromotions } from "./graph-augment-promote-apply.ts";
import {
  drawConceptRelationEdges,
  drawEntityRelationEdges,
} from "./graph-augment-relations.ts";

// 외부 import 표면 보존 — entityRefForId 는 옛 graph-augment.ts export 였다
// (graph-augment-t6-render.test.ts 등 참조).
export { entityRefForId } from "./graph-augment-shared.ts";

/**
 * 이미 조립된 메모리 노드 집합에 개념·사람·엔티티(신규 8 타입) 노드와 연결선을 더한다.
 * - 글↔개념(node_concept_edges) / 글↔사람(node_person_edges) — 메모리 노드당 상한 적용.
 * - 글에 이어진 identity 개념을 거쳐 신규 8 타입 엔티티 행을 노드로 합류 — 글당 상한 적용.
 * - 개념끼리 parent_of 위계(getHierarchyEdgesWithin · S0-T4 단일 출처) — 집합 안 개념끼리만.
 * - 개념끼리 llm_relation 관계(getLlmRelationNeighborConceptIds) — 집합 안 개념끼리만, 새 노드 미추가.
 * 읽기 전용. 모든 엣지는 양끝이 노드 집합 안일 때만 추가(기존 불변식 유지).
 *
 * 반환 AugmentResult(entityRefs·personRefs) 는 Task 4(관계선)가 재사용한다 — 합류된
 * 엔티티·사람을 다시 걷지 않고 그 식별자 묶음으로 관계 엣지를 그릴 수 있게.
 */
export async function augmentWithEntities(
  store: MemoryApiDeps["store"],
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
): Promise<AugmentResult> {
  // 현재 집합의 메모리 노드 id(숫자)를 모은다.
  const memoryNodeIds: number[] = [];
  for (const n of nodeById.values()) {
    if (typeof n.sourceId === "number" && n.id.startsWith("node:")) {
      memoryNodeIds.push(n.sourceId);
    }
  }

  // 명부 캐싱(plan 2026-06-28 G2·성능) — user 새 종류 명부를 요청당 1회만 읽는다. 매 cid·
  //   종류 곱마다 DB 를 왕복하면 폭증하므로, 여기서 한 번 listUserEntityTypes 로 받아
  //   ① idPrefix→typeName 역조회 맵(entityRefForId user 접두사 판정)·② typeName 목록
  //   (블록 1.5b·resolvePromotionRef identity 역조회 종류 순회)을 만들어 아래로 넘긴다.
  //   user 종류 0개면 빈 맵·빈 목록이라 옛 동작과 동일(회귀 0).
  const userTypeViews = store.entityTypeRegistryDb.listUserEntityTypes();
  const userPrefixToType = new Map<string, string>();
  const userTypeNames: string[] = [];
  for (const v of userTypeViews) {
    userTypeNames.push(v.typeName);
    if (v.idPrefix) userPrefixToType.set(v.idPrefix, v.typeName);
  }

  // 블록들이 공유하는 상태 묶음 — 옛 단일 함수의 지역 변수를 그대로 옮겼다
  // (전부 참조 공유라 앞 블록의 변형을 뒤 블록이 본다).
  const ctx: AugmentContext = {
    store,
    nodeById,
    edgeSet,
    memoryNodeIds,
    userPrefixToType,
    userTypeNames,
    conceptIds: new Set<string>(),
    collectedEntityRefs: [],
    collectedPersonRefs: new Set<string>(),
    collectedProjectRefs: new Set<string>(),
    conceptMentioners: new Map<string, Set<string>>(),
    personSubjectNodes: new Set<string>(),
  };

  // 1) 글↔개념 / 글↔사람
  await collectMentionEdges(ctx);

  // 반환은 항상 호출 시점 스냅샷(배열을 복사)으로 만든다 — 이후 push 가 이미 넘긴
  // result 를 뒤에서 변형시키지 않게(entityRefs·personRefs 둘 다 같은 형태).
  const makeResult = (): AugmentResult => ({
    entityRefs: [...ctx.collectedEntityRefs],
    personRefs: [...ctx.collectedPersonRefs],
    projectRefs: [...ctx.collectedProjectRefs],
  });

  // 1.7) 프로젝트 → 글 owns_memory 허브 — conceptIds 빈-집합 early-return *앞*
  //   (개념 유무와 무관하게 항상 돈다 — 배치 근거는 attachProjectHubs 주석).
  await attachProjectHubs(ctx);

  if (ctx.conceptIds.size === 0) return makeResult();
  const conceptIdList = [...ctx.conceptIds];

  // 1.5) 옛 identity 역조회 *흡수*(개념과 행을 한 노드로 합치기)는 폐기됐다(S2-T3·위계
  //   단일 출처). 8 타입 엔티티 행은 hierarchy_edges 위계 잎으로 *직접* 노드 집합에
  //   합류한다(블록 1.55 person+8 타입 잎 자식 합류·블록 1.6b 상위 합류). 다만 단일 배치
  //   (글이 잎 개념에만 mention·잎이 위계 밖)는 두 합류 경로의 시작점이 안 돼 행이 안
  //   떴다 — 그래서 블록 1.5b 가 identity 역조회를 *노드 합류용으로만* 되살린다(합치기 0·
  //   과흡수 0). conceptToEntityKey·absorbConceptsIntoEntities 호출은 부활하지 않는다.
  //   (행↔잎-개념 identity 엣지는 검색 JOIN 키로 DB 에 남고, 이제 블록 1.5b 가 노드 합류
  //   역조회 키로도 재사용한다 — 흡수 입구는 여전히 0.)

  // 1.6) 프로젝트 — 글에 이어진 개념 역조회 합류.
  await attachProjectsByConcept(ctx, conceptIdList);

  // 1.55) 위계 잎 행 합류(S1-T3 person·S2-T3 8 타입).
  await attachLeafHierarchyRows(ctx, conceptIdList);

  // 1.5b) identity 역조회 노드 합류(S2-T4·S2-LIVE 보강·spec §6.3.5).
  await attachIdentityRows(ctx, conceptIdList);

  // 1.5c) 글→엔티티행 승격 + 분리 잎 identity 1:1 미출력·재지정 + 사슬 분류 직접 선 제거.
  applyMentionPromotions(ctx, conceptIdList);

  // 1.6b) 위계 상위 개념 합류(S1-T3b) — 블록 1.55 의 부모 방향 거울.
  await walkHierarchyUpward(ctx, conceptIdList);

  // 2) parent_of 위계선 — 집합 안 개념·person·엔티티 행·project 끝점끼리.
  drawHierarchyEdges(ctx);

  // 3) 개념끼리 llm_relation 관계 — 집합 안 개념끼리만 (새 노드 미추가)
  drawConceptRelationEdges(ctx);

  // 4) 엔티티끼리 관계선 — entity_relation_edges (spec 3.5 · Task 4).
  drawEntityRelationEdges(ctx);

  // 5) 옛 identity 흡수 후처리(absorbConceptsIntoEntities 호출·개념과 행을 한 노드로
  //   합치기)는 폐기됐다(S2-T3·위계 단일 출처). 8 타입 엔티티 행은 흡수가 아니라 위계 잎
  //   직접 합류(블록 1.55 위계 자식·블록 1.5b identity 역조회·블록 1.6b 상위)로 노드 집합에
  //   들어오고, 블록 2 가 그 행을 끝점으로 하는 위계선을 직접 긋는다. 블록 1.5b 가 identity
  //   엣지를 노드 *합류* 역조회 키로 다시 쓰지만 *합치기* 는 부활하지 않는다(과흡수 0).
  //   (remap+rebuild 엔진 absorbConceptsIntoEntities 함수 자체는 ⑧ 같은-이름 흡수
  //   absorbSameLabelNodes 가 단일 출처로 재사용하므로 남긴다.)

  return makeResult();
}

/**
 * 노드 키 재지정 엔진(remap + rebuild) — 비대표 노드를 대표 노드로 합치고 그 노드에
 * 매달린 엣지를 대표 키로 재지정한다(자기-루프·중복 엣지 정리). 표시 합치기 한정이라
 * DB·검색·RRF 불변(읽기 전용 in-place 변형).
 *
 * 단일 출처 — ⑧ 같은-이름 흡수 absorbSameLabelNodes(graph-absorb-same-label.ts)가
 * 이 엔진을 그대로 재사용한다. 옛 ②(identity 역조회 흡수)도 이 엔진을 썼으나 S2-T3
 * (위계 단일 출처)에서 폐기돼 그 호출은 사라졌다 — 엔진은 ⑧ 단일 출처로 보존한다.
 *
 * 절차(absorbeeToRep: 합쳐질 노드 키 → 대표 노드 키):
 *   1. 합쳐질 노드를 nodeById 에서 제거한다(대표 노드가 남는다).
 *   2. 그 키를 from 또는 to 로 갖는 모든 엣지를 대표 키로 재지정한다 — 매달린 위계
 *      parent_of·글 엣지·관계 엣지가 대표 노드로 이어져 사슬이 한 줄로 이어진다.
 *   3. 재지정 결과 양끝이 같아진 엣지(자기-루프)는 버린다.
 *   4. 재지정 후 같은 (from,to,type) 이 이미 있으면 중복을 버린다(엣지 id 충돌).
 */
export function absorbConceptsIntoEntities(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
  absorbeeToRep: Map<string, string>,
): void {
  if (absorbeeToRep.size === 0) return;

  // 1) 합쳐지는 비대표 노드를 제거한다(대표 노드가 남는다).
  for (const absorbeeKey of absorbeeToRep.keys()) {
    nodeById.delete(absorbeeKey);
  }

  // 2~4) 합쳐진 노드 끝점을 대표 끝점으로 재지정하며 엣지를 다시 모은다.
  const remap = (key: string): string => absorbeeToRep.get(key) ?? key;
  const rebuilt = new Map<string, GraphEdge>();
  for (const edge of edgeSet.values()) {
    const from = remap(edge.from);
    const to = remap(edge.to);
    if (from === to) continue; // 자기-루프(대표·비대표가 같아진 엣지) 버림.
    const id = `edge:${from}->${to}:${edge.type}`;
    if (rebuilt.has(id)) continue; // 재지정 후 중복 엣지 버림(첫 엣지 유지).
    rebuilt.set(id, { id, from, to, type: edge.type, weight: edge.weight });
  }
  edgeSet.clear();
  for (const [id, edge] of rebuilt) edgeSet.set(id, edge);
}
