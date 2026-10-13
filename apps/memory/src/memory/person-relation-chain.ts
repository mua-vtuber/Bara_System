/**
 * person-relation-chain.ts — 관계 콜론 사슬 독립 추적기(2026-06-14 사람-역할 위계 Task 1).
 *
 * 큰 그림: 사용자가 `#사람:성춘향 #관계:가족 #가족:엄마` 처럼 속성을 *따로* 적으면(한 줄로
 * 이어진 콜론 사슬이 아님) 그래프는 사람 > 가족 > 엄마 > 성춘향 4단 위계로 보여야 한다.
 * 그런데 기존 traceColonChain 은 *첫 매치 사슬 하나*만 따라가 `#사람:성춘향` 에서 멈추고,
 * `#관계:가족 #가족:엄마` 는 떨어져 나간다. Approach A(확정): traceColonChain 을 건드리지
 * 않고 *옆에* 관계 전용 추적기를 새로 둔다(장소·생물 콜론 사슬 회귀 0).
 *
 * 이 모듈의 책임(Task 1 한정): `#사람:X` 선언과 *독립적으로*, 글의 관계/친족 콜론 사슬에서
 * 끝 분류 잎(엄마)과 그 잎이 거쳐 온 분류 단(가족)을 사슬 하나당 한 항목으로 뽑는다.
 * Task 2 가 이 위에 모호 검출을, Task 3 가 wirePersonHierarchy 합류를 얹는다. 여기서는
 * 사슬만 만든다.
 *
 * 관계 사슬을 *어휘 단일 출처*로 알아본다(키 하드코딩 0):
 *  - 관계 지붕(roof): person 타입 지시 키 중 *사람 표시 이름(koNameOf("person")) 이 아닌* 것.
 *    person synonyms 는 [사람, 인물, 관계] 인데, `사람` 은 사람 *선언* 지붕(값이 사람 이름)이라
 *    제외하고 `관계`·`인물` 만 관계 지붕으로 본다. 그래서 `#사람:성춘향` 는 사슬이 아니다(선언).
 *  - 관계/친족 분류 키: lookupRelationTag 가 family_of/friend_of 를 주는 키(가족·친구). 지붕
 *    없이 `#가족:엄마` 로 바로 시작하는 사슬도 잡는다.
 *
 * 사슬 한 걸음은 traceColonChain 과 *같은 구조 규칙*으로 가른다: 시작 태그의 value 를 키로
 * 하는 다음 콜론 태그가 같은 글에 있으면 value 는 분류 단(category)이고 그 다음 태그의 value
 * 가 잎(leaf)이다. 다음 태그가 없으면 value 자체가 잎이고 category 는 null(E3).
 *
 * 순수 함수 — DB·임베딩·LLM·네트워크 0. parseClassificationTags 산출을 입력으로 받는다
 * (새 콜론 파서 발명 금지). silent fallback 금지 — 관계 사슬이 없으면 정직히 빈 배열을
 * 돌려준다(빈 배열 ≠ 실패. 사람 선언만 있는 글의 올바른 답이다).
 */

import type { parseClassificationTags } from "./parsers/classification-tag.ts";
import {
  typeForIndicatorKey,
  koNameOf,
} from "./entity-type-classifier.ts";
import { lookupRelationTag } from "./entity-relation-vocabulary.ts";

/**
 * 관계 콜론 사슬 한 줄의 추출 결과.
 *
 *  - roof     사슬을 연 지붕 키 그대로(예 "관계"·"가족"). 사용자가 적은 rawCategory.
 *  - category 잎까지 거쳐 온 중간 분류 단(예 "가족"). 지붕에서 잎으로 바로 떨어지면 null(E3).
 *  - leaf     사슬 끝 분류 잎(예 "엄마"·"막내동생"). 어휘에 없는 호칭도 잎으로 잡는다.
 */
export interface RelationChain {
  roof: string;
  category: string | null;
  leaf: string;
}

type ParsedTags = ReturnType<typeof parseClassificationTags>;

/** 콜론 사슬 깊이 상한 — 순환·과길이 방어(traceColonChain 의 6 과 같은 정신). */
const RELATION_CHAIN_MAX_DEPTH = 6;

/**
 * rawCategory 가 *관계 지붕*인지 — person 타입 지시 키이되 사람 *선언* 지붕(사람 표시 이름)이
 * 아닌 것. person synonyms [사람, 인물, 관계] 중 koNameOf("person")("사람") 만 선언 지붕이라
 * 빼고, 나머지(관계·인물)를 관계 지붕으로 본다. 키를 하드코딩하지 않고 어휘 맵에서 끌어온다.
 */
function isRelationRoofKey(rawCategory: string): boolean {
  const key = (rawCategory ?? "").trim();
  if (!key) return false;
  if (typeForIndicatorKey(key) !== "person") return false;
  // 사람 선언 지붕(`#사람:성춘향`)은 관계 사슬이 아니다 — 값이 사람 이름이라 제외한다.
  return key.toLowerCase() !== koNameOf("person").toLowerCase();
}

