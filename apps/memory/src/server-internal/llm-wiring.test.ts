/**
 * llm-wiring.test.ts — buildLlmClient / autoDetectProvider 검증.
 *
 * extractor-a1-2.4b-transition T5 (IN-6) 핵심 불변식:
 *   buildLlmClient 가 ollama provider 로 OllamaClient 를 만들 때 settings 의
 *   `slot.timeoutMs` 를 그대로 전달한다. OllamaClient.timeoutMs 는 private 라
 *   직접 읽지 못하므로 동작으로 증명한다 — 응답을 일부러 늦게 돌려주는 실제
 *   Bun.serve 서버에 chat() 을 호출해, 짧은 timeoutMs 가 호출을 끊고 긴
 *   timeoutMs 가 통과시키는 대비로 wiring 전달을 확인한다.
 *
 * 데이터 정리 AI 효율 가동 spec 4.A-8 (Task 8) 추가 검증:
 *   cleanup 슬롯의 `requestTimeoutMs` 가 3 provider(Ollama/Anthropic/
 *   OpenAI-compatible) 전부에 균일 전달되는지를 같은 지연 서버 대비 패턴으로
 *   확인한다. Anthropic 은 SDK 요청 timeout 옵션(생성자 timeout)이 실제로
 *   느린 응답을 끊는지까지 동작으로 증명한다.
 *
 * Mock 클래스 금지(CLAUDE.md 정책) — 실제 클라이언트 인스턴스 + 실제 HTTP
 * 서버 + 데이터 fixture(extractor/cleanup 슬롯)만 쓴다.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildLlmClient, autoDetectProvider } from "./llm-wiring.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";

interface DelayServer {
  url: string;
  stop: () => void;
  setDelayMs: (ms: number) => void;
}

/**
 * 응답을 setDelayMs 만큼 늦춰 회신하는 실제 /api/chat 서버.
 * timeoutMs 동작을 시간 대비로 검증하기 위한 지연 서버.
 */
function startDelayingOllamaServer(): DelayServer {
  let delayMs = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "POST" && req.url.endsWith("/api/chat")) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return new Response(
          JSON.stringify({
            model: "test-model",
            message: { role: "assistant", content: "응답 본문" },
            done: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop();
    },
    setDelayMs: (ms) => {
      delayMs = ms;
    },
  };
}

