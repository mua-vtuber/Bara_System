/**
 * memories-edit.independent-save.test.ts — 원문 편집·철회가 자기 출처를 가진 기억을 숨기지 않는다
 * (WP-B1-20T 설계 5.7·5.8).
 *
 * 실제 SQLite + 실제 bge-m3 + 실제 저장 경로(saveTextInput)와 실제 REST 라우트(PATCH /memories/:id, POST /search),
 * 실제 MCP 도구 호출(update_memory·retract_memory — 실제 MCP Client 가 Streamable HTTP 로 인증 게이트를 지나
 * /mcp 를 부른다). 추출은 실제 MemoryExtractor 가 실제 OllamaClient 로 이 파일이 띄운 루프백 HTTP 서버(Ollama
 * /api/chat 응답 형식)를 부르고, 백필은 실제 startBackfillScheduler 사이클이다. regex 원자는 실제 builtin 양식이 만든다.
 *
 * 계보 무효화 규칙(설계 5.8): 원문 편집·철회의 계보로 닿은 노드가 자기 출처 행(memory_node_sources)을 가지면
 * 철회하지 않고, 철회되는 계보(원문과 이번에 철회되는 노드)로 가는 계보 엣지를 provenance 와 상관없이 모두 지우고
 * 그들의 extractedTo 에서 뺀다. 자기 출처 행이 없는 노드는 지금처럼 철회 후보다. 세 통로(REST PATCH /memories/:id,
 * MCP update_memory, MCP retract_memory)가 같은 규칙을 쓴다.
 *  - 대시보드 저장을 흡수한 regex 원자·추출 자식은 원문 편집 뒤에도 기본 조회에 남고, 원문과의 계보만 끊긴다.
 *  - 편집 뒤 재추출이 같은 사실을 다시 뽑아 그 노드에 흡수하면 계보 엣지가 다시 생기지만(설계 3.6), 그 노드는 자기
 *    출처 행으로 기본 조회와 출처 삭제에서 남는다.
 *  - 먼저 저장된 독립 기억이 regex 원자나 추출 자식을 같은 본문으로 흡수해 받은 계보 엣지(regex·merged_into)는
 *    원문 편집 뒤 낡은 연결이라 모두 끊긴다. 그 기억은 철회되지 않는다.
 * by-id 편집 규칙(설계 5.7, Q2): REST·MCP 편집은 같은 id 로 고치고 출처 행을 더하지 않는다 — 편집자는 출처가 아니다.
 */

import { TEST_EXTRACTION_BACKFILL_RETRY } from "../../test-utils/backfill-retry.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { readMemoryVisibility } from "../../memory/shared-memory-read.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { startBackfillScheduler, type BackfillCycleSummary } from "../../scheduler.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { registerMcpRoutes } from "../../mcp/server.ts";
import { buildMemoryApi } from "../../server.ts";
import { createAuthGate } from "../auth-gate.ts";
import { saveTextInput } from "../save-input.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";

const EXTRACTION_MODEL = "extraction-fixture";
const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const MCP_CLIENT = "ai-editor";
const JSON_HEADERS = { "Content-Type": "application/json" };

/** 실제 builtin regex 양식이 원자 두 개("운영팀 채널로 보내기로 확정했다." 등)를 만드는 문장. */
const REGEX_SENTENCE = "배포 알림은 앞으로 운영팀 채널로 보내기로 확정했다.";
const REGEX_ATOM = "운영팀 채널로 보내기로 확정했다.";
const REGEX_EDITED = "배포 알림 경로는 다음 회의에서 다시 정한다.";

const TWO_SENTENCES = "배포 창구는 금요일 오후로 정했다. 롤백 담당은 운영팀이 맡는다.";
const EDITED_TWO_SENTENCES = "배포 창구는 화요일 오전으로 옮겼다. 롤백 담당은 운영팀이 맡는다.";
const KEPT_FACT = "롤백 담당은 운영팀이 맡는다";
const NEW_FACT = "배포 창구는 화요일 오전이다";

const DASHBOARD_SAVE_KEY = sourceKeyOf({ kind: "direct_save", channel: "dashboard", actor: AUTHOR });
const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });

