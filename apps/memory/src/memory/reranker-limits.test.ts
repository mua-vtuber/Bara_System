/**
 * reranker-limits — 쌍 길이 한도 범위 검사와 모델 한도 비교 (2026-10-14 speed-step1 spec 3.1·3.2).
 */
import { describe, expect, test } from "bun:test";
import {
  RERANKER_MAX_PAIR_TOKENS_KEY,
  RERANKER_MAX_PAIR_TOKENS_MAX,
  RERANKER_MAX_PAIR_TOKENS_MIN,
  pairTokensExceedModelReason,
  rerankerMaxPairTokensError,
} from "./reranker-limits.ts";

describe("rerankerMaxPairTokensError", () => {
  test("상수 값", () => {
    expect(RERANKER_MAX_PAIR_TOKENS_MIN).toBe(64);
    expect(RERANKER_MAX_PAIR_TOKENS_MAX).toBe(8192);
    expect(RERANKER_MAX_PAIR_TOKENS_KEY).toBe("reranker.maxPairTokens");
  });

  test.each([[63], [8193], [512.5], ["512"], [Number.NaN]])("%p 는 키 이름이 든 문장으로 거부한다", (v) => {
    const msg = rerankerMaxPairTokensError(v);
    expect(msg).toBe(`reranker.maxPairTokens: 64 이상 8192 이하 정수 필요 (받은 값 ${String(v)})`);
  });

  test.each([[64], [512], [8192]])("%p 는 통과한다", (v) => {
    expect(rerankerMaxPairTokensError(v)).toBeNull();
  });
});

describe("pairTokensExceedModelReason", () => {
  test("모델 한도보다 크면 문장", () => {
    expect(pairTokensExceedModelReason(1024, 512)).toBe("reranker.maxPairTokens(1024) 가 모델 한도(512)보다 큼");
  });
  test("작거나 같거나 Infinity 면 null", () => {
    expect(pairTokensExceedModelReason(512, 8192)).toBeNull();
    expect(pairTokensExceedModelReason(512, 512)).toBeNull();
    expect(pairTokensExceedModelReason(512, Infinity)).toBeNull();
  });
});
