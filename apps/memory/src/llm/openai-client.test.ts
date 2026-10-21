import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OpenAiClient } from "./openai-client.ts";
import { LlmRequestError } from "./errors.ts";
import { classifyLlmError } from "../memory/cleanup-deep-pass/error-classifier.ts";
import { startProviderStandIn, type ProviderStandIn } from "../test-utils/provider-stand-in.ts";

const FAKE_KEY = "sk-test-OPENAI-FAKE-0123456789";
let standIn: ProviderStandIn;

beforeAll(() => {
  standIn = startProviderStandIn();
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => standIn.stop());

function client(model: string, timeoutMs = 5000): OpenAiClient {
  return new OpenAiClient({ apiKey: FAKE_KEY, model, timeoutMs, baseUrl: `${standIn.origin}/v1` });
}

function okReply(content: string, finish = "stop", usage?: unknown) {
  return () => ({ body: { choices: [{ message: { content }, finish_reason: finish }], ...(usage ? { usage } : {}) } });
}

describe("OpenAiClient — 요청 모양", () => {
  test("Bearer 헤더에만 키, URL 에는 없음, 출력 한도는 max_completion_tokens, JSON 스키마 강제", async () => {
    standIn.reply = okReply('{"ok":true}');
    const out = await client("gpt-4o").chat(
      [
        { role: "system", content: "JSON으로 답하라" },
        { role: "user", content: "ping" },
      ],
      { temperature: 0.1, maxOutputTokens: 64, jsonSchema: { type: "object" } },
    );
    expect(out).toBe('{"ok":true}');
    const req = standIn.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.path + req.search).not.toContain(FAKE_KEY);
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.1);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "bara_response", schema: { type: "object" }, strict: false },
    });
  });

  test("최상위가 배열인 JSON 스키마는 {items: 배열} 객체로 감싸 보낸다(Structured Outputs 는 최상위 객체만)", async () => {
    standIn.reply = okReply('{"items":[]}');
    const arraySchema = { type: "array", items: { type: "object" } };
    await client("gpt-4o").chat([{ role: "user", content: "ping" }], { jsonSchema: arraySchema });
    const body = standIn.requests[0]!.body as { response_format: { json_schema: { schema: unknown } } };
    expect(body.response_format.json_schema.schema).toEqual({
      type: "object",
      properties: { items: arraySchema },
      required: ["items"],
      additionalProperties: false,
    });
  });

  test("think:false 는 OpenAI 요청에 아무 칸도 더하지 않는다(끄는 규칙 미확인 — 지금 동작 그대로)", async () => {
    standIn.reply = okReply("응답");
    await client("gpt-5").chat([{ role: "user", content: "ping" }], { think: false });
    const body = standIn.requests[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
  });

  test("temperature 를 받지 않는 모델(gpt-5)에는 칸을 빼고 보낸다", async () => {
    standIn.reply = okReply("응답");
    await client("gpt-5").chat([{ role: "user", content: "ping" }], { temperature: 0.2, maxOutputTokens: 10 });
    const body = standIn.requests[0]!.body as Record<string, unknown>;
    expect("temperature" in body).toBe(false);
    expect(body.max_completion_tokens).toBe(10);
  });
});

describe("OpenAiClient — 잘림·사용량", () => {
  test("사용량: 캐시 읽기는 입력에서 빼고 출력은 추론 포함 completion_tokens", async () => {
    standIn.reply = okReply("ok", "stop", {
      prompt_tokens: 1000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 200 },
    });
    const result = await client("gpt-5").chatDetailed([{ role: "user", content: "ping" }]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 600, outputTokens: 300, cacheReadTokens: 400, cacheWriteTokens: 0 });
  });

  test("추론에 한도를 다 써 글 없이 잘림 → 빈 글 + max_tokens, chat() 은 던짐", async () => {
    standIn.reply = okReply("", "length", { prompt_tokens: 10, completion_tokens: 64 });
    const result = await client("gpt-5").chatDetailed([{ role: "user", content: "ping" }], { maxOutputTokens: 64 });
    expect(result.text).toBe("");
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage?.outputTokens).toBe(64);
    await expect(client("gpt-5").chat([{ role: "user", content: "ping" }])).rejects.toThrow("stopReason=max_tokens");
  });

  test("usage 칸이 없으면 null", async () => {
    standIn.reply = okReply("ok");
    expect((await client("gpt-4o").chatDetailed([{ role: "user", content: "x" }])).usage).toBeNull();
  });
});

describe("OpenAiClient — 실패 분류", () => {
  async function caught(c: OpenAiClient): Promise<LlmRequestError> {
    const err = await c.chatDetailed([{ role: "user", content: "ping" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    return err as LlmRequestError;
  }

  test("401 → status 401·code·설정 결함(config), 오류 문장에 키 없음", async () => {
    standIn.reply = () => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${FAKE_KEY}`, type: "invalid_request_error", code: "invalid_api_key" } },
    });
    const err = await caught(client("gpt-4o"));
    expect(err.provider).toBe("openai");
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).not.toContain(FAKE_KEY);
    expect(classifyLlmError(err)).toBe("config");
  });

  test("429 + Retry-After → 일시(transient), retryAfterMs 보존", async () => {
    standIn.reply = () => ({ status: 429, headers: { "retry-after": "7" }, body: { error: { message: "slow down" } } });
    const err = await caught(client("gpt-4o"));
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
    expect(classifyLlmError(err)).toBe("transient");
  });

  test("timeout → timedOut=true, status=null", async () => {
    standIn.reply = () => ({ hang: true });
    const err = await caught(client("gpt-4o", 80));
    expect(err.timedOut).toBe(true);
    expect(err.status).toBeNull();
    expect(classifyLlmError(err)).toBe("transient");
  });
});

describe("OpenAiClient — 빈칸은 칸 이름을 대며 멈춘다", () => {
  test("키 빈칸 → gptApiKey 이름, 모델 빈칸 → gptModel 이름", () => {
    expect(() => new OpenAiClient({ apiKey: "", model: "gpt-4o", timeoutMs: 1000 })).toThrow("gptApiKey");
    expect(() => new OpenAiClient({ apiKey: FAKE_KEY, model: " ", timeoutMs: 1000 })).toThrow("gptModel");
  });
});
