/**
 * ollama-client.test.ts — OllamaClient.chat() body 직렬화 검증.
 *
 * Bun.serve 가짜 server 가 /api/chat POST body 를 그대로 저장 → think 옵션이
 * 정의됐을 때만 body.think 가 실리는지 (미정의면 칸 부재) 검증한다. Mock 인터페이스
 * 구현체가 아니라 실제 HTTP server 라 프로젝트 Mock 금지 룰 정합.
 *
 * think 옵션 배선 (T4) — temperature·maxOutputTokens 선례 그대로:
 *   options.think 정의 시에만 body.think 송신 / 미정의면 칸 없음 = 모델 기본 동작.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OllamaClient } from "./ollama-client.ts";
import { LlmRequestError } from "./errors.ts";

/** 다음 응답의 HTTP 상태·헤더·본문을 통째로 갈아끼운다(오류 응답 흉내용). */
interface StatusOverride {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

interface FakeServer {
  url: string;
  stop: () => void;
  lastRequestBody: () => Record<string, unknown> | null;
  /** 다음 응답에 실을 필드를 갈아끼운다 — 기본 필드 위에 override 를 얹는다. */
  setNextResponseOverride: (override: Record<string, unknown>) => void;
  /** 다음 응답을 오류 상태(429/5xx 등)로 강제한다 — 헤더·본문 포함. */
  setNextStatusOverride: (override: StatusOverride | null) => void;
  /** 다음 응답을 무한 지연시켜 클라이언트 timeout 을 유발한다. */
  setHang: (hang: boolean) => void;
}

function startFakeOllamaServer(): FakeServer {
  let storedBody: Record<string, unknown> | null = null;
  let nextResponseOverride: Record<string, unknown> = {};
  let nextStatusOverride: StatusOverride | null = null;
  let hang = false;

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "POST" && req.url.endsWith("/api/chat")) {
        storedBody = (await req.json()) as Record<string, unknown>;
        if (hang) {
          // 응답을 영원히 미뤄 클라이언트 내부 timeout abort 를 유발한다.
          await new Promise(() => {});
        }
        if (nextStatusOverride) {
          return new Response(nextStatusOverride.body ?? "error", {
            status: nextStatusOverride.status,
            headers: nextStatusOverride.headers ?? {},
          });
        }
        return new Response(
          JSON.stringify({
            model: "qwen3:4b-instruct",
            message: { role: "assistant", content: "안녕" },
            done: true,
            ...nextResponseOverride,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
    lastRequestBody: () => storedBody,
    setNextResponseOverride: (override) => {
      nextResponseOverride = override;
    },
    setNextStatusOverride: (override) => {
      nextStatusOverride = override;
    },
    setHang: (value) => {
      hang = value;
    },
  };
}

let fakeServer: FakeServer;

beforeAll(() => {
  fakeServer = startFakeOllamaServer();
});

afterAll(() => {
  fakeServer.stop();
});

afterEach(() => {
  fakeServer.setNextResponseOverride({});
  fakeServer.setNextStatusOverride(null);
  fakeServer.setHang(false);
});

describe("OllamaClient.chat() — think 옵션 배선 (T4)", () => {
  test("think 옵션 미지정 → body 에 think 칸 없음 (기존 동작 회귀 0)", async () => {
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });
    const reply = await client.chat([{ role: "user", content: "안녕?" }]);
    expect(reply).toBe("안녕");

    const body = fakeServer.lastRequestBody();
    if (!body) throw new Error("body 미존재");
    expect("think" in body).toBe(false);
  });

  test("think:false 지정 → body.think === false 송신", async () => {
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });
    await client.chat([{ role: "user", content: "안녕?" }], { think: false });

    const body = fakeServer.lastRequestBody();
    if (!body) throw new Error("body 미존재");
    expect(body.think).toBe(false);
  });

  test("think:true 지정 → body.think === true 송신 (추론 원하는 미래 슬롯 대비)", async () => {
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });
    await client.chat([{ role: "user", content: "안녕?" }], { think: true });

    const body = fakeServer.lastRequestBody();
    if (!body) throw new Error("body 미존재");
    expect(body.think).toBe(true);
  });
});

describe("OllamaClient.chatDetailed() — stopReason·usage 정규화 (A-1)", () => {
  test("done_reason=stop + prompt/eval count → stopReason='stop', usage 매핑", async () => {
    fakeServer.setNextResponseOverride({
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 45,
    });
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.text).toBe("안녕");
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("done_reason=length → stopReason='max_tokens' (잘림 정규화)", async () => {
    fakeServer.setNextResponseOverride({
      done_reason: "length",
      prompt_eval_count: 200,
      eval_count: 768,
    });
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.stopReason).toBe("max_tokens");
  });

  test("done_reason 미제공 → stopReason='other' (사유를 지어내지 않는다)", async () => {
    fakeServer.setNextResponseOverride({});
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.stopReason).toBe("other");
  });

  test("prompt_eval_count/eval_count 미제공 → usage=null (0 위장 금지)", async () => {
    fakeServer.setNextResponseOverride({ done_reason: "stop" });
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    const result = await client.chatDetailed([{ role: "user", content: "안녕?" }]);

    expect(result.usage).toBeNull();
  });

  test("chat() 은 chatDetailed().text 위임 — 기존 소비처 회귀 0", async () => {
    fakeServer.setNextResponseOverride({
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 5,
    });
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    const reply = await client.chat([{ role: "user", content: "안녕?" }]);

    expect(reply).toBe("안녕");
  });
});

describe("OllamaClient — LlmRequestError throw 경로 (A-2)", () => {
  test("429 + Retry-After 헤더 → LlmRequestError(status=429, retryAfterMs 보존)", async () => {
    fakeServer.setNextStatusOverride({
      status: 429,
      headers: { "retry-after": "3" },
      body: "rate limited",
    });
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "안녕?" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.provider).toBe("ollama");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.timedOut).toBe(false);
  });

  test("500 → LlmRequestError(status=500, Retry-After 없으면 null)", async () => {
    fakeServer.setNextStatusOverride({ status: 500, body: "boom" });
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
    });

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "안녕?" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.status).toBe(500);
    expect(err.retryAfterMs).toBeNull();
  });

  test("timeout → LlmRequestError(timedOut=true, status=null)", async () => {
    fakeServer.setHang(true);
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
      timeoutMs: 80,
    });

    let caught: unknown;
    try {
      await client.chatDetailed([{ role: "user", content: "안녕?" }]);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmRequestError);
    const err = caught as LlmRequestError;
    expect(err.timedOut).toBe(true);
    expect(err.status).toBeNull();
  });

  test("외부 signal 취소 → LlmRequestError 아님(취소 의미 보존, AbortError 그대로)", async () => {
    fakeServer.setHang(true);
    const controller = new AbortController();
    const client = new OllamaClient({
      baseUrl: fakeServer.url,
      model: "qwen3:4b-instruct",
      timeoutMs: 5000,
    });

    const promise = client.chatDetailed([{ role: "user", content: "안녕?" }], {
      signal: controller.signal,
    });
    controller.abort();

    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }

    // 사용자 취소는 요청 실패가 아니다 — LlmRequestError 로 래핑하지 않는다.
    expect(caught).not.toBeInstanceOf(LlmRequestError);
    expect((caught as Error).name).toBe("AbortError");
  });
});
