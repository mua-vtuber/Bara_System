/**
 * place-user-entity-type.ts — 사용자 추가 새 종류 한 선언 배치 본체(entity-placement-loop
 * 에서 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만). 이 모듈은 placeOneUserEntityType — 화면으로
 * 더한 새 종류(기존 10종 밖 DB 종류) 선언을 범용 본체(entities)로 배치하는 통로 — 만 담는다.
 * 8 타입 대칭 통로는 place-entity-type.ts 에 있다.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import type { EntityTypeClassification } from "../entity-type-classifier.ts";
import {
  linkSubcategoryToTypeRoot,
  ensureTypeRootConcept,
  linkAdjacentCategoryPairs,
} from "../entity-hierarchy-wiring.ts";
import { relationTagKeySet } from "../entity-relation-vocabulary.ts";
import {
  getCanonicalItemKey,
  getTypeColumns,
} from "../concept-type-vocabulary.ts";
import type { Provenance } from "../provenance-vocabulary.ts";
import { isMidChainNode } from "./chain-structure.ts";
import {
  buildCandidateAndAttributes,
  lastCategoryOf,
} from "./candidate-attributes.ts";
import {
  appendChainStopWarning,
  type EntityPlacementResult,
} from "./placement-result.ts";

/**
 * 사용자가 화면으로 더한 *새 종류*(기존 10종 밖 DB 종류) 한 선언을 배치한다 — 분류 단계3 T4.
 *
 * placeOneEntityType(기존 10종 전용)과 *별 헬퍼*다 — 기존 경로는 한 줄도 안 바꾼다(회귀 0).
 * 새 종류는 전용 테이블·전용 facade·identity 엣지·그림자 잎 개념 통로를 안 탄다. 대신
 * 범용 본체(entities·entity_attributes·entities_fts·entities_vec) + 기존 위계 통로
 * (ensureTypeRootConcept·linkSubcategoryToTypeRoot)만 쓴다. 검색 도달은 단계3 T5 의
 * entities_fts(BM25)·entities_vec(KNN)가 전담하므로 concept identity JOIN 이 불필요하다.
 *
 * 호출처(entity-placement-wiring 그룹 루프)가 classification.typeName 이 새 종류
 * (store.entityTypeRegistryDb.isUserEntityType) 일 때만 이 헬퍼로 분기한다.
 *
 * 흐름(8 타입 full 통로보다 단순 — 결정 3):
 *  1. explicit 아니면 즉시 return(자동 배치 차단·placeOneEntityType 게이트 양식 계승).
 *  2. subcategory 가 있으면 linkSubcategoryToTypeRoot(타입 루트 → 분류 단 parent_of).
 *  3. 끝 고유명 후보를 글에서 뽑는다. 비면(분류 단어·일반명사) 행 안 만들고 경고만 남기고 return.
 *  4. entities 본체에 행 생성(findOrCreateEntity) + applyEmbedding(합성 텍스트 임베딩).
 *  5. 부모(단일 배치=타입 루트·다단계=마지막 분류 단 개념) → entities 행 parent_of 위계 엣지.
 *  6. 속성 = 라벨만 저장(is_column=0) — 관계 키·알 수 없는 키는 skip(경고). 칸 가름은 T8.
 *  관계 엣지(entity_relation_edges)는 단계4/T7 몫이라 T4 는 만들지 않는다(의존 역전 금지).
 *
 * @param store          실제 SqliteMemoryStore — store.entitiesRepo 로 본체에 쓴다.
 * @param originNodeId   글 노드 id.
 * @param content        글 원문 — 구조 신호(isMidChainNode) 판정에 쓴다(§6-B 단계2 D1·통로
 *                       대칭 I6). 후보가 같은 글의 다른 콜론 태그 키로 다시 쓰이는 중간 마디면
 *                       행 0(8타입 placeOneEntityType 과 같은 방어적 이중 안전).
 * @param classification 이 선언 값 하나의 분류 산출(explicit 사슬 결과·typeName = 새 종류 string).
 * @param subContent     이 선언 값의 sub-content — 후보·속성 태그를 여기서 구성한다.
 * @param result         누적 결과(이 함수가 += 로 더한다).
 */
