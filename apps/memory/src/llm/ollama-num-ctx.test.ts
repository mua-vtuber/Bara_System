/**
 * ollama-num-ctx.test.ts — Ollama 컨텍스트 창 값 계산 (순수 함수, env 는 데이터 객체로 넘김).
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_OLLAMA_NUM_CTX } from "./constants.ts";
import { OLLAMA_NUM_CTX_ENV, resolveOllamaNumCtx } from "./ollama-num-ctx.ts";

describe("resolveOllamaNumCtx", () => {
  test("환경 변수 이름 상수", () => {
    expect(OLLAMA_NUM_CTX_ENV).toBe("OLLAMA_NUM_CTX");
  });

  test("명시값이 환경 변수보다 우선", () => {
    expect(resolveOllamaNumCtx(4096, { OLLAMA_NUM_CTX: "16384" })).toBe(4096);
  });

  test("환경 변수만 있으면 그 값", () => {
    expect(resolveOllamaNumCtx(undefined, { OLLAMA_NUM_CTX: "16384" })).toBe(16384);
  });

  test("환경 변수가 없거나 빈 문자열이면 기본값 8192", () => {
    expect(resolveOllamaNumCtx(undefined, {})).toBe(DEFAULT_OLLAMA_NUM_CTX);
    expect(resolveOllamaNumCtx(undefined, { OLLAMA_NUM_CTX: "" })).toBe(8192);
  });

  test.each(["abc", "0", "-1", "8192.5", "8192abc"])("%p 는 이름과 받은 값이 든 오류", (raw) => {
    expect(() => resolveOllamaNumCtx(undefined, { OLLAMA_NUM_CTX: raw })).toThrow(
      `OLLAMA_NUM_CTX 가 양의 정수가 아님 (받은 값 "${raw}")`,
    );
  });

  test("숫자 글자만 있어도 안전 정수 범위를 넘는 아주 긴 값은 이름과 받은 값이 든 오류", () => {
    const raw = "9".repeat(40);
    expect(() => resolveOllamaNumCtx(undefined, { OLLAMA_NUM_CTX: raw })).toThrow(
      `OLLAMA_NUM_CTX 가 양의 정수가 아님 (받은 값 "${raw}")`,
    );
  });
});