/** 노드의 출처 행 키(정렬). */
function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function mentionCount(db: Database, id: number): number {
  return (db.query("SELECT mention_count FROM knowledge_nodes WHERE id = ?").get(id) as { mention_count: number }).mention_count;
}

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface LoopbackLlm {
  server: ReturnType<typeof Bun.serve>;
  /** 다음 /api/chat 응답이 돌려줄 추출 항목. */
  items: unknown[];
}

/** 실제 OllamaClient 가 부르는 루프백 서버 — Ollama /api/chat 응답 형식으로 items 를 돌려준다. */
function startLoopbackLlm(): LoopbackLlm {
  const llm: Omit<LoopbackLlm, "server"> = { items: [] };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        model: EXTRACTION_MODEL,
        message: { role: "assistant", content: JSON.stringify(llm.items) },
        done: true,
      });
    },
  });
  return Object.assign(llm, { server });
}

interface McpHarness {
  client: Client;
  server: ReturnType<typeof Bun.serve>;
  dir: string;
}

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  llm: LoopbackLlm;
  extractor: MemoryExtractor;
  settings: MemorySettings;
  mcp?: McpHarness;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    if (h.mcp) {
      await h.mcp.client.close();
      h.mcp.server.stop(true);
      rmSync(h.mcp.dir, { recursive: true, force: true });
    }
    h.llm.server.stop(true);
    h.db.close();
  }
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  const llm = startLoopbackLlm();
  // 중복 흡수는 같은 문장(유사도 1)만 — 문장 사실이 자기 원문(두 문장 전체)에 흡수되지 않게 한다.
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: `http://127.0.0.1:${llm.server.port}`, model: EXTRACTION_MODEL }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    getSettings: () => settings,
  });
  const h: Harness = { app, db, store, llm, extractor, settings };
  harnesses.push(h);
  return h;
}

/**
 * 같은 저장소에 인증 게이트 + /mcp 를 띄우고 실제 MCP Client 로 연결한다(tools-shared-memory.int.test.ts 와 같은 조립).
 * 토큰 행위자(adapterId)가 MCP_CLIENT 다.
 */
async function connectMcp(h: Harness): Promise<Client> {
  const dir = mkdtempSync(join(tmpdir(), "bara-independent-save-mcp-"));
  const tokens = new SseTokenStore(join(dir, "tokens.json"));
  const app = new Hono({ strict: false });
  app.use("*", createAuthGate({
    sseTokens: tokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  registerMcpRoutes(app, {
    store: h.store, retriever: new HybridRetriever(h.store, embedder), assembler: new ContextAssembler(),
    getSettings: () => h.settings,
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  const client = new Client({ name: MCP_CLIENT, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.issueToken(MCP_CLIENT)}` } },
  }));
  h.mcp = { client, server, dir };
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { error: result.isError === true, data: JSON.parse(content[0]!.text) };
}

function builtinRegexL0(): RegexL0Extractor {
  return new RegexL0Extractor({ patternPaths: [], boosterPaths: [], userRepo: undefined, langs: ["ko"] });
}

/** Discord 봇이 보내는 모양으로 regex 를 켜고 저장한다(추출기 없음 — plain 갈래). */
async function saveDiscordWithRegex(h: Harness, content: string, messageId: string) {
  const saved = await saveTextInput(h.store, {
    content, source: PLATFORM, author: AUTHOR, force: true,
    extraMetadata: { messageId, source: DISCORD_SOURCE },
    regexL0: builtinRegexL0(), regexEnabled: true,
  });
  return { origin: saved.originNodeId!, regexAtoms: saved.extracted };
}

/** Discord 봇이 보내는 모양으로 즉시 추출해 저장한다 — 추출 항목 하나(KEPT_FACT). */
async function saveDiscordExtracted(h: Harness, content: string, messageId: string) {
  h.llm.items = [{ content: KEPT_FACT, memoryType: "episode", importance: 0.8 }];
  const saved = await saveTextInput(h.store, {
    content, source: PLATFORM, author: AUTHOR, force: true,
    extraMetadata: { messageId, source: DISCORD_SOURCE },
    extractor: h.extractor, extractorSettings: h.settings.llm.extractor,
  });
  expect(saved.immediateExtractionRan).toBe(true);
  expect(saved.extracted).toHaveLength(1);
  return { origin: saved.originNodeId!, child: saved.extracted[0]! };
}

/** 대시보드 저장 — 같은 본문이면 저장 경로가 기존 노드로 흡수한다. */
async function saveDashboard(h: Harness, content: string) {
  return await saveTextInput(h.store, { content, source: "dashboard", author: AUTHOR });
}

/** Discord 원문과, 대시보드 저장을 흡수한 추출 자식. */
async function childWithDashboardSave(h: Harness, messageId: string) {
  const { origin, child } = await saveDiscordExtracted(h, TWO_SENTENCES, messageId);
  const dashboard = await saveDashboard(h, KEPT_FACT);
  expect(dashboard.cacheHit).toBe(true);
  expect(dashboard.originNodeId).toBe(child);
  expect(lineageParents(h.db, child)).toEqual([origin]);
  expect((await h.store.getNode(origin))!.metadata.extractedTo).toEqual([child]);
  expect(sourceKeys(h.db, child)).toEqual([DASHBOARD_SAVE_KEY]);
  expect(sourceKeys(h.db, origin)).toEqual([messageKey(messageId)]);
  return { origin, child };
}

async function editContent(h: Harness, id: number, content: string): Promise<void> {
  const res = await h.app.request(`/memories/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ content }) });
  expect(res.status).toBe(200);
}

async function searchIds(h: Harness, query: string): Promise<number[]> {
  const res = await h.app.request("/search", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ query, limit: 20 }) });
  expect(res.status).toBe(200);
  return (await res.json() as { results: Array<{ id: number }> }).results.map((r) => r.id);
}

