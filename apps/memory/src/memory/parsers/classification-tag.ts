/**
 * classification-tag.ts — Phase 11b T1 + T8.
 *
 * 사용자 메시지 안 `#category:value` colon 양식 자동 매치.
 *
 * 평면 해시태그(`#봄`)는 자연 제외 — colon 없는 양식 한 갈래.
 * value 는 정규식 캡처가 아니라 쉼표/줄바꿈/다음 `#` 경계까지 별도 추출한다.
 * 그래서 값 안 공백은 보존된다.
 * 빈 category·빈 value = 자연 무시.
 *
 * T8 정합: 추출 직후 category 키를 builtin 동의어 사전으로 정규화.
 * value 는 정규화 X — 사용자 어휘 그대로 보존. 매치 없음 = 입력 그대로 통과
 * (정직한 passthrough). 상세는 `synonyms/category-synonyms.ts` 참조.
 *
 * 옛 hashtag 흐름(`extractor.ts` 안 `applyHashtagWiring` + `parseTags`)와는 별 갈래 —
 * 6a 정규식 L0 가족(`regex-l0/`) 무수정 정합 (회귀 0 불변식 (6)).
 */

import { recognizeCategorySynonym } from "../synonyms/category-synonyms.ts";
import { findTagValueEndForKey } from "./tag-value-boundary.ts";

export interface ClassificationTag {
  category: string;
  value: string;
  /**
   * 정규화 전 원본 키 — 이미지 분류 동의어 정규화(작품→series)를 우회해 엔티티
   * 타입 키로 매칭하려는 소비처용. category 는 기존대로 정규화값 유지.
   *
   * 두 필드가 다 필요한 이유: category 는 이미지 분류 소비처(Phase 11b T8 경로)가
   * canonical 키를 요구해 정규화값을 유지한다. rawCategory 는 그 정규화를 우회해야
   * 하는 엔티티 타입 키 매칭용(작품→series 처럼 두 사전 키가 겹칠 때 갈라진다).
   * 그래서 rawCategory 한 가지로 통일할 수 없다 — 소비처마다 필요한 키가 다르다.
   */
  rawCategory: string;
}

// `#` + category(공백 안·colon 안) + `:` — 값은 정규식 캡처가 아니라 경계 추출.
// 값 경계 = 다음 쉼표/줄바꿈, 없으면 줄 끝(tag-value-boundary 단일 출처·방식 A).
// 한국어 가나다 / 영어 / 숫자 / underscore / hyphen 한 갈래.
const CLASSIFICATION_KEY_REGEX = /#([\p{L}\p{N}_-]+):/gu;

/** 콜론 태그 키 하나가 글 안에서 놓인 자리 — 값이 비어 있어도 담는다. */
export interface ClassificationKeyMatch {
  /** `#` 의 위치. */
  index: number;
  rawCategory: string;
  /** 값이 시작하는 위치(`:` 바로 뒤). */
  valueStart: number;
  /** 값 경계(다음 쉼표·줄바꿈·`#` 또는 글 끝)의 위치. */
  valueEnd: number;
  /** 앞뒤 공백을 자른 값. 빈 문자열이면 parseClassificationTags 가 버리는 태그다. */
  value: string;
}

/**
 * 글 안 모든 `#키:` 자리를 값 경계와 함께 돌려준다. parseClassificationTags 가 이 결과에서
 * 값이 빈 것만 빼고 쓰므로, 저장 응답의 해시태그 경고(hashtag-chain-check.ts)가 파서와
 * 똑같은 읽기를 보게 하는 단일 출처다.
 */
export function scanClassificationKeys(text: string): ClassificationKeyMatch[] {
  const result: ClassificationKeyMatch[] = [];
  if (!text) return result;

  CLASSIFICATION_KEY_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASSIFICATION_KEY_REGEX.exec(text)) !== null) {
    const rawCategory = match[1];
    if (!rawCategory) continue;
    const valueStart = match.index + match[0].length;
    const valueEnd = findTagValueEndForKey(text, valueStart, rawCategory);
    result.push({
      index: match.index,
      rawCategory,
      valueStart,
      valueEnd,
      value: text.slice(valueStart, valueEnd).trim(),
    });
  }
  return result;
}

export function parseClassificationTags(text: string): ClassificationTag[] {
  const result: ClassificationTag[] = [];
  for (const match of scanClassificationKeys(text)) {
    if (!match.value) continue;
    const category = recognizeCategorySynonym(match.rawCategory);
    result.push({ category, value: match.value, rawCategory: match.rawCategory });
  }
  return result;
}
