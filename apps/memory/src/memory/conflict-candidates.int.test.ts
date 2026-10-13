import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { cosineSimilarity } from "../embedding/vector-utils.ts";
import { EMBEDDING_CONFLICT_THRESHOLDS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { registerMemoriesRoutes } from "../server-internal/routes/memories.ts";
import { registerMcpRoutes } from "../mcp/server.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { CONFLICT_FTS_CANDIDATE_LIMIT, ConflictChecker } from "./conflict-checker.ts";
import { originAndAncestorsSync, originWholeLineageSync } from "./extractor-internal/origin-lineage.ts";
import { MemoryExtractor } from "./extractor.ts";
import { HybridRetriever } from "./retriever.ts";
import { ContextAssembler } from "./context-assembler.ts";
import { readSharedMemory } from "./shared-memory-contract.ts";
import type { SourceType } from "./types.ts";

let db: Database;
let store: SqliteMemoryStore;
let checker: ConflictChecker;
const vector = (similarity: number) => {
  const v = new Float32Array(1024);
  v[0] = similarity;
  v[1] = Math.sqrt(1 - similarity * similarity);
  return v;
};
beforeEach(() => { db = openMemoryDatabase(":memory:"); store = new SqliteMemoryStore(db, new Bgem3Embedder()); checker = new ConflictChecker(store); });
afterEach(() => db.close());

test("similarity creates a disputed new candidate without replacing or weakening the prior assertion", async () => {
  const oldId = await store.addNode({ content: "커피 예전 진술", author: "owner", importance: 0.7, embedding: vector(1) });
  const nodeId = await store.addNode({ content: "커피 새 진술", author: "owner", embedding: vector(0.7) });
  const args = { newNodeId: nodeId, content: "커피", author: "owner", memoryType: "fact" as const, newVector: vector(0.7) };
  expect(await checker.check(args)).toBe(1);
  const old = (await store.getNode(oldId))!;
  expect(old.importance).toBe(0.7);
  expect(readSharedMemory(old.metadata).status).toBe("active");
  expect(readSharedMemory((await store.getNode(nodeId))!.metadata)).toMatchObject({ status: "disputed", revision: 1 });
  expect(await store.getSupersededNodeIds([oldId])).toEqual(new Set());
  expect(db.query("SELECT relation FROM knowledge_edges").all()).toEqual([{ relation: "contradicts" }]);
  expect(await checker.check(args)).toBe(0);
  expect(readSharedMemory((await store.getNode(nodeId))!.metadata).revision).toBe(1);
});

test("rechecking an edit preserves legacy authoritative supersedes edges", async () => {
  const oldId = await store.addNode({ content: "커피 이전 상태", author: "owner", embedding: vector(1) });
  const nodeId = await store.addNode({ content: "커피 현재 상태", author: "owner", embedding: vector(0.7) });
  await store.addEdge({ sourceId: nodeId, targetId: oldId, relation: "supersedes", provenance: "system", sourceNodeId: nodeId, weight: 0.7 });
  const result = await checker.recheckAfterEdit({ nodeId, content: "전혀 다른 본문", author: "owner", memoryType: "fact", newVector: vector(0) });
  expect(result).toEqual({ removed: 0, added: 0 });
  expect(await store.getSupersededNodeIds([oldId])).toEqual(new Set([oldId]));
  expect(await store.getRevisionsForNode(oldId)).toEqual([]);
});

test("inactive memories cannot become conflict candidates or dispute targets", async () => {
  const oldId = await store.addNode({ content: "커피 철회한 진술", author: "owner", embedding: vector(1), metadata: { sharedMemory: { status: "retracted" } } });
  const nodeId = await store.addNode({ content: "커피 새 진술", author: "owner", embedding: vector(0.7) });
  expect(await checker.check({ newNodeId: nodeId, content: "커피", author: "owner", memoryType: "fact", newVector: vector(0.7) })).toBe(0);
  expect(await store.getSupersededNodeIds([oldId])).toEqual(new Set());
});

test("a prior assertion with expired evidence cannot dispute a current assertion", async () => {
  const source = await store.addNode({ content: "만료된 관찰", embedding: vector(1),
    metadata: { sharedMemory: { validUntil: "2020-01-01T00:00:00Z" } } });
  await store.addNode({ content: "커피 옛 추론", author: "owner", embedding: vector(1),
    metadata: { sharedMemory: { evidenceRefs: [source] } } });
  const nodeId = await store.addNode({ content: "커피 현재 진술", author: "owner", embedding: vector(0.7) });
  expect(await checker.check({ newNodeId: nodeId, content: "커피", author: "owner", memoryType: "fact", newVector: vector(0.7) })).toBe(0);
  expect(readSharedMemory((await store.getNode(nodeId))!.metadata).status).toBe("active");
});

function contradictsEdges(): Array<{ source_id: number; target_id: number }> {
  return db.query("SELECT source_id, target_id FROM knowledge_edges WHERE relation = 'contradicts' ORDER BY source_id, target_id")
    .all() as Array<{ source_id: number; target_id: number }>;
}

// SL-4 — 충돌 비교 단위는 작성 AI(author)가 아니라 주장의 주체(conflictSubjectKey)다.
test("different AI clients recording the owner's claims are compared as one subject", async () => {
  const oldId = await store.addNode({ content: "커피 클로드가 기록한 진술", author: "claude-code", embedding: vector(1) });
  const nodeId = await store.addNode({ content: "커피 코덱스가 기록한 진술", author: "codex", embedding: vector(0.7) });
  expect(await checker.check({ newNodeId: nodeId, content: "커피", author: "codex", memoryType: "fact", newVector: vector(0.7) })).toBe(1);
  expect(contradictsEdges()).toEqual([{ source_id: nodeId, target_id: oldId }]);
  expect(readSharedMemory((await store.getNode(nodeId))!.metadata).status).toBe("disputed");
});

test("relayed claims are compared only with the same person's claims", async () => {
  const personA = await store.addNode({ content: "커피 A 의 발언", author: "discord-bot", metadata: { user_id: "1001" }, embedding: vector(1) });
  await store.addNode({ content: "커피 소유자 기록", author: "claude-code", embedding: vector(1) });
  const personB = await store.addNode({ content: "커피 B 의 발언", author: "discord-bot", metadata: { user_id: "1002" }, embedding: vector(0.7) });
  expect(await checker.check({ newNodeId: personB, content: "커피", author: "discord-bot", memoryType: "fact", newVector: vector(0.7) })).toBe(0);
  const personAAgain = await store.addNode({ content: "커피 A 의 다른 발언", author: "another-bot", metadata: { user_id: " 1001 " }, embedding: vector(0.7) });
  expect(await checker.check({ newNodeId: personAAgain, content: "커피", author: "another-bot", memoryType: "fact", newVector: vector(0.7) })).toBe(1);
  expect(contradictsEdges()).toEqual([{ source_id: personAAgain, target_id: personA }]);
});

// WP-B1-09R — 충돌 상한(0.85) 이상 쌍: 작성 AI 가 다르면 충돌 후보, 같으면 중복 흡수 몫이다.
test("a near-identical claim written by a different AI client is a conflict candidate", async () => {
  const oldId = await store.addNode({ content: "커피 클로드가 기록한 선호", author: "claude-code", embedding: vector(1) });
  const nodeId = await store.addNode({ content: "커피 코덱스가 기록한 선호", author: "codex", embedding: vector(0.9) });
  expect(await checker.check({ newNodeId: nodeId, content: "커피", author: "codex", memoryType: "fact", newVector: vector(0.9) })).toBe(1);
  expect(contradictsEdges()).toEqual([{ source_id: nodeId, target_id: oldId }]);
  expect(readSharedMemory((await store.getNode(nodeId))!.metadata)).toMatchObject({ status: "disputed", revision: 1 });
  expect(readSharedMemory((await store.getNode(oldId))!.metadata)).toMatchObject({ status: "active", revision: 0 });
});

test("a near-identical claim written by the same AI client is left to duplicate absorption", async () => {
  await store.addNode({ content: "커피 클로드가 기록한 선호", author: "claude-code", embedding: vector(1) });
  const nodeId = await store.addNode({ content: "커피 클로드가 다시 기록한 선호", author: "claude-code", embedding: vector(0.9) });
  expect(await checker.check({ newNodeId: nodeId, content: "커피", author: "claude-code", memoryType: "fact", newVector: vector(0.9) })).toBe(0);
  expect(contradictsEdges()).toEqual([]);
  expect(readSharedMemory((await store.getNode(nodeId))!.metadata).status).toBe("active");
});

/**
 * 실제 저장 흐름 — 두 AI 토큰(MCP)과 Discord 중계(REST)가 짧은 글을 즉시 추출하고, 추출 자식이
 * 충돌 검사를 거친다. 실 bge-m3 + 실 SQLite + 인증 게이트 + SDK 클라이언트. LLM 은 테스트 안
 * 로컬 HTTP 서버가 Ollama /api/chat 형식으로 원문마다 정해진 추출 결과를 돌려주고, 실제
 * OllamaClient 가 그 서버를 부른다. 문장 쌍의 bge-m3 유사도는 충돌 범위 안이다(실측 0.67~0.75).
 */
const KOREAN_SAVE = "답변은 한국어로 해 주세요. 코드 주석도 한국어로 남겨 주세요.";
const KOREAN_CHILD = "답변은 한국어로 해 주세요";
const ENGLISH_SAVE = "앞으로 답변은 영어로 받고 싶다. 커밋 메시지도 영어로 쓴다.";
const ENGLISH_CHILD = "앞으로 답변은 영어로 받고 싶다";
const ENGLISH_SAVE_2 = "답변은 영어로 작성해야 한다. 문서 제목도 영어로 붙인다.";
const ENGLISH_CHILD_2 = "답변은 영어로 작성해야 한다";
// WP-B1-09R — 계획의 원래 예시 쌍. 자식끼리 bge-m3 유사도 0.867(충돌 상한 0.85 이상, 실측)이다.
// 원문끼리는 저장 시 유사-중복 관문(0.89) 아래다(실측: 영어 원문 0.730, 한국어 두 번째 원문 0.870).
const ENGLISH_NEAR_SAVE = "답변은 영어로 해 주세요. 변수 이름도 영어로 지어 주세요.";
const ENGLISH_NEAR_CHILD = "답변은 영어로 해 주세요";
const KOREAN_SAVE_2 = "답변은 한국어로 해 주세요. 커밋 메시지도 한국어로 써 주세요.";
// WP-B1-20T T3(설계 3.6.1) — 추출 항목이 원문 자신의 주장인 원문. 항목(09R 예시 문장)과 원문의 bge-m3
// 유사도가 중복 흡수 임계 0.85 이상이라(실측 0.923·0.921) 자식 없이 원문이 충돌 검사를 받는다. 영어 항목과
// 한국어 원문의 유사도는 실측 0.824 로 충돌 범위다. save_preference 는 유사-중복 관문을 돌지 않는다.
const KOREAN_SELF_SAVE = "답변은 한국어로 해 주세요. 부탁드립니다.";
const ENGLISH_SELF_SAVE = "답변은 영어로 해 주세요. 부탁드립니다.";
const EXTRACTIONS: ReadonlyArray<readonly [string, string]> = [
  [KOREAN_SAVE, KOREAN_CHILD], [ENGLISH_SAVE, ENGLISH_CHILD], [ENGLISH_SAVE_2, ENGLISH_CHILD_2],
  [ENGLISH_NEAR_SAVE, ENGLISH_NEAR_CHILD], [KOREAN_SAVE_2, KOREAN_CHILD],
  [KOREAN_SELF_SAVE, KOREAN_CHILD], [ENGLISH_SELF_SAVE, ENGLISH_NEAR_CHILD],
];
const BGE_M3 = EMBEDDING_CONFLICT_THRESHOLDS["bge-m3"];

describe("저장 흐름의 충돌 후보와 해소", () => {
  let embedder: Bgem3Embedder;
  let llm: ReturnType<typeof Bun.serve>;
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let tokens: SseTokenStore;
  let clients: Map<string, Client>;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    llm = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") return new Response("not found", { status: 404 });
        const body = await request.json() as { messages: Array<{ content: string }> };
        const prompt = body.messages.at(-1)?.content ?? "";
        const match = EXTRACTIONS.find(([source]) => prompt.includes(source));
        if (!match) return new Response("no extraction for this prompt", { status: 500 });
        const items = [{ content: match[1], memoryType: "preference", importance: 0.8 }];
        return Response.json({ model: "extraction-fixture", message: { role: "assistant", content: JSON.stringify(items) }, done: true });
      },
    });
  });
  afterAll(() => llm.stop(true));

  beforeEach(async () => {
    store = new SqliteMemoryStore(db, embedder);
    // server.ts 조립과 같은 임계: 충돌 범위와 추출 중복 흡수 임계를 글 모델 값으로 넘긴다.
    const extractor = new MemoryExtractor(
      new OllamaClient({ baseUrl: `http://127.0.0.1:${llm.port}`, model: "extraction-fixture" }), store, embedder,
      { conflictChecker: new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh }), duplicateSim: BGE_M3.dedupSim },
    );
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.llm.extractor.enabled = true;
    settings.llm.extractor.mode = "immediate";
    const deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), extractor, getSettings: () => settings };
    dir = mkdtempSync(join(tmpdir(), "bara-conflict-"));
    tokens = new SseTokenStore(join(dir, "tokens.json"));
    const app = new Hono({ strict: false });
    app.use("*", createAuthGate({ sseTokens: tokens, remoteAddrOf: () => "127.0.0.1", getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes }));
    registerMcpRoutes(app, deps);
    registerMemoriesRoutes(app, deps);
    server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
    clients = new Map();
    for (const name of ["claude-code", "codex"]) {
      const client = new Client({ name, version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.issueToken(name, undefined, undefined, "mcp-standard")}` } },
      }));
      clients.set(name, client);
    }
  });
  afterEach(async () => {
    await Promise.all([...clients.values()].map((client) => client.close()));
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(client: string, name: string, args: Record<string, unknown>) {
    const result = await clients.get(client)!.callTool({ name, arguments: args });
    return { error: result.isError === true, data: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) };
  }

  /** Discord 봇(full 토큰)이 다른 사람의 글을 REST 로 중계한다. */
  async function relay(userId: string, content: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${server.port}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.issueToken("discord-bot")}` },
      body: JSON.stringify({ content, author: "discord-bot", platform: "discord", memoryType: "preference", metadata: { user_id: userId } }),
    });
    expect(response.status).toBe(201);
  }

  const countOf = (content: string) =>
    (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content = ?").get(content) as { n: number }).n;
  const mentionsOf = (id: number) =>
    (db.query("SELECT mention_count AS n FROM knowledge_nodes WHERE id = ?").get(id) as { n: number }).n;
  const edgeWeight = (sourceId: number, targetId: number) =>
    (db.query("SELECT weight FROM knowledge_edges WHERE relation = 'contradicts' AND source_id = ? AND target_id = ?")
      .get(sourceId, targetId) as { weight: number }).weight;

  function idOf(content: string): number {
    const rows = db.query("SELECT id FROM knowledge_nodes WHERE content = ?").all(content) as Array<{ id: number }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }
  const disputesFrom = (id: number) => contradictsEdges().filter((edge) => edge.source_id === id).length;
  const stateOf = async (id: number) => readSharedMemory((await store.getNode(id))!.metadata);
  const recalledIds = async (client: string) =>
    ((await call(client, "recall_context", { query: "답변 언어", budget: 4000 })).data.memories as Array<{ id: number }>).map((m) => m.id);

  test("Claude 와 Codex 가 기록한 반대 선호는 충돌 후보가 되고, supersede 한 번으로 새 선호를 채택한다", async () => {
    expect((await call("claude-code", "save_preference", { content: KOREAN_SAVE })).error).toBe(false);
    expect((await call("codex", "save_preference", { content: ENGLISH_SAVE })).error).toBe(false);
    const korean = idOf(KOREAN_CHILD);
    const english = idOf(ENGLISH_CHILD);
    expect(contradictsEdges()).toContainEqual({ source_id: english, target_id: korean });
    // 충돌 기록 하나마다 revision 이 1 오른다(한국어 원문도 충돌 범위면 엣지가 둘이다).
    const recorded = disputesFrom(english);
    expect(await stateOf(english)).toMatchObject({ status: "disputed", revision: recorded });
    expect(await stateOf(korean)).toMatchObject({ status: "active", revision: 0 });
    expect(await recalledIds("claude-code")).not.toContain(english);

    const adopted = await call("codex", "supersede_memory", {
      id: korean, replacementId: english, expectedRevision: 0, requestId: "adopt-english",
    });
    expect(adopted.error).toBe(false);
    expect(adopted.data.affectedNodeIds).toEqual([korean, english]);
    expect(await stateOf(korean)).toMatchObject({ status: "superseded", revision: 1, supersededBy: english });
    expect(await stateOf(english)).toMatchObject({ status: "active", revision: recorded + 1 });
    const recalled = await recalledIds("claude-code");
    expect(recalled).toContain(english);
    expect(recalled).not.toContain(korean);
  });

  test("대상과 contradicts 로 연결되지 않은 disputed 기억으로는 대체할 수 없다", async () => {
    await call("claude-code", "save_preference", { content: KOREAN_SAVE });
    await call("codex", "save_preference", { content: ENGLISH_SAVE });
    const english = idOf(ENGLISH_CHILD);
    const unrelated = (await call("claude-code", "store_memory", { content: "배포는 금요일에 한다" })).data.id as number;
    const refused = await call("codex", "supersede_memory", {
      id: unrelated, replacementId: english, expectedRevision: 0, requestId: "adopt-unlinked",
    });
    expect(refused.error).toBe(true);
    expect(refused.data.code).toBe("INVALID_INPUT");
    expect(refused.data.message).toContain("contradicts");
    expect(await stateOf(english)).toMatchObject({ status: "disputed", revision: disputesFrom(english) });
    expect(await stateOf(unrelated)).toMatchObject({ status: "active", revision: 0 });
  });

  test("서로 다른 Discord 사용자의 선호는 후보가 아니고, 같은 사용자의 선호끼리만 후보가 된다", async () => {
    await relay("1001", KOREAN_SAVE);
    await relay("1002", ENGLISH_SAVE);
    const korean = idOf(KOREAN_CHILD);
    const otherPerson = idOf(ENGLISH_CHILD);
    expect(await stateOf(otherPerson)).toMatchObject({ status: "active", revision: 0 });
    expect(contradictsEdges()).toEqual([]);

    await relay("1001", ENGLISH_SAVE_2);
    const samePerson = idOf(ENGLISH_CHILD_2);
    expect(await stateOf(samePerson)).toMatchObject({ status: "disputed" });
    const edges = contradictsEdges();
    expect(edges).toContainEqual({ source_id: samePerson, target_id: korean });
    expect(edges.every((edge) => edge.source_id === samePerson)).toBe(true);
    expect(edges.some((edge) => edge.target_id === otherPerson || edge.target_id === idOf(ENGLISH_SAVE))).toBe(false);
  });

  test("다른 AI 가 거의 같은 문장으로 남긴 반대 선호(유사도 충돌 상한 이상)도 충돌 후보가 된다", async () => {
    expect((await call("claude-code", "save_preference", { content: KOREAN_SAVE })).error).toBe(false);
    expect((await call("codex", "save_preference", { content: ENGLISH_NEAR_SAVE })).error).toBe(false);
    const korean = idOf(KOREAN_CHILD);
    const english = idOf(ENGLISH_NEAR_CHILD);
    expect(contradictsEdges()).toContainEqual({ source_id: english, target_id: korean });
    expect(edgeWeight(english, korean)).toBeGreaterThanOrEqual(BGE_M3.conflictHigh);
    expect(await stateOf(english)).toMatchObject({ status: "disputed", revision: disputesFrom(english) });
    expect(await stateOf(korean)).toMatchObject({ status: "active", revision: 0 });
    expect(await recalledIds("claude-code")).not.toContain(english);
  });

  test("같은 AI 가 거의 같은 문장을 다시 남기면 지금처럼 기존 기억에 흡수되고 충돌이 아니다", async () => {
    expect((await call("claude-code", "save_preference", { content: KOREAN_SAVE })).error).toBe(false);
    const korean = idOf(KOREAN_CHILD);
    const mentionsBefore = mentionsOf(korean);
    expect((await call("claude-code", "save_preference", { content: ENGLISH_NEAR_SAVE })).error).toBe(false);
    expect(countOf(ENGLISH_NEAR_CHILD)).toBe(0);
    expect(mentionsOf(korean)).toBe(mentionsBefore + 1);
    expect(contradictsEdges()).toEqual([]);
    expect(await stateOf(korean)).toMatchObject({ status: "active", revision: 0 });
  });

  test("다른 AI 가 정규화 후 같은 본문을 남기면 충돌이 아니다", async () => {
    expect((await call("claude-code", "save_preference", { content: KOREAN_SAVE })).error).toBe(false);
    expect((await call("codex", "save_preference", { content: KOREAN_SAVE_2 })).error).toBe(false);
    const korean = idOf(KOREAN_CHILD);
    expect(contradictsEdges()).toEqual([]);
    expect(await stateOf(korean)).toMatchObject({ status: "active", revision: 0 });
    expect(await recalledIds("codex")).toContain(korean);
  });

  test("편집으로 다른 AI 의 기억과 정규화 후 같은 본문이 되어도 충돌이 아니다", async () => {
    const claude = await store.addNode({ content: KOREAN_CHILD, author: "claude-code", memoryType: "preference" });
    const codex = await store.addNode({ content: ENGLISH_NEAR_CHILD, author: "codex", memoryType: "preference" });
    // 편집은 같은 본문 흡수를 거치지 않아 같은 프로젝트에 정규화 후 같은 본문이 둘 생길 수 있다.
    expect(await store.editNodeContent({ nodeId: codex, content: `  ${KOREAN_CHILD.normalize("NFD")}
` })).not.toBeNull();
    const edited = (await store.getVectorById(codex))!;
    expect(cosineSimilarity(edited, (await store.getVectorById(claude))!)).toBeGreaterThanOrEqual(BGE_M3.conflictHigh);
    const recheck = new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh });
    expect(await recheck.recheckAfterEdit({
      nodeId: codex, content: KOREAN_CHILD, author: "codex", memoryType: "preference", newVector: edited,
    })).toEqual({ removed: 0, added: 0 });
    expect(contradictsEdges()).toEqual([]);
    expect(await stateOf(codex)).toMatchObject({ status: "active" });
  });

  test("거의 같은 문장의 충돌 후보도 supersede 한 번으로 채택한다", async () => {
    await call("claude-code", "save_preference", { content: KOREAN_SAVE });
    await call("codex", "save_preference", { content: ENGLISH_NEAR_SAVE });
    const korean = idOf(KOREAN_CHILD);
    const english = idOf(ENGLISH_NEAR_CHILD);
    const recorded = disputesFrom(english);
    expect(recorded).toBeGreaterThan(0);
    const adopted = await call("claude-code", "supersede_memory", {
      id: korean, replacementId: english, expectedRevision: 0, requestId: "adopt-near-english",
    });
    expect(adopted.error).toBe(false);
    expect(adopted.data.affectedNodeIds).toEqual([korean, english]);
    expect(await stateOf(korean)).toMatchObject({ status: "superseded", revision: 1, supersededBy: english });
    expect(await stateOf(english)).toMatchObject({ status: "active", revision: recorded + 1 });
    const recalled = await recalledIds("codex");
    expect(recalled).toContain(english);
    expect(recalled).not.toContain(korean);
  });

  // WP-B1-20T T3(설계 3.6.1, 9절 위험 3) — 두 AI 가 09R 예시 문장을 거의 그대로 원문으로 남기면 추출 항목이
  // 원문 자신의 주장이라 자식이 생기지 않고, 원문끼리 contradicts + disputed 가 된다. 원문에 붙은 충돌은 기존
  // 열린 충돌 읽기(get_memory·recall_context)와 supersede 해소 경로에서 자식 충돌과 같게 다뤄진다.
  test("09R 예시가 자기 주장 규칙으로 원문끼리 충돌 후보가 되고, 열린 충돌 표시와 supersede 가 원문에서 동작한다", async () => {
    expect((await call("claude-code", "save_preference", { content: KOREAN_SELF_SAVE })).error).toBe(false);
    expect((await call("codex", "save_preference", { content: ENGLISH_SELF_SAVE })).error).toBe(false);
    const korean = idOf(KOREAN_SELF_SAVE);
    const english = idOf(ENGLISH_SELF_SAVE);
    expect(countOf(KOREAN_CHILD)).toBe(0);
    expect(countOf(ENGLISH_NEAR_CHILD)).toBe(0);
    expect(contradictsEdges()).toEqual([{ source_id: english, target_id: korean }]);
    expect(await stateOf(english)).toMatchObject({ status: "disputed", revision: 1 });
    expect(await stateOf(korean)).toMatchObject({ status: "active", revision: 0 });

    expect((await call("claude-code", "get_memory", { id: english })).data.memory.conflicts).toEqual([korean]);
    expect((await call("claude-code", "get_memory", { id: korean })).data.memory.conflicts).toEqual([english]);
    expect(await recalledIds("claude-code")).not.toContain(english);

    const adopted = await call("codex", "supersede_memory", {
      id: korean, replacementId: english, expectedRevision: 0, requestId: "adopt-english-origin",
    });
    expect(adopted.error).toBe(false);
    expect(adopted.data.openConflicts).toEqual([]);
    expect(await stateOf(korean)).toMatchObject({ status: "superseded", revision: 1, supersededBy: english });
    expect(await stateOf(english)).toMatchObject({ status: "active", revision: 2 });
    expect((await call("codex", "get_memory", { id: english })).data.memory.conflicts).toEqual([]);
    const recalled = await recalledIds("codex");
    expect(recalled).toContain(english);
    expect(recalled).not.toContain(korean);
  });

  // WP-B1-10S(Medium 3) → WP-B1-20T T6(설계 5.11) — 원문(auto_capture, preservedRaw 없음)도 충돌
  // 후보라, 새 기억 N이 원문 A와 그 원문에서 추출된 자식 A' 둘 다에 contradicts로 이어지면 A'만
  // supersede해도 N-A가 해소되지 않은 채 남는다. 선택 (i): 원문·자식이 **둘 다 충돌 쌍일 때** 원문을
  // 빼고 자식만 잇는다 — N은 A'하고만 이어진다. 옛 규칙은 자식이 후보이기만 해도 원문을 뺐다(자식이
  // 쌍이 아니면 원문과의 실제 충돌을 잃음 — conflict-origin-exclusion.int.test.ts (b)).
  test("원문과 그 원문에서 추출된 자식이 둘 다 충돌 쌍이면 자식만 충돌 상대가 된다", async () => {
    expect((await call("claude-code", "save_preference", { content: KOREAN_SAVE })).error).toBe(false);
    const koreanOrigin = idOf(KOREAN_SAVE);
    const koreanChild = idOf(KOREAN_CHILD);
    // 원문이 preservedRaw 없는 auto_capture 로 저장됐고, 자식이 merged_into 로 이어졌는지 확인.
    expect((await store.getNode(koreanOrigin))!.sourceType).toBe("auto_capture");
    expect((await store.getNode(koreanOrigin))!.metadata.preservedRaw).toBeUndefined();
    const mergedIntoEdge = db.query(
      "SELECT 1 FROM knowledge_edges WHERE relation = 'merged_into' AND source_id = ? AND target_id = ?",
    ).get(koreanChild, koreanOrigin);
    expect(mergedIntoEdge).not.toBeNull();

    expect((await call("codex", "save_preference", { content: ENGLISH_SAVE })).error).toBe(false);
    const english = idOf(ENGLISH_CHILD);

    // 전제: N(english)은 원문과 자식 둘 다와 충돌 범위의 쌍이다(실측 0.675·0.754). 원문이 후보에서
    // 빠진 것이 "쌍이 아니라서"가 아니라 "자식과 함께 쌍이라서"임을 못 박는다.
    const englishVector = (await store.getVectorById(english))!;
    for (const pairId of [koreanOrigin, koreanChild]) {
      const sim = cosineSimilarity(englishVector, (await store.getVectorById(pairId))!);
      expect(sim).toBeGreaterThanOrEqual(BGE_M3.conflictLow);
      expect(sim).toBeLessThan(BGE_M3.conflictHigh);
    }

    // N(english)은 자식(koreanChild)하고만 이어진다 — 원문(koreanOrigin)과는 이어지지 않는다.
    expect(contradictsEdges()).toContainEqual({ source_id: english, target_id: koreanChild });
    expect(contradictsEdges().some((edge) => edge.target_id === koreanOrigin)).toBe(false);

    // 자식만 supersede해도 원문 쪽에 해소 안 된 충돌이 남지 않는다(N-A 없음 자체가 증거).
    const adopted = await call("codex", "supersede_memory", {
      id: koreanChild, replacementId: english, expectedRevision: 0, requestId: "adopt-english-over-child",
    });
    expect(adopted.error).toBe(false);
    expect(adopted.data.openConflicts).toEqual([]);
  });
});

