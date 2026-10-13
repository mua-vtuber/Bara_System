/**
 * entity-hierarchy-wiring.ts — 타입 루트 노드 + 분류 키 → 타입 루트 parent_of 위계 연결
 * (개념 엔티티 타입 체계 3단계 Task 2, spec §6.3).
 *
 * 목표는 `생물(타입 지붕) → 동물(분류)` 한 조각을 데이터로 세우는 것이다. 각 타입의
 * "타입 루트" 개념 노드(name = koName, is_classification_key = 1)를 보장하고, 분류 키
 * (subcategory)가 들어오면 `타입 루트 parent_of 분류 키` 엣지를 만든다. 기존 엔진이
 * 만드는 `동물 → 고양이` 와 이어져 `생물 → 동물 → 고양이` 사슬이 같은 concept_edges
 * parent_of 사슬 하나로 완결된다(spec §6.0.1·§6.3).
 *
 * 핵심 제약 — 새 엣지 종류·새 테이블·새 스키마 0. 이 모듈이 더하는 것은 "타입 루트를
 * 보장하고 분류 키를 그 아래 매다는 호출 흐름"뿐이다. 위계 엣지·멱등·과거 평평 글
 * 자동 재정리(reflow)는 전부 기존 `addClassificationTagFlow`(store.addClassificationTag)
 * 를 그대로 재사용한다. 그래서 타입 루트(category 로 들어감)는 자연히 is_classification_key
 * 로, 분류 키(value 로 들어감)는 is_classification_value 로 만들어지고 weight 0.9 parent_of
 * 엣지가 INSERT OR IGNORE 멱등·ON CONFLICT MAX 자가 치유로 세워진다.
 *
 * koName 단일 출처 = 2단계 `koNameOf`(entity-type-classifier). 타입 이름을 이 파일에
 * 하드코딩하지 않는다 — 알 수 없는 타입 이름은 식별자와 함께 loud throw 한다
 * (silent fallback 금지, CLAUDE.md "실패 ≠ 빈 결과").
 *
 * 검색 펼침(생물 검색 → 동물·고양이 글)은 retrieve-channels.ts §4.1 A2·A3 의 parent_of
 * transitive 가 이미 처리한다 — 이 모듈은 검색 점수(RRF 코어)에 손대지 않는다.
 *
 * Task 5 오케스트레이션(wireEntityPlacement)이 subcategory 가 있을 때 이 모듈의
 * linkSubcategoryToTypeRoot 를 부른다. 이 Task 는 그 함수 토대만 만든다(입력 통로 합류는 Task 5).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import {
  placementTypeNames,
  isPlacementType,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { koNameOf } from "./entity-type-classifier.ts";
import {
  reflowFlatParentTags,
  REFLOW_TRIGGER_LABEL,
} from "./tag-reflow.ts";
import type { Provenance } from "./provenance-vocabulary.ts";

/**
 * 배치 타입 이름이 등록된 배치 타입(정적 10종 ∪ DB 새 종류)인지 확인한다.
 * 호출 측이 분류기 산출 등에서 받은 string 을 넘길 수 있으므로 런타임에서 직접 검사해,
 * 알 수 없는 이름은 식별자와 함께 loud throw 한다(거짓 koName 생성·silent drop 금지).
 */
function assertPlacementType(typeName: string): asserts typeName is PlacementTypeName {
  if (!isPlacementType(typeName)) {
    throw new Error(
      `entity-hierarchy-wiring: 알 수 없는 배치 타입 '${typeName}' — ` +
        `등록된 배치 타입(${placementTypeNames().join(", ")}) 중 하나여야 한다`,
    );
  }
}

/**
 * 타입의 "타입 루트" 개념 노드를 보장하고 그 conceptId 를 돌려준다.
 *
 * name = 타입의 koName(생물·작품·프로젝트…), is_classification_key = 1 로 만든다 —
 * 타입 루트가 is_classification_key 여야 위계가 정합하다(spec §6.3). 이름 UNIQUE 라
 * 같은 타입으로 다시 불러도 같은 노드를 재사용한다(중복 0). koName 은 2단계
 * koNameOf 단일 출처에서 가져온다.
 *
 * @param store    실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param typeName 배치 타입 이름(예: 'creature'). 알 수 없는 이름은 loud throw.
 * @returns 타입 루트 개념의 conceptId('cpt_' + uuid).
 */
