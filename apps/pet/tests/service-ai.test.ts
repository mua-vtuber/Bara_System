import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProbeResult } from "../src/shared/contracts.ts";
import { AiClient, parseChatContent, parseClassification, parseGroundedAnswer } from "../src/service/ai.ts";
import { searchOnlyAnswer } from "../src/service/assistant.ts";
import { ConfigStore } from "../src/service/config.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

test("classification accepts only a strict known kind or null", () => {
  expect(parseClassification('{"kind":"idea"}', ["idea", "task"])).toBe("idea");
  expect(parseClassification('{"kind":null}', ["idea", "task"])).toBeNull();
  for (const text of ['{"kind":"general"}', '{"kind":"idea","other":1}', 'idea']) expect(() => parseClassification(text, ["idea", "task"])).toThrow();
});

test("grounded answer rejects invented memory ids", () => {
  expect(parseGroundedAnswer('{"answer":"확인했습니다","sourceIds":[4]}', [4, 7])).toEqual({ text: "확인했습니다", sourceIds: [4] });
  expect(() => parseGroundedAnswer('{"answer":"허구","sourceIds":[999]}', [4, 7])).toThrow();
});

test("search-only answer uses the real retrieved memory and generated false", () => {
  const result = searchOnlyAnswer([{ id: 4, content: "기억 하나" }]);
  expect(result).toEqual({ text: messages.assistant.foundMemories, sources: [{ id: 4, content: "기억 하나" }], generated: false, outcome: "found" });
});

test("search-only answer for a search that returned nothing is notFound, not found", () => {
  expect(searchOnlyAnswer([])).toEqual({ text: messages.assistant.noMemories, sources: [], generated: false, outcome: "notFound" });
});

test("local and OpenAI-compatible chat envelopes yield content", () => {
  expect(parseChatContent("ollama", { message: { content: '{"kind":null}' } })).toBe('{"kind":null}');
  expect(parseChatContent("openai-compatible", { choices: [{ message: { content: '{"kind":"idea"}' } }] })).toBe('{"kind":"idea"}');
  expect(() => parseChatContent("openai-compatible", { choices: [] })).toThrow();
});

// WP-PFIX-6: the settings screen's AI check used to report every failure as "could not connect". A
// refused connection, a refused credential and an answer that is not a model list are different faults,
// and the server's own cause text is kept wherever the server did answer. Real HTTP servers on loopback.
const MODEL = "qwen-test";

async function withChatFixture(
  provider: "ollama" | "openai-compatible",
  reply: (body: Record<string, unknown>) => unknown,
  run: (ai: AiClient) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pet-ai-chat-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = provider === "ollama" ? "/api/chat" : "/v1/chat/completions";
    if (new URL(request.url).pathname !== path || request.method !== "POST") return new Response("", { status: 404 });
    return Response.json(reply(await request.json() as Record<string, unknown>));
  } });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token", ai: { provider, baseUrl, model: MODEL } });
    await run(new AiClient(config));
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}

const requestContext = () => ({ signal: new AbortController().signal, progress() {} });

test("Ollama classification disables thinking so the small reply budget produces a kind", async () => {
  let sent: Record<string, unknown> | undefined;
  await withChatFixture("ollama", (body) => {
    sent = body;
    // A thinking model can exhaust num_predict before writing any final content.
    const done = body.think === false;
    return { model: MODEL, message: { role: "assistant", content: done ? '{"kind":"preference"}' : "", thinking: done ? "" : "Considering the note..." }, done: true, done_reason: done ? "stop" : "length" };
  }, async (ai) => {
    expect(await ai.classify("나는 조용한 카페가 좋아", ["preference", "idea"], requestContext())).toBe("preference");
    expect(sent).toMatchObject({ think: false, options: { num_predict: 120 }, format: "json" });
  });
});

test("information classification is accepted only when the server offers it", () => {
  expect(parseClassification('{"kind":"information"}', ["information", "preference"])).toBe("information");
  expect(() => parseClassification('{"kind":"information"}', ["preference", "idea"])).toThrow();
  expect(parseClassification('{"kind":null}', ["preference", "idea"])).toBeNull();
});

