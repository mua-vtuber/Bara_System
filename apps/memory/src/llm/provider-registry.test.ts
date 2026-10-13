import { describe, expect, test } from "bun:test";
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_SPECS,
  isLlmProvider,
  providersForMode,
} from "./provider-registry.ts";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA } from "../settings/memory-schema.ts";

const SLOTS = ["extractor", "cleanup", "vision"] as const;

describe("공급자 표 — 단일 출처", () => {
  test("모든 공급자 값이 표에 한 줄씩 있고 표에 남는 줄도 없다", () => {
    expect(Object.keys(LLM_PROVIDER_SPECS).sort()).toEqual([...LLM_PROVIDERS].sort());
  });

  test("키가 필요한 공급자는 키 칸이 있고, 키 칸이 없는 공급자는 키가 필요 없다", () => {
    for (const provider of LLM_PROVIDERS) {
      const spec = LLM_PROVIDER_SPECS[provider];
      if (spec.apiKeyRequired) expect(spec.apiKeyField).not.toBeNull();
      if (spec.apiKeyField === null) expect(spec.apiKeyRequired).toBe(false);
    }
  });

  test("처리 방법 분류 — 서버 AI 는 Ollama·LM Studio, API 는 Anthropic·OpenAI·Google", () => {
    expect(providersForMode("server")).toEqual(["ollama", "openai_compatible"]);
    expect(providersForMode("api")).toEqual(["anthropic", "openai", "google"]);
  });

  test("isLlmProvider — 표 밖 값과 문자열이 아닌 값은 거절", () => {
    for (const p of LLM_PROVIDERS) expect(isLlmProvider(p)).toBe(true);
    expect(isLlmProvider("pc_companion")).toBe(false);
    expect(isLlmProvider("")).toBe(false);
    expect(isLlmProvider(undefined)).toBe(false);
    expect(isLlmProvider(1)).toBe(false);
  });

  test("세 슬롯 스키마의 provider 선택지 = LLM_PROVIDERS", () => {
    const llm = MEMORY_SCHEMA.properties.llm.properties;
    for (const slot of SLOTS) {
      expect([...llm[slot].properties.provider.enum]).toEqual([...LLM_PROVIDERS]);
    }
  });

  test("표가 가리키는 칸이 세 슬롯 기본값에 모두 문자열로 있다", () => {
    for (const slot of SLOTS) {
      const defaults = MEMORY_DEFAULTS.llm[slot] as unknown as Record<string, unknown>;
      for (const provider of LLM_PROVIDERS) {
        const spec = LLM_PROVIDER_SPECS[provider];
        for (const field of [spec.modelField, spec.apiKeyField, spec.baseUrlField]) {
          if (field === null) continue;
          expect(typeof defaults[field]).toBe("string");
        }
      }
    }
  });

  test("GPT·Gemini 모델·키 기본값은 빈 칸 (모델 이름을 코드에 박지 않음)", () => {
    for (const slot of SLOTS) {
      const d = MEMORY_DEFAULTS.llm[slot];
      expect(d.gptModel).toBe("");
      expect(d.gptApiKey).toBe("");
      expect(d.geminiModel).toBe("");
      expect(d.geminiApiKey).toBe("");
    }
  });
});
