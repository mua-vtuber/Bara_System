/**
 * anthropic.test.ts — AnthropicVisionProvider + createVisionProvider 검증 (Phase 11b T9).
 *
 * Bun.serve 가짜 server 가동 → Anthropic SDK baseURL 옵션 자가 가짜 server 가리키게 →
 * response body fixture 회신 → 호출 검증. CLAUDE.md "Mock 객체 금지 / 데이터 fixture 허용"
 * 정합 — fixture 글 만 회신하고 인터페이스 가짜 구현 X.
 *
 * 검증 case (사이드카 6 안 4 case 가 본 파일):
 *   (1) createVisionProvider(enabled=false) → null
 *   (2) createVisionProvider(provider=null) → null
 *   (3) createVisionProvider(anthropic + 빈 apiKey) → throw + 'apiKey' 단어 포함
 *   (4) AnthropicVisionProvider.captionImage → 가짜 server 위 호출 → caption + usage 회수
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AnthropicVisionProvider,
} from "./anthropic.ts";
import { createVisionProvider } from "./index.ts";

interface FakeServer {
  url: string;
  stop: () => void;
  lastRequestBody: () => unknown;
  setResponse: (body: unknown, status?: number) => void;
}

function startFakeAnthropicServer(): FakeServer {
  let storedBody: unknown = null;
  let responseBody: unknown = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "text",
        text: "고양이 한 마리가 창가에 앉아 있다",
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1024, output_tokens: 12 },
  };
  let responseStatus = 200;

  const server = Bun.serve({
    port: 0, // 동적 port 자가 할당
    fetch: async (req) => {
      if (req.method === "POST" && req.url.endsWith("/v1/messages")) {
        storedBody = await req.json();
        return new Response(JSON.stringify(responseBody), {
          status: responseStatus,
          headers: { "Content-Type": "application/json" },
        });
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
    setResponse: (body, status = 200) => {
      responseBody = body;
      responseStatus = status;
    },
  };
}

let fakeServer: FakeServer;

beforeAll(() => {
  fakeServer = startFakeAnthropicServer();
});

afterAll(() => {
  fakeServer.stop();
});

describe("createVisionProvider — 분기 검사", () => {
  test("(1) enabled=false → null", () => {
    const provider = createVisionProvider({
      enabled: false,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      endpoint: null,
      apiKey: "sk-ant-test",
      tokenCap: 256,
      forceCall: false,
    });
    expect(provider).toBeNull();
  });

  test("(2) provider=null → null", () => {
    const provider = createVisionProvider({
      enabled: true,
      provider: null,
      model: null,
      endpoint: null,
      apiKey: null,
      tokenCap: 256,
      forceCall: false,
    });
    expect(provider).toBeNull();
  });

  test("(3) anthropic + 빈 apiKey → throw + 'apiKey' 단어 포함", () => {
    expect(() =>
      createVisionProvider({
        enabled: true,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        endpoint: null,
        apiKey: "",
        tokenCap: 256,
        forceCall: false,
      }),
    ).toThrow(/apiKey/);
  });
});

describe("AnthropicVisionProvider.captionImage — 가짜 server 위 호출", () => {
  test("(4) base64 image + text 보내고 caption + usage 회수", async () => {
    const provider = new AnthropicVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      defaultMaxTokens: 200,
      baseURL: fakeServer.url,
    });

    // 작은 PNG buffer (실 이미지 X — fixture base64 통로 검증 한정)
    const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    const result = await provider.captionImage(
      imageBuffer,
      "image/png",
      "이 이미지를 한 줄로 묘사하라",
      { maxTokens: 150 },
    );

    expect(result.caption).toBe("고양이 한 마리가 창가에 앉아 있다");
    expect(result.usage?.inputTokens).toBe(1024);
    expect(result.usage?.outputTokens).toBe(12);

    // 호출된 body 검증 — content blocks 양식 + base64 인코딩 확인
    const body = fakeServer.lastRequestBody() as {
      model: string;
      max_tokens: number;
      messages: Array<{
        role: string;
        content: Array<
          | { type: "image"; source: { type: string; media_type: string; data: string } }
          | { type: "text"; text: string }
        >;
      }>;
    };
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(150);
    const firstMessage = body.messages[0];
    if (!firstMessage) throw new Error("body.messages[0] 미존재");
    expect(firstMessage.role).toBe("user");
    const firstContent = firstMessage.content[0];
    const secondContent = firstMessage.content[1];
    if (!firstContent || !secondContent)
      throw new Error("content blocks 부족");
    expect(firstContent.type).toBe("image");
    const imageBlock = firstContent as {
      type: "image";
      source: { type: string; media_type: string; data: string };
    };
    expect(imageBlock.source.media_type).toBe("image/png");
    expect(imageBlock.source.data).toBe(
      Buffer.from(imageBuffer).toString("base64"),
    );
    expect(secondContent.type).toBe("text");
  });
});

describe("AnthropicVisionProvider.captionImage — 모델별 temperature 칸", () => {
  const imageBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  async function captionWith(model: string): Promise<Record<string, unknown>> {
    const provider = new AnthropicVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      apiKey: "sk-ant-test",
      model,
      baseURL: fakeServer.url,
    });
    await provider.captionImage(imageBuffer, "image/png", "묘사하라");
    return fakeServer.lastRequestBody() as Record<string, unknown>;
  }

  test("claude-haiku-5-5 → temperature 를 보내지 않는다 (최신 모델은 400 거절)", async () => {
    const body = await captionWith("claude-haiku-5-5");
    expect("temperature" in body).toBe(false);
  });

  test("claude-haiku-4-5 → 기본 temperature 0.3 유지", async () => {
    const body = await captionWith("claude-haiku-4-5");
    expect(body.temperature).toBe(0.3);
  });
});
