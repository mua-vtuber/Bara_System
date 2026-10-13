/**
 * score-decision 순수 함수 테스트 — Phase 6 spec 단락 4.1 (점수 → 처리) +
 * 단락 4.2 (저장 metadata 양식).
 *
 * data fixture (RegexMatch 직접 생성 → 출력 검증) 방식만 사용한다. 인터페이스
 * mock 없음 (CLAUDE.md 테스트 정책 정합).
 */

import { describe, expect, test } from "bun:test";
import type { RegexMatch } from "./types.ts";
import {
  buildRegexMetadata,
  decideByScore,
  scoreToImportance,
} from "./score-decision.ts";

describe("decideByScore (spec 4.1 + 정밀화 spec §5.4 base 게이트)", () => {
  test("≥5 && base≥3 → auto_store", () => {
    expect(decideByScore(9, 3)).toBe("auto_store");
    expect(decideByScore(6, 3)).toBe("auto_store");
  });

  test("경계값 5 && base≥3 = auto_store", () => {
    expect(decideByScore(5, 3)).toBe("auto_store");
  });

  test("≥5 && base<3 → pending_review (booster 만으로 auto_store 금지)", () => {
    // 선호 +2 양식이 booster 로 finalScore 5·6 이 되어도 base<3 이라 검토 대기 상한.
    expect(decideByScore(5, 2)).toBe("pending_review");
    expect(decideByScore(6, 2)).toBe("pending_review");
    expect(decideByScore(8, 1)).toBe("pending_review");
  });

  test("3~4 → pending_review (base 무관)", () => {
    expect(decideByScore(4, 3)).toBe("pending_review");
    expect(decideByScore(3, 3)).toBe("pending_review");
    expect(decideByScore(4, 2)).toBe("pending_review");
  });

  test("≤2 → ignore", () => {
    expect(decideByScore(2, 2)).toBe("ignore");
    expect(decideByScore(0, 0)).toBe("ignore");
    expect(decideByScore(-3, 0)).toBe("ignore");
  });
});

describe("scoreToImportance (사용자 결정 #2 / DCL-1 — clamp(score/10,0,1))", () => {
  test("점수 +9 → 0.9", () => {
    expect(scoreToImportance(9)).toBeCloseTo(0.9);
  });

  test("점수 +5 → 0.5", () => {
    expect(scoreToImportance(5)).toBeCloseTo(0.5);
  });

  test("음수 점수 → 0 (하한 clamp)", () => {
    expect(scoreToImportance(-3)).toBe(0);
  });

  test("점수 11 → 1 (상한 clamp)", () => {
    expect(scoreToImportance(11)).toBe(1);
  });

  test("경계 0 → 0, 경계 10 → 1", () => {
    expect(scoreToImportance(0)).toBe(0);
    expect(scoreToImportance(10)).toBe(1);
  });
});

/** spec 단락 4.2 예시 metadata 를 형성하는 매치 fixture (점수 6 / decision). */
const SPEC_EXAMPLE_MATCH: RegexMatch = {
  patternId: "decision_ko_001",
  category: "decision",
  score: 6,
  polarity: "positive",
  extractedContent: "디스코드 봇 자동 추출 끄기로",
  matchText: "디스코드 봇 자동 추출 끄기로 확정",
  lang: "ko",
};

describe("buildRegexMetadata (spec 4.2)", () => {
  test("auto_store 갈래 — spec 4.2 예시 metadata 재현 + auto_stored:true", () => {
    const meta = buildRegexMetadata(
      SPEC_EXAMPLE_MATCH,
      ["앞으로", "확정"],
      "auto_store",
    );
    expect(meta).toEqual({
      source: "regex",
      regex_category: "decision",
      regex_pattern_id: "decision_ko_001",
      regex_score: 6,
      boosters_hit: ["앞으로", "확정"],
      pattern_match_text: "디스코드 봇 자동 추출 끄기로 확정",
      extracted_content: "디스코드 봇 자동 추출 끄기로",
      regex_polarity: "positive",
      lang: "ko",
      auto_stored: true,
    });
  });

  test("pending_review 갈래 — auto_stored:false + pending_review:true", () => {
    const match: RegexMatch = {
      patternId: "preference_ko_003",
      category: "preference",
      score: 4,
      polarity: "negative",
      extractedContent: "게임스러운 디자인",
      matchText: "게임스러운 디자인 별로야",
      lang: "ko",
    };
    const meta = buildRegexMetadata(match, ["별로"], "pending_review");
    expect(meta).toEqual({
      source: "regex",
      regex_category: "preference",
      regex_pattern_id: "preference_ko_003",
      regex_score: 4,
      boosters_hit: ["별로"],
      pattern_match_text: "게임스러운 디자인 별로야",
      extracted_content: "게임스러운 디자인",
      regex_polarity: "negative",
      lang: "ko",
      auto_stored: false,
      pending_review: true,
    });
  });

  test("boosters_hit 없는 경우 빈 배열", () => {
    const meta = buildRegexMetadata(SPEC_EXAMPLE_MATCH, [], "auto_store");
    expect(meta.boosters_hit).toEqual([]);
  });

  test("metadata 칸 9개 + auto_store 갈래는 auto_stored 1개 추가 (pending_review 칸 없음)", () => {
    const meta = buildRegexMetadata(SPEC_EXAMPLE_MATCH, [], "auto_store");
    expect(Object.keys(meta).sort()).toEqual(
      [
        "auto_stored",
        "boosters_hit",
        "extracted_content",
        "lang",
        "pattern_match_text",
        "regex_category",
        "regex_pattern_id",
        "regex_polarity",
        "regex_score",
        "source",
      ].sort(),
    );
    expect(meta.source).toBe("regex");
  });

  test("ignore 결정으로는 metadata 를 빌드하지 않는다 (loud throw)", () => {
    expect(() =>
      buildRegexMetadata(SPEC_EXAMPLE_MATCH, [], "ignore"),
    ).toThrow();
  });
});
