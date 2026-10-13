/**
 * polarity-infer 순수 함수 테스트 — Phase 6 spec 단락 5.1 / 5.4.
 *
 * data fixture (RegexPatternDef 직접 생성 → 출력 검증) 방식만 사용한다.
 * builtin 상수에 의존하지 않고 순수 함수 입출력만 확인한다 (인터페이스 mock 없음).
 */

import { describe, expect, test } from "bun:test";
import type { Polarity, RegexCategory, RegexPatternDef } from "./types.ts";
import { CATEGORY_DEFAULT_POLARITY, inferPolarity } from "./polarity-infer.ts";

/** 양식 한 항목을 만드는 fixture 헬퍼 — 검증에 필요한 칸만 채운다. */
function makePattern(
  category: RegexCategory,
  polarity?: Polarity,
): RegexPatternDef {
  return {
    id: `fixture_${category}_${polarity ?? "default"}`,
    pattern: "(.+)",
    regex: /(.+)/,
    score: 1,
    category,
    polarity,
    lang: "ko",
    enabled: true,
  };
}

describe("CATEGORY_DEFAULT_POLARITY", () => {
  test("spec 5.4 default 표를 그대로 재현한다", () => {
    const expected: Record<RegexCategory, Polarity> = {
      decision: "positive",
      preference: "positive",
      constraint: "negative",
      status: "neutral",
      fact: "neutral",
      technical: "positive",
    };
    expect(CATEGORY_DEFAULT_POLARITY).toEqual(expected);
  });
});

describe("inferPolarity — 명시 polarity 우선 (spec 5.1)", () => {
  test("constraint 인데 명시 polarity 가 positive 면 그 값 우선 (의무 결정 갈래)", () => {
    const pattern = makePattern("constraint", "positive");
    expect(inferPolarity(pattern)).toBe("positive");
  });

  test("부정 제약 양식은 명시 negative 를 그대로 사용", () => {
    const pattern = makePattern("constraint", "negative");
    expect(inferPolarity(pattern)).toBe("negative");
  });

  test("preference 부정 갈래 명시 negative 우선", () => {
    const pattern = makePattern("preference", "negative");
    expect(inferPolarity(pattern)).toBe("negative");
  });

  test("decision 명시 positive 그대로", () => {
    const pattern = makePattern("decision", "positive");
    expect(inferPolarity(pattern)).toBe("positive");
  });

  test("status 양식이 드물게 명시 positive 면 그 값 우선", () => {
    const pattern = makePattern("status", "positive");
    expect(inferPolarity(pattern)).toBe("positive");
  });
});

describe("inferPolarity — 명시 없으면 category default (spec 5.4)", () => {
  test("decision → positive", () => {
    expect(inferPolarity(makePattern("decision"))).toBe("positive");
  });

  test("preference → positive", () => {
    expect(inferPolarity(makePattern("preference"))).toBe("positive");
  });

  test("constraint → negative", () => {
    expect(inferPolarity(makePattern("constraint"))).toBe("negative");
  });

  test("status → neutral", () => {
    expect(inferPolarity(makePattern("status"))).toBe("neutral");
  });

  test("fact → neutral", () => {
    expect(inferPolarity(makePattern("fact"))).toBe("neutral");
  });

  test("technical → positive", () => {
    expect(inferPolarity(makePattern("technical"))).toBe("positive");
  });
});

describe("inferPolarity — 알 수 없는 category 안전 default", () => {
  test("타입 밖 category 가 런타임에 들어오면 neutral 반환 (throw 안 함)", () => {
    // 타입 시스템 밖 값이 yaml / DB 에서 들어오는 시점을 모사한 fixture.
    const rogue = makePattern("decision");
    (rogue as { category: string }).category = "unknown_category";
    expect(inferPolarity(rogue)).toBe("neutral");
  });

  test("category 가 빈 문자열이어도 neutral 안전 default", () => {
    const rogue = makePattern("fact");
    (rogue as { category: string }).category = "";
    delete (rogue as { polarity?: Polarity }).polarity;
    expect(inferPolarity(rogue)).toBe("neutral");
  });
});
