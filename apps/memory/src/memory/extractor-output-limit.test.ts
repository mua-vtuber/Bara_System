/**
 * extractor-output-limit.test.ts — 추출 출력 한도 범위·Ollama 컨텍스트 창 관계 검사 (순수 함수).
 */

import { describe, expect, test } from "bun:test";
import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_KEY,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MAX,
  EXTRACTOR_MAX_OUTPUT_TOKENS_MIN,
  EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE,
  extractorMaxOutputTokensError,
  extractorOutputExceedsOllamaContextError,
} from "./extractor-output-limit.ts";
import { OLLAMA_NUM_CTX_ENV } from "../llm/ollama-num-ctx.ts";
import { DEFAULT_OLLAMA_NUM_CTX } from "../llm/constants.ts";
import { DEFAULT_TOKEN_CAP } from "./chunker.ts";
import { estimateTokens } from "./token-counter.ts";
import { buildExtractionMessages } from "./extractor-internal/prompt.ts";

describe("extractorMaxOutputTokensError", () => {
  test("상수 값은 spec 3.1 그대로", () => {
    expect(EXTRACTOR_MAX_OUTPUT_TOKENS_KEY).toBe("llm.extractor.maxOutputTokens");
    expect(EXTRACTOR_MAX_OUTPUT_TOKENS_MIN).toBe(256);
    expect(EXTRACTOR_MAX_OUTPUT_TOKENS_MAX).toBe(32768);
    expect(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT).toBe(4096);
    expect(EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE).toBe(4096);
  });

  test.each([255, 32769, 1024.5, "1024", Number.NaN, null])("%p 는 키 이름이 든 문장", (value) => {
    const message = extractorMaxOutputTokensError(value);
    expect(message).toBe(
      `llm.extractor.maxOutputTokens: 256 이상 32768 이하 정수 필요 (받은 값 ${String(value)})`,
    );
  });

  test.each([256, 1024, 32768])("%p 는 통과", (value) => {
    expect(extractorMaxOutputTokensError(value)).toBeNull();
  });
});

describe("extractorOutputExceedsOllamaContextError", () => {
  test("(4096, 8192) 는 딱 맞아 통과", () => {
    expect(extractorOutputExceedsOllamaContextError(4096, 8192)).toBeNull();
  });

  test("(4097, 8192) 는 두 숫자와 환경 변수 이름이 든 문장", () => {
    const message = extractorOutputExceedsOllamaContextError(4097, 8192);
    expect(message).toBe(
      `llm.extractor.maxOutputTokens(4097) + 추출 입력 여유(4096) 가 Ollama 컨텍스트 창(num_ctx 8192 — 환경 변수 ${OLLAMA_NUM_CTX_ENV})보다 큼`,
    );
    expect(message).toContain("OLLAMA_NUM_CTX");
  });

  test("(1024, 4096) 은 창이 작아 문장", () => {
    const message = extractorOutputExceedsOllamaContextError(1024, 4096);
    expect(message).toContain("1024");
    expect(message).toContain("4096");
  });
});

describe("기본 출력 한도·입력 여유 — 꽉 찬 청크 한 덩어리 기준 (2026-10-20 계산)", () => {
  /** estimateTokens 가 한글 1자를 2토큰으로 세므로 DEFAULT_TOKEN_CAP 토큰짜리 본문 = 한글 DEFAULT_TOKEN_CAP/2 자. */
  const FULL_CHUNK_BODY = "가".repeat(DEFAULT_TOKEN_CAP / 2);

  test("꽉 찬 청크 본문은 정확히 DEFAULT_TOKEN_CAP 토큰으로 센다(아래 계산의 전제)", () => {
    expect(estimateTokens(FULL_CHUNK_BODY)).toBe(DEFAULT_TOKEN_CAP);
  });

  test("출력 기본값은 본문 몫(DEFAULT_TOKEN_CAP)보다 크다 — 원문을 거의 그대로 옮기는 응답이 들어간다", () => {
    expect(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT).toBeGreaterThan(DEFAULT_TOKEN_CAP);
  });

  test("기본 출력 한도 + 입력 여유가 기본 Ollama 창 안에 든다(관계 검사 통과)", () => {
    expect(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT + EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE).toBeLessThanOrEqual(
      DEFAULT_OLLAMA_NUM_CTX,
    );
    expect(
      extractorOutputExceedsOllamaContextError(EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT, DEFAULT_OLLAMA_NUM_CTX),
    ).toBeNull();
  });

  test("꽉 찬 청크를 넣어 조립한 실제 입력(시스템 + few-shot + 본문)이 입력 여유 안에 든다", () => {
    const messages = buildExtractionMessages(FULL_CHUNK_BODY);
    const inputTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    expect(inputTokens).toBeLessThanOrEqual(EXTRACTOR_OLLAMA_INPUT_TOKEN_RESERVE);
  });
});