export async function ensureTypeRootConcept(
  store: SqliteMemoryStore,
  typeName: string,
): Promise<string> {
  assertPlacementType(typeName);
  const rootKoName = koNameOf(typeName);
  return store.findOrCreateConcept(rootKoName, { isClassificationKey: true });
}

/**
 * 콜론 위계(category → value)만 만든다. origin 노드가 없는 엔티티 프로필 패치에서
 * addClassificationTag 를 부르면 node_concept_edges FK 가 필요하므로, 같은 위계 부수효과
 * 중 "글→값 mention" 만 빼고 concept 위계와 reflow 를 보존한다.
 */
export async function linkClassificationPair(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  category: string,
  value: string,
  provenance: Provenance,
): Promise<void> {
  if (originNodeId !== null) {
    await store.addClassificationTag(
      originNodeId,
      category,
      value,
      provenance,
      originNodeId,
    );
    return;
  }
  if (!category || !category.trim()) {
    throw new Error("linkClassificationPair: category must be non-empty");
  }
  if (!value || !value.trim()) {
    throw new Error("linkClassificationPair: value must be non-empty");
  }

  const categoryId = await store.findOrCreateConcept(category, {
    isClassificationKey: true,
  });
  const valueId = await store.findOrCreateConcept(value, {
    isClassificationValue: true,
  });
  const hierarchy = store.addReducedHierarchyEdge({
    sourceType: "concept",
    sourceId: categoryId,
    targetType: "concept",
    targetId: valueId,
    provenance,
    sourceNodeId: null,
    weight: 0.9,
  });
  if (hierarchy.skippedAsShortcut) return;
  try {
    await reflowFlatParentTags(store, categoryId, valueId, REFLOW_TRIGGER_LABEL);
  } catch (err) {
    console.warn(
      `[linkClassificationPair reflow] 자동 재정리 실패 — 위계 등록은 유지 ` +
        `(parent ${categoryId}, label ${category}:${value}): ${String(err)}`,
    );
  }
}

/**
 * 타입 루트와 분류 키 사이에 parent_of 위계 엣지를 세운다 — `타입 루트(koName) → 분류 키`.
 *
 * 기존 `store.addClassificationTag(originNodeId, category, value)` 를 그대로 호출한다
 * (category = 타입 루트 koName / value = subcategory). 그러면:
 *   - 타입 루트(category)는 is_classification_key 개념으로,
 *   - 분류 키(value)는 is_classification_value 개념으로 보장되고,
 *   - 둘 사이 parent_of 엣지가 weight 0.9·INSERT OR IGNORE 멱등·ON CONFLICT MAX 자가
 *     치유로 세워지며,
 *   - 과거 평평 글 자동 재정리(reflow)까지 같은 헬퍼가 처리한다(spec §6.3 마지막 단락).
 *
 * 이렇게 같은 양식을 재사용하므로 ensureTypeRootConcept 가 만든 타입 루트와 여기서
 * addClassificationTag 가 보장하는 category 노드가 같은 노드다(이름 UNIQUE) — 따로
 * 노드를 만들지 않는다. 결과로 `addClassificationTag` 가 별도로 만드는 `동물 → 고양이`
 * 와 이어져 `생물 → 동물 → 고양이` 사슬 하나가 완결된다.
 *
 * 멱등 — 같은 타입·분류로 두 번 불러도 노드·엣지 중복 0(findOrCreateConcept 이름
 * UNIQUE + addConceptEdge INSERT OR IGNORE/ON CONFLICT MAX).
 *
 * @param store        실제 SqliteMemoryStore.
 * @param originNodeId 분류 신호가 나온 글 노드 id — addClassificationTag 가 이 글을
 *                     분류 키(value)에 classification role 로 잇는다(기존 양식 그대로).
 * @param typeName     배치 타입 이름(예: 'creature'). 알 수 없는 이름은 loud throw.
 * @param subcategory  분류 키(예: '동물'). 빈 값이면 addClassificationTag 가 loud throw.
 */
