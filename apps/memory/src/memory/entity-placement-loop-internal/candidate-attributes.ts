/**
 * candidate-attributes.ts — 끝 고유명 후보·속성 태그·타입 힌트 추출(entity-placement-loop
 * 에서 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만). 이 모듈은 분류 산출(EntityTypeClassification)
 * 과 글 원문에서 배치 재료를 뽑는 함수를 모은다:
 *   - isEntityType — 신규 8 타입 판정(registry 단일 출처 파생).
 *   - extractCandidateName·extractTypeTagKey — matched 에서 끝 값·머리 키 추출.
 *   - buildCandidateAndAttributes — 끝 고유명 후보 + 동반 속성 태그 구성.
 *   - extractFirstAuthorValue — 작가 관계 태그 첫 값(work 정체성 키 축).
 *   - lastCategoryOf·detectSameSubcategoryExtras — 마지막 분류 단·같은 분류 둘+ 검출.
 *   - buildSameDocTypeHints — 같은 글의 명시 타입 태그 (값 → 타입) 힌트.
 *   - buildTypeAttributeKeys — 한 타입의 속성 어휘 키 집합(sub-content 분리용).
 */

import {
  typeForIndicatorKey,
  type EntityTypeClassification,
} from "../entity-type-classifier.ts";
import { subcategoryToTypeMap } from "../concept-type-vocabulary.ts";
import { type SameDocTypeHint } from "../entity-relation-target.ts";
import {
  getTypeAttributes,
  getItemSynonymAliasesForType,
  type PlacementTypeName,
} from "../concept-type-vocabulary.ts";
import { lookupRelationTag } from "../entity-relation-vocabulary.ts";
import { type EntityAttributeTag } from "../entity-attribute-wiring.ts";
import { parseClassificationTags } from "../parsers/classification-tag.ts";
import {
  getEntityTypeMeta,
  ENTITY_TYPE_NAMES,
  type EntityTypeName,
} from "../../db/store-internal/entity-type-registry.ts";

/**
 * person/project 를 배치에서 제외하는 판정 — 신규 8 타입 이름 목록은 registry 단일 출처
 * (ENTITY_TYPE_NAMES, ENTITY_TYPE_METAS 순서 파생)에서 읽는다(손 재구현 금지·드리프트 0).
 */
export function isEntityType(t: PlacementTypeName): t is EntityTypeName {
  return (ENTITY_TYPE_NAMES as readonly string[]).includes(t);
}

/** classification.matched(`rawCategory:value`)에서 타입 선언 태그의 끝 값을 뽑는다. */
export function extractCandidateName(
  classification: EntityTypeClassification,
): string {
  const matched = classification.matched;
  if (!matched) return "";
  const colon = matched.indexOf(":");
  if (colon < 0) return "";
  return matched.slice(colon + 1).trim();
}

/** classification.matched(`rawCategory:value`)에서 타입 선언 태그의 키(rawCategory)를 뽑는다. */
function extractTypeTagKey(classification: EntityTypeClassification): string {
  const matched = classification.matched;
  if (!matched) return "";
  const colon = matched.indexOf(":");
  if (colon < 0) return "";
  return matched.slice(0, colon).trim().toLowerCase();
}

