/**
 * memories-from-text.sources.test.ts — POST /memories/from-text 의 저장 순서와 출처(WP-B1-20T T3, 설계 5.10).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 Hono 라우트(buildMemoryApi: POST /memories/from-text,
 * DELETE /memories/by-source, POST /search) + 실제 MemoryExtractor·OllamaClient. LLM 은 테스트 안 루프백
 * 서버(test-utils/prompt-ollama-chat-server.ts)가 원문마다 정해 둔 항목을 돌려준다.
 *
 *  - preserveRaw 참: 원문 R 이 먼저 저장되고(메시지 행), 자식은 R 의 계보(merged_into)로만 붙는다. R 과 같은
 *    항목은 자기 주장이라 자식이 없다. 메시지를 지우면 R 과 자식이 모두 지워지고 검색 0건.
 *  - preserveRaw 거짓: 부모가 없으므로 자식마다 메시지 행이 남는다. 메시지를 지우면 자식이 직접 지워진다.
 *    같은 본문의 대시보드 저장에 흡수된 자식은 그 저장의 행으로 남는다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EMBEDDING_CONFLICT_THRESHOLDS } from "../../embedding/factory.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { ConflictChecker } from "../../memory/conflict-checker.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { describeInputSource, sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { buildMemoryApi } from "../../server.ts";
import {
  startPromptOllamaChatServer,
  type ExtractionReply,
  type PromptOllamaChatServer,
} from "../../test-utils/prompt-ollama-chat-server.ts";

const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const BGE_M3 = EMBEDDING_CONFLICT_THRESHOLDS["bge-m3"];

/** 두 사실을 담은 한 문장 — 항목 두 개의 원문 유사도는 실측 0.824·0.772(중복 흡수 임계 0.85 아래). */
const TEXT = "주말에는 북한산에 오르고 저녁에는 추리소설을 읽는다";
const FACT_A = "주말에는 북한산에 오른다";
const FACT_B = "저녁에는 추리소설을 읽는다";

const REPLIES: readonly ExtractionReply[] = [{
  source: TEXT,
  items: [
    { content: TEXT, memoryType: "fact", importance: 0.8 },
    { content: FACT_A, memoryType: "fact", importance: 0.7 },
    { content: FACT_B, memoryType: "fact", importance: 0.7 },
  ],
}];

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  llm: PromptOllamaChatServer;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.llm.stop();
    h.db.close();
  }
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const llm = startPromptOllamaChatServer(REPLIES);
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: llm.url, model: "test-model" }), store, embedder,
    { conflictChecker: new ConflictChecker(store, { simLow: BGE_M3.conflictLow, simHigh: BGE_M3.conflictHigh }), duplicateSim: BGE_M3.dedupSim },
  );
  const app = buildMemoryApi({ store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), extractor });
  const h = { app, db, store, llm };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function request(h: Harness, method: string, path: string, body?: Json): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Json };
}

function fromText(h: Harness, messageId: string, preserveRaw: boolean) {
  return request(h, "POST", "/memories/from-text", {
    text: TEXT, author: AUTHOR, platform: PLATFORM, preserveRaw,
    metadata: { messageId, channelId: "channel-1", source: DISCORD_SOURCE },
  });
}

function deleteMessage(h: Harness, messageId: string) {
  return request(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);
}

function contentOf(db: Database, id: number): string {
  return (db.query("SELECT content FROM knowledge_nodes WHERE id = ?").get(id) as { content: string }).content;
}

function llmExtractContents(db: Database): string[] {
  return (db.query("SELECT content FROM knowledge_nodes WHERE source_type = 'llm_extract' ORDER BY id").all() as Array<{ content: string }>)
    .map((row) => row.content);
}

function lineageEdges(db: Database): Array<{ source_id: number; target_id: number }> {
  return db.query("SELECT source_id, target_id FROM knowledge_edges WHERE relation IN ('merged_into', 'parent_of') ORDER BY source_id")
    .all() as Array<{ source_id: number; target_id: number }>;
}

function sourceKeys(db: Database, id: number): string[] {
  return (new NodeSourceRepository(db).listSync([id]).get(id) ?? []).map((row) => row.key);
}

function nodeIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
}

async function searchContents(h: Harness, query: string): Promise<string[]> {
  const { status, body } = await request(h, "POST", "/search", { query, limit: 20 });
  expect(status).toBe(200);
  return (body.results as Array<{ content: string }>).map((r) => r.content);
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });
const ascending = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