export async function placeOneUserEntityType(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  classification: EntityTypeClassification,
  subContent: string,
  result: EntityPlacementResult,
  provenance: Provenance = originNodeId === null ? "user_input" : "hashtag",
): Promise<void> {
  const typeName = classification.typeName;
  if (typeName === null) return; // 방어 — 호출처가 새 종류만 넘기지만 null 가드.

  // 1) 명시 타입 선언(explicit)일 때만 배치한다(자동 배치 차단·불변식 I1·placeOneEntityType 양식).
  if (classification.source !== "explicit") return;

  // 새 종류 string 을 PlacementTypeName 으로 흐르게 한다(동적 명부 비대칭 — 런타임 게이트가
  // 진짜 검사). ensureTypeRootConcept·linkSubcategoryToTypeRoot 가 isPlacementType(동적 Set)
  // 로 새 종류를 통과시킨다(기존 코드 무수정 재사용).
  const userType = typeName as string;

  // 2) 위계 상위 — subcategory(첫 분류 단)가 있으면 `타입 루트 → 분류 단` parent_of 를 더한다.
  if (classification.subcategory) {
    await linkSubcategoryToTypeRoot(
      store,
      originNodeId,
      userType,
      classification.subcategory,
      provenance,
    );
    result.hierarchyEdges += 1;
  }

  // 3) 끝 고유명 후보 + 동반 속성 태그(이 타입 sub-content 에서 구성·기존 헬퍼 재사용).
  const { candidateName, attributeTags } = buildCandidateAndAttributes(
    subContent,
    classification,
  );
  const trimmedName = candidateName.trim();
  if (!trimmedName) {
    result.hierarchyEdges += await linkAdjacentCategoryPairs(
      store,
      originNodeId,
      classification.categoryChain,
      provenance,
    );
    // 분류 단어·일반명사로 끝나 잎 고유명이 없다 — 행 안 만들고 정직한 경고만(거짓 엔티티 0).
    appendChainStopWarning(result, classification, candidateName);
    return;
  }

  // 구조 신호 가드(§6-B 단계2 D1·통로 대칭 I6) — 후보가 같은 글의 다른 콜론 태그 키로 다시
  // 쓰이는 사슬 중간 마디면 개념 폴더라 1급 행을 안 만든다(I2). 8타입 placeOneEntityType 이
  // shouldCreateEntityRow 게이트로 받는 isMidChainNode 신호를, 게이트를 안 거치는 새 종류
  // 통로(여기)는 같은 isMidChainNode 단일 출처를 직접 불러 적용한다(통로별 비대칭 차단).
  // chainEntriesOf 가 진입점에서 중간 마디를 이미 걸러 candidateName 이 보통 leaf 라 이 신호는
  // 방어적 이중 안전이다(회귀 0). 중간 마디면 행 0 + 정직한 경고(거짓 엔티티 0).
  if (isMidChainNode(trimmedName, content)) {
    result.hierarchyEdges += await linkAdjacentCategoryPairs(
      store,
      originNodeId,
      classification.categoryChain,
      provenance,
    );
    result.warnings.push(
      `'${trimmedName}' 은(는) 사슬 중간 마디(뒤에 콜론이 더 이어짐)라 개념 폴더로 두고 1급 행 안 만듦(I2)`,
    );
    return;
  }

  // 4) 범용 본체 행 생성 + 합성 텍스트 임베딩 적재. findOrCreateEntity 가 UNIQUE(type_name,name)
  //    로 같은 이름을 한 행에 모은다(멱등). 미등록 종류·빈 이름은 repo 가 loud throw.
  const entity = await store.entitiesRepo.findOrCreateEntity(userType, trimmedName);
  result.entityRowCreated = true;
  result.entityId = entity.id;
  (result.entities ??= []).push({ typeName: userType, id: entity.id });

  // 4.5) identity 통로 — 8 타입 placeOneEntityType(:999-1003)과 *대칭*으로 잎 개념·글→잎
  //   mention·user identity 엣지를 깐다(plan 2026-06-28 G1·RC1). 수정 전엔 이 통로가 없어
  //   entity_concept_edges=[] 였고, 그래서 graph-augment 의 identity 역조회(블록 1.5b)·승격
  //   (1.5c)이 user 행에 못 닿아 묶음 노드가 안 떴다. 셋을 8 타입 양식 그대로 깐다:
  //     ① 잎 개념(findOrCreateConcept·isClassificationValue) — 행 이름의 개념 노드. work 의
  //        정체성 키 분리(workLeafConceptName)는 user 종류엔 없어 행 이름을 그대로 잎 이름으로
  //        쓴다(8 타입 비-work 갈래와 같다 — leafName=createdRow.name).
  //     ② addNodeConceptEdge(originNodeId, 잎-개념, "classification") — 글→잎개념 mention.
  //        graph-augment 의 글↔개념 합류(블록 1)와 검색 도달 경로를 그대로 탄다.
  //     ③ user identity 엣지 — store.addEntityConceptEdge(userType, …, "identity") 를 *직접*
  //        부른다. linkEntityIdentity(entity-attribute-wiring)는 assertEntityType 으로 8 타입만
  //        통과하므로 안 부른다 — user 전용 진입점으로 8 타입 불변식(assertEntityType 무변경)을
  //        보존한다(plan "assertEntityType 안 넓힘"). entity_id 전역 UNIQUE 라 _typeName 은
  //        통합 테이블 조회에 안 쓰여 user string 도 같은 통로로 안전히 흐른다.
  //
  //   project 제외 — 이 헬퍼는 isUserEntityType(새 종류) *와* project 둘을 받지만(호출처
  //   entity-placement-wiring §12 D5 의 `isUserEntityType || project` 게이트), project 는
  //   identity 엣지를 *의도적으로 안 가진다*(entities 단일 모델·spec §11 D6 대안 A·
  //   hashtag-wiring 주석 "프로젝트는 project_id 칸·8 타입은 identity"). project 는
  //   project_id 칸 + project_concept_edges role='tag' 로 그래프에 합류하므로 여기서
  //   identity 를 깔면 그 단일 모델을 깨고 project 합류가 이중이 된다(특성 테스트가 잡는다).
  //   그래서 *새 종류일 때만* identity 통로를 깐다 — project 동작 무변경.
  if (store.entityTypeRegistryDb.isUserEntityType(userType)) {
    const leafConceptId = await store.findOrCreateConcept(trimmedName, {
      isClassificationValue: true,
    });
    if (originNodeId !== null) {
      await store.addNodeConceptEdge(
        originNodeId,
        leafConceptId,
        "classification",
        provenance,
        originNodeId,
      );
    }
    store.addEntityConceptEdge(
      userType,
      entity.id,
      leafConceptId,
      "identity",
      provenance,
      originNodeId,
    );
  }

  // (다) 게이트② 경고 — 깊이 상한·순환 도달 비정상 사슬은 행을 만들되 경고를 남긴다.
  if (classification.chainStop?.reason === "depth-or-cycle") {
    result.warnings.push(
      "사슬이 비정상으로 길거나 순환 — 결과가 의도와 다를 수 있음" +
        ` (추적 경로: ${classification.chainStop.visitedKeys.join(" → ")})`,
    );
  }

  // 6) 속성 = 칸/라벨 가름 저장(단계3 T8·D15). 관계 키·알 수 없는 키는 skip(정직한 경고).
  //    칸 어휘(columns slot·getTypeColumns)면 is_column=1(검색 합성 색인 포함·정렬·필터 1급),
  //    아니면 is_column=0 라벨(꼬리표). 칸 어휘 0개·기존 거동이면 전부 라벨(T4 byte 동일).
  const relationKeys = relationTagKeySet();
  // 칸 어휘를 소문자 Set 으로 한 번만 모은다(getCanonicalItemKey 정규화 키와 소문자 비교).
  const columnKeySet = new Set(getTypeColumns(typeName).map((k) => k.toLowerCase()));
  for (const tag of attributeTags) {
    const key = tag.key.trim();
    const value = tag.value.trim();
    if (!key) {
      result.warnings.push("속성 키가 비어 있어 라벨로 만들지 않음");
      continue;
    }
    if (!value) {
      result.warnings.push(`속성 '${key}' 값이 비어 있어 라벨로 만들지 않음(빈 값은 정보 아님)`);
      continue;
    }
    // 관계 키(창작자·주인 등)는 라벨이 아니다 — 관계 엣지(단계4/T7)가 전담하므로 skip.
    // 항목 동의어 정규화 전후 모두 막아 3분법 경계를 지킨다(applyEntityAttributes 양식 미러).
    const canonicalKey = getCanonicalItemKey(typeName, key);
    if (relationKeys.has(key) || relationKeys.has(canonicalKey)) {
      result.warnings.push(
        `속성 '${key}' 은(는) 관계 키라 라벨로 만들지 않음 — 새 종류 관계는 단계4 가 처리`,
      );
      continue;
    }
    // 칸 가름 — 원본 키 또는 정규화 키가 칸 어휘면 is_column=1(색인 합성·정렬·필터), 아니면
    // is_column=0 라벨. 칸 어휘는 화면 편집(columns slot)이 정하고, 라벨 어휘는 attributes
    // slot 이 정한다. 원본·정규화 둘 다 보는 이유: 칸 어휘 '구입일' 이 항목 동의어로 다른
    // 대표키('비고')에 묶이면 canonicalKey 가 '비고' 로 바뀌어 칸 판정을 빠져나가 라벨로
    // 강등된다. 바로 위 관계 키 검사(relationKeys.has(key) || relationKeys.has(canonicalKey))
    // 와 같은 규칙(원본·정규화 둘 다)으로 맞춰 칸 판정도 대칭이 되게 한다(3분법 경계 보존).
    const isColumn =
      columnKeySet.has(key.toLowerCase()) || columnKeySet.has(canonicalKey.toLowerCase());
    store.entitiesRepo.setAttribute(entity.id, key, value, isColumn);
    if (isColumn) result.columnsApplied += 1;
    else result.labelsApplied += 1;
  }

  // 5) 위계 잎 매달림 — 부모(단일 배치=타입 루트·다단계=마지막 분류 단 개념) → entities 행
  //    parent_of. 라벨 저장 뒤(임베딩 합성에 칸값이 들어가나 T4 는 칸 0 이라 순서 무관)
  //    임베딩을 적재한다. hierarchy_edges 는 다형 끝점이라 새 종류 string target 을 받는다.
  const isSinglePlacement =
    classification.subcategory === null &&
    (classification.categoryChain?.length ?? 0) === 0;
  const lastCategory = lastCategoryOf(classification);
  // 다단계 사슬의 *중간 마디* 부모 개념(부모와 자식을 둘 다 가진 분류 폴더)은 분류 키이자
  // 분류 값이다 — 8 타입 장소(`#병원:피부과` 의 '병원')가 wireGeneralClassification →
  // addClassificationTag 통로에서 k=1 v=1 로 등록되는 모습과 대칭으로 맞춘다(2026-06-27
  // 단계3 후속 결함 수정). project/새 종류 사슬은 그 통로가 consumedByEntity·projectChainConsumedKeys
  // 로 막혀 lastCategory 가 여기서만 등록되므로, 중간 마디일 때 isClassificationKey 도 켜야
  // 코딩·라이브2D 가 분류 키로 그려지고(representativeConceptType) 분류 종류 시각 구분에 든다.
  //
  // 판정 = isMidChainNode(lastCategory, content) — lastCategory 가 같은 글의 다른 콜론 태그의
  // 키(rawCategory)로도 쓰이면 그 뒤에 콜론이 더 이어지는 중간 마디다(부모·자식 둘 다 보유).
  // `#일정:장터당번` 처럼 단일 분류 잎의 부모('일정')는 다른 콜론 태그의 키로 안 쓰여 false 라
  // k 를 안 붙인다(단일 배치 잎 부모는 분류 키가 아님 — 전제 2). 끝 실체(잎)는 entity 행이라
  // 이 findOrCreateConcept 경로를 안 타므로 개념 키 부여 대상 자체가 아니다. isClassificationValue
  // 는 OR 누적이라(findOrCreateConcept MAX) 기존/신규 모두 v=1 을 유지한다(전제 1).
  const lastCategoryIsMidChain =
    !!lastCategory && isMidChainNode(lastCategory, content);
  const parentConceptId =
    isSinglePlacement || !lastCategory
      ? await ensureTypeRootConcept(store, userType)
      : await store.findOrCreateConcept(lastCategory, {
          isClassificationKey: lastCategoryIsMidChain,
          isClassificationValue: true,
        });
  store.addReducedHierarchyEdge({
    sourceType: "concept",
    sourceId: parentConceptId,
    targetType: userType,
    targetId: entity.id,
    provenance,
    sourceNodeId: originNodeId,
    weight: 0.9,
  });
  result.hierarchyEdges += 1;

  // 5-mid) 사슬 가운데 다리 — categoryChain 인접 쌍 전체를 placement 가 스스로 잇는다(8 타입
  //   placeOneEntityType 5-mid 와 대칭·통로 대칭 I6·spec §10 S1). user/project 통로도 같은 단일
  //   출처(linkAdjacentCategoryPairs)를 공유해 드리프트 0. project 사슬은 보조 통로 둘이 막혀
  //   가운데가 비었으므로 여기서 채운다(케이스 A·H). 멱등이라 통로 3 이 이미 만든 user 종류
  //   케이스(I)도 중복 0. categoryChain.length ≤ 1 이면 no-op.
  await linkAdjacentCategoryPairs(
    store,
    originNodeId,
    classification.categoryChain,
    provenance,
  );
  store.pruneHierarchyShortcutParentsOf({ type: userType, id: entity.id });

  // 합성 텍스트(이름 + ko_name + 칸값) 임베딩 적재 — 검색(T5)이 entities_vec KNN 으로 닿는다.
  await store.entitiesRepo.applyEmbedding(entity.id);
}
