import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience, type RequestContext } from "../src/shared/contracts.ts";
import { Assistant } from "../src/service/assistant.ts";
import { MemoryClient } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

const context: RequestContext = { signal: new AbortController().signal, progress() {} };

/** Real HTTP fixture standing in for the memory server, with per-route overrides for failure cases. */
function memoryFixture(overrides: { clientInfo?: () => Response; update?: () => Response; search?: () => Response } = {}) {
  const counts = { ingest: 0, get: 0, clientInfo: 0, update: 0, search: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ingest") { counts.ingest++; return Response.json({ ok: true, originNodeId: 1 }); }
    if (request.method === "GET" && url.pathname === "/memories/1") { counts.get++; return Response.json({ memory: { id: 1, content: "테스트용 기억 본문" } }); }
    if (request.method === "GET" && url.pathname === "/client-info") {
      counts.clientInfo++;
      return overrides.clientInfo ? overrides.clientInfo() : Response.json({ protocolVersion: 1, capabilities: ["capture"], captureKinds: ["idea", "decision", "question", "preference", "task"] });
    }
    if (request.method === "PATCH" && url.pathname === "/memories/1") {
      counts.update++;
      return overrides.update ? overrides.update() : Response.json({ memory: { id: 1, content: "테스트용 기억 본문", metadata: { capture: { kind: "idea", source: "ai" } } } });
    }
    if (request.method === "POST" && url.pathname === "/search") {
      counts.search++;
      return overrides.search ? overrides.search() : Response.json({ results: [{ id: 1, content: "테스트용 기억 본문" }] });
    }
    return new Response("", { status: 404 });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, counts };
}

/** Real HTTP fixture standing in for an Ollama-shaped AI server. */
function aiFixture(reply: () => Response) {
  const state = { calls: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== "/api/chat") return new Response("", { status: 404 });
    state.calls++;
    return reply();
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, state };
}

async function realConfig(baseUrl: string, ai?: { baseUrl: string; model: string }): Promise<{ config: ConfigStore; dir: string; audience: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pet-assistant-test-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const settings = await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token",
    ...(ai ? { ai: { provider: "ollama" as const, baseUrl: ai.baseUrl, model: ai.model } } : {}) });
  return { config, dir, audience: connectionAudience(settings.connection) };
}