function isVisible(h: Harness, id: number): boolean {
  const allowed = readMemoryVisibility(h.store).allowedIds;
  return allowed === undefined || allowed.has(id);
}

async function statusOf(h: Harness, id: number) {
  return readSharedMemory((await h.store.getNode(id))!.metadata);
}

function lineageParents(db: Database, id: number): number[] {
  return (db.query(`SELECT target_id FROM knowledge_edges
    WHERE source_id = ? AND relation IN ('merged_into', 'parent_of') ORDER BY target_id`)
    .all(id) as Array<{ target_id: number }>).map((r) => r.target_id);
}

async function runBackfill(h: Harness): Promise<BackfillCycleSummary> {
  const handle = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 10, retry: TEST_EXTRACTION_BACKFILL_RETRY });
  try {
    return await handle.tickNow();
  } finally {
    await handle.stop();
  }
}

/** 편집 뒤 자기 출처를 가진 자식이 철회되지 않고 원문 계보에서 떨어져 기본 조회에 남았다. */
async function expectKeptAndDetached(h: Harness, child: number): Promise<void> {
  expect((await statusOf(h, child)).status).toBe("active");
  expect((await statusOf(h, child)).invalidatedBy).toBeUndefined();
  expect(lineageParents(h.db, child)).toEqual([]);
  expect(isVisible(h, child)).toBe(true);
  expect(sourceKeys(h.db, child)).toEqual([DASHBOARD_SAVE_KEY]);
  expect(await searchIds(h, KEPT_FACT)).toContain(child);
}