/**
 * 끝 고유명 후보와 동반 속성 태그를 글에서 구성한다(새 파서 0 — parseClassificationTags 재사용).
 *
 *  - 후보 이름: explicit 분류일 때만 의미가 있다 — classifier 가 돌려준 matched 의 값(데못죽).
 *    seed/llm 은 본문 단어나 LLM 판정이라 끝 고유명 후보가 없다(빈 문자열).
 *  - 속성 태그: 글의 모든 `#키:값` 중 *타입 선언 사슬에 속하지 않는* 나머지. 타입 선언 사슬은
 *    두 갈래로 제외한다:
 *      ① leaf 선언 키 — classifier 의 matched(`rawCategory:value`)에서 뽑은 머리 키. 사슬
 *         끝 마디의 키(`#가계부:배달 #배달:돈까스` 면 '배달', 단일 `#작품:데못죽` 이면 '작품').
 *         한 번만 제외한다(같은 키가 여러 번이면 첫 등장만).
 *      ② 사슬 중간 마디 키 — 그 태그의 *값* 이 같은 sub-content 안 다른 콜론 태그의 *키*
 *         (rawCategory)로 이어지면 그 태그는 타입 선언 사슬의 한 마디다(`#가계부:배달` 의
 *         '배달' 이 `#배달:` 의 키 → '가계부' 는 사슬 머리). 그 마디 키도 속성이 아니라 타입
 *         선언이라 제외한다. 이 제외가 없으면 다단 사슬의 머리 키(`가계부:배달`)가 속성으로
 *         떨어져 user 종류 통로(칸/라벨 직접 가름)에서 `가계부→배달` 라벨 누수가 난다
 *         (plan 2026-06-28 G5 문제1b). 8 타입은 머리 키가 타입 지시 키라 applyEntityAttributes
 *         가 칸/라벨로 안 받아 *원래도* 누수가 없었다 — 이 제외는 그 키를 아예 후보 목록에서
 *         빼므로 8 타입 결과는 무변(걸러지던 것이 안 들어올 뿐)이고 user 통로만 누수가 막힌다.
 *    이렇게 해야 `#작품:데못죽 #장르:판타지` 에서 장르만 속성으로, 데못죽은 후보로 갈린다.
 */
export function buildCandidateAndAttributes(
  content: string,
  classification: EntityTypeClassification,
): { candidateName: string; attributeTags: EntityAttributeTag[] } {
  const candidateName =
    classification.source === "explicit"
      ? extractCandidateName(classification)
      : "";

  const typeTagKey = extractTypeTagKey(classification);
  const tags = parseClassificationTags(content ?? "");

  // ② 사슬 중간 마디 키 집합(소문자) — 그 값이 같은 sub-content 안 다른 태그의 키로 이어지는
  //    태그의 키를 모은다. isMidChainNode 와 같은 구조 판정(값→다음 키 연결)을 sub-content
  //    범위에서 본다(단일 출처·parseClassificationTags). leaf(matched 값)는 다음 키로 안
  //    이어져 여기 안 들어온다 — leaf 키는 ①(typeTagKey)이 제외한다.
  const tagKeys = new Set<string>();
  for (const tag of tags) {
    const k = tag.rawCategory.trim().toLowerCase();
    if (k) tagKeys.add(k);
  }
  const midChainKeys = new Set<string>();
  for (const tag of tags) {
    const nextKey = tag.value.trim().toLowerCase();
    if (nextKey && tagKeys.has(nextKey)) {
      midChainKeys.add(tag.rawCategory.trim().toLowerCase());
    }
  }

  const attributeTags: EntityAttributeTag[] = [];
  let typeTagExcluded = false;
  for (const tag of tags) {
    const lowerKey = tag.rawCategory.trim().toLowerCase();
    if (!typeTagExcluded && typeTagKey && lowerKey === typeTagKey) {
      // ① leaf 선언 태그(#작품:데못죽·#배달:돈까스)는 속성이 아니라 후보다 — 한 번만 제외.
      typeTagExcluded = true;
      continue;
    }
    if (midChainKeys.has(lowerKey)) {
      // ② 사슬 중간 마디 키(#가계부:배달 의 '가계부') — 타입 선언 사슬이라 속성 아님.
      continue;
    }
    attributeTags.push({ key: tag.rawCategory, value: tag.value });
  }
  return { candidateName, attributeTags };
}

/**
 * 같은 글의 작가 관계 태그(`#작가:`·`#창작자:` 등) 값 중 첫째를 뽑는다 — work 정체성 키의
 * created_by 축(P3-B3). 관계 키 식별은 entity-relation-vocabulary 단일 출처를 재사용한다
 * (lookupRelationTag·relation === 'created_by') — 키 어휘를 이 파일에 하드코딩하지 않는다.
 *
 * 같은 글의 관계 wiring(6단·wireEntityRelations)도 같은 키를 created_by *관계 엣지*로 잇는다.
 * works.created_by *칸*(정체성 스냅샷)과 entity_relation_edges(관계 그래프)는 용도가 다른
 * 별개 저장이라(spec §0.1 R1) 둘 다 채우는 게 맞다 — 같은 어휘 단일 출처를 양쪽이 보므로
 * 작가 값이 일관된다(이중 처리 0 — 다른 산출이다).
 *
 * 작가 값이 여럿이면(드문 케이스) 첫째만 정체성 스냅샷으로 넘긴다(정직). 작가 태그가 없으면
 * undefined — findOrCreateEntity("work", …) 가 NULL 경로로 떨어진다(Q3-1 동명 같은 행).
 */
