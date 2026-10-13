/**
 * place-entity-type.ts — 신규 8 타입 한 선언 배치 본체(entity-placement-loop 에서 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만). 이 모듈은 placeOneEntityType — 한 선언을
 * 위계 → 행 게이트 → 칸/라벨/identity/별칭/관계로 배치하는 8 타입 전용 본체 — 만 담는다.
 * user 종류 대칭 통로는 place-user-entity-type.ts 에 있다.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import type { EntityTypeClassification } from "../entity-type-classifier.ts";
import { wireEntityRelations } from "../entity-relation-wiring.ts";
import {
  linkSubcategoryToTypeRoot,
  ensureTypeRootConcept,
  linkAdjacentCategoryPairs,
} from "../entity-hierarchy-wiring.ts";
import {
  applyEntityAttributes,
  linkEntityIdentity,
} from "../entity-attribute-wiring.ts";
import { parseHashtagEntities } from "../parsers/hashtag-entity-parser.ts";
import { personAliasWouldConsume } from "../alias-attribution.ts";
import { lookupRelationTag } from "../entity-relation-vocabulary.ts";
import {
  workLeafConceptName,
  workLeafOriginalAlias,
} from "../work-leaf-concept-key.ts";
import type { Provenance } from "../provenance-vocabulary.ts";
import { isMidChainNode } from "./chain-structure.ts";
import {
  isEntityType,
  buildCandidateAndAttributes,
  extractFirstAuthorValue,
  buildSameDocTypeHints,
  lastCategoryOf,
} from "./candidate-attributes.ts";
import {
  createRowForPlacement,
  registerAliasesFromAliasTags,
} from "./row-and-alias.ts";
import {
  appendChainStopWarning,
  type EntityPlacementResult,
} from "./placement-result.ts";

/**
 * 신규 8 타입 한 선언을 배치한다 — 위계 → 행 게이트 → 칸/라벨/identity/별칭/관계(P4-A2).
 *
 * 옛 wireEntityPlacement 의 2.5~6 단계를 그대로 한 헬퍼로 추출했다(동작 보존). 타입 그룹
 * 루프가 그룹·선언 값별로 만든 classification(그 값의 sub-content 를
 * classifyEntityTypeDeterministic 에 다시 태운 산출)으로 부른다. result 에 hierarchyEdges·
 * columnsApplied 등을 *누적*(+=)한다 — 여러 선언이 같은 result 에 합산된다. entityRowCreated·
 * entityId 는 행이 생긴 호출이 set 한다(마지막 생성 행이 entityId 에 남는다 — 호출처가 정렬).
 *
 * @param store          실제 SqliteMemoryStore.
 * @param originNodeId   글 노드 id.
 * @param content        글 원문 — 별칭·관계 wiring 이 같은 글에서 태그를 다시 본다.
 * @param classification 이 선언 값 하나의 분류 산출(explicit 사슬 결과).
 * @param subContent     이 선언 값의 sub-content — (나) 같은 분류 둘+ 검출에 쓴다(그룹 안 중복).
 * @param result         누적 결과 객체(이 함수가 += 로 더한다).
 */
