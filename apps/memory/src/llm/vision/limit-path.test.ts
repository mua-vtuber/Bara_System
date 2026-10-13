/**
 * 이미지 캡션 공급자 일반화 (2026-10-11 document-ocr spec T2).
 * 한도 칸 경로 인자(limitSettingPath)·Anthropic 호출 한도·Ollama 종료 사유/오류 형식/문맥 길이를 진짜 로컬 HTTP
 * 서버(Bun.serve)로 확인한다(mock 클래스 0).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AnthropicVisionProvider } from "./anthropic.ts";
import { OllamaVisionProvider } from "./ollama.ts";
import { OpenAiVisionProvider } from "./openai.ts";
import { OpenAiCompatibleVisionProvider } from "./openai-compatible.ts";
import { GeminiVisionProvider } from "./gemini.ts";
import { createVisionProvider, type VisionProvider } from "./index.ts";
import { LlmRequestError } from "../errors.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const OCR_PATH = "documents.ocr.maxOutputTokensPerPage";
let standIn: ProviderStandIn;

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => standIn.stop());

const anthropicTruncatedEmpty = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-x",
  content: [], stop_reason: "max_tokens", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 8192 },
};

/** 공급자 여섯 갈래 — 글 없이 잘린 응답을 돌려주는 대역 응답과 함께. */
function providers(limit: string): Array<{ name: string; make: () => VisionProvider; reply: unknown }> {
  const origin = { get value() { return standIn.origin; } };
  return [
    {
      name: "anthropic",
      make: () => new AnthropicVisionProvider({ limitSettingPath: limit, apiKey: "sk-ant-test", model: "claude-x", baseURL: origin.value, timeoutMs: 5000, maxRetries: 0 }),
      reply: anthropicTruncatedEmpty,
    },
    {
      name: "openai",
      make: () => new OpenAiVisionProvider({ limitSettingPath: limit, apiKey: "sk-test", model: "gpt-4.1", defaultMaxTokens: 100, timeoutMs: 5000, baseUrl: `${origin.value}/v1` }),
      reply: { choices: [{ message: { content: "" }, finish_reason: "length" }] },
    },
    {
      name: "google",
      make: () => new GeminiVisionProvider({ limitSettingPath: limit, apiKey: "gm-test", model: "gemini-x", defaultMaxTokens: 100, timeoutMs: 5000, baseUrl: `${origin.value}/v1beta` }),
      reply: { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] },
    },
    {
      name: "openai_compatible",
      make: () => new OpenAiCompatibleVisionProvider({ limitSettingPath: limit, baseUrl: `${origin.value}/v1`, model: "local", timeoutMs: 5000 }),
      reply: { choices: [{ message: { content: "" }, finish_reason: "length" }] },
    },
    {
      name: "lmstudio(openai_compatible)",
      make: () => new OpenAiCompatibleVisionProvider({ limitSettingPath: limit, baseUrl: `${origin.value}/v1`, model: "lm-vlm", timeoutMs: 5000 }),
      reply: { choices: [{ message: { content: "" }, finish_reason: "length" }] },
    },
    {
      name: "ollama",
      make: () => new OllamaVisionProvider({ limitSettingPath: limit, baseUrl: origin.value, model: "qwen3-vl", timeoutMs: 5000 }),
      reply: { model: "qwen3-vl", message: { role: "assistant", content: "" }, done: true, done_reason: "length" },
    },
  ];
}

describe("limitSettingPath — 글 없이 잘린 응답 오류 문장", () => {
  for (const p of providers(OCR_PATH)) {
    test(`${p.name}: 오류 문장에 넘긴 한도 칸 경로가 들어간다`, async () => {
      standIn.reply = () => ({ body: p.reply });
      await expect(p.make().captionImage(PNG, "image/png", "read", { maxTokens: 50 })).rejects.toThrow(OCR_PATH);
    });
  }

  test("빈 limitSettingPath 는 생성 시점에 이름을 대며 멈춘다", () => {
    expect(() => new OllamaVisionProvider({ limitSettingPath: "", baseUrl: "http://x", model: "m" })).toThrow(
      "limitSettingPath",
    );
    expect(() => new AnthropicVisionProvider({ limitSettingPath: " ", apiKey: "k", model: "m" })).toThrow(
      "limitSettingPath",
    );
  });

  test("캡션 배선(createVisionProvider)은 지금처럼 llm.vision.tokenCap 을 쓴다", async () => {
    standIn.reply = () => ({ body: { model: "q", message: { role: "assistant", content: "" }, done: true, done_reason: "length" } });
    const provider = createVisionProvider({
      enabled: true, provider: "ollama", model: "q", endpoint: standIn.origin, apiKey: null,
      tokenCap: 100, forceCall: true, timeoutMs: 5000,
    })!;
    await expect(provider.captionImage(PNG, "image/png", "p")).rejects.toThrow("llm.vision.tokenCap");
  });
});

