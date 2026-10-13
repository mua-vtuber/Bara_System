/**
 * anthropic-client.test.ts — AnthropicClient.chatDetailed() stopReason·usage 정규화 검증 (A-1).
 *
 * Anthropic SDK 는 baseURL 오버라이드를 지원 — 실제 Bun.serve fake server 로
 * Messages API 응답을 흉내내 검증한다. Mock 인터페이스 구현체가 아니라 실제
 * HTTP server 라 프로젝트 Mock 금지 룰 정합(ollama-client.test.ts 선례와 동일 패턴).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AnthropicClient } from "./anthropic-client.ts";
import { LlmRequestError } from "./errors.ts";

/** 다음 응답의 HTTP 상태·헤더·본문을 통째로 갈아끼운다(SDK 오류 흉내용). */
interface StatusOverride {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

let server: ReturnType<typeof Bun.serve>;
/** 다음 응답에 실을 필드를 갈아끼운다 — 기본 Messages API 응답 위에 override 를 얹는다. */
let nextResponseOverride: Record<string, unknown> = {};
let nextStatusOverride: StatusOverride | null = null;
/** 다음 응답을 이 ms 만큼 늦춘다 — timeout 옵션(Task 8) 동작 검증용. */
let nextDelayMs = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        if (nextDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, nextDelayMs));
        }
        if (nextStatusOverride) {
          return new Response(
            typeof nextStatusOverride.body === "string"
              ? nextStatusOverride.body
              : JSON.stringify(nextStatusOverride.body ?? {}),
            {
              status: nextStatusOverride.status,
              headers: {
                "content-type": "application/json",
                ...nextStatusOverride.headers,
              },
            },
          );
        }
        return Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "안녕" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
          ...nextResponseOverride,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  nextResponseOverride = {};
  nextStatusOverride = null;
  nextDelayMs = 0;
});

function makeClient(timeoutMs?: number): AnthropicClient {
  return new AnthropicClient({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    baseURL: `http://127.0.0.1:${server.port}`,
    // SDK 내장 재시도를 꺼 오류를 즉시 받는다(테스트 결정성 + 실행층 이중 재시도 방지).
    maxRetries: 0,
    timeoutMs,
  });
}

describe("AnthropicClient.chatDetailed() — stopReason·usage 정규화 (A-1)", () => {
  test("stop_reason=end_turn → stopReason='stop', usage 매핑(캐시 포함)", async () => {
    nextResponseOverride = {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    };
    const client = makeClient();

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.text).toBe("안녕");
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    });
  });

  test("stop_reason=stop_sequence → stopReason='stop' (정상 종료 계열)", async () => {
    nextResponseOverride = { stop_reason: "stop_sequence" };
    const client = makeClient();

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.stopReason).toBe("stop");
  });

  test("stop_reason=max_tokens → stopReason='max_tokens' (잘림 정규화)", async () => {
    nextResponseOverride = { stop_reason: "max_tokens" };
    const client = makeClient();

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.stopReason).toBe("max_tokens");
  });

  test("stop_reason=tool_use 등 그 외 값 → stopReason='other'", async () => {
    nextResponseOverride = { stop_reason: "tool_use" };
    const client = makeClient();

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.stopReason).toBe("other");
  });

  test("cache_read/cache_creation 미제공(null) → 0 고정 (캐시 미사용 정직 표현)", async () => {
    nextResponseOverride = {
      usage: {
        input_tokens: 50,
        output_tokens: 15,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
    };
    const client = makeClient();

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("chat() 은 chatDetailed().text 위임 — 기존 소비처 회귀 0", async () => {
    const client = makeClient();

    const reply = await client.chat([{ role: "user", content: "안녕?" }]);

    expect(reply).toBe("안녕");
  });
});

describe("AnthropicClient — SDK 오류 → LlmRequestError 래핑 (A-2)", () => {
  test("429 + Retry-After → LlmRequestError(status=429, code=error.type, retryAfterMs 보존)", async () => {
    nextStatusOverride = {
      status: 429,
      headers: { "retry-after": "7" },
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    };
    const client = makeClient();

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "안녕?" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.provider).toBe("anthropic");
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limit_error");
    expect(err.retryAfterMs).toBe(7000);
    expect(err.timedOut).toBe(false);
  });

  test("500 → LlmRequestError(status=500)", async () => {
    nextStatusOverride = {
      status: 500,
      body: { type: "error", error: { type: "api_error", message: "boom" } },
    };
    const client = makeClient();

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "안녕?" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    expect((caught as LlmRequestError).status).toBe(500);
  });

  test("400 → LlmRequestError(status=400, config 분류 대상)", async () => {
    nextStatusOverride = {
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    };
    const client = makeClient();

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "안녕?" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_request_error");
  });
});

describe("AnthropicClient — timeoutMs 옵션 (데이터 정리 AI 효율 가동 spec 4.A-8 / Task 8)", () => {
  test("짧은 timeoutMs 는 늦은 응답을 끊는다 (SDK 요청 timeout 이 실제로 적용됨)", async () => {
    // 지연 300ms 보다 timeoutMs 5ms 가 훨씬 짧아, 전체 부하 상황의 시간 흔들림과
    // 무관하게 항상 timeout 이 먼저 트리거된다(llm-wiring.test.ts ollama 대비 패턴과 동일).
    nextDelayMs = 300;
    const client = makeClient(5);

    await expect(
      client.chatDetailed([{ role: "user", content: "안녕?" }]),
    ).rejects.toThrow();
  });

  test("긴 timeoutMs 는 즉시 응답을 통과시킨다", async () => {
    nextDelayMs = 0;
    const client = makeClient(10000);

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.text).toBe("안녕");
  });

  test("timeoutMs 미지정(undefined) 이어도 정상 응답을 받는다 — SDK 자체 default 로 동작", async () => {
    nextDelayMs = 0;
    const client = makeClient(undefined);

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.text).toBe("안녕");
  });
});

describe("AnthropicClient — 생각(thinking)이 출력 한도를 다 쓴 잘림", () => {
  /** 생각 블록만 있고 글 블록이 없는 max_tokens 응답(Haiku 5.5 실측 모양). */
  const THINKING_ONLY_TRUNCATED = {
    content: [{ type: "thinking", thinking: "", signature: "sig" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 1752, output_tokens: 1536 },
  };

  test("chatDetailed 는 던지지 않고 빈 글 + max_tokens + usage 를 돌려준다", async () => {
    nextResponseOverride = THINKING_ONLY_TRUNCATED;
    const result = await makeClient().chatDetailed([{ role: "user", content: "안녕?" }]);
    expect(result).toEqual({
      text: "",
      stopReason: "max_tokens",
      usage: { inputTokens: 1752, outputTokens: 1536, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  test("글만 받는 chat() 은 빈 답을 넘기지 않고 던진다", async () => {
    nextResponseOverride = THINKING_ONLY_TRUNCATED;
    await expect(makeClient().chat([{ role: "user", content: "안녕?" }])).rejects.toThrow(/텍스트 블록이 없다/);
  });

  test("잘림이 아닌데 글이 없는 응답은 여전히 던진다", async () => {
    nextResponseOverride = { content: [], stop_reason: "end_turn" };
    await expect(makeClient().chatDetailed([{ role: "user", content: "안녕?" }])).rejects.toThrow(/텍스트 블록이 없다/);
  });
});
