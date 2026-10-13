/**
 * alias-attribution.ts — `#별명:`/`#닉네임:` 귀속 경계 단일 출처
 * (2026-06-13 어휘 독립 다단계 위계 §14·V9).
 *
 * `#별명:`·`#닉네임:` 은 두 맥락에서 쓰인다 — 사람 닉네임(wireHashtagEntities 가
 * addPersonAlias 로)과 엔티티 약칭(wireEntityPlacement 가 ko_aliases 로). 같은 키라
 * *누구에게 붙나*를 글 안 다른 태그로 가른다. 두 통로가 같은 글을 각자 파싱하므로,
 * "이 글이 사람 별칭을 소비하는 글인가"를 한 출처에서 판정해 둘이 같은 규칙을 보게 한다
 * (드리프트 차단·spec §14.3 조정 지점).
 *
 * §14 귀속 경계(사용자 확정):
 *   ① `#사람:` 만 있는 글(주 사람 있고 엔티티 행 없음) → 사람 alias(기존·변경 0).
 *   ② 엔티티 사슬만 있는 글(주 사람 없음·엔티티 행 생성) → 엔티티 ko_aliases.
 *   ③ 둘 다 있는 글(주 사람 있음 AND 엔티티 행 생성) → 어디에도 안 붙이고 모호 경고
 *      (방향 4·거짓 귀속 0). 두 통로가 각자 이 헬퍼로 상대 소비 조건을 확인해 막는다.
 *
 * LLM 호출 0 — 순수 규칙 판정. RRF·schema 0줄(읽기만·DB 변경 없음).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import { parseTags } from "./tag-extractor.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { classifyEntityTypeDeterministic } from "./entity-type-classifier.ts";
import { shouldCreateEntityRow } from "./entity-row-gate.ts";

/**
 * 사람 통로(wireHashtagEntities)가 이 글에서 `#별명:` 을 *정말 소비하는가* 를
 * 그 통로의 factPersonId 게이트와 같은 규칙으로 재현한다(hashtag-entity-wiring.ts:258).
 *
 * 소비 조건 = 프로젝트 주 엔티티 아님 AND (고유 사실 또는 별칭 있음) AND 주 사람 정확히 1명.
 * 주 사람 수는 `#사람:` 선언 + 등록 신호가 있을 때 콜론 없는 `#이름`이 등록된 사람으로
 * 해석되는 경우(wireHashtagEntities:209~226)까지 포함해 같은 평면에서 센다.
 *
 * 사람 통로가 안 가져가는 글(주 사람 0·2+·프로젝트 글)이면 false — 그 글의 `#별명:` 은
 * 엔티티 통로가 단독으로 가져갈 수 있다(② 케이스).
 */
export async function personAliasWouldConsume(
  store: SqliteMemoryStore,
  content: string,
): Promise<boolean> {
  const parsed = parseHashtagEntities(content);
  const hasFactsOrAlias =
    parsed.attributes.length > 0 || parsed.aliases.length > 0;
  const hasLabels = parsed.labels.length > 0;
  if (!hasFactsOrAlias) return false; // alias 도 fact 도 없으면 사람 통로 별칭 소비 0.

  const hasProject = parsed.projectDeclarations.length > 0;
  if (hasProject) return false; // 프로젝트 주 엔티티면 사람 별칭 갈래로 안 간다.

  // 주 사람 후보 — `#사람:` 선언 + 콜론 없는 등록 사람 끌어오기(같은 평면·displayName 기준).
  const declared = new Set(parsed.personDeclarations);
  if (hasFactsOrAlias || hasLabels) {
    const { tags } = parseTags(content);
    for (const tag of tags) {
      const lookup = await store.findPersonByNameOrAlias(tag);
      if (lookup.person && !lookup.ambiguous) {
        declared.add(lookup.person.displayName);
      }
    }
  }
  // factPersonId 는 주 사람이 정확히 1명일 때만 생긴다 — 그때만 사람 통로가 alias 를 소비.
  return declared.size === 1;
}

/** 신규 8 엔티티 타입 이름 집합 — person/project 를 행 생성 판정에서 제외(엔티티 통로 정합). */
const ENTITY_TYPE_NAMES: ReadonlySet<string> = new Set([
  "creature",
  "thing",
  "intake",
  "usable",
  "work",
  "material",
  "place",
  "schedule",
]);

/**
 * 이 글에서 wireEntityPlacement 가 신규 8 타입 *행을 만드는가* 를 그 통로와 같은 단일
 * 출처 함수로 판정한다(부작용 0·읽기만). 사람 통로(wireHashtagEntities)가 §14.3 ③ 모호를
 * 막을 때 "같은 글에 엔티티 행이 생기나"를 이 헬퍼로 확인한다 — 드리프트 차단.
 *
 * wireEntityPlacement 의 행 생성 갈래를 그대로 재현한다:
 *   1. classifyEntityTypeDeterministic(LLM null·결정적 1·2단)로 타입 판정.
 *   2. source === 'explicit' 이고 typeName 이 신규 8 타입일 때만 행 생성 후보.
 *   3. candidateName = matched 콜론 뒷값(explicit), hasAttributes = 타입 선언 태그를 뺀
 *      나머지 콜론 태그가 있나. shouldCreateEntityRow 게이트(결정 A·B)가 통과면 행 생성.
 *
 * 게이트 판정 함수(shouldCreateEntityRow)·분류기를 엔티티 통로와 *같은 함수*로 부르므로
 * 판정이 어긋나지 않는다. LLM 단은 안 탄다(입력 통로 default OFF 정합 — wireEntityPlacement
 * 도 글 입력에서 llm=null).
 */
export function entityRowWouldBeCreated(content: string): boolean {
  const classification = classifyEntityTypeDeterministic(content ?? "");
  if (classification.source !== "explicit") return false;
  if (classification.typeName === null) return false;
  if (!ENTITY_TYPE_NAMES.has(classification.typeName)) return false;

  // candidateName = matched(`rawCategory:value`)의 콜론 뒷값(explicit 갈래·엔티티 통로 정합).
  const matched = classification.matched ?? "";
  const colon = matched.indexOf(":");
  const candidateName = colon < 0 ? "" : matched.slice(colon + 1).trim();

  // hasAttributes = 타입 선언 태그(matched 키)를 한 번 뺀 나머지 콜론 태그가 있나.
  const typeTagKey = colon < 0 ? "" : matched.slice(0, colon).trim().toLowerCase();
  let typeTagExcluded = false;
  let hasAttributes = false;
  for (const tag of parseClassificationTags(content ?? "")) {
    if (
      !typeTagExcluded &&
      typeTagKey &&
      tag.rawCategory.trim().toLowerCase() === typeTagKey
    ) {
      typeTagExcluded = true;
      continue;
    }
    hasAttributes = true;
    break;
  }

  return shouldCreateEntityRow({
    typeName: classification.typeName,
    candidateName,
    source: classification.source,
    hasAttributes,
    subcategory: classification.subcategory,
  }).create;
}