describe("빈 글 — 이미지 캡션은 지금처럼 오류, 문서 OCR(allowEmptyText)만 빈 caption", () => {
  const emptyStop: Record<string, unknown> = {
    openai: { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    google: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
    ollama: { model: "q", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    anthropic: { ...anthropicTruncatedEmpty, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
  };
  for (const p of providers("llm.vision.tokenCap")) {
    const key = p.name.startsWith("lmstudio") || p.name === "openai_compatible" ? "openai" : p.name;
    test(`${p.name}: 캡션은 던지고, allowEmptyText 면 빈 caption + stop`, async () => {
      standIn.reply = () => ({ body: emptyStop[key] });
      await expect(p.make().captionImage(PNG, "image/png", "p")).rejects.toThrow();
      const out = await p.make().captionImage(PNG, "image/png", "p", { allowEmptyText: true });
      expect(out.caption).toBe("");
      expect(out.stopReason).toBe("stop");
    });
  }
});

describe("AnthropicVisionProvider — 호출 한도", () => {
  test("timeoutMs 를 주면 큰 출력 한도에서도 SDK 가 스트리밍 요구로 던지지 않는다", async () => {
    standIn.reply = () => ({
      body: { ...anthropicTruncatedEmpty, content: [{ type: "text", text: "본문" }], stop_reason: "end_turn" },
    });
    const provider = new AnthropicVisionProvider({
      limitSettingPath: OCR_PATH, apiKey: "sk-ant-test", model: "claude-x", baseURL: standIn.origin,
      timeoutMs: 5000, maxRetries: 0, defaultMaxTokens: 64000,
    });
    const out = await provider.captionImage(PNG, "image/png", "read");
    expect(out.caption).toBe("본문");
    expect(out.stopReason).toBe("stop");
    expect((standIn.requests[0]!.body as { max_tokens: number }).max_tokens).toBe(64000);
  });

  test("timeoutMs 를 넘기면 끊긴다(재시도 0 이면 요청 1번)", async () => {
    standIn.reply = () => ({ hang: true });
    const provider = new AnthropicVisionProvider({
      limitSettingPath: OCR_PATH, apiKey: "sk-ant-test", model: "claude-x", baseURL: standIn.origin,
      timeoutMs: 300, maxRetries: 0,
    });
    await expect(provider.captionImage(PNG, "image/png", "read")).rejects.toThrow();
    expect(standIn.requests.length).toBe(1);
  });
});

describe("OllamaVisionProvider — 종료 사유·오류 형식·문맥 길이", () => {
  const make = (timeoutMs = 5000) =>
    new OllamaVisionProvider({ limitSettingPath: OCR_PATH, baseUrl: standIn.origin, model: "qwen3-vl", timeoutMs });

  test("done_reason stop→stop, length→max_tokens, 그 밖·없음→other", async () => {
    const cases: Array<[string | undefined, string]> = [["stop", "stop"], ["length", "max_tokens"], ["load", "other"], [undefined, "other"]];
    for (const [doneReason, expected] of cases) {
      standIn.reply = () => ({
        body: { model: "q", message: { role: "assistant", content: "글" }, done: true, ...(doneReason ? { done_reason: doneReason } : {}) },
      });
      expect((await make().captionImage(PNG, "image/png", "p")).stopReason).toBe(expected as never);
    }
  });

  test("numCtx 를 주면 options.num_ctx 로 보내고, 안 주면 보내지 않는다", async () => {
    standIn.reply = () => ({ body: { model: "q", message: { role: "assistant", content: "글" }, done: true, done_reason: "stop" } });
    await make().captionImage(PNG, "image/png", "p", { maxTokens: 8192, numCtx: 16384 });
    await make().captionImage(PNG, "image/png", "p");
    const first = standIn.requests[0]!.body as { options: Record<string, unknown> };
    const second = standIn.requests[1]!.body as { options: Record<string, unknown> };
    expect(first.options.num_ctx).toBe(16384);
    expect(first.options.num_predict).toBe(8192);
    expect("num_ctx" in second.options).toBe(false);
  });

  test("2xx 아님 → LlmRequestError{provider:ollama, status}", async () => {
    standIn.reply = () => ({ status: 503, body: { error: "busy" } });
    const err = await make().captionImage(PNG, "image/png", "p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).provider).toBe("ollama");
    expect((err as LlmRequestError).status).toBe(503);
  });

  test("시간 초과 → LlmRequestError{timedOut:true}", async () => {
    standIn.reply = () => ({ hang: true });
    const err = await make(200).captionImage(PNG, "image/png", "p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).timedOut).toBe(true);
  });
});