export async function linkSubcategoryToTypeRoot(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  typeName: string,
  subcategory: string,
  provenance: Provenance = originNodeId === null ? "user_input" : "hashtag",
): Promise<void> {
  assertPlacementType(typeName);
  const rootKoName = koNameOf(typeName);
  await linkClassificationPair(
    store,
    originNodeId,
    rootKoName,
    subcategory,
    provenance,
  );
}

/**
 * 단일 배치(`#일정:장터당번`)에서 타입 루트와 잎 사이에 parent_of 한 단을 세운다 —
 * `타입 루트(koName) → 잎 이름`(2026-06-13 단일 타입 배치 잎 개념 보장 spec §5.2 L2).
 *
 * `linkSubcategoryToTypeRoot` 의 변형이다 — 같은 `store.addClassificationTag` 단일 출처를
 * 부르되 value 로 *분류 키*(subcategory) 대신 *잎 이름*(candidateName = 행 이름)을 넘긴다.
 * 단일 배치는 `subcategory=null`·`categoryChain=[]` 라 중간 분류 단이 없어
 * `linkSubcategoryToTypeRoot` 가 안 돈다 — 그러면 잎("장터당번")이 위계에 안 매달려
 * force-layout 중심성이 약해 외톨이로 흩어진다. 이 함수가 타입 루트("일정") → 잎
 * ("장터당번") 한 단을 직접 건다.
 *
 * `addClassificationTag(origin, koName, leafName)` 가 한 헬퍼로 한꺼번에 보장한다:
 *   - 타입 루트(category·is_classification_key) 노드 — 다단계의 타입 루트와 같은 노드(name UNIQUE),
 *   - 잎(value·is_classification_value) 노드 — L1 이 `findOrCreateConcept` 로 만든 같은 노드,
 *   - `타입 루트 → 잎` parent_of(weight 0.9·INSERT OR IGNORE 멱등·ON CONFLICT MAX 자가 치유),
 *   - 글-연결(`node_concept_edges` role `classification`) — L1 의 글-연결과 같은 (node,concept,role)이라 멱등,
 *   - 위계 지름길 차단 2-(a)·2-(b)·reflow — `addClassificationTagFlow` 가 이미 품는다.
 *
 * 그래서 나중에 더 긴 사슬(`일정 → 장터 → 장터당번`)이 서면 2-(b)가 `일정 → 장터당번`
 * 직결을 소급 제거한다(D1 (A) 직결 허용 + 소급 정리와 자동 정합·별도 코드 0).
 *
 * 멱등 — 같은 타입·잎으로 두 번 불러도 노드·엣지 중복 0. 다단계가 이미 만든 잎과도
 * 중복 0(같은 이름이면 같은 노드). 호출처(wireEntityPlacement)가 *단일 배치 판정* 뒤에만
 * 불러 다단계에서는 안 돈다(reflow 헛돎 0·spec §5.4).
 *
 * @param store        실제 SqliteMemoryStore.
 * @param originNodeId 분류 신호가 나온 글 노드 id — addClassificationTag 가 이 글을
 *                     잎(value)에 classification role 로 잇는다(기존 양식 그대로).
 * @param typeName     배치 타입 이름(예: 'schedule'). 알 수 없는 이름은 loud throw.
 * @param leafName     잎 이름(= candidateName = 행 이름·예 '장터당번'). 빈 값이면
 *                     addClassificationTag 가 loud throw.
 */
export async function linkLeafToTypeRoot(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  typeName: string,
  leafName: string,
  provenance: Provenance = originNodeId === null ? "user_input" : "hashtag",
): Promise<void> {
  assertPlacementType(typeName);
  const rootKoName = koNameOf(typeName);
  await linkClassificationPair(
    store,
    originNodeId,
    rootKoName,
    leafName,
    provenance,
  );
}