test("OpenAI-compatible classification keeps Ollama-only thinking options out of its request", async () => {
  let sent: Record<string, unknown> | undefined;
  await withChatFixture("openai-compatible", (body) => {
    sent = body;
    return { choices: [{ message: { role: "assistant", content: '{"kind":"idea"}' }, finish_reason: "stop", index: 0 }] };
  }, async (ai) => {
    expect(await ai.classify("메모를 날짜별로 모아보면 좋겠다", ["idea"], requestContext())).toBe("idea");
    expect(sent).toMatchObject({ model: MODEL, max_tokens: 120 });
    expect(sent).not.toHaveProperty("think");
    expect(sent).not.toHaveProperty("options");
  });
});

test("a reply wrapped entirely in one markdown fence is parsed; other text around JSON is not", () => {
  expect(parseClassification('```json\n{"kind":"idea"}\n```', ["idea"])).toBe("idea");
  expect(parseClassification('```\n{"kind":"idea"}```\n', ["idea"])).toBe("idea");
  expect(parseGroundedAnswer('```json\r\n{"answer":"a","sourceIds":[1]}\r\n```', [1])).toEqual({ text: "a", sourceIds: [1] });
  for (const bad of ['Here you go: {"kind":"idea"}', '```json\n{"kind":"idea"}\n``` thanks', 'sure\n```json\n{"kind":"idea"}\n```', '```json\n{"kind":"idea"}\n```\n```json\n{"kind":"idea"}\n```', '```json\nnot json\n```'])
    expect(() => parseClassification(bad, ["idea"])).toThrow(messages.aiService.responseFormat);
});

test("an OpenAI-compatible cleanup decision in a code fence is read; garbage is refused", async () => {
  await withChatFixture("openai-compatible", () => ({ choices: [{ message: { role: "assistant", content: '```json\n{"finding":false,"payload":{}}\n```' } }] }), async (ai) => {
    expect(await ai.cleanupDecision("personLink", {}, {}, "openai-compatible", "cleanup-model", requestContext())).toEqual({ finding: false, payload: {} });
  });
  await withChatFixture("openai-compatible", () => ({ choices: [{ message: { role: "assistant", content: 'finding: false' } }] }), async (ai) => {
    const error = await ai.cleanupDecision("personLink", {}, {}, "openai-compatible", "cleanup-model", requestContext()).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "AI_RESPONSE" });
  });
});

test("both chat paths state the same lens draft shape and limits", async () => {
  const { ownStageInstruction, PROPOSAL_JSON_MAX_CHARS } = await import("../src/service/cleanup-instruction.ts");
  let system = "";
  await withChatFixture("ollama", (body) => {
    system = (body.messages as { content: string }[])[0]!.content;
    return { message: { role: "assistant", content: '{"finding":false,"payload":{}}' }, done: true, done_reason: "stop" };
  }, async (ai) => { await ai.cleanupDecision("lensDraft", {}, {}, "ollama", "cleanup-model", requestContext()); });
  expect(system).toBe(ownStageInstruction("chat"));
  for (const format of ["chat", "cli"] as const) {
    const text = ownStageInstruction(format);
    expect(text).toContain(format === "cli" ? `payloadJson, the whole payload including the {"values":...} wrapper, stays under ${PROPOSAL_JSON_MAX_CHARS} characters` : `values encoded as JSON stays under ${PROPOSAL_JSON_MAX_CHARS} characters`);
    for (const part of ["emptyColumnKeys", "non-empty", "string, number or boolean", "labels, relations and metadata stay empty", String(PROPOSAL_JSON_MAX_CHARS), "topKPersonIds"]) expect(text).toContain(part);
  }
});

test("Ollama answer and cleanup turn thinking off so the reply budget produces final JSON", async () => {
  const sent: Record<string, unknown>[] = [];
  await withChatFixture("ollama", (body) => {
    sent.push(body);
    return { message: { role: "assistant", content: sent.length === 1 ? '{"answer":"조용한 카페","sourceIds":[4]}' : '{"finding":false,"payload":{}}' }, done: true, done_reason: "stop" };
  }, async (ai) => {
    expect(await ai.answer("어떤 카페를 좋아해?", [{ id: 4, content: "나는 조용한 카페가 좋아" }], requestContext())).toEqual({ text: "조용한 카페", sourceIds: [4] });
    expect(await ai.cleanupDecision("personLink", {}, {}, "ollama", "cleanup-model", requestContext())).toEqual({ finding: false, payload: {} });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ model: MODEL, options: { num_predict: 700 } });
    expect(sent[1]).toMatchObject({ model: "cleanup-model", options: { num_predict: 800 } });
    for (const body of sent) expect(body).toMatchObject({ think: false });
  });
});

