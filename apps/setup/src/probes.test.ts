import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { detectOllama, detectOpenAiCompatible } from "./probes.ts";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/tags") {
        return Response.json({ models: [{ name: "qwen3:4b-instruct" }] });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "local-model" }] });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

describe("provider probes", () => {
  test("Ollama /api/tags 모델 목록을 읽는다", async () => {
    const out = await detectOllama(`http://127.0.0.1:${server.port}`);
    expect(out).toEqual({
      ok: true,
      value: [{ name: "qwen3:4b-instruct" }],
    });
  });

  test("OpenAI-compatible /v1/models 모델 목록을 읽는다", async () => {
    const out = await detectOpenAiCompatible(
      `http://127.0.0.1:${server.port}/v1`,
    );
    expect(out).toEqual({ ok: true, value: [{ id: "local-model" }] });
  });
});

