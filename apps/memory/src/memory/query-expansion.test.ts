/**
 * query-expansion.test.ts — expandQueryWithSynonyms 단위 검증(공통 인프라 1.1b T2).
 *
 * 순수 함수 — DB·임베딩 의존 0. 데이터 fixture(SynonymDictionary Map)만 입력해
 * 출력을 검증한다. 인터페이스 가짜 구현체(mock) 금지.
 */
import { describe, test, expect } from "bun:test";
import type { SynonymDictionary } from "./synonym-dictionary.ts";
import { expandQueryWithSynonyms } from "./query-expansion.ts";

const DICT: SynonymDictionary = new Map([
  ["포근한", ["따뜻한", "아늑한"]],
  ["회의록", ["미팅노트", "회의 정리"]],
]);

describe("expandQueryWithSynonyms (pure)", () => {
  test("매치 토큰은 동의어로 확장 + 미매치 토큰은 보존", () => {
    const out = expandQueryWithSynonyms("포근한 디자인", DICT);
    const tokens = new Set(out.split(/\s+/));
    expect(tokens.has("포근한")).toBe(true); // 원본 토큰 보존
    expect(tokens.has("따뜻한")).toBe(true); // 동의어 합류
    expect(tokens.has("아늑한")).toBe(true);
    expect(tokens.has("디자인")).toBe(true); // 미매치 토큰 보존
  });

  test("매치 0 = 원본 query 그대로(자연 degrade — 동작 불변)", () => {
    expect(expandQueryWithSynonyms("자동차 수리", DICT)).toBe("자동차 수리");
  });

  test("빈 query = 빈 query 그대로", () => {
    expect(expandQueryWithSynonyms("", DICT)).toBe("");
    expect(expandQueryWithSynonyms("   ", DICT)).toBe("   ");
  });

  test("빈 사전 = 원본 query 그대로", () => {
    const empty: SynonymDictionary = new Map();
    expect(expandQueryWithSynonyms("포근한 디자인", empty)).toBe("포근한 디자인");
  });

  test("동의어 중복 제거 — 같은 토큰 두 번 안 들어감", () => {
    // query 에 이미 동의어가 들어와도 확장 결과에 중복 없음.
    const out = expandQueryWithSynonyms("포근한 따뜻한", DICT);
    const arr = out.split(/\s+/);
    expect(new Set(arr).size).toBe(arr.length);
    expect(arr).toContain("아늑한");
  });

  test("여러 매치 토큰 동시 확장", () => {
    const out = expandQueryWithSynonyms("포근한 회의록", DICT);
    const tokens = new Set(out.split(/\s+/));
    expect(tokens.has("따뜻한")).toBe(true);
    expect(tokens.has("미팅노트")).toBe(true);
  });
});