describe("POST /memories/from-text — preserveRaw 참", () => {
  test("원문이 먼저 저장돼 메시지 행을 갖고, 자식은 원문 계보로만 붙으며, 원문과 같은 항목은 자식이 아니다", async () => {
    const h = makeHarness();
    const { status, body } = await fromText(h, "msg-ft-raw", true);
    expect(status).toBe(201);
    const rawId = (body.raw as { id: number }).id;
    const stored = body.stored as number[];

    expect(contentOf(h.db, rawId)).toBe(TEXT);
    expect(llmExtractContents(h.db)).toEqual([FACT_A, FACT_B]);
    expect(stored.map((id) => contentOf(h.db, id))).toEqual([FACT_A, FACT_B]);
    expect(lineageEdges(h.db)).toEqual(stored.map((id) => ({ source_id: id, target_id: rawId })));
    expect((h.db.query("SELECT COUNT(*) AS n FROM knowledge_edges WHERE source_id = target_id").get() as { n: number }).n).toBe(0);
    expect(sourceKeys(h.db, rawId)).toEqual([messageKey("msg-ft-raw")]);
    for (const id of stored) expect(sourceKeys(h.db, id)).toEqual([]);
    const raw = await h.store.getNode(rawId);
    expect(raw?.metadata).toMatchObject({ preservedRaw: true, extracted: 1, extractedTo: stored });
  }, 120_000);

  test("메시지를 지우면 원문과 자식이 모두 지워지고 세 본문 모두 검색 0건", async () => {
    const h = makeHarness();
    const { body } = await fromText(h, "msg-ft-raw-delete", true);
    const rawId = (body.raw as { id: number }).id;
    const stored = body.stored as number[];

    const deleted = await deleteMessage(h, "msg-ft-raw-delete");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deletedIds: [rawId], derivedDeletedIds: ascending(stored), keptIds: [] });
    expect(nodeIds(h.db)).toEqual([]);
    for (const content of [TEXT, FACT_A, FACT_B]) expect(await searchContents(h, content)).toEqual([]);
  }, 120_000);
});

describe("POST /memories/from-text — preserveRaw 거짓", () => {
  test("부모가 없으므로 자식마다 메시지 행이 남고, 메시지를 지우면 자식이 직접 지워져 검색 0건", async () => {
    const h = makeHarness();
    const { status, body } = await fromText(h, "msg-ft-children", false);
    expect(status).toBe(201);
    expect(body.raw).toBeNull();
    const stored = body.stored as number[];
    expect(stored.map((id) => contentOf(h.db, id))).toEqual([TEXT, FACT_A, FACT_B]);
    for (const id of stored) expect(sourceKeys(h.db, id)).toEqual([messageKey("msg-ft-children")]);
    expect(lineageEdges(h.db)).toEqual([]);

    const deleted = await deleteMessage(h, "msg-ft-children");
    expect(deleted.body).toMatchObject({ deletedIds: ascending(stored), derivedDeletedIds: [], keptIds: [] });
    expect(nodeIds(h.db)).toEqual([]);
    for (const content of [TEXT, FACT_A, FACT_B]) expect(await searchContents(h, content)).toEqual([]);
  }, 120_000);

  test("같은 본문의 대시보드 저장에 흡수된 자식은 메시지를 지워도 그 저장의 행으로 남는다", async () => {
    const h = makeHarness();
    const dashboardSource = describeInputSource({ source: "dashboard:manual", author: AUTHOR });
    const dashboard = await h.store.addNode({
      content: FACT_A, author: AUTHOR, memoryType: "fact", sourceType: "user_explicit",
      provenance: { kind: "source", source: dashboardSource },
    });
    const { body } = await fromText(h, "msg-ft-absorbed", false);
    // 같은 본문 항목은 유사 흡수로 대시보드 저장에 흡수되고, 그 노드가 이 메시지의 행을 받는다(설계 3.6).
    expect(body.bumped).toEqual([dashboard]);
    expect(body.stored as number[]).not.toContain(dashboard);
    expect(sourceKeys(h.db, dashboard).sort()).toEqual([dashboardSource.key, messageKey("msg-ft-absorbed")].sort());

    const deleted = await deleteMessage(h, "msg-ft-absorbed");
    expect(deleted.body).toMatchObject({ keptIds: [dashboard] });
    expect(nodeIds(h.db)).toEqual([dashboard]);
    expect(sourceKeys(h.db, dashboard)).toEqual([dashboardSource.key]);
    expect(await searchContents(h, FACT_A)).toContain(FACT_A);
    // 남은 대시보드 저장이 비슷한 질의에 걸릴 수는 있지만, 지운 메시지의 본문은 결과에 없다.
    for (const content of [TEXT, FACT_B]) expect(await searchContents(h, content)).not.toContain(content);
  }, 120_000);
});