export async function placeOneEntityType(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  classification: EntityTypeClassification,
  subContent: string,
  result: EntityPlacementResult,
  provenance: Provenance = originNodeId === null ? "user_input" : "hashtag",
): Promise<void> {
  const typeName = classification.typeName;
  if (typeName === null || !isEntityType(typeName)) return; // 8 타입만 — 방어(호출처가 이미 가름).

  // 2.5) 명시 타입 선언(explicit)일 때만 배치한다(spec §5 "태그 우선"). 씨앗/LLM 신호는
  //      input 시점 자동 배치를 안 한다(불변식 I1 — 위계 자가 증식 차단). 그룹 루프가 넘기는
  //      선언은 사용자 명시 콜론 태그라 보통 explicit 다 — 방어적으로 게이트를 그대로 둔다.
  if (classification.source !== "explicit") return;

  // 3) 위계 — subcategory(첫 분류 단)가 있으면 `타입 루트 → 첫 분류` parent_of 를 더한다.
  //    다단계 인접 쌍·잎은 글당 1회 wireGeneralClassification 이 콜론 태그에서 세운다(겹침 0).
  if (classification.subcategory) {
    await linkSubcategoryToTypeRoot(
      store,
      originNodeId,
      typeName,
      classification.subcategory,
      provenance,
    );
    result.hierarchyEdges += 1;
  }

  // 4) 끝 고유명 후보 + 동반 속성 태그 — sub-content 에서 구성(이 타입 속성만 담겼다).
  const { candidateName, attributeTags } = buildCandidateAndAttributes(
    subContent,
    classification,
  );

  // 행 게이트 — 결정 A·D + 구조 신호로 1급 행을 만들지 가른다. 분류 단어·중간 마디·모호는
  // null(행 X). work 만 정체성 키를 매체·작가로 넓힌다(P3-B3) — 게이트 판정
  // (shouldCreateEntityRow)을 재사용해 entity-row-gate.ts 의 판정 본체를 그대로 쓴다.
  // 구조 신호(isMidChainNode·§6-B 단계2) — candidateName 이 같은 글의 다른 콜론 태그 키로
  // 다시 쓰이는 사슬 중간 마디면 어휘 무관하게 행 0(I2). 콜론 통로는 chainEntriesOf 가 이미
  // 중간 마디를 진입점에서 걸러 leaf 만 후보로 오므로 이 신호는 방어적 이중 안전이다.
  const createdRow = await createRowForPlacement(
    store,
    typeName,
    candidateName,
    classification,
    attributeTags.length > 0,
    content,
    isMidChainNode(candidateName, content),
  );

  if (!createdRow) {
    result.hierarchyEdges += await linkAdjacentCategoryPairs(
      store,
      originNodeId,
      classification.categoryChain,
      provenance,
    );
    // 행을 안 만든 건 결정 A·B 상 정직한 결과(거짓 엔티티 방지) — (다) 게이트 경고만 남긴다.
    appendChainStopWarning(result, classification, candidateName);
    return;
  }

  result.entityRowCreated = true;
  result.entityId = createdRow.id;
  (result.entities ??= []).push({ typeName, id: createdRow.id });

  // (다) 게이트② 경고 — 깊이 상한·순환 도달로 멈춘 자리 값을 candidateName 으로 쓴 비정상
  // 사슬은 행을 만들되 "결과가 의도와 다를 수 있음" 경고를 남긴다(spec §7-(다)).
  if (classification.chainStop?.reason === "depth-or-cycle") {
    result.warnings.push(
      "사슬이 비정상으로 길거나 순환 — 결과가 의도와 다를 수 있음" +
        ` (추적 경로: ${classification.chainStop.visitedKeys.join(" → ")})`,
    );
  }

  // 5) 칸/라벨 — 속성 태그를 §3 3분법으로 전용 칸·라벨 엣지에 채운다(이 타입 속성만).
  if (attributeTags.length > 0) {
    const applied = await applyEntityAttributes(
      store,
      typeName,
      createdRow.id,
      attributeTags,
      provenance,
      originNodeId,
    );
    result.columnsApplied += applied.columnKeys.length;
    result.labelsApplied += applied.labelConceptIds.length;
    for (const s of applied.skipped) {
      if (lookupRelationTag(s.key) !== null) continue;
      result.warnings.push(`속성 '${s.key}' 건너뜀 — ${s.reason}`);
    }
  }

  // 5-L1) 엔티티 행을 위계 잎으로 직접 잇기(S2-T1·위계 단일 출처 spec §2·§5.2). 부모는
  //    단일 배치면 타입 루트, 다단계면 사슬 마지막 분류 단. 그림자 잎 개념·identity·mention
  //    은 검색 JOIN 키·글 도달 경로라 유지하되 위계 잎 역할은 엔티티 행이 직접 진다.
  const isSinglePlacement =
    classification.subcategory === null &&
    (classification.categoryChain?.length ?? 0) === 0;
  const lastCategory = lastCategoryOf(classification);
  const parentConceptId =
    isSinglePlacement || !lastCategory
      ? await ensureTypeRootConcept(store, typeName)
      : await store.findOrCreateConcept(lastCategory, {
          isClassificationValue: true,
        });

  // 잎 개념 이름 — work 는 정체성 키(매체·작가)로 갈라 동명 work 가 한 개념을 공유하는
  // 표시 엉킴을 막는다(P3-leaf). medium·author 는 createRowForPlacement 가 work 행을 만들 때
  // 쓴 값과 *같은 출처*(medium=classification.subcategory·author=extractFirstAuthorValue(content))
  // 를 재사용해 행과 잎 개념이 한 키로 일관된다(중복 추출 0·드리프트 0). 다른 8 타입은
  // 기존 이름 그대로(무변).
  const leafName =
    typeName === "work"
      ? workLeafConceptName(
          createdRow.name,
          classification.subcategory ?? undefined,
          extractFirstAuthorValue(content),
        )
      : createdRow.name;
  const leafConceptId = await store.findOrCreateConcept(leafName, {
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
  linkEntityIdentity(
    store,
    typeName,
    createdRow.id,
    leafConceptId,
    provenance,
    originNodeId,
  );

  // 잎 이름이 분리됐으면(원래 이름과 다르면) 원래 이름을 별칭으로 더한다 — 개념 채널이
  // "괴담" 으로도 그 분리 개념에 닿게 한다(검색 보강·E2 addConceptAlias 합집합·멱등).
  if (typeName === "work" && leafName !== createdRow.name) {
    await store.addConceptAlias(
      leafConceptId,
      workLeafOriginalAlias(createdRow.name),
    );
  }

  // 그림자 잎 개념이 받은 위계 엣지를 뗀다(멱등 no-op 가능). 위계 잎 역할만 종료.
  store.removeHierarchyEdge("concept", parentConceptId, "concept", leafConceptId);

  // 부모 → 엔티티 행 parent_of 위계 엣지. reduced API 로 상위 지름길 직통을 저장하지 않는다.
  store.addReducedHierarchyEdge({
    sourceType: "concept",
    sourceId: parentConceptId,
    targetType: typeName,
    targetId: createdRow.id,
    provenance,
    sourceNodeId: originNodeId,
    weight: 0.9,
  });
  result.hierarchyEdges += 1;

  // 5-mid) 사슬 가운데 다리 — categoryChain 인접 쌍 전체(`categoryChain[i] → categoryChain[i+1]`)를
  //   placement 가 스스로 잇는다(2026-06-28 가운데 다리 누락 수정 spec §9 (나)·§10 S1·I6 통로 대칭).
  //   양 끝 두 토막(타입 루트 → 첫 분류·마지막 분류 → 끝-실체 행)은 위에서 이미 세웠고, 가운데
  //   인접 쌍은 보조 통로(일반 분류·라벨 위계)가 project 사슬에서 함께 막혀 비어 있었다(케이스 A·H).
  //   멱등(addClassificationTag INSERT OR IGNORE·ON CONFLICT MAX)이라 통로 2/3 이 이미 만든
  //   place·creature 케이스에서도 중복 0(위계 byte 동일). 끝-실체 행 생성 이후라 순서 무관.
  //   categoryChain.length ≤ 1 이면 헬퍼가 no-op(단독·2단 회귀 0).
  await linkAdjacentCategoryPairs(
    store,
    originNodeId,
    classification.categoryChain,
    provenance,
  );
  store.pruneHierarchyShortcutParentsOf({ type: typeName, id: createdRow.id });

  // 5.5) 엔티티 별칭 등록 — `#별명:`/`#닉네임:` 콜론 태그 값을 ko_aliases 에 합집합으로 더한다.
  //      §14.3 ③ 귀속 경계 — 같은 글에 주 사람 엔티티도 있으면 별칭이 모호해 어디에도 안 붙이고
  //      경고만 남긴다. personAliasWouldConsume 가 사람 통로 게이트와 같은 규칙으로 판정한다.
  const aliasCount = parseHashtagEntities(content).aliases.length;
  if (await personAliasWouldConsume(store, content)) {
    if (aliasCount > 0) {
      result.warnings.push(
        "별칭 귀속 모호 — 한 글에 사람과 엔티티가 함께 있어 #별칭: 을 어디에도 안 붙임" +
          " (#사람: 만 또는 엔티티 사슬만 있는 글에 적어 주세요)",
      );
    }
  } else if (aliasCount > 0 && typeName !== "work") {
    result.warnings.push(
      "별칭 미반영 — 별칭은 사람·작품·프로젝트에만 사용할 수 있음",
    );
  } else {
    await registerAliasesFromAliasTags(store, typeName, createdRow.id, content);
  }

  // 6) 관계 엣지(4단계 Task 4) — source 행이 생겼을 때만 같은 글의 관계 태그를 target 행으로
  //    잇는다. sameDocTypeHints 는 글 원문에서 모은다(같은 글의 다른 타입 선언도 힌트가 된다).
  //    멱등이라 같은 글의 여러 선언이 같은 관계를 만들어도 created 에 새 것만 누적된다.
  const sameDocTypeHints = buildSameDocTypeHints(content);
  const relations = await wireEntityRelations(store, {
    originNodeId,
    sourceType: typeName,
    sourceId: createdRow.id,
    content,
    provenance,
    sameDocTypeHints,
  });
  for (const e of relations.created) result.relationEdges.push(e);
  for (const w of relations.warnings) result.warnings.push(`관계 ${w}`);
}