describe("원문 편집과 자기 출처를 가진 기억 (REST PATCH /memories/:id)", () => {
  test("대시보드 저장을 흡수한 regex 원자는 원문 편집 뒤에도 기본 조회에 남고 원문 계보만 끊긴다", async () => {
    const h = makeHarness();
    const discord = await saveDiscordWithRegex(h, REGEX_SENTENCE, "msg-edit-regex");
    const dashboard = await saveDashboard(h, REGEX_ATOM);
    expect(dashboard.cacheHit).toBe(true);
    const kept = dashboard.originNodeId!;
    expect(discord.regexAtoms).toContain(kept);
    // 흡수된 대시보드 저장은 그 원자의 출처 행으로 남는다(설계 3.6).
    expect(sourceKeys(h.db, kept)).toEqual([DASHBOARD_SAVE_KEY]);
    const others = discord.regexAtoms.filter((id) => id !== kept);
    expect(others.length).toBeGreaterThan(0);

    await editContent(h, discord.origin, REGEX_EDITED);

    expect((await statusOf(h, kept)).status).toBe("active");
    expect((await statusOf(h, kept)).invalidatedBy).toBeUndefined();
    expect(lineageParents(h.db, kept)).toEqual([]);
    expect(isVisible(h, kept)).toBe(true);
    expect(await searchIds(h, REGEX_ATOM)).toContain(kept);
    // 자기 출처 행이 없는 원자는 옛 주장과 함께 철회된다.
    for (const id of others) {
      expect(await statusOf(h, id)).toMatchObject({ status: "retracted", invalidatedBy: discord.origin });
      expect(isVisible(h, id)).toBe(false);
    }
    // by-id 편집은 원문에 출처 행을 더하지 않는다(설계 5.7, Q2).
    expect(sourceKeys(h.db, discord.origin)).toEqual([messageKey("msg-edit-regex")]);
  }, 120_000);

  test("대시보드 저장을 흡수한 추출 자식은 편집 뒤에도 남고, 재추출이 다시 흡수해 계보가 생겨도 자기 출처로 남는다", async () => {
    const h = makeHarness();
    const { origin, child } = await childWithDashboardSave(h, "msg-edit-llm");

    await editContent(h, origin, EDITED_TWO_SENTENCES);

    await expectKeptAndDetached(h, child);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("msg-edit-llm")]);
    // WP-B1-06 표시: 원문은 추출 대기, 끊긴 자식은 원문의 추출 기록으로 읽히지 않는다.
    const pending = (await h.store.getNode(origin))!;
    expect(pending.metadata.extracted).toBe(0);
    expect(pending.metadata).not.toHaveProperty("extractedTo");
    expect((await h.store.getBackfillCandidates({ limit: 50 })).map((n) => n.id)).toEqual([origin]);

    // 재추출이 바뀌지 않은 문장의 사실을 다시 뽑으면 남은 자식에 흡수된다(파생 흡수 — 언급만 오른다).
    const mentionsBeforeReextract = mentionCount(h.db, child);
    h.llm.items = [
      { content: KEPT_FACT, memoryType: "episode", importance: 0.8 },
      { content: NEW_FACT, memoryType: "episode", importance: 0.8 },
    ];
    expect(await runBackfill(h)).toMatchObject({ processed: 1, storedNodes: 1, bumpedNodes: 1, failures: 0 });
    const reextracted = (await h.store.getNode(origin))!;
    expect(reextracted.metadata.extracted).toBe(1);
    const [newChild] = reextracted.metadata.extractedTo as number[];
    expect(reextracted.metadata.extractedTo).toEqual([newChild]);
    expect(newChild).not.toBe(child);
    // 파생 흡수는 출처 행을 더하지 않고 언급을 올리며, 흡수한 노드 → 원문 계보 엣지를 다시 더한다(설계 3.6,
    // 5.8 셋째 항목). 대시보드 저장의 출처 행은 그대로라 생존에는 영향이 없다(아래 출처 삭제).
    expect(sourceKeys(h.db, child)).toEqual([DASHBOARD_SAVE_KEY]);
    expect(mentionCount(h.db, child)).toBe(mentionsBeforeReextract + 1);
    expect(lineageParents(h.db, child)).toEqual([origin]);
    expect(isVisible(h, child)).toBe(true);
    expect((await h.store.getBackfillCandidates({ limit: 50 })).map((n) => n.id)).toEqual([]);

    // 출처 삭제도 이 노드를 남긴다(자기 출처 행).
    const deleted = await h.store.deleteBySource({ messageId: "msg-edit-llm", platform: PLATFORM });
    expect(deleted.deletedIds).toContain(origin);
    expect(await h.store.getNode(child)).not.toBeNull();
    expect(await searchIds(h, KEPT_FACT)).toContain(child);
  }, 120_000);

  test("regex 원자를 흡수한 독립 기억은 원문 편집으로 철회되지 않고 원문과의 계보 엣지를 모두 잃는다", async () => {
    const h = makeHarness();
    // 같은 본문을 먼저 대시보드에 저장했다 — 뒤 Discord 글의 regex 원자가 이 노드로 흡수된다.
    const independent = (await saveDashboard(h, REGEX_ATOM)).originNodeId!;
    const discord = await saveDiscordWithRegex(h, REGEX_SENTENCE, "msg-edit-independent");
    expect(discord.regexAtoms).toContain(independent);
    expect(lineageParents(h.db, independent)).toEqual([discord.origin]);

    await editContent(h, discord.origin, REGEX_EDITED);

    expect((await h.store.getNode(independent))!.metadata.sharedMemory).toBeUndefined();
    expect(lineageParents(h.db, independent)).toEqual([]);
    expect(isVisible(h, independent)).toBe(true);
    expect(sourceKeys(h.db, independent)).toEqual([DASHBOARD_SAVE_KEY]);
    expect(await searchIds(h, REGEX_ATOM)).toContain(independent);
  }, 120_000);

  test("추출 자식을 같은 본문으로 흡수한 독립 기억은 원문 편집 뒤 낡은 merged_into 를 잃고 철회되지 않는다", async () => {
    const h = makeHarness();
    // 같은 본문을 먼저 대시보드에 저장했다 — 뒤 Discord 글의 추출 항목이 이 노드로 흡수된다(설계 3.6 파생 흡수).
    const independent = (await saveDashboard(h, KEPT_FACT)).originNodeId!;
    h.llm.items = [{ content: KEPT_FACT, memoryType: "episode", importance: 0.8 }];
    const saved = await saveTextInput(h.store, {
      content: TWO_SENTENCES, source: PLATFORM, author: AUTHOR, force: true,
      extraMetadata: { messageId: "msg-edit-merged", source: DISCORD_SOURCE },
      extractor: h.extractor, extractorSettings: h.settings.llm.extractor,
    });
    const origin = saved.originNodeId!;
    // 흡수는 새 자식이 아니라 기존 노드의 재언급이다 — 계보 엣지만 생긴다.
    expect(saved).toMatchObject({ immediateExtractionRan: true, extracted: [], bumped: [independent] });
    expect(h.db.query(`SELECT relation, provenance FROM knowledge_edges
      WHERE source_id = ? AND target_id = ?`).all(independent, origin)).toEqual([{ relation: "merged_into", provenance: "system" }]);
    expect(lineageParents(h.db, independent)).toEqual([origin]);

    await editContent(h, origin, EDITED_TWO_SENTENCES);

    expect((await h.store.getNode(independent))!.metadata.sharedMemory).toBeUndefined();
    expect(lineageParents(h.db, independent)).toEqual([]);
    expect(isVisible(h, independent)).toBe(true);
    expect(sourceKeys(h.db, independent)).toEqual([DASHBOARD_SAVE_KEY]);
    expect(await searchIds(h, KEPT_FACT)).toContain(independent);
    // 원문 쪽도 낡은 기록이 없다 — 편집이 추출 대기로 표시하며 extractedTo 를 지웠다.
    expect((await h.store.getNode(origin))!.metadata).not.toHaveProperty("extractedTo");
  }, 120_000);
});