// WP-B1-20U U3(설계 17.5, D19, QA Medium) — 충돌 후보 FTS 창. 후보는 FTS 상위 건 중에서 뽑는데, 같은 계보
// (excludeNodeIds)와 새 노드 자신을 빼기 전에 건수를 자르면 계보가 상위를 채울 때 바깥의 실제 충돌 상대를 놓친다.
describe("충돌 후보 FTS 창 — 제외 대상이 상위를 채워도 실제 충돌 상대를 찾는다 (설계 17.5)", () => {
  const WINDOW_ORIGIN = "답변은 한국어로 해 주세요. 코드 주석도 한국어로 남겨 주세요.";
  const WINDOW_CHILD = "답변은 한국어로 해 주세요";
  const WINDOW_OPPOSING = "앞으로 답변은 영어로 받고 싶다";
  const LINEAGE_SIZES = [2, 12, 40] as const;

  let windowEmbedder: Bgem3Embedder;
  beforeAll(async () => {
    windowEmbedder = new Bgem3Embedder();
    await windowEmbedder.load();
  });
  beforeEach(() => {
    store = new SqliteMemoryStore(db, windowEmbedder);
    checker = new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh });
  });

  const addFact = (content: string, sourceType: SourceType, author: string) =>
    store.addNode({ content, memoryType: "fact", sourceType, author });
  const mergedInto = (child: number, parent: number) =>
    store.addEdge({ sourceId: child, targetId: parent, relation: "merged_into", provenance: "system", sourceNodeId: parent, weight: 1 });
  const contradictTargets = (sourceId: number) =>
    contradictsEdges().filter((edge) => edge.source_id === sourceId).map((edge) => edge.target_id);
  const ftsTop = async (query: string) => (await store.ftsSearch(query, 10)).map(([id]) => id);
  async function similarity(a: number, b: number): Promise<number> {
    return cosineSimilarity((await store.getVectorById(a))!, (await store.getVectorById(b))!);
  }

  /** 새 노드 n 의 충돌 검사 — 저장 경로와 같은 인자(새 기억의 본문·작성자·벡터)로 부른다. */
  async function checkNew(newNodeId: number, content: string, excludeNodeIds: ReadonlySet<number>): Promise<number> {
    return checker.check({
      newNodeId, content, author: (await store.getNode(newNodeId))!.author, memoryType: "fact",
      newVector: (await store.getVectorById(newNodeId))!, excludeNodeIds,
    });
  }

  // QA 재현 — 다른 AI 의 반대 주장 X, 원문 O, O 의 계보 자식 N 개. 자식은 O 본문을 품어 O 의 FTS 질의에서 X 보다
  // 위에 오므로, 자식이 상위 10건을 채우면(N >= 10) 옛 창(10건)은 계보를 거른 뒤 후보가 0건이 되어 X 를 놓쳤다.
  for (const childCount of LINEAGE_SIZES) {
    test(`자기 주장 검사: 원문의 계보 자식 ${childCount}개가 FTS 상위를 채워도 다른 AI 의 반대 주장과 충돌 후보가 된다`, async () => {
      const opposing = await addFact(WINDOW_OPPOSING, "user_explicit", "other-ai");
      const origin = await addFact(WINDOW_ORIGIN, "auto_capture", "owner");
      const children: number[] = [];
      for (let i = 0; i < childCount; i++) {
        const child = await addFact(`코드 주석도 한국어로 남겨 주세요 ${i}번 규칙 답변은 한국어로`, "llm_extract", "owner");
        await mergedInto(child, origin);
        children.push(child);
      }
      const lineage = originWholeLineageSync(db, origin);
      expect(lineage.size).toBe(childCount + 1);
      // 전제: 원문과 X 는 충돌 범위의 쌍이고, 계보가 10건을 넘으면 옛 창 안(FTS 상위 10건)에 X 가 없다.
      const sim = await similarity(origin, opposing);
      expect(sim).toBeGreaterThanOrEqual(BGE_M3.conflictLow);
      expect(sim).toBeLessThan(BGE_M3.conflictHigh);
      const top10 = await ftsTop(WINDOW_ORIGIN);
      expect(top10.includes(opposing)).toBe(childCount + 1 < 10);
      expect(top10.every((id) => id === opposing || lineage.has(id))).toBe(true);

      const before = checker.readCounts;
      expect(await checkNew(origin, WINDOW_ORIGIN, lineage)).toBe(1);

      expect(contradictTargets(origin)).toEqual([opposing]);
      expect(readSharedMemory((await store.getNode(origin))!.metadata)).toMatchObject({ status: "disputed", revision: 1 });
      expect(readSharedMemory((await store.getNode(opposing))!.metadata)).toMatchObject({ status: "active", revision: 0 });
      expect(children.some((child) => contradictTargets(origin).includes(child))).toBe(false);
      // T6 (d): 제외 대상이 아무리 많아도 벡터 일괄 읽기는 check 한 번에 1회다.
      expect(checker.readCounts.vectorReads - before.vectorReads).toBe(1);
    }, 60_000);
  }

  // 자식 검사의 제외 집합은 원문과 그 조상(extractor 의 origin.selfAndAncestors)이다. 형제는 제외 대상이 아니라 지금처럼
  // 비교된다(origin-lineage.ts) — 그래서 이 창 규칙이 지키는 것은 "제외 대상이 후보 자리를 먹지 않는다"이다. 조상
  // 사슬이 계보 크기만큼 긴 원문을 만들어 같은 규칙을 자식 경로에서 고정한다.
  for (const excludedCount of LINEAGE_SIZES) {
    test(`자식 검사: 원문과 조상 ${excludedCount}개를 빼도 바깥의 다른 AI 의 반대 주장과 충돌 후보가 된다`, async () => {
      const opposing = await addFact(WINDOW_OPPOSING, "user_explicit", "other-ai");
      let origin = await addFact(`${WINDOW_ORIGIN} 상위 0단계`, "auto_capture", "owner");
      for (let depth = 1; depth < excludedCount; depth++) {
        const next = await addFact(`${WINDOW_ORIGIN} 상위 ${depth}단계`, "auto_capture", "owner");
        await mergedInto(next, origin);
        origin = next;
      }
      const child = await addFact(WINDOW_CHILD, "llm_extract", "owner");
      await mergedInto(child, origin);
      const excluded = originAndAncestorsSync(db, origin);
      expect(excluded.size).toBe(excludedCount);
      const sim = await similarity(child, opposing);
      expect(sim).toBeGreaterThanOrEqual(BGE_M3.conflictLow);
      expect(sim).toBeLessThan(BGE_M3.conflictHigh);
      const top10 = await ftsTop(WINDOW_CHILD);
      expect(top10.includes(opposing)).toBe(excludedCount + 1 < 10);

      const before = checker.readCounts;
      expect(await checkNew(child, WINDOW_CHILD, excluded)).toBe(1);

      expect(contradictTargets(child)).toEqual([opposing]);
      expect(readSharedMemory((await store.getNode(child))!.metadata)).toMatchObject({ status: "disputed", revision: 1 });
      expect(checker.readCounts.vectorReads - before.vectorReads).toBe(1);
    }, 60_000);
  }

  // 창을 넓혀도 후보는 제외 뒤 앞에서 상한(CONFLICT_FTS_CANDIDATE_LIMIT)건뿐이다 — 노드·벡터 읽기는 check 한 번에 그 건수
  // 이하를 지킨다(설계 17.5). 제외 집합이 FTS 에 안 잡히는 노드(본문이 질의와 무관한 조상)면 창이 그만큼 남아 제외 뒤에도
  // 후보가 상한보다 많이 남으므로, 자르지 않으면 이 테스트가 깨진다.
  test("창을 넓혀도 제외 뒤 앞에서 상한 건만 후보로 쓴다 — 제외 대상이 FTS 에 안 잡히면 창이 남아도 잘라 낸다", async () => {
    const unrelatedAncestors: number[] = [];
    let origin = await addFact("배포 일정은 매주 금요일 오후에 확정한다", "auto_capture", "owner");
    unrelatedAncestors.push(origin);
    for (let depth = 1; depth < 5; depth++) {
      const next = await addFact(`배포 일정 상위 ${depth}단계 문서의 머리말`, "auto_capture", "owner");
      await mergedInto(next, origin);
      unrelatedAncestors.push(next);
      origin = next;
    }
    const independents: number[] = [];
    for (let i = 0; i < CONFLICT_FTS_CANDIDATE_LIMIT + 4; i++) {
      independents.push(await addFact(`${WINDOW_CHILD} ${i}번 규칙`, "llm_extract", "owner"));
    }
    const child = await addFact(WINDOW_CHILD, "llm_extract", "owner");
    await mergedInto(child, origin);
    const excluded = originAndAncestorsSync(db, origin);
    expect(excluded.size).toBe(unrelatedAncestors.length);
    // 전제: 독립 후보 전부가 새 기억과 충돌 범위의 쌍이고 제외 집합은 FTS 에 하나도 안 잡힌다.
    for (const id of independents) {
      const sim = await similarity(child, id);
      expect(sim).toBeGreaterThanOrEqual(BGE_M3.conflictLow);
      expect(sim).toBeLessThan(BGE_M3.conflictHigh);
    }
    const ranked = (await store.ftsSearch(WINDOW_CHILD, 100)).map(([id]) => id);
    expect(ranked.some((id) => excluded.has(id))).toBe(false);

    const before = checker.readCounts;
    expect(await checkNew(child, WINDOW_CHILD, excluded)).toBe(CONFLICT_FTS_CANDIDATE_LIMIT);

    // 이어진 것은 FTS 순위 앞의 상한 건이다(나머지 4건은 모두 그 뒤 순위).
    const linked = contradictTargets(child);
    const rankOf = (id: number) => ranked.indexOf(id);
    const unlinked = independents.filter((id) => !linked.includes(id));
    expect(linked.every((id) => independents.includes(id))).toBe(true);
    expect(unlinked).toHaveLength(4);
    expect(Math.max(...linked.map(rankOf))).toBeLessThan(Math.min(...unlinked.map(rankOf)));
    expect(checker.readCounts.vectorReads - before.vectorReads).toBe(1);
  }, 60_000);
});
