/**
 * routes/graph-augment-shared.ts — 합류 엔진 공용 상태 묶음·키 판정·사슬 헬퍼.
 *
 * routes/graph-augment.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). augmentWithEntities 의
 * 블록들이 공유하던 지역 상태를 AugmentContext 한 묶음으로 들고, id prefix 종류
 * 판정(entityRefForId — graph-augment.ts 파사드가 이름 그대로 재노출)·위계 끝점 키·
 * "종류" 메타 키 판정·사슬 분류 개념 수집을 담는다. 읽기 전용 — nodeById·edgeSet 만
 * in-place 변형. 쓰기 0 / 스키마 변경 0 / RRF 코어 0.
 */

import type { MemoryApiDeps } from "../types.ts";
import {
  ENTITY_TYPE_METAS,
  type EntityTypeName,
} from "../../db/store-internal/entity-type-registry.ts";
import { KIND_CATEGORY } from "../../memory/glob-field-apply.ts";
import type { ConceptNode } from "../../memory/types.ts";
import {
  type GraphNode,
  type GraphEdge,
  conceptKey,
  personKey,
  entityKey,
  projectKey,
} from "./graph-nodes-shared.ts";

/**
 * augmentWithEntities 한 호출이 블록들 사이에서 공유하는 상태 묶음 — 옛 단일 함수의
 * 지역 변수를 그대로 옮겼다(전부 참조 공유라 블록이 변형하면 다음 블록이 본다).
 */
export interface AugmentContext {
  store: MemoryApiDeps["store"];
  nodeById: Map<string, GraphNode>;
  edgeSet: Map<string, GraphEdge>;
  /** 현재 집합의 메모리 노드 id(숫자). */
  memoryNodeIds: number[];
  /** user 새 종류 명부 캐싱(요청당 1회) — idPrefix→typeName 역조회 맵. */
  userPrefixToType: Map<string, string>;
  /** user 새 종류 명부 캐싱(요청당 1회) — typeName 목록. */
  userTypeNames: string[];
  conceptIds: Set<string>;
  collectedEntityRefs: { type: string; id: string }[];
  collectedPersonRefs: Set<string>;
  /** 합류 프로젝트 id (묶음 노드용). */
  collectedProjectRefs: Set<string>;
  /**
   * 개념 id → 그 개념을 mention 한 글 노드 키 집합(블록 1.5b·G2 재지정용).
   *   G2(글→works행 승격)가 ① 글→works행 간선의 글 끝점을 찾고, ③ 분리 잎 개념 노드를
   *   뺄 때 "그 개념을 다른 글도 mention 하는가"(공유 방어)를 이 맵으로 판정한다.
   */
  conceptMentioners: Map<string, Set<string>>;
  /**
   * 사람 주체 글 노드 키 집합(블록 1.5c·G4 가드용·Q2-4).
   *   글이 글→person mention 엣지(node_person_edges·#사람: 선언 통로)를 하나라도 가지면
   *   사람 주체 글로 본다. 블록 1 이 글→person 엣지를 그릴 때 그 글 끝점을 여기 모아,
   *   블록 1.5c 의 글→works 행 승격이 사람 글일 땐 부모(70) 대신 곁다리 type 으로 emit 하게
   *   한다. 추가 store 조회 0 — 블록 1 산출 재사용.
   */
  personSubjectNodes: Set<string>;
}

/** 중복 id 차단 엣지 추가 — 옛 augmentWithEntities 내부 closure 를 함수로 옮겼다. */
export function addEntityEdge(
  edgeSet: Map<string, GraphEdge>,
  fromKey: string,
  toKey: string,
  type: string,
  weight: number,
  meta?: Record<string, unknown>,
): void {
  const id = `edge:${fromKey}->${toKey}:${type}`;
  if (!edgeSet.has(id)) {
    edgeSet.set(id, { id, from: fromKey, to: toKey, type, weight, ...(meta ? { meta } : {}) });
  }
}

/**
 * 위계 끝점 id 의 종류를 id prefix 로 가른다(단일 출처). person 은 'psn_', project 는
 * 'prj_', 8 타입은 ENTITY_TYPE_METAS 의 idPrefix(cre_/thg_/itk_/usb_/wrk_/mat_/plc_/
 * sch_), 새 user 종류는 런타임 명부 idPrefix(ldg_ 등), 그 밖(개념 cpt_ 포함)은 'concept'.
 *
 * 분류 단계4 T6 — prj_ 를 정직하게 'project' 로 가른다(옛날엔 'concept' 로 오분류).
 * 단계4 source wiring 후 project 끝 실체가 hierarchy_edges 끝점(target_type='project')이
 * 됐으므로, 이 함수에 prj_ 가 위계 자식·부모로 도달한다. 호출처(블록 1.55·1.6b)는 그
 * project 끝점을 projectKey 노드로 합류시켜 위계선 양끝을 집합 안에 넣고, 노드 키·
 * collectedProjectRefs Set 을 1.6/1.7 허브와 공유해 중복 0 을 지킨다(8 타입 통로의
 * entity:project:<id> 키로는 새지 않는다 — 이중 처리 0).
 *
 * user 종류(plan 2026-06-28 G2·RC2) — 8 타입 idPrefix 와 안 맞는 user 행 id(ldg_ 등)는
 * 옛날엔 'concept' 로 오분류돼 user 묶음 노드가 안 떴다. userPrefixToType(idPrefix→typeName
 * 역조회 맵)을 받아 user 접두사를 그 종류 string 으로 가른다 — 호출처(augmentWithEntities)가
 * 요청당 1회 listUserEntityTypes 로 만들어 캐싱한 맵을 넘긴다(매 호출 DB 왕복 0). 빈 맵
 * (기본값)이면 옛 동작과 동일(user 종류 0개 환경·정적 호출처 회귀 0).
 */
