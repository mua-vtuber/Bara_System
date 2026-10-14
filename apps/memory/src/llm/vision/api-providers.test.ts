/**
 * OpenAI·Gemini·LM Studio 이미지 캡션 공급자 (2026-10-11 llm-api-providers spec T6).
 * 공급자 자리에 진짜 로컬 HTTP 서버(Bun.serve)를 세워 요청 모양·잘림·오류를 확인한다(mock 클래스 0).
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { OpenAiVisionProvider } from "./openai.ts";
import { GeminiVisionProvider } from "./gemini.ts";
import { OpenAiCompatibleVisionProvider } from "./openai-compatible.ts";
import { createVisionProvider, type VisionProviderSettings } from "./index.ts";
import { requestVlmCaption } from "./caption-flow.ts";
import { LlmRequestError } from "../errors.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const PNG_B64 = "iVBORw==";
const GPT_KEY = "sk-test-VISION-GPT-112233";
const GEMINI_KEY = "AIza-test-VISION-GEM-445566";
let standIn: ProviderStandIn;

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => standIn.stop());

function gpt(model = "gpt-4.1-mini"): OpenAiVisionProvider {
  return new OpenAiVisionProvider({ limitSettingPath: "llm.vision.tokenCap", apiKey: GPT_KEY, model, defaultMaxTokens: 300, timeoutMs: 5000, baseUrl: `${standIn.origin}/v1` });
}
function gemini(): GeminiVisionProvider {
  return new GeminiVisionProvider({ limitSettingPath: "llm.vision.tokenCap", apiKey: GEMINI_KEY, model: "gemini-2.5-flash", defaultMaxTokens: 300, timeoutMs: 5000, baseUrl: `${standIn.origin}/v1beta` });
}

const VISION_SETTINGS: VisionProviderSettings = {
  enabled: true,
  provider: "openai",
  model: "gpt-4.1-mini",
  endpoint: null,
  apiKey: GPT_KEY,
  tokenCap: 300,
  forceCall: true,
  timeoutMs: 5000,
};

describe("OpenAiVisionProvider", () => {
  test("data URL 이미지 + max_completion_tokens + Bearer 헤더", async () => {
    standIn.reply = () => ({
      body: { choices: [{ message: { content: " 고양이 사진 " }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 6 } },
    });
    const out = await gpt().captionImage(PNG, "image/png", "설명", { temperature: 0.3 });
    expect(out).toEqual({ caption: "고양이 사진", usage: { inputTokens: 80, outputTokens: 6 }, stopReason: "stop" });
    const req = standIn.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${GPT_KEY}`);
    const body = req.body as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(300);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.3);
    const content = (body.messages as Array<{ content: unknown[] }>)[0]!.content;
    expect(content).toEqual([
      { type: "text", text: "설명" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ]);
  });

  test("temperature 를 받지 않는 모델에는 빼고 보낸다", async () => {
    standIn.reply = () => ({ body: { choices: [{ message: { content: "x" }, finish_reason: "stop" }] } });
    await gpt("gpt-5-mini").captionImage(PNG, "image/png", "설명", { temperature: 0.3 });
    expect("temperature" in (standIn.requests[0]!.body as Record<string, unknown>)).toBe(false);
  });

  test("글 없이 잘림 → tokenCap 칸 이름을 담아 던진다", async () => {
    standIn.reply = () => ({ body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } });
    await expect(gpt("gpt-5-mini").captionImage(PNG, "image/png", "설명")).rejects.toThrow("llm.vision.tokenCap");
  });
});

describe("GeminiVisionProvider", () => {
  test("inlineData 조각 + x-goog-api-key + maxOutputTokens", async () => {
    standIn.reply = () => ({
      body: { candidates: [{ content: { parts: [{ text: "강아지" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 3 } },
    });
    const out = await gemini().captionImage(PNG, "image/png", "설명", { temperature: 0.3 });
    expect(out).toEqual({ caption: "강아지", usage: { inputTokens: 300, outputTokens: 3 }, stopReason: "stop" });
    const req = standIn.requests[0]!;
    expect(req.path).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(req.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    expect(req.body).toEqual({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }, { text: "설명" }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
    });
  });

  test("생각만 하고 MAX_TOKENS → tokenCap 칸 이름을 담아 던진다", async () => {
    standIn.reply = () => ({ body: { candidates: [{ content: { parts: [{ text: "…", thought: true }] }, finishReason: "MAX_TOKENS" }] } });
    await expect(gemini().captionImage(PNG, "image/png", "설명")).rejects.toThrow("llm.vision.tokenCap");
  });
});

describe("OpenAiCompatibleVisionProvider — 공통 본체로 옮긴 뒤", () => {
  test("HTTP 실패는 상태 코드를 담은 LlmRequestError", async () => {
    standIn.reply = () => ({ status: 503, body: "busy" });
    const provider = new OpenAiCompatibleVisionProvider({ limitSettingPath: "llm.vision.tokenCap", baseUrl: `${standIn.origin}/v1`, model: "local-vlm", timeoutMs: 5000 });
    const err = await provider.captionImage(PNG, "image/png", "설명").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBe(503);
    expect((err as LlmRequestError).provider).toBe("openai_compatible");
  });

  test("finish_reason=length 이면 stopReason=max_tokens 를 함께 돌려준다", async () => {
    standIn.reply = () => ({ body: { choices: [{ message: { content: "잘린 설명" }, finish_reason: "length" }] } });
    const provider = new OpenAiCompatibleVisionProvider({ limitSettingPath: "llm.vision.tokenCap", baseUrl: `${standIn.origin}/v1`, model: "local-vlm", timeoutMs: 5000 });
    const out = await provider.captionImage(PNG, "image/png", "설명");
    expect(out.caption).toBe("잘린 설명");
    expect(out.stopReason).toBe("max_tokens");
  });
});

describe("caption-flow — 잘린 캡션은 저장하고 경고", () => {
  const baseArgs = {
    parentNodeId: 7,
    assetSha256: "abc",
    imageBuffer: PNG,
    mimeType: "image/png",
    visionSettings: VISION_SETTINGS,
    hasEmbedding: false,
  };

  test("글이 있는 잘림 → 캡션 회수 + tokenCap 경고 한 줄", async () => {
    standIn.reply = () => ({ body: { choices: [{ message: { content: "앞부분 설명" }, finish_reason: "length" }] } });
    const warn = spyOn(console, "warn");
    try {
      const out = await requestVlmCaption({ ...baseArgs, provider: gpt() });
      expect(out).toEqual({ called: true, caption: "앞부분 설명" });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("[vision] 캡션이 출력 한도(tokenCap=300)에서 잘림 — llm.vision.tokenCap 을 올려라"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("글 없는 잘림 → called=true, caption=null (자산 저장 흐름은 막지 않음)", async () => {
    standIn.reply = () => ({ body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } });
    const warn = spyOn(console, "warn");
    try {
      const out = await requestVlmCaption({ ...baseArgs, provider: gpt() });
      expect(out).toMatchObject({ called: true, caption: null });
      expect((out as { failure?: unknown }).failure).toBeInstanceOf(Error);
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("llm.vision.tokenCap"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createVisionProvider — OpenAI·Gemini 분기", () => {
  test("키 빈칸은 gptApiKey / geminiApiKey 칸 이름, 모델 빈칸은 gptModel / geminiModel 칸 이름", () => {
    expect(() => createVisionProvider({ ...VISION_SETTINGS, apiKey: "" })).toThrow("settings.llm.vision.gptApiKey");
    expect(() => createVisionProvider({ ...VISION_SETTINGS, provider: "google", apiKey: null })).toThrow(
      "settings.llm.vision.geminiApiKey",
    );
    expect(() => createVisionProvider({ ...VISION_SETTINGS, model: "" })).toThrow("settings.llm.vision.gptModel");
    expect(() => createVisionProvider({ ...VISION_SETTINGS, provider: "google", model: "" })).toThrow(
      "settings.llm.vision.geminiModel",
    );
  });

  test("정상 설정이면 공급자 이름이 맞는 캡션 공급자를 만든다", () => {
    expect(createVisionProvider(VISION_SETTINGS)?.name).toBe("openai:gpt-4.1-mini");
    expect(createVisionProvider({ ...VISION_SETTINGS, provider: "google", model: "gemini-2.5-flash" })?.name).toBe(
      "google:gemini-2.5-flash",
    );
  });
});
