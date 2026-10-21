/**
 * anthropic-model-capabilities — 모델별 표본 조절값(temperature 등) 허용 판정 +
 * 글 클라이언트 요청 본문 조립이 그 판정을 따르는지 검증.
 */

import { describe, expect, test } from "bun:test";
import {
  anthropicModelAcceptsSampling,
  anthropicSamplingParams,
  anthropicThinkingParams,
  normalizeAnthropicModelId,
  type AnthropicThinkingOffParam,
} from "./anthropic-model-capabilities.ts";
import { buildAnthropicChatRequest } from "./anthropic-client.ts";

describe("anthropicModelAcceptsSampling — 거절 가족", () => {
  const rejecting = [
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos-5",
    "claude-mythos-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
    // 공급자 접두·날짜·판 표시·문맥 표시가 붙어도 같은 판정.
    "anthropic.claude-haiku-5-5",
    "us.anthropic.claude-opus-4-7-v1:0",
    "claude-opus-4-8-20260101",
    "claude-sonnet-5-5[1m]",
    "CLAUDE-HAIKU-5-5",
    // 아직 없는 새 이름도 규칙상 거절 쪽.
    "claude-haiku-6",
    "claude-fable-6-2",
    "claude-mythos-7",
  ];
  for (const id of rejecting) {
    test(`${id} → false`, () => {
      expect(anthropicModelAcceptsSampling(id)).toBe(false);
    });
  }
});

describe("anthropicModelAcceptsSampling — 허용 가족(옛 모델)", () => {
  const accepting = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-opus-4-1-20250805",
    "claude-opus-4-1@20250805",
    "claude-sonnet-4-5",
    "claude-opus-4",
    "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307",
    "claude-2.1",
    "claude-instant-1.2",
  ];
  for (const id of accepting) {
    test(`${id} → true`, () => {
      expect(anthropicModelAcceptsSampling(id)).toBe(true);
    });
  }
});

describe("anthropicModelAcceptsSampling — 알아볼 수 없는 이름", () => {
  test("이름 규칙을 모르면 보내지 않는다(false)", () => {
    expect(anthropicModelAcceptsSampling("claude-latest")).toBe(false);
    expect(anthropicModelAcceptsSampling("some-other-model")).toBe(false);
  });
});

describe("normalizeAnthropicModelId", () => {
  test("접두·판 표시·날짜 꼬리를 걷어낸다", () => {
    expect(normalizeAnthropicModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5",
    );
    expect(normalizeAnthropicModelId("claude-opus-4-1@20250805")).toBe("claude-opus-4-1");
  });
});

describe("anthropicSamplingParams", () => {
  test("허용 모델 + 값 있음 → temperature 칸 포함", () => {
    expect(anthropicSamplingParams("claude-haiku-4-5", { temperature: 0.2 })).toEqual({
      temperature: 0.2,
    });
  });
  test("거절 모델 → 빈 객체", () => {
    expect(anthropicSamplingParams("claude-haiku-5-5", { temperature: 0.2 })).toEqual({});
  });
  test("값 없음 → 빈 객체", () => {
    expect(anthropicSamplingParams("claude-haiku-4-5", {})).toEqual({});
  });
});

describe("buildAnthropicChatRequest — 요청 본문 조립", () => {
  const base = {
    maxTokens: 512,
    temperature: 0.2,
    system: "시스템",
    messages: [{ role: "user" as const, content: "안녕" }],
  };

  test("claude-haiku-5-5 → temperature 칸 없음", () => {
    const body = buildAnthropicChatRequest({ ...base, model: "claude-haiku-5-5" });
    expect("temperature" in body).toBe(false);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(512);
    expect(body.system).toBe("시스템");
    expect(body.messages).toEqual(base.messages);
  });

  test("claude-haiku-4-5 → temperature 유지", () => {
    const body = buildAnthropicChatRequest({ ...base, model: "claude-haiku-4-5" });
    expect(body.temperature).toBe(0.2);
  });

  test("system 미지정 → system 칸 없음", () => {
    const body = buildAnthropicChatRequest({
      ...base,
      system: undefined,
      model: "claude-haiku-4-5",
    });
    expect("system" in body).toBe(false);
  });
});

