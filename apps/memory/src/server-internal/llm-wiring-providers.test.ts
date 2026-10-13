/**
 * buildLlmClient(WithReason) — OpenAI·Gemini 배선과 빈칸 사유 (2026-10-11 llm-api-providers spec T7).
 * 실제 클래스만 만든다(mock 0). 네트워크는 쓰지 않는다 — 어느 클래스·칸으로 만들었는지만 본다.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { buildLlmClient, buildLlmClientWithReason, type LlmClientSlot } from "./llm-wiring.ts";
import { OpenAiClient } from "../llm/openai-client.ts";
import { GeminiClient } from "../llm/gemini-client.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { buildCleanupGateInput } from "../memory/cleanup-deep-pass/entity-register/boot-wiring.ts";
import { cleanupDeepPassGateReasons } from "../memory/cleanup-deep-pass/scheduler-gate.ts";
import type { MemorySettings } from "../settings/memory-settings-types.ts";

const FAKE_GPT = "sk-gpt-test-WIRING-77";
const FAKE_GEMINI = "gm-test-WIRING-88";

function slot(overrides: Partial<LlmClientSlot> = {}): LlmClientSlot {
  return { ...structuredClone(MEMORY_DEFAULTS.llm.cleanup), timeoutMs: 60_000, ...overrides };
}

/** 실패 경로는 에러 로그를 남긴다 — 테스트 출력에 섞이지 않게 잠시 가린다. */
function quietErrors<T>(fn: () => T): T {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe("buildLlmClient — 공급자별 클래스와 칸", () => {
  test("openai → OpenAiClient(gptModel), google → GeminiClient(geminiModel)", () => {
    const gpt = buildLlmClient("openai", slot({ gptApiKey: FAKE_GPT, gptModel: "gpt-4.1" }), "llm.cleanup");
    expect(gpt).toBeInstanceOf(OpenAiClient);
    expect(gpt!.name).toBe("openai:gpt-4.1");
    const gem = buildLlmClient("google", slot({ geminiApiKey: FAKE_GEMINI, geminiModel: "gemini-2.5-pro" }), "llm.cleanup");
    expect(gem).toBeInstanceOf(GeminiClient);
    expect(gem!.name).toBe("google:gemini-2.5-pro");
  });

  test("다른 공급자의 키·모델 칸은 섞어 쓰지 않는다 (openai 를 골랐는데 LM Studio 칸만 찬 경우)", () => {
    const result = quietErrors(() =>
      buildLlmClientWithReason("openai", slot({ openaiApiKey: FAKE_GPT, openaiModel: "gpt-4.1" }), "llm.cleanup"),
    );
    expect(result.client).toBeNull();
    expect(result.reason).toBe("openai: llm.cleanup.gptApiKey 이 비어 있음");
  });
});

describe("buildLlmClientWithReason — 빈칸 사유(칸 이름만, 키 값 없음)", () => {
  test("키 빈칸 → 키 칸 이름, 모델 빈칸 → 모델 칸 이름", () => {
    const noKey = quietErrors(() => buildLlmClientWithReason("google", slot({ geminiModel: "gemini-2.5-flash" }), "llm.extractor"));
    expect(noKey).toEqual({ client: null, reason: "google: llm.extractor.geminiApiKey 이 비어 있음" });
    const noModel = quietErrors(() => buildLlmClientWithReason("openai", slot({ gptApiKey: FAKE_GPT }), "llm.cleanup"));
    expect(noModel.reason).toBe("openai: llm.cleanup.gptModel 이 비어 있음");
    expect(noModel.reason).not.toContain(FAKE_GPT);
  });

  test("호출 한도가 넘어오지 않으면 API 공급자는 사유를 대며 실패", () => {
    const s = slot({ gptApiKey: FAKE_GPT, gptModel: "gpt-4.1" });
    delete s.timeoutMs;
    const result = quietErrors(() => buildLlmClientWithReason("openai", s, "llm.cleanup"));
    expect(result.client).toBeNull();
    expect(result.reason).toContain("timeoutMs");
  });

  test("none 은 사유 없이 null", () => {
    expect(buildLlmClientWithReason("none", slot(), "llm.cleanup")).toEqual({ client: null, reason: null });
  });
});

describe("정리 게이트 사유에 구성 실패 원인이 붙는다", () => {
  test("cleanupLlmFailureReason 이 있으면 사유 문장 뒤에 괄호로 붙는다", () => {
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.llm.cleanup.enabled = true;
    settings.llm.cleanup.provider = "openai";
    settings.llm.cleanup.gptModel = "gpt-4.1";
    const build = quietErrors(() =>
      buildLlmClientWithReason("openai", { ...settings.llm.cleanup, timeoutMs: 1000 }, "llm.cleanup"),
    );
    const reasons = cleanupDeepPassGateReasons(
      buildCleanupGateInput(settings, {
        cleanupLlmAvailable: build.client !== null,
        cleanupLlmFailureReason: build.reason,
        regexAvailable: false,
      }),
    );
    expect(reasons).toContain("cleanup LLM 클라이언트 구성 실패 (openai: llm.cleanup.gptApiKey 이 비어 있음)");
  });

  test("사유를 모르면 옛 문장 그대로", () => {
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.llm.cleanup.enabled = true;
    const reasons = cleanupDeepPassGateReasons(
      buildCleanupGateInput(settings, { cleanupLlmAvailable: false, regexAvailable: false }),
    );
    expect(reasons).toContain("cleanup LLM 클라이언트 구성 실패");
  });
});
