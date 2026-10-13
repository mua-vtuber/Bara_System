/**
 * ollama.test.ts — OllamaVisionProvider 검증 (Phase 11b T9).
 *
 * Bun.serve 가짜 server 가동 → /api/chat 라우트만 정합 → JSON body 검증 (images 배열 +
 * base64 인코딩) + caption response 회신.
 *
 * 검증 case (사이드카 6 안 2 case 가 본 파일):
 *   (5) Ollama captionImage → 가짜 server 위 호출 → response.message.content 회수
 *   (6) Ollama 가동 실패 (500 에러) → 정직 throw + 구체 메시지
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OllamaVisionProvider } from "./ollama.ts";
import { createVisionProvider } from "./index.ts";

interface FakeServer {
  url: string;
  stop: () => void;
  lastRequestBody: () => unknown;
  setMode: (mode: "ok" | "500" | "slow") => void;
}

function startFakeOllamaServer(): FakeServer {
  let storedBody: unknown = null;
  let mode: "ok" | "500" | "slow" = "ok";

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "POST" && req.url.endsWith("/api/chat")) {
        storedBody = await req.json();
        if (mode === "500") {
          return new Response("internal server error 양식 글", {
            status: 500,
          });
        }
        if (mode === "slow") {
          // 300ms 지연 — 짧은 timeoutMs 가 끊고 긴 timeoutMs 가 통과시키는 대비.
          await new Promise((r) => setTimeout(r, 300));
        }
        return new Response(
          JSON.stringify({
            model: "qwen3-vl:4b",
            message: {
              role: "assistant",
              content: "강아지 한 마리가 잔디 위에서 뛰고 있다",
            },
            done: true,
            prompt_eval_count: 512,
            eval_count: 18,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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
    lastRequestBody: () => storedBody,
    setMode: (m) => {
      mode = m;
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

describe("OllamaVisionProvider.captionImage", () => {
  test("(5) 가짜 server 위 호출 → message.content 회수 + usage 합류", async () => {
    fakeServer.setMode("ok");
    const provider = new OllamaVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      baseUrl: fakeServer.url,
      model: "qwen3-vl:4b",
      defaultMaxTokens: 200,
    });

    const imageBuffer = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    ]);

    const result = await provider.captionImage(
      imageBuffer,
      "image/jpeg",
      "이 이미지를 한 줄로 묘사하라",
      { maxTokens: 120, temperature: 0.4 },
    );

    expect(result.caption).toBe("강아지 한 마리가 잔디 위에서 뛰고 있다");
    expect(result.usage?.inputTokens).toBe(512);
    expect(result.usage?.outputTokens).toBe(18);

    const body = fakeServer.lastRequestBody() as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string; images?: string[] }>;
      options?: { temperature?: number; num_predict?: number };
    };
    expect(body.model).toBe("qwen3-vl:4b");
    expect(body.stream).toBe(false);
    const firstMessage = body.messages[0];
    if (!firstMessage) throw new Error("body.messages[0] 미존재");
    expect(firstMessage.role).toBe("user");
    expect(firstMessage.content).toBe("이 이미지를 한 줄로 묘사하라");
    expect(firstMessage.images).toEqual([
      Buffer.from(imageBuffer).toString("base64"),
    ]);
    expect(body.options?.num_predict).toBe(120);
    expect(body.options?.temperature).toBeCloseTo(0.4, 5);
  });

  test("think 옵션 미지정 → body 에 think 칸 없음 (모델 기본 동작·회귀 0)", async () => {
    fakeServer.setMode("ok");
    const provider = new OllamaVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      baseUrl: fakeServer.url,
      model: "qwen3-vl:4b-instruct",
      defaultMaxTokens: 200,
    });
    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await provider.captionImage(imageBuffer, "image/png", "묘사하라");

    const body = fakeServer.lastRequestBody() as Record<string, unknown>;
    expect("think" in body).toBe(false);
  });

  test("think:false 지정 → body.think === false 송신", async () => {
    fakeServer.setMode("ok");
    const provider = new OllamaVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      baseUrl: fakeServer.url,
      model: "qwen3-vl:4b-instruct",
      defaultMaxTokens: 200,
    });
    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await provider.captionImage(imageBuffer, "image/png", "묘사하라", {
      think: false,
    });

    const body = fakeServer.lastRequestBody() as { think?: boolean };
    expect(body.think).toBe(false);
  });

  test("(6) 가동 실패 (500 에러) → 정직 throw + 구체 메시지", async () => {
    fakeServer.setMode("500");
    const provider = new OllamaVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      baseUrl: fakeServer.url,
      model: "qwen3-vl:4b",
    });

    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await expect(
      provider.captionImage(imageBuffer, "image/png", "test"),
    ).rejects.toThrow(/500/);
  });
});

// vision timeoutMs 전달 — settings.llm.vision.timeoutMs 가 createVisionProvider 를 거쳐
// OllamaVisionProvider 로 닿는지 시간 대비로 검증한다. OllamaVisionProvider.timeoutMs 는
// private 라 직접 못 읽으니, 지연 응답을 짧은 / 긴 timeoutMs 로 끊고 통과시키는 대비로
// 전달을 확인한다 (extractor-a1-2.4b-transition llm-wiring 패턴 정합).
describe("createVisionProvider — vision timeoutMs 전달 (ollama 갈래)", () => {
  test("짧은 timeoutMs 는 늦은 응답을 끊는다 (settings 값이 OllamaVisionProvider 로 전달됨)", async () => {
    fakeServer.setMode("slow");
    const provider = createVisionProvider({
      enabled: true,
      provider: "ollama",
      model: "qwen2.5vl:3b",
      endpoint: fakeServer.url,
      apiKey: null,
      tokenCap: 200,
      forceCall: false,
      // 지연 300ms 보다 5ms 가 훨씬 짧아, 전체 부하 시간 흔들림과 무관하게 끊긴다.
      timeoutMs: 5,
    });
    if (!provider) throw new Error("createVisionProvider 가 null 회신 (ollama 갈래 기대)");

    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(
      provider.captionImage(imageBuffer, "image/png", "test"),
    ).rejects.toThrow();
  });

  test("긴 timeoutMs 는 지연 응답을 통과시킨다 (default 120초 안전망이 아니라 settings 값이 적용됨)", async () => {
    fakeServer.setMode("slow");
    const provider = createVisionProvider({
      enabled: true,
      provider: "ollama",
      model: "qwen2.5vl:3b",
      endpoint: fakeServer.url,
      apiKey: null,
      tokenCap: 200,
      forceCall: false,
      // 지연 300ms 보다 10000ms 가 여유라 전체 부하에서도 timeout 무관 — 통과 기대.
      timeoutMs: 10_000,
    });
    if (!provider) throw new Error("createVisionProvider 가 null 회신 (ollama 갈래 기대)");

    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = await provider.captionImage(
      imageBuffer,
      "image/png",
      "test",
    );
    expect(result.caption).toBe("강아지 한 마리가 잔디 위에서 뛰고 있다");
  });
});