describe("원문 편집·철회와 자기 출처를 가진 기억 (MCP 도구)", () => {
  test("MCP update_memory 도 대시보드 저장을 흡수한 추출 자식을 철회하지 않고 계보에서 떼며, 원문에 출처를 더하지 않는다", async () => {
    const h = makeHarness();
    const { origin, child } = await childWithDashboardSave(h, "msg-mcp-update");
    const client = await connectMcp(h);

    const updated = await callTool(client, "update_memory", {
      id: origin, content: EDITED_TWO_SENTENCES, expectedRevision: 0, requestId: "update-origin",
    });
    expect(updated.error).toBe(false);
    expect(updated.data.node.content).toBe(EDITED_TWO_SENTENCES);
    expect(updated.data.affectedNodeIds).toEqual([origin]);

    await expectKeptAndDetached(h, child);
    // 편집한 AI(MCP_CLIENT)는 출처가 아니다 — 원문의 출처 행은 그 메시지 하나 그대로다(설계 5.7, Q2).
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("msg-mcp-update")]);
    expect((await h.store.getNode(origin))!.metadata).not.toHaveProperty("extractedTo");
  }, 120_000);

  test("MCP retract_memory 로 원문을 철회해도 대시보드 저장을 흡수한 추출 자식은 extractedTo 에서 빠져 기본 조회에 남는다", async () => {
    const h = makeHarness();
    const { origin, child } = await childWithDashboardSave(h, "msg-mcp-retract");
    const client = await connectMcp(h);

    const retracted = await callTool(client, "retract_memory", { id: origin, expectedRevision: 0, requestId: "retract-origin" });
    expect(retracted.error).toBe(false);
    expect(retracted.data.affectedNodeIds).toEqual([origin]);

    await expectKeptAndDetached(h, child);
    expect((await h.store.getNode(origin))!.metadata.extractedTo).toEqual([]);
    expect(isVisible(h, origin)).toBe(false);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("msg-mcp-retract")]);
  }, 120_000);
});