/**
 * rawCategory 가 *관계/친족 분류 키*(가족·친구)인지 — lookupRelationTag 가 사람↔사람 관계
 * (family_of/friend_of)를 주는 키. 지붕 없이 `#가족:엄마` 로 바로 시작하는 사슬을 잡는다.
 */
function isRelationCategoryKey(rawCategory: string): boolean {
  const spec = lookupRelationTag((rawCategory ?? "").trim());
  return (
    !!spec &&
    (spec.relation === "family_of" || spec.relation === "friend_of")
  );
}

/**
 * 한 시작 태그에서 사슬을 끝 잎까지 따라가 RelationChain 으로 만든다.
 *
 * traceColonChain 과 같은 구조 규칙: value 를 키로 하는 다음 콜론 태그가 있으면 value 는
 * 분류 단(category), 다음 태그로 한 걸음 내려가고 그 끝 value 가 잎이다. 다음 태그가 없으면
 * value 자체가 잎이고 category 는 null. 거쳐 온 분류 단이 둘 이상이면 *마지막* 단을 category
 * 로 둔다(잎 바로 위 단 = 그 잎의 직접 분류). 방문 키 Set·깊이 상한으로 순환·과길이를 막는다.
 *
 * @param startTag 사슬 시작 태그(roof 가 될 태그).
 * @param byKey    rawCategory(소문자) → 태그 빠른 조회 맵.
 */
function traceOneRelationChain(
  startTag: ParsedTags[number],
  byKey: Map<string, ParsedTags[number]>,
): RelationChain {
  const roof = startTag.rawCategory;
  const visited = new Set<string>([roof.trim().toLowerCase()]);
  let current = startTag;
  let category: string | null = null;
  let depth = 1;

  for (;;) {
    const nextKey = current.value.trim().toLowerCase();
    const next = nextKey ? byKey.get(nextKey) : undefined;

    // 다음 태그 없음 — current.value 가 잎이다(중간 분류 단이 있었으면 category 에 이미 들어 있다).
    if (!next) {
      return { roof, category, leaf: current.value };
    }
    // 순환·깊이 상한 — current.value 를 마지막 분류 단으로 두고 멈춘다(잎 = 그 다음 태그 값).
    if (visited.has(nextKey) || depth >= RELATION_CHAIN_MAX_DEPTH) {
      return { roof, category: current.value, leaf: next.value };
    }
    // 분류 단으로 통과 — current.value 가 잎 위 분류 단. 한 걸음 내려간다.
    category = current.value;
    visited.add(nextKey);
    current = next;
    depth += 1;
  }
}

/**
 * 글의 파싱된 콜론 태그에서 관계 콜론 사슬을 *전부* 뽑는다(`#사람:X` 선언과 독립).
 *
 * 시작 태그 = 관계 지붕(관계·인물) 또는 관계/친족 분류 키(가족·친구). 각 시작 태그마다
 * 끝 잎까지 사슬을 따라간다. 같은 글의 독립 사슬 여럿이면 항목 여럿을 돌려준다. 시작 태그가
 * 없으면(사람 선언만·관계 태그 0) 빈 배열을 정직히 돌려준다.
 *
 * 중간 단으로 *소비된* 태그(예 `#가족:엄마` 의 `#가족`)는 다시 시작 태그로 잡지 않는다 —
 * 그러지 않으면 `#관계:가족 #가족:엄마` 가 사슬 2개(관계→가족→엄마, 가족→엄마)로 중복된다.
 * 분류 키(가족) 가 다른 사슬의 분류 단으로 이미 쓰였으면 그 키에서 새 사슬을 열지 않는다.
 */
export function extractRelationChains(tags: ParsedTags): RelationChain[] {
  if (!tags.length) return [];

  // rawCategory(소문자) → 태그 조회 맵. 같은 키가 여러 번이면 첫 태그를 쓴다(parseTags 순서).
  const byKey = new Map<string, ParsedTags[number]>();
  for (const t of tags) {
    const k = t.rawCategory.trim().toLowerCase();
    if (!byKey.has(k)) byKey.set(k, t);
  }

  const chains: RelationChain[] = [];
  // 다른 사슬의 *중간 분류 단*으로 소비된 키 — 거기서 새 사슬을 열지 않는다(중복 0).
  const consumedAsCategory = new Set<string>();

  for (const tag of tags) {
    const key = tag.rawCategory.trim().toLowerCase();
    // 이미 다른 사슬의 분류 단으로 쓰인 키면 새 사슬을 열지 않는다.
    if (consumedAsCategory.has(key)) continue;
    // 관계 지붕(관계·인물) 또는 관계/친족 분류 키(가족·친구)에서만 사슬을 연다.
    if (!isRelationRoofKey(tag.rawCategory) && !isRelationCategoryKey(tag.rawCategory)) {
      continue;
    }
    const chain = traceOneRelationChain(tag, byKey);
    chains.push(chain);
    // 사슬이 거쳐 온 분류 단(category)이 있으면 그 키를 소비 처리한다.
    if (chain.category) consumedAsCategory.add(chain.category.trim().toLowerCase());
  }

  return chains;
}

