/**
 * ollama-timing.test.ts — Ollama 호출 시간 한 줄의 순수 계산·문장 형식(spec 5.3).
 * 순수 함수에 데이터를 넣어 출력을 확인한다(인터페이스 흉내 없음).
 */

import { describe, expect, test } from "bun:test";
import {
  formatOllamaTimingLine,
  OLLAMA_TIMING_PREFIX,
  parseOllamaTimingFields,
  type OllamaCallTiming,
} from "./ollama-timing.ts";

const FULL: OllamaCallTiming = {
  caller: "extraction",
  model: "qwen3:4b-instruct",
  doneReason: "length",
  inputChars: 9120,
  imageBytes: null,
  wallMs: 305210,
  totalMs: 304900,
  loadMs: 120,
  promptTokens: 3100,
  promptMs: 95000,
  outputTokens: 1024,
  outputMs: 209700,
};

describe("parseOllamaTimingFields", () => {
  test("나노초를 ms 로 반올림하고 개수는 그대로 둔다", () => {
    const f = parseOllamaTimingFields({
      total_duration: 304_900_400_000,
      load_duration: 120_600_000,
      prompt_eval_count: 3100,
      prompt_eval_duration: 95_000_000_000,
      eval_count: 1024,
      eval_duration: 209_700_499_999,
    });
    expect(f).toEqual({
      totalMs: 304900,
      loadMs: 121,
      promptTokens: 3100,
      promptMs: 95000,
      outputTokens: 1024,
      outputMs: 209700,
    });
  });

  test("칸이 없거나 숫자가 아니면 null", () => {
    const f = parseOllamaTimingFields({
      total_duration: "300",
      load_duration: null,
      prompt_eval_count: Number.NaN,
      eval_count: 5,
    });
    expect(f.totalMs).toBeNull();
    expect(f.loadMs).toBeNull();
    expect(f.promptTokens).toBeNull();
    expect(f.promptMs).toBeNull();
    expect(f.outputTokens).toBe(5);
    expect(f.outputMs).toBeNull();
  });
});

describe("formatOllamaTimingLine", () => {
  test("머리말로 시작하는 줄바꿈 없는 한 줄이고 초당 토큰이 계산된다", () => {
    const line = formatOllamaTimingLine(FULL);
    expect(line.startsWith(`${OLLAMA_TIMING_PREFIX} `)).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("caller=extraction");
    expect(line).toContain("model=qwen3:4b-instruct");
    expect(line).toContain("done=length");
    expect(line).toContain("inputChars=9120");
    expect(line).toContain("wall=305210ms");
    expect(line).toContain("total=304900ms");
    expect(line).toContain("load=120ms");
    expect(line).toContain("prompt=3100tok/95000ms(32.6tok/s)");
    expect(line).toContain("output=1024tok/209700ms(4.9tok/s)");
  });

  test("값이 없으면 - 로, caller 가 없으면 미지정으로 찍는다", () => {
    const line = formatOllamaTimingLine({
      ...FULL,
      caller: undefined,
      doneReason: null,
      totalMs: null,
      loadMs: null,
      promptTokens: null,
      promptMs: null,
      outputTokens: null,
      outputMs: null,
    });
    expect(line).toContain("caller=미지정");
    expect(line).toContain("done=-");
    expect(line).toContain("total=-");
    expect(line).toContain("load=-");
    expect(line).toContain("prompt=-/-");
    expect(line).toContain("output=-/-");
    expect(line).not.toContain("tok/s");
  });

  test("시간이 0 이면 초당 토큰을 계산하지 않는다", () => {
    const line = formatOllamaTimingLine({ ...FULL, promptMs: 0, outputMs: 0 });
    expect(line).toContain("prompt=3100tok/0ms");
    expect(line).not.toContain("tok/s");
  });

  test("개수가 없고 시간만 있으면 초당 토큰을 계산하지 않는다", () => {
    const line = formatOllamaTimingLine({ ...FULL, outputTokens: null });
    expect(line).toContain("output=-/209700ms");
    expect(line).not.toContain("output=-/209700ms(");
  });

  test("imageBytes 칸은 값이 있을 때만 나온다", () => {
    expect(formatOllamaTimingLine(FULL)).not.toContain("imageBytes");
    const withImage = formatOllamaTimingLine({ ...FULL, imageBytes: 48213 });
    expect(withImage).toContain("inputChars=9120 imageBytes=48213 wall=");
  });
});
