/**
 * Tests for CJK-aware token estimation.
 *
 * Verifies parity with backend/app/services/memory/token_counter.py:
 * - 2 tokens per CJK char (Korean/Chinese/Japanese kana)
 * - 0.75 tokens per Latin word
 * - mixed text sums both
 * - binary-search truncation respects budget
 */

import { describe, expect, test } from "bun:test";
import { estimateTokens, truncateToBudget } from "./token-counter.ts";

describe("estimateTokens", () => {
  test("empty string → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("single Korean char → 2", () => {
    expect(estimateTokens("안")).toBe(2);
  });

  test("Korean word → 2 * char count, rounded", () => {
    // "안녕하세요" = 5 chars × 2 = 10 tokens
    expect(estimateTokens("안녕하세요")).toBe(10);
  });

  test("Chinese chars counted as CJK", () => {
    // "你好" = 2 chars × 2 = 4 tokens
    expect(estimateTokens("你好")).toBe(4);
  });

  test("Hiragana counted as CJK", () => {
    // "こんにちは" = 5 chars × 2 = 10 tokens
    expect(estimateTokens("こんにちは")).toBe(10);
  });

  test("Katakana counted as CJK", () => {
    // "カタカナ" = 4 chars × 2 = 8 tokens
    expect(estimateTokens("カタカナ")).toBe(8);
  });

  test("single Latin word → ceil(0.75) = 1", () => {
    // 1 * 0.75 = 0.75 → round → 1
    expect(estimateTokens("hello")).toBe(1);
  });

  test("Latin sentence → words * 0.75 rounded", () => {
    // 4 words × 0.75 = 3 tokens
    expect(estimateTokens("hello world from bun")).toBe(3);
  });

  test("mixed CJK + Latin sums both", () => {
    // "Bun is 좋아" → 3 Latin words + 2 CJK chars
    //   = 3 * 0.75 + 2 * 2 = 2.25 + 4 = 6.25 → round → 6
    expect(estimateTokens("Bun is 좋아")).toBe(6);
  });

  test("non-empty input always >= 1", () => {
    // Whitespace only is 0 words & 0 CJK → tokens=0 → max(1, 0) = 1
    expect(estimateTokens("   ")).toBeGreaterThanOrEqual(1);
  });

  test("punctuation does not crash", () => {
    expect(estimateTokens("...!?")).toBeGreaterThanOrEqual(1);
    expect(estimateTokens("안녕!")).toBeGreaterThanOrEqual(2);
  });
});

describe("truncateToBudget", () => {
  test("budget 0 → empty string", () => {
    expect(truncateToBudget("hello world", 0)).toBe("");
    expect(truncateToBudget("안녕하세요", 0)).toBe("");
  });

  test("budget >= total tokens → unchanged text", () => {
    const text = "hello world";
    expect(truncateToBudget(text, 1000)).toBe(text);
  });

  test("truncated result fits within budget", () => {
    const text = "안녕하세요. 반갑습니다. 오늘은 좋은 날이에요.";
    const budget = 10;
    const truncated = truncateToBudget(text, budget);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(budget);
  });

  test("truncated result is a prefix of original", () => {
    const text = "this is a long sentence that needs to be cut";
    const truncated = truncateToBudget(text, 3);
    expect(text.startsWith(truncated)).toBe(true);
  });

  test("binary search finds maximal fit", () => {
    // Construct text where we know exact prefix lengths.
    // "안" = 2 tokens, "안녕" = 4 tokens, "안녕하" = 6 tokens.
    expect(estimateTokens("안")).toBe(2);
    expect(estimateTokens("안녕")).toBe(4);
    expect(estimateTokens("안녕하")).toBe(6);

    const text = "안녕하세요";
    // Budget 4 → "안녕" is the longest fit.
    expect(truncateToBudget(text, 4)).toBe("안녕");
    // Budget 5 → still "안녕" (next prefix "안녕하" = 6 > 5).
    expect(truncateToBudget(text, 5)).toBe("안녕");
    // Budget 6 → "안녕하".
    expect(truncateToBudget(text, 6)).toBe("안녕하");
  });

  test("empty text returns empty regardless of budget", () => {
    expect(truncateToBudget("", 100)).toBe("");
  });
});