export function extractFirstAuthorValue(content: string): string | undefined {
  for (const tag of parseClassificationTags(content ?? "")) {
    const spec = lookupRelationTag(tag.rawCategory);
    if (spec?.relation !== "created_by") continue;
    const value = tag.value.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * 사슬이 거쳐 온 *마지막 분류 단*을 돌려준다(2026-06-13 어휘 독립 다단계 위계 §7).
 *
 * (나) 같은 분류 둘+ 경고가 다단계 사슬에서 *어느 분류 단* 기준인지를 정한다 — 사용자
 * 확정은 마지막 분류 단(categoryChain[last]). candidateName 이 그 아래에서 나오므로 의미
 * 정합이다. categoryChain 이 비었거나 미설정이면(단일 태그·seed/llm 단) subcategory(=첫
 * 분류 단·하위 호환)로 떨어진다 — 6/11 단일 태그 동작과 동치(회귀 0).
 */
export function lastCategoryOf(
  classification: EntityTypeClassification,
): string | null {
  const chain = classification.categoryChain;
  if (chain && chain.length > 0) return chain[chain.length - 1]!;
  return classification.subcategory;
}

/**
 * (나) 같은 분류 둘+ 검출(2026-06-12 콜론 사슬 자동 배치 C6 옵션 A·순수 함수).
 *
 * 받은 분류 키(category)와 같은 키를 가진 콜론 태그가 한 글에 둘 이상이면 둘째+ 의 값을
 * 모은다(`#소설:A #소설:B` → ["B"]). 다단계 사슬에서는 호출처가 *마지막 분류 단*을 넘긴다
 * (2026-06-13 §7 — `#피부과:한빛의원 #피부과:서울의원` → ["서울의원"]).
 * classifyEntityTypeDeterministic 은 글당 한 배치라 첫 고유명만 candidateName 이 돼 행은
 * 자연히 첫째만 생긴다 — 이 검출은 둘째+ 의 누락을 경고로 알리는 용도다(silent 차단).
 * 옵션 B(각각 엔티티)는 별도 spec(§10).
 *
 * 첫째 값(=candidateName 출처)은 경고에서 제외한다 — "둘째부터 미반영"이 핵심. 분류 키가
 * 없으면(분류 키 없이 멈춤) 같은 분류 둘+ 개념이 성립 안 하니 빈 배열.
 */
export function detectSameSubcategoryExtras(
  content: string,
  category: string | null,
): string[] {
  if (!category) return [];
  const subKey = category.trim().toLowerCase();
  if (!subKey) return [];

  const valuesUnderSub: string[] = [];
  for (const tag of parseClassificationTags(content ?? "")) {
    if (tag.rawCategory.trim().toLowerCase() === subKey) {
      const v = tag.value.trim();
      if (v) valuesUnderSub.push(v);
    }
  }
  // 첫째(첫 등장 = candidateName 출처)를 빼고 둘째+ 만 둘 이상일 때 반환.
  if (valuesUnderSub.length < 2) return [];
  return valuesUnderSub.slice(1);
}

/**
 * 같은 글의 명시 타입 태그(`#작품:데못죽`)에서 (값 → 타입) 힌트를 모은다 — 관계 wiring 의
 * sameDocTypeHints 로 넘긴다(Task 4). target 타입이 여럿 가능한 사용자 관계에서 같은 글의
 * 명시 타입 선언으로 가르기에 쓴다.
 *
 * 어느 키가 "타입 선언"인지는 classifier 1단과 *같은 규칙*으로 가른다(드리프트 차단):
 *  - 타입 지시 키(작품·생물 등 — typeForIndicatorKey, typeIndicatorMap 단일 출처) → 그 타입.
 *  - 분류 진입 키(동물·소설 등 — subcategoryToTypeMap) → 그 키가 속한 타입.
 * 둘 다 아니면 타입 선언이 아니라 힌트로 안 모은다(관계 키·속성 키·일반 분류는 제외). 빈
 * 값은 parseClassificationTags 가 이미 거른다. rawCategory 로 매칭한다(category 동의어
 * 정규화(작품→series) 우회 — classifier·타입 배치와 같은 규칙).
 */
export function buildSameDocTypeHints(content: string): SameDocTypeHint[] {
  const subcatMap = subcategoryToTypeMap();
  const hints: SameDocTypeHint[] = [];
  for (const tag of parseClassificationTags(content ?? "")) {
    const value = tag.value.trim();
    if (!value) continue;
    const typeHit = typeForIndicatorKey(tag.rawCategory);
    if (typeHit) {
      hints.push({ value, type: typeHit });
      continue;
    }
    const subHit = subcatMap.get(tag.rawCategory.trim().toLowerCase());
    if (subHit) hints.push({ value, type: subHit });
  }
  return hints;
}

/**
 * 한 타입 그룹의 한 선언 값을 위한 sub-content 를 재조립한다(P4-A2 속성 귀속 경계 Q4-1).
 *
 * 타입별 배치 루프가 그룹의 declValue 마다 placeOneEntityType 을 돌린다. 분류기를 그 값
 * 하나에 다시 태우려면 *그 선언 한 줄 + 그 타입에 귀속되는 속성 태그만* 담은 글 조각이
 * 필요하다. 그래야 `#직업:`(person 라벨)이 work 그룹 sub-content 에 안 섞여 work 행에
 * 라벨로 새지 않는다(속성 귀속 경계).
 *
 *  - declTag       — 이 선언 한 줄(`#작품:데못죽`). rawCategory·value 그대로 `#키:값` 으로.
 *  - 속성 태그     — 글의 다른 `#키:값` 중 *이 타입의 속성 어휘*(getTypeAttributes(type) ∪
 *                    getEntityTypeMeta(type).columnLabels 키)에 드는 것만. person/project 는
 *                    8 타입 칸/라벨 어휘가 없어 속성 합류 0(선언 줄만) — 사람 속성은 입력
 *                    통로 wireHashtagEntities 가 전담한다(역할 경계).
 *
 * rawCategory(소문자)로 어휘를 비교한다(applyEntityAttributes·wireGeneralClassification 과
 * 같은 규칙). 다단계 사슬 선언(`#장소:병원 #병원:피부과 #피부과:한빛의원`)은 declTag 한 줄로
 * 다 안 담기므로 사슬 글은 그룹 단일 값일 때 *원문 그대로* 넘긴다(아래 호출처에서 가른다).
 */
export function buildTypeAttributeKeys(type: PlacementTypeName): Set<string> {
  const keys = new Set<string>();
  if (!isEntityType(type)) return keys; // person/project 는 8 타입 속성 어휘 없음.
  const meta = getEntityTypeMeta(type);
  for (const k of getTypeAttributes(type)) keys.add(k.toLowerCase());
  for (const k of Object.keys(meta.columnLabels)) keys.add(k.toLowerCase());
  // 항목 동의어 펼침(단계2) — 대표키가 이 타입 속성 어휘(라벨·칸)에 들면 그 동의어 키도
  // 속성으로 인식한다. `#닉네임:값` 의 '닉네임' 이 '별명' 동의어이고 '별명' 이 라벨이면
  // '닉네임' 도 이 타입 속성으로 떨어져 서브콘텐츠 분리에서 안 새 나간다(applyEntityAttributes
  // 정규화와 한 출처를 본다 — 미등록 동의어면 펼침 0).
  for (const [aliasLower, canonical] of getItemSynonymAliasesForType(type)) {
    if (keys.has(canonical.toLowerCase())) keys.add(aliasLower);
  }
  return keys;
}
