/**
 * polarity 추론 순수 함수 — Phase 6 spec 단락 5.1 (category별 polarity 표) +
 * 단락 5.4 (polarity 칸 default 갈래).
 *
 * regex 양식 한 항목 매치 시점에 최종 polarity 를 정한다:
 *   1. 양식 yaml 안 `polarity` 칸이 명시돼 있으면 그 값 우선 (단락 5.1 표 정합 —
 *      예: 부정 제약 양식은 `negative`, 의무 결정 양식은 `positive`).
 *   2. 누락 양식은 category default 표 (단락 5.4) 를 따른다.
 *   3. 타입 밖 category 가 런타임(yaml / DB)에서 들어오면 `neutral` 안전 default
 *      반환 — 순수 함수는 throw 하지 않는다. 구체 경고는 호출자 책임.
 *
 * 인터페이스 mock 없이 RegexPatternDef 입력 → Polarity 출력만 다룬다.
 */

import type { Polarity, RegexCategory, RegexPatternDef } from "./types.ts";

/**
 * category별 polarity default 표 — Phase 6 spec 단락 5.4 그대로.
 *
 * decision/preference/technical = positive, constraint = negative,
 * status/fact = neutral. 양식 yaml 안 `polarity` 칸 누락 양식의 안전 fallback.
 */
export const CATEGORY_DEFAULT_POLARITY: Record<RegexCategory, Polarity> = {
  decision: "positive",
  preference: "positive",
  constraint: "negative",
  status: "neutral",
  fact: "neutral",
  technical: "positive",
};

/** 타입 밖 category 가 들어오는 시점의 안전 default (단락 5.4 fallback 정신). */
const UNKNOWN_CATEGORY_DEFAULT: Polarity = "neutral";

/**
 * 양식 한 항목의 최종 polarity 를 정한다.
 *
 * @param pattern 매치한 양식 정의. `polarity` 칸이 있으면 명시 값 우선.
 * @returns 명시 polarity → category default → (타입 밖 시점) neutral.
 */
export function inferPolarity(pattern: RegexPatternDef): Polarity {
  if (pattern.polarity !== undefined) {
    return pattern.polarity;
  }
  const fromDefault = CATEGORY_DEFAULT_POLARITY[pattern.category];
  return fromDefault ?? UNKNOWN_CATEGORY_DEFAULT;
}