test.each(["", '{"kind":"unknown"}'])("classification still rejects invalid final content %j", async (content) => {
  await withChatFixture("ollama", () => ({ message: { role: "assistant", content }, done: true, done_reason: "stop" }), async (ai) => {
    const error = await ai.classify("메모", ["idea"], requestContext()).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "AI_RESPONSE" });
  });
});

async function probeAt(baseUrl: string, signal: AbortSignal = new AbortController().signal, model = MODEL): Promise<AiProbeResult> {
  const dir = mkdtempSync(join(tmpdir(), "pet-ai-probe-"));
  try {
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token", ai: { provider: "ollama", baseUrl, model } });
    return await new AiClient(config).probe("answer", { signal, progress() {} });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function tagsServer(reply: () => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new URL(request.url).pathname === "/api/tags" ? reply() : new Response("", { status: 404 }) });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

test("a server that lists the selected model is reported as connected", async () => {
  const { server, baseUrl } = tagsServer(() => Response.json({ models: [{ name: MODEL }] }));
  try {
    expect(await probeAt(baseUrl)).toEqual({ available: true, models: [MODEL], message: messages.aiService.probe.connected });
  } finally { server.stop(true); }
});

test("model discovery lists available models before a model has been selected", async () => {
  const { server, baseUrl } = tagsServer(() => Response.json({ models: [{ name: MODEL }] }));
  try {
    expect(await probeAt(baseUrl, new AbortController().signal, "")).toEqual({
      available: false, models: [MODEL], message: messages.aiService.modelNeeded, reason: "model-missing",
    });
  } finally { server.stop(true); }
});

test("a refused connection is reported as a connection failure", async () => {
  const { server, baseUrl } = tagsServer(() => Response.json({ models: [] }));
  server.stop(true); // nothing listens on this port any more
  const result = await probeAt(baseUrl);
  expect(result.available).toBe(false);
  expect(result.message).toContain("AI 서버에 연결하지 못했습니다");
  expect(result.message).not.toContain("모델 목록");
});

test("a reply that is not a model list is reported as that, with the cause, not as a connection failure", async () => {
  const { server, baseUrl } = tagsServer(() => Response.json({ hello: "world" }));
  try {
    const result = await probeAt(baseUrl);
    expect(result.available).toBe(false);
    expect(result.message).toContain("모델 목록으로 읽지 못했습니다");
    expect(result.message).toContain(messages.aiService.modelListUnreadable);
    expect(result.message).not.toContain("연결하지 못했습니다");
  } finally { server.stop(true); }
});

test("a web server that answers with a page instead of JSON keeps its cause too", async () => {
  const { server, baseUrl } = tagsServer(() => new Response("<html>not an AI server</html>", { headers: { "content-type": "text/html" } }));
  try {
    const result = await probeAt(baseUrl);
    expect(result.message).toContain("모델 목록으로 읽지 못했습니다");
    expect(result.message).toContain(messages.serverClient.responseUnreadable);
  } finally { server.stop(true); }
});

test("an address that answers 404 to the model list is reported with the server's answer", async () => {
  const { server, baseUrl } = tagsServer(() => new Response("", { status: 404 }));
  try {
    const result = await probeAt(baseUrl);
    expect(result.message).toContain("모델 목록으로 읽지 못했습니다");
    expect(result.message).toContain(messages.serverClient.http.notFound);
  } finally { server.stop(true); }
});

test("a refused credential is reported as an authentication failure with the server's answer", async () => {
  const { server, baseUrl } = tagsServer(() => new Response("", { status: 401 }));
  try {
    const result = await probeAt(baseUrl);
    expect(result.message).toContain("인증을 받아들이지 않았습니다");
    expect(result.message).toContain(messages.serverClient.http.authRequired);
    expect(result.message).not.toContain("모델 목록");
  } finally { server.stop(true); }
});

test("a cancelled check is not reported as a server fault", async () => {
  const { server, baseUrl } = tagsServer(() => Response.json({ models: [{ name: MODEL }] }));
  const cancelled = new AbortController();
  cancelled.abort();
  try {
    const error = await probeAt(baseUrl, cancelled.signal).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "CANCELLED" });
  } finally { server.stop(true); }
});