test("allowedCaptureKinds failure surfaces as classification.outcome failed with the original reason", async () => {
  const memory = memoryFixture({ clientInfo: () => new Response("", { status: 500 }) });
  const { config, dir, audience } = await realConfig(memory.baseUrl);
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "AI 서버가 꺼진 상태에서 저장하는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "failed", reason: "서버 요청이 실패했습니다 (500)." });
  } finally { memory.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// WP-P2-03: a pre-integration server (403/404 on /client-info) must read as a version mismatch here
// too, not a permission error -- allowedCaptureKinds shares client.info()'s /client-info judgment.
test("allowedCaptureKinds on a pre-integration server (403) surfaces the version-mismatch reason, not FORBIDDEN", async () => {
  const memory = memoryFixture({ clientInfo: () => new Response("", { status: 403 }) });
  const { config, dir, audience } = await realConfig(memory.baseUrl);
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "구버전 서버에 저장하는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "failed", reason: "이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다. 펫 연동을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요." });
  } finally { memory.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("ai.classify failure surfaces as classification.outcome failed with the AI's own message", async () => {
  const memory = memoryFixture();
  const ai = aiFixture(() => Response.json({ message: { content: "not-json" } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "분류 AI가 깨진 응답을 돌려주는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "failed", reason: messages.aiService.responseFormat });
    expect(memory.counts.update).toBe(0); // classification never reached the update call
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("client.update conflict (409) surfaces as classification.outcome failed with the conflict reason", async () => {
  const memory = memoryFixture({ update: () => new Response("", { status: 409 }) });
  const ai = aiFixture(() => Response.json({ message: { content: '{"kind":"idea"}' } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "분류는 성공하지만 되쓰기가 충돌하는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "failed", reason: messages.serverClient.http.conflict });
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit AI kind:null is an undecided classification, never a failure", async () => {
  const memory = memoryFixture();
  const ai = aiFixture(() => Response.json({ message: { content: '{"kind":null}' } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "AI가 판단을 보류하는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "undecided" });
    expect(memory.counts.update).toBe(0); // no capture to write when the AI withheld judgment
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a successful AI classification is outcome applied and carries the same capture as the top-level field", async () => {
  const memory = memoryFixture();
  const ai = aiFixture(() => Response.json({ message: { content: '{"kind":"idea"}' } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "AI가 성공적으로 분류하는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "applied", capture: { kind: "idea", source: "ai" } });
    expect(result.capture).toEqual({ kind: "idea", source: "ai" });
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("zero search results answer immediately without ever calling the AI (PR-19)", async () => {
  const memory = memoryFixture({ search: () => Response.json({ results: [] }) });
  const ai = aiFixture(() => Response.json({ message: { content: '{"answer":"안 씀","sourceIds":[1]}' } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("아무 관련 기억도 없는 질문", context, audience);
    expect(answer).toMatchObject({ generated: false, outcome: "notFound", text: messages.assistant.noMemories });
    expect(ai.state.calls).toBe(0);
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// P4: the outcome is named where the answer is built, so these two cases (memories found, no AI answer
// needed vs. memories found, AI answer made) both read as `found`, and only a failed AI reads as `aiFailed`.
test("memories found without any AI configured answer as found, from the search only", async () => {
  const memory = memoryFixture();
  const { config, dir, audience } = await realConfig(memory.baseUrl);
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("AI 없이 검색만 하는 질문", context, audience);
    expect(answer).toMatchObject({ generated: false, outcome: "found", text: messages.assistant.foundMemories });
    expect(answer.sources.map((source) => source.id)).toEqual([1]);
  } finally { memory.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("an AI answer grounded in a found memory is found", async () => {
  const memory = memoryFixture();
  const ai = aiFixture(() => Response.json({ message: { content: '{"answer":"테스트용 기억에 있습니다.","sourceIds":[1]}' } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("AI가 기억을 근거로 답하는 질문", context, audience);
    expect(answer).toMatchObject({ generated: true, outcome: "found", text: "테스트용 기억에 있습니다." });
    expect(ai.state.calls).toBe(1);
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// An AI answer exists only with at least one citation: `parseGroundedAnswer` rejects an empty `sourceIds`
// as AI_RESPONSE, so a zero-citation response is a failed AI answer, not a `found` one.
test("an AI response citing no memory is rejected and answers aiFailed with every found memory as a source", async () => {
  const memory = memoryFixture({ search: () => Response.json({ results: [{ id: 1, content: "테스트용 기억 본문" }, { id: 2, content: "두 번째 테스트용 기억" }] }) });
  const ai = aiFixture(() => Response.json({ message: { content: '{"answer":"근거를 대지 못한 답입니다.","sourceIds":[]}' } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("AI가 아무 기억도 인용하지 않는 질문", context, audience);
    expect(answer).toMatchObject({ generated: false, outcome: "aiFailed", text: messages.feedback.answerFailed("AI_RESPONSE") });
    expect(answer.sources.map((source) => source.id)).toEqual([1, 2]);
    expect(ai.state.calls).toBe(1); // the rejection came from a real AI response, not from skipping the AI
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("an unconfigured answer AI (no model selected) gets its own guidance text", async () => {
  const memory = memoryFixture();
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: "http://127.0.0.1:1", model: "" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("모델이 선택되지 않은 상태의 질문", context, audience);
    expect(answer).toMatchObject({ generated: false, outcome: "aiFailed", text: "AI 모델을 선택해 주세요. 연결과 설정에서 AI를 구성할 수 있어요." });
  } finally { memory.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("an AI authentication failure gets its own guidance text, distinct from other answer failures", async () => {
  const memory = memoryFixture();
  const ai = aiFixture(() => new Response("", { status: 401 }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("API 키가 잘못된 상태의 질문", context, audience);
    expect(answer).toMatchObject({ generated: false, outcome: "aiFailed", text: "AI 인증에 실패했습니다. API 키를 확인해 주세요." });
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed AI answer body falls back to the generic answer-failed text, distinct from the other two", async () => {
  const memory = memoryFixture();
  const ai = aiFixture(() => Response.json({ message: { content: "not-json" } }));
  const { config, dir, audience } = await realConfig(memory.baseUrl, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const answer = await assistant.ask("AI가 깨진 응답을 돌려주는 질문", context, audience);
    expect(answer).toMatchObject({ generated: false, outcome: "aiFailed", text: "AI 답변을 만들지 못했습니다. 찾은 기억을 직접 확인해 주세요." });
  } finally { memory.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

// WP-P2-09: client.update() no longer hands back the PATCH body when the read after it fails. For the
// AI classification that PATCH was still accepted, so it is reported as applied, not as a failure.
test("a classification PATCH the server accepted stays applied when only the read after it fails", async () => {
  const counts = { get: 0, update: 0 };
  const memoryServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ingest") return Response.json({ ok: true, originNodeId: 1 });
    if (request.method === "GET" && url.pathname === "/client-info") return Response.json({ protocolVersion: 1, capabilities: ["capture"], captureKinds: ["idea", "decision", "question", "preference", "task"] });
    if (request.method === "PATCH" && url.pathname === "/memories/1") { counts.update++; return Response.json({ memory: { id: 1, content: "테스트용 기억 본문", metadata: { capture: { kind: "idea", source: "ai" } } } }); }
    // The read right after saving succeeds; the read after the classification PATCH fails.
    if (request.method === "GET" && url.pathname === "/memories/1") { counts.get++; return counts.update === 0 ? Response.json({ memory: { id: 1, content: "테스트용 기억 본문" } }) : new Response("", { status: 500 }); }
    return new Response("", { status: 404 });
  } });
  const ai = aiFixture(() => Response.json({ message: { content: '{"kind":"idea"}' } }));
  const { config, dir, audience } = await realConfig(`http://127.0.0.1:${memoryServer.port}`, { baseUrl: ai.baseUrl, model: "authored-fixture" });
  try {
    const assistant = new Assistant(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await assistant.save({ requestId: randomUUID(), audience, content: "분류는 저장됐지만 다시 읽기가 실패하는 테스트 문장", autoClassify: true }, context);
    expect(result.state).toBe("saved");
    expect(result.classification).toEqual({ outcome: "applied", capture: { kind: "idea", source: "ai" } });
    expect(result.capture).toEqual({ kind: "idea", source: "ai" });
    expect(result.memory).toMatchObject({ id: 1, content: "테스트용 기억 본문" });
    expect(counts).toEqual({ get: 2, update: 1 });
  } finally { memoryServer.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
