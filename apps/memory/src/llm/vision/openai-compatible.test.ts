import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAiCompatibleVisionProvider } from "./openai-compatible.ts";

interface CapturedVisionRequest {
  authorization: string | null;
  body: Record<string, unknown>;
}

let captured: CapturedVisionRequest[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        captured.push({
          authorization: req.headers.get("authorization"),
          body: (await req.json()) as Record<string, unknown>,
        });
        return Response.json({
          choices: [{ message: { content: "작은 PNG 이미지" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

describe("OpenAiCompatibleVisionProvider", () => {
  test("data URL image content 를 OpenAI-compatible chat completions 로 보낸다", async () => {
    captured = [];
    const provider = new OpenAiCompatibleVisionProvider({ limitSettingPath: "llm.vision.tokenCap",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "local-vlm",
      apiKey: "vision-key",
      defaultMaxTokens: 128,
      timeoutMs: 5000,
    });

    const out = await provider.captionImage(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "image/png",
      "설명",
      { temperature: 0.2 },
    );

    expect(out.caption).toBe("작은 PNG 이미지");
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.authorization).toBe("Bearer vision-key");
    expect(req.body.model).toBe("local-vlm");
    expect(req.body.max_tokens).toBe(128);
    const messages = req.body.messages as Array<Record<string, unknown>>;
    const content = messages[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "설명" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw==" },
    });
  });
});