/**
 * categoryChain 의 *인접 분류 쌍 전체*(`categoryChain[i] → categoryChain[i+1]`, i=0..len-2)를
 * 위계로 직접 잇는다 — 3단 이상 콜론 사슬의 가운데 다리를 placement 가 스스로 메우는 단일
 * 출처(2026-06-28 콜론 사슬 가운데 다리 누락 수정 spec §9 (나)·§10 S1).
 *
 * 배경 — 배치 헬퍼(placeOneEntityType·placeOneUserEntityType)는 *양 끝 두 토막*만 만든다:
 * `타입 루트 → categoryChain[0]`(linkSubcategoryToTypeRoot)·`categoryChain[last] → 끝-실체
 * 행`(잎 매달림). 가운데 인접 쌍(`categoryChain[0]→[1]`, …)은 보조 통로 둘이 나눠 만들어
 * 왔다 — 일반 분류(wireGeneralClassification·콜론 태그)와 라벨 위계(ensureLabelValueConcept).
 * 그런데 project 콜론 사슬은 그 두 통로가 *함께* 막힌다(소비 게이트 labelsConsumed +
 * projectChainConsumedKeys 라벨 필터) — 그래서 `#프로젝트:코딩 #코딩:앱 #앱:바라` 가
 * `프로젝트→코딩`+`앱→바라` 두 토막으로 갈라졌다(spec §7·§8 케이스 A·H). 이 함수가
 * placement 자기 완결로 그 의존을 끊는다 — 보조 통로가 돌든 안 돌든 가운데가 채워진다(I6 통로 대칭).
 *
 * 단일 출처 — `store.addClassificationTag(originNodeId, categoryChain[i], categoryChain[i+1])`
 * 를 그대로 쓴다(linkSubcategoryToTypeRoot 가 쓰는 그 헬퍼). 그래서:
 *   - 두 분류 단이 is_classification_key/value 개념으로 보장되고,
 *   - 둘 사이 parent_of 엣지가 weight 0.9·INSERT OR IGNORE 멱등·ON CONFLICT MAX 자가 치유로 서고,
 *   - 위계 지름길 차단 2-(a)·2-(b)·reflow 까지 같은 헬퍼가 처리한다.
 * `addHierarchyEdge` 직접 호출은 그 부수 보장(플래그·reflow·지름길 차단)을 놓치므로 쓰지 않는다.
 *
 * 멱등이라 정상 케이스(place·creature·user 종류)에서 통로 2/3 이 이미 같은 인접 쌍을 만들었어도
 * 같은 (source,target,relation) PK 에 INSERT OR IGNORE 로 떨어져 중복·이중 엣지 0 이다(위계 byte
 * 동일·spec §10 회귀 위험). categoryChain.length ≤ 1(단독·2단 사슬)이면 인접 쌍이 0 개라 no-op
 * (회귀 0). 빈 분류 단은 addClassificationTag 가 loud throw 하므로 환각 위계 0(분류기가 산출한
 * 인접 쌍만 잇는다).
 *
 * 8 타입(placeOneEntityType)과 user/project(placeOneUserEntityType) 두 통로가 이 한 출처를
 * 공유해 드리프트 0·책임 경계가 명확하다(spec §9 (나) 약점 1 — 헬퍼 추출로 복제 차단).
 *
 * @param store        실제 SqliteMemoryStore.
 * @param originNodeId 분류 신호가 나온 글 노드 id — addClassificationTag 가 이 글을 각 인접
 *                     쌍의 자식(value)에 classification role 로 잇는다(기존 양식 그대로).
 * @param categoryChain 분류기가 산출한 사슬의 거쳐 온 분류 단들(순서대로). 빈 배열·1개면 no-op.
 * @returns 새로 잇기를 시도한 인접 쌍 수(= max(categoryChain.length - 1, 0)). 멱등이라 이미 있던
 *          엣지도 이 수에 포함된다(시도 횟수·중복 생성 0).
 */
export async function linkAdjacentCategoryPairs(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  categoryChain: readonly string[] | undefined,
  provenance: Provenance = originNodeId === null ? "user_input" : "hashtag",
): Promise<number> {
  const chain = categoryChain ?? [];
  if (chain.length <= 1) return 0; // 단독·2단 — 가운데 인접 쌍 없음(no-op·회귀 0).
  let linked = 0;
  for (let i = 0; i < chain.length - 1; i += 1) {
    await linkClassificationPair(
      store,
      originNodeId,
      chain[i]!,
      chain[i + 1]!,
      provenance,
    );
    linked += 1;
  }
  return linked;
}