/**
 * 글의 파싱된 콜론 태그에서 `#사람:X` *선언*의 사람 표시 이름만 뽑는다(Task 2).
 *
 * 사람 선언 = isRelationRoofKey 의 정확한 역(逆). person 타입 지시 키이되 *사람 선언 지붕*
 * (koNameOf("person") = "사람")인 태그 — 값이 사람 이름이다. 관계 지붕(관계·인물)이나
 * 친족 분류 키(가족·친구)는 값이 분류·잎이라 사람 이름이 아니다(여기서 제외).
 *
 * 키를 하드코딩하지 않고 어휘 맵(typeForIndicatorKey·koNameOf)에서 끌어온다 — Task 1 의
 * isRelationRoofKey 와 같은 어휘 출처를 쓴다. 적힌 순서대로 이름을 돌려준다(중복도 그대로 —
 * 둘 이상 여부 판정은 호출 쪽 decidePersonAttachment 의 몫). 사람 선언이 없으면 빈 배열.
 */
export function extractPersonDeclarations(tags: ParsedTags): string[] {
  if (!tags.length) return [];
  const personKey = koNameOf("person").toLowerCase();
  const names: string[] = [];
  for (const tag of tags) {
    const key = tag.rawCategory.trim().toLowerCase();
    if (typeForIndicatorKey(key) !== "person") continue;
    // 사람 *선언* 지붕(`#사람:성춘향`)만 — 관계 지붕(관계·인물)은 값이 사람 이름이 아니라 제외.
    if (key !== personKey) continue;
    const name = tag.value.trim();
    if (name) names.push(name);
  }
  return names;
}

/** 사람-역할 1대1 매달기 결정 결과(Task 2). */
export interface PersonAttachmentDecision {
  /**
   * 사람 1명 + 서로 다른 역할 잎 1개일 때만 그 매달기 한 건. 둘 중 어느 쪽이라도 0 이거나
   * 둘 이상이면 null(거짓 연결 0 = E4).
   */
  attach: { person: string; leaf: string } | null;
  /** 모호해서 매달지 못한 사유. 매달았거나 매달 대상 자체가 없으면 빈 배열(정직). */
  warnings: string[];
}

/**
 * 사람 선언 목록과 관계 사슬 목록을 받아, 사람 1명을 역할 잎 1개 아래 매달지 결정한다(Task 2).
 *
 * 매달기는 *사람 1명 + 서로 다른 역할 잎 1개*일 때만 한다(E4 — 거짓 연결 0). 둘 중 하나라도
 * 모호하면(둘 이상) 매달지 않고 모호 경고를 남긴다. 매달 대상 자체가 없으면(사람 0 또는
 * 역할 0) 매달기 없이 경고도 없다 — 빈 결과는 실패가 아니라 정직한 답이다.
 *
 * 역할 개수는 사슬 *개수*가 아니라 서로 다른 잎(distinct leaf) 개수로 센다. 비정상 입력
 * (`#가족:엄마` 가 `#관계:가족` 앞)에서 같은 잎 "엄마"가 사슬 2개로 나올 수 있는데, 사슬
 * 개수로 세면 실제 역할 1개를 2개로 오인해 거짓 거부한다. 잎으로 묶어 세면 실제 역할 1개라
 * 정상 매달린다. 매달 잎 = 그 단 하나의 서로 다른 잎.
 *
 * 순수 함수 — DB·LLM·네트워크 0.
 */
export function decidePersonAttachment(
  persons: string[],
  chains: RelationChain[],
): PersonAttachmentDecision {
  const distinctLeaves = [...new Set(chains.map((c) => c.leaf.trim()).filter(Boolean))];

  // 매달 대상이 없음 — 매달기 없이 경고도 없다(정직한 빈 결과, 실패 아님).
  if (persons.length === 0 || distinctLeaves.length === 0) {
    return { attach: null, warnings: [] };
  }
  // 사람이 둘 이상 — 어느 사람을 매달지 모호. 거짓 연결을 만들지 않는다(E4).
  if (persons.length > 1) {
    return {
      attach: null,
      warnings: ["사람이 둘 이상이라 어느 사람을 어느 역할에 매달지 모호합니다. 매달지 않았습니다."],
    };
  }
  // 서로 다른 역할 잎이 둘 이상 — 어느 역할에 매달지 모호. 거짓 연결을 만들지 않는다(E4).
  if (distinctLeaves.length > 1) {
    return {
      attach: null,
      warnings: ["역할이 둘 이상이라 어느 역할에 사람을 매달지 모호합니다. 매달지 않았습니다."],
    };
  }
  // 사람 1명 + 역할 잎 1개 — 매달기 한 건.
  return { attach: { person: persons[0]!, leaf: distinctLeaves[0]! }, warnings: [] };
}
