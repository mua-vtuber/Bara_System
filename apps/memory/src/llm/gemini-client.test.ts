import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GeminiClient } from "./gemini-client.ts";
import { LlmRequestError } from "./errors.ts";
import { classifyLlmError } from "../memory/cleanup-deep-pass/error-classifier.ts";
import { startProviderStandIn, type ProviderStandIn } from "../test-utils/provider-stand-in.ts";

const FAKE_KEY = "AIza-test-GEMINI-FAKE-abcdef123456";
let standIn: ProviderStandIn;

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => standIn.stop());

function client(model = "gemini-2.5-flash", timeoutMs = 5000): GeminiClient {
  return new GeminiClient({ apiKey: FAKE_KEY, model, timeoutMs, baseUrl: `${standIn.origin}/v1beta` });
}

const OK_BODY = {
  candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
};

describe("GeminiClient — 요청 모양", () => {
  test("x-goog-api-key 헤더에만 키, URL 에 없음, 공식 generateContent 경로, systemInstruction·generationConfig", async () => {
    standIn.reply = () => ({ body: OK_BODY });
    const out = await client("models/gemini-2.5-flash").chat(
      [
        { role: "system", content: "JSON으로" },
        { role: "user", content: "ping" },
      ],
      { temperature: 0.1, maxOutputTokens: 32, jsonSchema: { type: "object" } },
    );
    expect(out).toBe('{"ok":true}');
    const req = standIn.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(req.search).toBe("");
    expect(req.headers["x-goog-api-key"]).toBe(FAKE_KEY);
    expect(req.headers.authorization).toBeUndefined();
    expect(JSON.stringify(req.body)).not.toContain(FAKE_KEY);
    const body = req.body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "JSON으로" }] });
    expect(body.generationConfig).toEqual({
      temperature: 0.1,
      maxOutputTokens: 32,
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
  });

  test("사용량 정규화", async () => {
    standIn.reply = () => ({ body: OK_BODY });
    const result = await client().chatDetailed([{ role: "user", content: "ping" }]);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(result.stopReason).toBe("stop");
  });
});

describe("GeminiClient — 잘림·차단", () => {
  test("MAX_TOKENS + 생각만 → chatDetailed 빈 글 + max_tokens, chat() 은 던짐", async () => {
    standIn.reply = () => ({
      body: { candidates: [{ content: { parts: [{ text: "…", thought: true }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 5, thoughtsTokenCount: 32 } },
    });
    const result = await client().chatDetailed([{ role: "user", content: "ping" }], { maxOutputTokens: 32 });
    expect(result).toEqual({ text: "", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 32, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    await expect(client().chat([{ role: "user", content: "ping" }])).rejects.toThrow("stopReason=max_tokens");
  });

  test("promptFeedback.blockReason → 결정적 실패로 던진다(LlmRequestError 아님)", async () => {
    standIn.reply = () => ({ body: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } } });
    const err = await client().chatDetailed([{ role: "user", content: "x" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LlmRequestError);
    expect((err as Error).message).toContain("PROHIBITED_CONTENT");
  });
});

describe("GeminiClient — 실패 분류", () => {
  async function caught(c: GeminiClient): Promise<LlmRequestError> {
    const err = await c.chatDetailed([{ role: "user", content: "ping" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    return err as LlmRequestError;
  }

  test("잘못된 키 400 → 설정 결함(config), code=INVALID_ARGUMENT, 문장에 키 없음", async () => {
    standIn.reply = () => ({
      status: 400,
      body: { error: { code: 400, message: `API key not valid: ${FAKE_KEY}`, status: "INVALID_ARGUMENT" } },
    });
    const err = await caught(client());
    expect(err.provider).toBe("google");
    expect(err.status).toBe(400);
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(err.message).not.toContain(FAKE_KEY);
    expect(classifyLlmError(err)).toBe("config");
  });

  test("429 RESOURCE_EXHAUSTED + Retry-After → 일시", async () => {
    standIn.reply = () => ({ status: 429, headers: { "retry-after": "3" }, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } } });
    const err = await caught(client());
    expect(err.code).toBe("RESOURCE_EXHAUSTED");
    expect(err.retryAfterMs).toBe(3000);
    expect(classifyLlmError(err)).toBe("transient");
  });

  test("timeout → timedOut=true", async () => {
    standIn.reply = () => ({ hang: true });
    const err = await caught(client("gemini-2.5-flash", 80));
    expect(err.timedOut).toBe(true);
  });

  test("키·모델 빈칸은 칸 이름을 대며 멈춘다", () => {
    expect(() => new GeminiClient({ apiKey: "", model: "gemini-2.5-flash", timeoutMs: 1000 })).toThrow("geminiApiKey");
    expect(() => new GeminiClient({ apiKey: FAKE_KEY, model: "models/", timeoutMs: 1000 })).toThrow("geminiModel");
  });
});