describe("anthropicThinkingParams — 생각 끄기 칸", () => {
  test("think 가 false 가 아니면 어느 모델에도 칸을 넣지 않는다", () => {
    expect(anthropicThinkingParams("claude-haiku-5-5", undefined)).toEqual({});
    expect(anthropicThinkingParams("claude-haiku-5-5", true)).toEqual({});
  });

  test.each<[string, AnthropicThinkingOffParam]>([
    ["claude-opus-5", { type: "disabled" }],
    ["claude-sonnet-5", { type: "disabled" }],
    ["claude-haiku-5-5", { type: "disabled" }],
    ["anthropic.claude-haiku-5-5-v1:0", { type: "disabled" }],
    ["claude-sonnet-5-5", { type: "between_tools" }],
  ])("%p 는 think:false 에 끄는 칸을 받는다", (model, thinking) => {
    expect(anthropicThinkingParams(model, false)).toEqual({ thinking });
  });

  test.each([
    "claude-opus-5-5", // 끌 수 없음("disabled" 400)
    "claude-fable-5-1", // 생각 항상 켜짐
    "claude-mythos-5-1",
    "claude-opus-4-8", // 칸을 빼면 원래 생각하지 않음
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "unparseable-model-x1", // 모르는 이름 — 넣으면 400 이 날 수 있다
  ])("%p 는 think:false 여도 칸을 넣지 않는다", (model) => {
    expect(anthropicThinkingParams(model, false)).toEqual({});
  });

  test("buildAnthropicChatRequest 가 think:false 를 thinking 칸으로 옮긴다", () => {
    const body = buildAnthropicChatRequest({
      model: "claude-haiku-5-5",
      maxTokens: 512,
      temperature: 0.1,
      think: false,
      system: undefined,
      messages: [{ role: "user", content: "안녕" }],
    });
    expect(body.thinking).toEqual({ type: "disabled" });
    const unchanged = buildAnthropicChatRequest({
      model: "claude-opus-5-5",
      maxTokens: 512,
      temperature: 0.1,
      think: false,
      system: undefined,
      messages: [{ role: "user", content: "안녕" }],
    });
    expect("thinking" in unchanged).toBe(false);
  });
});

describe("anthropicModelAcceptsSampling — 알아볼 수 없는 모델 이름 경고", () => {
  function captureWarnings(run: () => void): string[] {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      run();
    } finally {
      console.warn = orig;
    }
    return warned;
  }

  test("이름 규칙을 알아볼 수 없는 모델은 이름마다 한 번만 경고하고 temperature 를 뺀다", () => {
    const warned = captureWarnings(() => {
      expect(anthropicModelAcceptsSampling("unparseable-model-x1")).toBe(false);
      expect(anthropicModelAcceptsSampling("unparseable-model-x1")).toBe(false);
      expect(anthropicSamplingParams("unparseable-model-x1", { temperature: 0.1 })).toEqual({});
      expect(anthropicModelAcceptsSampling("claude-newfamily-1")).toBe(false);
    });
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("'unparseable-model-x1'");
    expect(warned[1]).toContain("'claude-newfamily-1'");
  });

  test("알려진 가족(받는 모델·거절 모델)은 경고하지 않는다", () => {
    const warned = captureWarnings(() => {
      anthropicModelAcceptsSampling("claude-haiku-5-5");
      anthropicModelAcceptsSampling("claude-fable-5");
      anthropicModelAcceptsSampling("claude-sonnet-4-6");
      anthropicModelAcceptsSampling("claude-3-5-sonnet-20241022");
    });
    expect(warned).toEqual([]);
  });
});