export function entityRefForId(
  id: string,
  userPrefixToType: ReadonlyMap<string, string> = new Map(),
): { type: "concept" | "person" | "project" | EntityTypeName | string; id: string } {
  if (id.startsWith("psn_")) return { type: "person", id };
  if (id.startsWith("prj_")) return { type: "project", id };
  for (const m of ENTITY_TYPE_METAS) {
    if (id.startsWith(m.idPrefix)) return { type: m.typeName, id };
  }
  for (const [prefix, typeName] of userPrefixToType) {
    if (id.startsWith(prefix)) return { type: typeName, id };
  }
  return { type: "concept", id };
}

/**
 * "종류"(KIND_CATEGORY) 메타 키 개념인지 판정한다 — 그래프에서 제외할 단 하나의 분류 키
 * (2026-06-28 "종류" 허브 버그 수정·spec §4.4).
 *
 * 옛 입력 흐름은 엔티티 종류를 "종류" 꼬리표로 자동 승격해, 장소·사람 등 모든 글이 "종류"
 * 한 개념 노드로 위계 연결선을 그어 허브처럼 보였다. ingest 가 그 자동 승격을 끊었고
 * (배지는 본문 typeName 으로 직접 산출), 폼 드롭다운 폴백·빈 DB 가 아닌 환경의 잔존
 * "종류" 꼬리표를 그래프에서도 거른다.
 *
 * 경계 — **이름이 KIND_CATEGORY("종류")인 분류 키 한정**이다. is_classification_key 플래그
 * 전체를 거르면 사용자가 의도적으로 만든 콜론 위계 분류 키(작품·장소·캐릭터 유리조각 노드)를
 * 다 지운다(spec §3·함정 1). 그래서 isClassificationKey && name === KIND_CATEGORY 두 조건을
 * 모두 만족할 때만 true. KIND_CATEGORY 는 glob-field-apply.ts 단일 출처(하드코딩 분산 금지).
 */
export function isKindCategoryConcept(concept: ConceptNode): boolean {
  return concept.isClassificationKey === true && concept.name === KIND_CATEGORY;
}

/**
 * hierarchy_edges 끝점(종류 문자열 + id)을 그래프 노드 키로 바꾼다. source_type/
 * target_type 이 'person' 이면 personKey, 'project' 면 projectKey, 8 타입 typeName 이면
 * entityKey, 그 밖('concept')이면 conceptKey. 블록 2 위계선이 양끝 노드 존재를 이 키로
 * 판정한다.
 *
 * 'project' 분기 — 단계4 source wiring 후 project 끝 실체(디롱)가 hierarchy_edges 의
 * target_type='project' 로 들어온다(entity-placement-loop.ts placeOneUserEntityType).
 * 그 끝점 키는 1.6/1.7 허브가 만드는 노드 키 projectKey(=project:<id>) 와 같아야 위계선
 * (코딩→디롱)의 양끝 노드 존재 판정이 같은 한 노드를 본다 — entityKey("project", id)
 * (=entity:project:<id>)로 떨어지면 허브 노드와 키가 어긋나 위계선이 못 그어진다.
 */
export function hierEndpointKey(endpointType: string, id: string): string {
  if (endpointType === "person") return personKey(id);
  if (endpointType === "project") return projectKey(id);
  if (endpointType === "concept") return conceptKey(id);
  return entityKey(endpointType, id);
}

/** 사슬 분류 직접 선 제거(H1)에서 한 행이 거슬러 올라가 모을 분류 개념 BFS 깊이 상한.
 *  위계 사슬(행→고양이→동물→생물·행→소설→작품)은 얕아 64 면 충분하고, 비정상 깊은
 *  사슬·순환 방어로도 쓰인다(visited Set 이 순환은 이미 막는다). */
const CHAIN_CLIMB_CAP = 64;

/**
 * 엔티티 행 id 에서 getHierarchyDirectParents 를 재귀로 거슬러(블록 1.6b BFS 양식)
 * 사슬 안 분류 *개념* id 집합을 모은다(H1·Q2-5 사슬 분류 직접 선 제거용).
 *
 * 행의 위계 부모를 BFS 로 올라가며 개념(cpt_·entityRefForId 가 'concept')만 모은다.
 * person·8 타입 부모는 이 용도에 대상이 아니다(글→분류 mention 의 to 는 개념 노드뿐).
 * visited Set 으로 순환·중복 거슬러 올라가기 0, 깊이 상한으로 비정상 사슬 방어.
 * 읽기 전용(store SELECT)·DB 쓰기 0.
 */
export function climbHierarchyConceptIds(
  store: MemoryApiDeps["store"],
  rowId: string,
  userPrefixToType: ReadonlyMap<string, string>,
): Set<string> {
  const conceptIds = new Set<string>();
  const visited = new Set<string>([rowId]);
  const queue: string[] = [rowId];
  let head = 0;
  let steps = 0;
  while (head < queue.length && steps < CHAIN_CLIMB_CAP) {
    const childId = queue[head++]!;
    steps++;
    for (const parentId of store.getHierarchyDirectParents(childId)) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      // user 종류 행 부모(ldg_ 등)는 'concept' 가 아니라 그 종류로 갈려 conceptIds 에 안
      // 든다(사슬 분류 직접 선 제거 대상은 개념뿐). userPrefixToType 으로 user 접두사를
      // 가른다(없으면 옛 동작·8 타입+개념만 가름).
      if (entityRefForId(parentId, userPrefixToType).type === "concept") {
        conceptIds.add(parentId);
      }
      queue.push(parentId); // 개념·행 무관 계속 거슬러(작품 행→소설 개념→작품 개념).
    }
  }
  return conceptIds;
}
