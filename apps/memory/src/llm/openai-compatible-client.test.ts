import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OpenAiCompatibleClient } from "./openai-compatible-client.ts";
import { LlmRequestError } from "./errors.ts";

interface CapturedRequest {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** 다음 응답의 HTTP 상태·헤더·본문을 통째로 갈아끼운다(오류 응답 흉내용). */
interface StatusOverride {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

let captured: CapturedRequest[] = [];
let server: ReturnType<typeof Bun.serve>;
/** 다음 응답에 실을 필드를 갈아끼운다 — 기본 choices[0].message 위에 override 를 얹는다. */
let nextResponseOverride: Record<string, unknown> = {};
let nextStatusOverride: StatusOverride | null = null;
let hang = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as Record<string, unknown>;
        captured.push({
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          body,
        });
        if (hang) {
          await new Promise(() => {});
        }
        if (nextStatusOverride) {
          return new Response(nextStatusOverride.body ?? "error", {
            status: nextStatusOverride.status,
            headers: nextStatusOverride.headers ?? {},
          });
        }
        return Response.json({
          choices: [{ message: { content: '{"ok":true}' } }],
          ...nextResponseOverride,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  nextResponseOverride = {};
  nextStatusOverride = null;
  hang = false;
});

afterAll(() => {
  server.stop();
});

describe("OpenAiCompatibleClient", () => {
  test("OpenAI-compatible chat completions body/headers 를 직렬화한다", async () => {
    captured = [];
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
      apiKey: "test-key",
      timeoutMs: 5000,
    });

    const out = await client.chat(
      [
        { role: "system", content: "JSON으로 답하라" },
        { role: "user", content: "ping" },
      ],
      {
        temperature: 0.1,
        maxOutputTokens: 64,
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    );

    expect(out).toBe('{"ok":true}');
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.authorization).toBe("Bearer test-key");
    expect(req.body.model).toBe("local-model");
    expect(req.body.stream).toBe(false);
    expect(req.body.max_tokens).toBe(64);
    expect(req.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "bara_response",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        strict: false,
      },
    });
  });
});

describe("OpenAiCompatibleClient — 최상위 배열 JSON 스키마", () => {
  test("호환 서버에는 최상위 배열 스키마를 감싸지 않고 그대로 보낸다", async () => {
    captured = [];
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
      timeoutMs: 5000,
    });
    const arraySchema = { type: "array", items: { type: "object" } };
    await client.chat([{ role: "user", content: "ping" }], { jsonSchema: arraySchema });
    const format = captured[0]!.body.response_format as { json_schema: { schema: unknown } };
    expect(format.json_schema.schema).toEqual(arraySchema);
  });
});

describe("OpenAiCompatibleClient.chatDetailed() — stopReason·usage 정규화 (A-1)", () => {
  test("finish_reason=stop + usage → stopReason='stop', usage 매핑(캐시 읽기는 입력에서 뺀다)", async () => {
    nextResponseOverride = {
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    const result = await client.chatDetailed([{ role: "user", content: "ping" }]);

    expect(result.text).toBe('{"ok":true}');
    expect(result.stopReason).toBe("stop");
    // 사용량 뜻 통일(2026-10-11 spec D7) — inputTokens 는 캐시에서 읽지 않은 입력(100 − 30).
    expect(result.usage).toEqual({
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
  });

  test("finish_reason=length → stopReason='max_tokens' (잘림 정규화)", async () => {
    nextResponseOverride = {
      choices: [{ message: { content: "잘린 응답" }, finish_reason: "length" }],
    };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    const result = await client.chatDetailed([{ role: "user", content: "ping" }]);

    expect(result.stopReason).toBe("max_tokens");
  });

  test("finish_reason 미제공 → stopReason='other' (사유를 지어내지 않는다)", async () => {
    nextResponseOverride = {
      choices: [{ message: { content: "응답" } }],
    };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    const result = await client.chatDetailed([{ role: "user", content: "ping" }]);

    expect(result.stopReason).toBe("other");
  });

  test("usage 칸 자체 미제공 → usage=null (0 위장 금지)", async () => {
    nextResponseOverride = {
      choices: [{ message: { content: "응답" }, finish_reason: "stop" }],
    };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    const result = await client.chatDetailed([{ role: "user", content: "ping" }]);

    expect(result.usage).toBeNull();
  });

  test("chat() 은 chatDetailed().text 위임 — 기존 소비처 회귀 0", async () => {
    nextResponseOverride = {
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    const reply = await client.chat([{ role: "user", content: "ping" }]);

    expect(reply).toBe('{"ok":true}');
  });
});

describe("OpenAiCompatibleClient — LlmRequestError throw 경로 (A-2)", () => {
  test("429 + Retry-After → LlmRequestError(status=429, retryAfterMs 보존)", async () => {
    nextStatusOverride = {
      status: 429,
      headers: { "retry-after": "5" },
      body: "rate limited",
    };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "ping" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.provider).toBe("openai_compatible");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.timedOut).toBe(false);
  });

  test("503 → LlmRequestError(status=503)", async () => {
    nextStatusOverride = { status: 503, body: "unavailable" };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
    });

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "ping" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    expect((caught as LlmRequestError).status).toBe(503);
  });

  test("timeout → LlmRequestError(timedOut=true, status=null)", async () => {
    hang = true;
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
      timeoutMs: 80,
    });

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "ping" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.timedOut).toBe(true);
    expect(err.status).toBeNull();
  });
});

describe("OpenAiCompatibleClient — 글 없이 잘린 응답 (2026-10-11 spec D7)", () => {
  test("빈 글 + finish_reason=length → chatDetailed 는 {text:'', stopReason:'max_tokens'} + 사용량", async () => {
    nextResponseOverride = {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 50, completion_tokens: 64 },
    };
    const client = new OpenAiCompatibleClient({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "local-model" });
    const result = await client.chatDetailed([{ role: "user", content: "ping" }]);
    expect(result).toEqual({
      text: "",
      stopReason: "max_tokens",
      usage: { inputTokens: 50, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  test("빈 글 + 잘림 → chat() 은 빈 답을 넘기지 않고 던진다", async () => {
    nextResponseOverride = { choices: [{ message: { content: "" }, finish_reason: "length" }] };
    const client = new OpenAiCompatibleClient({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "local-model" });
    await expect(client.chat([{ role: "user", content: "ping" }])).rejects.toThrow("stopReason=max_tokens");
  });

  test("잘림이 아닌데 글이 없으면 chatDetailed 도 던진다", async () => {
    nextResponseOverride = { choices: [{ message: { content: "" }, finish_reason: "stop" }] };
    const client = new OpenAiCompatibleClient({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "local-model" });
    await expect(client.chatDetailed([{ role: "user", content: "ping" }])).rejects.toThrow("finish_reason=stop");
  });

  test("오류 본문이 보낸 키를 되돌려 줘도 오류 문장에는 키가 없다", async () => {
    nextStatusOverride = { status: 401, body: '{"error":{"message":"bad key sk-local-SECRET-123","code":"invalid_api_key"}}' };
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-model",
      apiKey: "sk-local-SECRET-123",
    });
    const err = (await client.chatDetailed([{ role: "user", content: "ping" }]).catch((e: unknown) => e)) as LlmRequestError;
    expect(err).toBeInstanceOf(LlmRequestError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).not.toContain("sk-local-SECRET-123");
  });
});