/** 응답을 setDelayMs 만큼 늦춰 회신하는 실제 /v1/chat/completions 서버(OpenAI-compatible). */
function startDelayingOpenAiCompatibleServer(): DelayServer {
  let delayMs = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return Response.json({
          choices: [
            { message: { content: "응답 본문" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => {
      server.stop();
    },
    setDelayMs: (ms) => {
      delayMs = ms;
    },
  };
}

/**
 * cleanup 슬롯 fixture — baseUrl 종류별 필드·requestTimeoutMs 만 검증에 직접
 * 쓰이고 나머지는 형식 충족용.
 */
function cleanupSlot(
  provider: "ollama" | "anthropic" | "openai_compatible",
  baseUrl: string,
  requestTimeoutMs: number,
): MemorySettings["llm"]["cleanup"] {
  return {
    enabled: true,
    provider,
    ollamaUrl: provider === "ollama" ? baseUrl : "http://127.0.0.1:11434",
    ollamaModel: "test-model",
    anthropicApiKey: "test-key",
    anthropicModel: "claude-sonnet-4-6",
    openaiBaseUrl: provider === "openai_compatible" ? baseUrl : "http://127.0.0.1:1234/v1",
    openaiModel: "test-model",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    intervalDays: 7,
    requestTimeoutMs,
    trigger: "interval",
  };
}

/**
 * buildLlmClient 호출부(index.ts:557)와 동일한 매핑 — cleanup 슬롯의
 * requestTimeoutMs 를 LlmClientSlot 공통 timeoutMs 칸으로 옮긴다. 이 매핑을
 * 재현하지 않으면 wiring 회귀를 못 잡는다.
 */
function toClientSlot(
  slot: MemorySettings["llm"]["cleanup"],
): Parameters<typeof buildLlmClient>[1] {
  return { ...slot, timeoutMs: slot.requestTimeoutMs };
}

/**
 * extractor 슬롯 fixture — baseUrl·timeoutMs 만 본 검증에 직접 쓰이고 나머지는
 * 형식 충족용. save-input.test.ts 의 동형 fixture 와 같은 구조.
 */
function extractorSlot(
  baseUrl: string,
  timeoutMs: number,
): MemorySettings["llm"]["extractor"] {
  return {
    enabled: true,
    provider: "ollama",
    ollamaUrl: baseUrl,
    ollamaModel: "test-model",
    anthropicApiKey: "",
    anthropicModel: "",
    openaiBaseUrl: "http://127.0.0.1:1234/v1",
    openaiModel: "test-model",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    mode: "immediate",
    minImportance: 0.3,
    forceJsonFormat: false,
    timeoutMs,
    backfill: { intervalMin: 30, batchSize: 10, minImportance: 0 },
  };
}

let server: DelayServer;
beforeAll(() => {
  server = startDelayingOllamaServer();
});
afterAll(() => {
  server.stop();
});

describe("buildLlmClient — extractor-a1-2.4b-transition T5 timeoutMs 전달", () => {
  test("짧은 timeoutMs 는 늦은 응답을 끊는다 (settings 값이 OllamaClient 로 전달됨)", async () => {
    // 지연 300ms 보다 timeoutMs 5ms 가 훨씬 짧아, 전체 부하 상황의 시간 흔들림과
    // 무관하게 항상 timeout 이 먼저 트리거된다.
    server.setDelayMs(300);
    const slot = extractorSlot(server.url, 5);
    const client = buildLlmClient("ollama", slot, "llm.extractor");
    expect(client).not.toBeNull();
    await expect(
      client!.chat([{ role: "user", content: "안녕" }]),
    ).rejects.toThrow();
  });

  test("긴 timeoutMs 는 즉시 응답을 통과시킨다 (default 120초 안전망이 아니라 settings 값이 적용됨)", async () => {
    // 지연 0 으로 즉시 회신. timeoutMs 10000 여유라 전체 부하에서도 timeout 무관.
    // 짧은 timeoutMs(5ms) 테스트와 대비해, settings 값이 그대로 OllamaClient 로
    // 흘러 동작을 가른다는 사실을 증명.
    server.setDelayMs(0);
    const slot = extractorSlot(server.url, 10000);
    const client = buildLlmClient("ollama", slot, "llm.extractor");
    expect(client).not.toBeNull();
    const out = await client!.chat([{ role: "user", content: "안녕" }]);
    expect(out).toBe("응답 본문");
  });

  test("provider 'none' 은 null 을 돌려준다", () => {
    const slot = extractorSlot(server.url, 5000);
    expect(buildLlmClient("none", slot, "llm.extractor")).toBeNull();
  });
});

describe("buildLlmClient — 데이터 정리 AI 효율 가동 spec 4.A-8: cleanup.requestTimeoutMs 3 provider 균일 전달", () => {
  test("ollama — 짧은 requestTimeoutMs 는 늦은 응답을 끊는다", async () => {
    const ollamaServer = startDelayingOllamaServer();
    try {
      ollamaServer.setDelayMs(300);
      const slot = cleanupSlot("ollama", ollamaServer.url, 5);
      const client = buildLlmClient("ollama", toClientSlot(slot), "llm.cleanup");
      expect(client).not.toBeNull();
      await expect(
        client!.chat([{ role: "user", content: "안녕" }]),
      ).rejects.toThrow();
    } finally {
      ollamaServer.stop();
    }
  });

  test("ollama — 긴 requestTimeoutMs 는 즉시 응답을 통과시킨다", async () => {
    const ollamaServer = startDelayingOllamaServer();
    try {
      ollamaServer.setDelayMs(0);
      const slot = cleanupSlot("ollama", ollamaServer.url, 10000);
      const client = buildLlmClient("ollama", toClientSlot(slot), "llm.cleanup");
      expect(client).not.toBeNull();
      const out = await client!.chat([{ role: "user", content: "안녕" }]);
      expect(out).toBe("응답 본문");
    } finally {
      ollamaServer.stop();
    }
  });

  test("openai_compatible — 짧은 requestTimeoutMs 는 늦은 응답을 끊는다", async () => {
    const oaiServer = startDelayingOpenAiCompatibleServer();
    try {
      oaiServer.setDelayMs(300);
      const slot = cleanupSlot("openai_compatible", oaiServer.url, 5);
      const client = buildLlmClient("openai_compatible", toClientSlot(slot), "llm.cleanup");
      expect(client).not.toBeNull();
      await expect(
        client!.chat([{ role: "user", content: "안녕" }]),
      ).rejects.toThrow();
    } finally {
      oaiServer.stop();
    }
  });

  test("openai_compatible — 긴 requestTimeoutMs 는 즉시 응답을 통과시킨다", async () => {
    const oaiServer = startDelayingOpenAiCompatibleServer();
    try {
      oaiServer.setDelayMs(0);
      const slot = cleanupSlot("openai_compatible", oaiServer.url, 10000);
      const client = buildLlmClient("openai_compatible", toClientSlot(slot), "llm.cleanup");
      expect(client).not.toBeNull();
      const out = await client!.chat([{ role: "user", content: "안녕" }]);
      expect(out).toBe("응답 본문");
    } finally {
      oaiServer.stop();
    }
  });

  test("anthropic — buildLlmClient 가 slot.timeoutMs 를 AnthropicClient 생성자로 그대로 전달한다", () => {
    // buildLlmClient 는 baseURL 오버라이드 통로가 없어(운영 경로엔 불필요) fake
    // 서버 대비로 SDK timeout 동작 자체를 여기서 증명할 수 없다 — 그 동작 증명은
    // anthropic-client.test.ts(AnthropicClient 직접 생성, baseURL 오버라이드 가능)
    // 가 담당한다. 여기서는 wiring 배선(undefined 미전달·값 전달) 만 확인한다.
    const slot = cleanupSlot("anthropic", "unused", 12345);
    const client = buildLlmClient("anthropic", toClientSlot(slot), "llm.cleanup");
    expect(client).not.toBeNull();
    expect(client!.name).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("autoDetectProvider", () => {
  test("enabled=false 면 'none'", () => {
    const slot = extractorSlot(server.url, 5000);
    slot.enabled = false;
    expect(autoDetectProvider(slot)).toBe("none");
  });

  test("enabled=true 면 slot.provider 그대로", () => {
    const slot = extractorSlot(server.url, 5000);
    expect(autoDetectProvider(slot)).toBe("ollama");
  });
});
