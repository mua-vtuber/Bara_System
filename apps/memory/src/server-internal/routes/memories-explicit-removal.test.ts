/**
 * memories-explicit-removal.test.ts — 명시적 제거의 계보 정리(WP-B1-20U 설계 17.3, U1).
 *
 * 원문이 메시지 삭제가 아닌 통로(자동 정리, 단건 영구 삭제·봇 /forget, 휴지통)로 먼저 사라지면, 출처 행이
 * 없는 추출 자식이 부모 없이 남아 메시지 삭제가 영영 찾지 못했다(QA 재현). 모든 제거 통로가 explicit 계획을
 * 거쳐 "살아 있는 노드는 자기 출처 행이나 살아 있는 계보 부모를 가진다" 불변식을 지키는지 본다.
 *
 * Real bun:sqlite(:memory:) + real bge-m3 + 실제 라우트(buildMemoryApi) + 실제 즉시 추출(MemoryExtractor 가
 * 실제 OllamaClient 로 테스트 안 Bun.serve 루프백 LLM 을 부른다) + 실제 자동 정리 본체(runAutoCleanup) +
 * 실제 MemoryApiClient(봇 /forget 이 쓰는 클라이언트)를 루프백 Bun.serve 의 실제 앱에 붙인다. mock 0.
 * 가치 점수를 낮추는 것은 실제 노드 행의 importance·last_accessed_at 칸을 SQL 로 바꾸는 데이터 픽스처다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EMBEDDING_CONFLICT_THRESHOLDS } from "../../embedding/factory.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { ConflictChecker } from "../../memory/conflict-checker.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { runAutoCleanup } from "../../memory/auto-cleanup-runner.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import { archivedLineageKeyOf, sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { MemoryApiClient } from "../../api-client.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import {
  startPromptOllamaChatServer,
  type ExtractionReply,
  type PromptOllamaChatServer,
} from "../../test-utils/prompt-ollama-chat-server.ts";

const BGE = EMBEDDING_CONFLICT_THRESHOLDS["bge-m3"];
const OWNER = "owner";
const PLATFORM = "discord";
/** QA 재현 원문 — 즉시 추출이 자식 하나(CHILD)를 만든다. */
const ORIGIN_TEXT = "새 노트북은 맥북 프로로 샀다. 사무실 와이파이 비밀번호는 바뀌었다.";
const CHILD = "새 노트북은 맥북 프로다";
/** 대시보드에서 고친 자식 본문 — 편집 이력 행을 만들기 위해 쓴다. */
const EDITED_CHILD = "새 노트북은 맥북 프로 십육 인치다";
const EXTRACTION: ExtractionReply[] = [
  { source: ORIGIN_TEXT, items: [{ content: CHILD, memoryType: "fact", importance: 0.9 }] },
  { source: EDITED_CHILD, items: [] },
];
/** 자동 정리 가치 임계(auto-cleanup-runner 기본값과 같은 값을 명시). */
const VALUE_THRESHOLD = 0.05;
/** 가치 점수 미달로 만드는 칸 값 — 오래 안 읽혔고 중요도가 낮다. */
const LOW_IMPORTANCE = 0.01;
const LONG_AGO = "2020-01-01 00:00:00";
/** 잠금을 쥔 동안 DELETE 요청이 잠금 줄에 서기를 기다리는 시간. */
const LOCK_SETTLE_MS = 500;
/** WP-B1-20U 설계 17.17 — 문서·이미지 노드가 없어 해제한 첨부가 없는 단건 영구 삭제의 assetCleanup. */
const NO_ASSET_CLEANUP = { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] };

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
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const h of harnesses.splice(0)) {
    h.llm.stop();
    h.db.close();
  }
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const llm = startPromptOllamaChatServer(EXTRACTION);
  const conflictChecker = new ConflictChecker(store, { simLow: BGE.conflictLow, simHigh: BGE.conflictHigh });
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: llm.url, model: "test-model" }),
    store,
    embedder,
    { conflictChecker, duplicateSim: BGE.dedupSim },
  );
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  settings.extractor.regex.enabled = false;
  const app = buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    extractor,
    conflictChecker,
    getSettings: () => settings,
  });
  const h = { app, db, store, llm };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

/** Discord 메시지 저장(즉시 추출) → [원문, 추출 자식]. */
async function saveDiscordMessage(h: Harness, messageId: string): Promise<{ origin: number; child: number }> {
  const saved = await call(h, "POST", "/memories", {
    content: ORIGIN_TEXT,
    author: OWNER,
    platform: PLATFORM,
    metadata: { messageId, channelId: "c1", guildId: "g1", source: "discord-channel" },
  });
  expect(saved.status).toBe(201);
  const origin = saved.body.id as number;
  const child = liveNodes(h.db).find((node) => node.content === CHILD)?.id;
  if (child === undefined) throw new Error(`즉시 추출 자식 '${CHILD}' 가 저장되지 않았습니다`);
  expect(liveNodes(h.db).map((node) => node.id)).toEqual([origin, child]);
  return { origin, child };
}

function dropMessage(h: Harness, messageId: string) {
  return call(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);
}

function liveNodes(db: Database): Array<{ id: number; content: string }> {
  return db.query("SELECT id, content FROM knowledge_nodes ORDER BY id").all() as Array<{ id: number; content: string }>;
}

function archivedIds(db: Database): number[] {
  return (db.query("SELECT id FROM knowledge_nodes_archive ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

function sourceKinds(db: Database, id: number): string[] {
  return (db.query("SELECT kind FROM memory_node_sources WHERE node_id = ? ORDER BY kind").all(id) as Array<{ kind: string }>)
    .map((r) => r.kind);
}

function archivedSourceKeys(db: Database, id: number): string[] {
  return (db.query("SELECT source_key FROM memory_node_sources_archive WHERE node_id = ? ORDER BY source_key")
    .all(id) as Array<{ source_key: string }>).map((r) => r.source_key);
}

function revisionCount(db: Database, id: number): number {
  return (db.query("SELECT COUNT(*) AS n FROM memory_revisions WHERE old_node_id = ? OR new_node_id = ?")
    .get(id, id) as { n: number }).n;
}

/** 살아 있는 노드·보관표·수정 이력에 그 글이 남은 수. */
function textCount(db: Database, text: string): { live: number; archive: number; revisions: number } {
  const like = `%${text}%`;
  const count = (sql: string, ...args: string[]) => (db.query(sql).get(...args) as { n: number }).n;
  return {
    live: count("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content LIKE ?", like),
    archive: count("SELECT COUNT(*) AS n FROM knowledge_nodes_archive WHERE content LIKE ?", like),
    revisions: count("SELECT COUNT(*) AS n FROM memory_revisions WHERE old_content LIKE ? OR new_content LIKE ?", like, like),
  };
}

const NO_TEXT = { live: 0, archive: 0, revisions: 0 };

async function searchContents(h: Harness, query: string): Promise<string[]> {
  const res = await call(h, "POST", "/search", { query, limit: 30 });
  expect(res.status).toBe(200);
  return (res.body.results as Array<{ content: string }>).map((r) => r.content);
}

function makeLowValue(db: Database, id: number): void {
  db.query("UPDATE knowledge_nodes SET importance = ?, last_accessed_at = ? WHERE id = ?").run(LOW_IMPORTANCE, LONG_AGO, id);
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });
const ascending = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("자동 정리(selected_only) — QA 재현 1", () => {
  test("원문만 가치 미달이면 원문·자식 모두 남고(nodesKeptForLineage 1), 메시지 삭제가 둘 다 지운다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-auto");
    makeLowValue(h.db, origin);

    const summary = await runAutoCleanup(h.store, { valueThreshold: VALUE_THRESHOLD });
    expect(summary.nodesArchived).toBe(0);
    expect(summary.nodesKeptForLineage).toBe(1);
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([origin, child]);
    expect(archivedIds(h.db)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const dropped = await dropMessage(h, "m-auto");
    expect(dropped.status).toBe(200);
    expect(dropped.body).toMatchObject({ deletedIds: [origin], derivedDeletedIds: [child], keptIds: [], archivePurgedIds: [] });
    expect(liveNodes(h.db)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);
    expect((await searchContents(h, CHILD)).filter((content) => content.includes(CHILD))).toEqual([]);
    expect(textCount(h.db, CHILD)).toEqual(NO_TEXT);
  }, 300_000);

  test("원문·자식 모두 가치 미달이면 함께 휴지통 — 자식은 archived_lineage 를 받고, 메시지 삭제가 보관표에서 둘 다 지운다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-auto-both");
    makeLowValue(h.db, origin);
    makeLowValue(h.db, child);
    const revisionBefore = h.store.getDbRevision();

    const summary = await runAutoCleanup(h.store, { valueThreshold: VALUE_THRESHOLD });
    expect(summary).toMatchObject({ nodesArchived: 2, nodesKeptForLineage: 0 });
    expect(h.store.getDbRevision()).toBeGreaterThan(revisionBefore);
    expect(liveNodes(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual(ascending([origin, child]));
    expect(archivedSourceKeys(h.db, origin)).toEqual([messageKey("m-auto-both")]);
    expect(archivedSourceKeys(h.db, child)).toEqual([archivedLineageKeyOf(origin)]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const dropped = await dropMessage(h, "m-auto-both");
    expect(dropped.body).toMatchObject({ deletedIds: [], derivedDeletedIds: [], archivePurgedIds: ascending([origin, child]) });
    expect(archivedIds(h.db)).toEqual([]);
    expect(textCount(h.db, CHILD)).toEqual(NO_TEXT);
  }, 300_000);

  test("고르지 않은 자식이 자기 출처(대시보드 저장)를 가지면 막지 않고 원문만 옮긴다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-auto-held");
    const dashboard = await call(h, "POST", "/memories", { content: CHILD, author: OWNER, platform: "dashboard" });
    expect(dashboard.body.id).toBe(child);
    makeLowValue(h.db, origin);

    const summary = await runAutoCleanup(h.store, { valueThreshold: VALUE_THRESHOLD });
    expect(summary).toMatchObject({ nodesArchived: 1, nodesKeptForLineage: 0 });
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([child]);
    expect(sourceKinds(h.db, child)).toEqual(["direct_save"]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const dropped = await dropMessage(h, "m-auto-held");
    expect(dropped.body).toMatchObject({ deletedIds: [], derivedDeletedIds: [], archivePurgedIds: [origin] });
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([child]);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 300_000);
});

describe("단건 영구 삭제(DELETE /memories/:id, 봇 /forget) — QA 재현 2", () => {
  test("실제 MemoryApiClient.forget: 원문과 출처 없는 자식을 함께 지우고, 두 노드의 수정 이력도 지운다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-forget");
    // 지운 메시지 본문이 이력에 남는 경우를 만든다: 자식 본문 편집, 원문 분류만 편집(본문 그대로 이력에 남는다).
    const editedChild = await call(h, "PATCH", `/memories/${child}`, { content: EDITED_CHILD, editor: OWNER, source: "dashboard" });
    expect(editedChild.status).toBe(200);
    const originNode = await h.store.getNode(origin);
    const capturedOrigin = await call(h, "PATCH", `/memories/${origin}`, {
      capture: { kind: "idea", source: "user" },
      expectedRevision: readSharedMemory(originNode!.metadata).revision,
      editor: OWNER,
      source: "dashboard",
    });
    expect(capturedOrigin.status).toBe(200);
    expect(revisionCount(h.db, origin)).toBeGreaterThan(0);
    expect(revisionCount(h.db, child)).toBeGreaterThan(0);

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
    servers.push(server);
    const client = new MemoryApiClient(`http://127.0.0.1:${server.port}`);
    const revisionBefore = h.store.getDbRevision();

    expect(await client.forget(origin)).toEqual({
      deleted: origin, derivedDeletedIds: [child], archivePurgedIds: [], assetCleanup: NO_ASSET_CLEANUP,
    });
    expect(h.store.getDbRevision()).toBeGreaterThan(revisionBefore);
    expect(liveNodes(h.db)).toEqual([]);
    expect(revisionCount(h.db, origin)).toBe(0);
    expect(revisionCount(h.db, child)).toBe(0);
    expect(textCount(h.db, CHILD)).toEqual(NO_TEXT);
    expect(textCount(h.db, EDITED_CHILD)).toEqual(NO_TEXT);
    expect(textCount(h.db, ORIGIN_TEXT)).toEqual(NO_TEXT);
    expect(await searchContents(h, EDITED_CHILD)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const dropped = await dropMessage(h, "m-forget");
    expect(dropped.body).toMatchObject({ deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [] });
    expect(await client.forget(origin)).toBeNull();
  }, 300_000);

  test("자식에 대시보드 저장이 흡수돼 있으면 원문을 지워도 자식이 남고, 메시지 삭제 뒤에도 남는다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-forget-held");
    const dashboard = await call(h, "POST", "/memories", { content: CHILD, author: OWNER, platform: "dashboard" });
    expect(dashboard.body.id).toBe(child);

    const removed = await call(h, "DELETE", `/memories/${origin}`);
    expect(removed).toEqual({
      status: 200, body: { deleted: origin, derivedDeletedIds: [], archivePurgedIds: [], assetCleanup: NO_ASSET_CLEANUP },
    });
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([child]);
    expect(sourceKinds(h.db, child)).toEqual(["direct_save"]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const dropped = await dropMessage(h, "m-forget-held");
    expect(dropped.body).toMatchObject({ deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [] });
    expect(liveNodes(h.db).map((n) => n.id)).toEqual([child]);
    expect(await searchContents(h, CHILD)).toContain(CHILD);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 300_000);

  test("자식만 먼저 휴지통에 넣은 뒤 원문을 지우면, 그 원문에만 기대던 휴지통의 자식도 영구 삭제된다", async () => {
    const h = makeHarness();
    const { origin, child } = await saveDiscordMessage(h, "m-forget-trashed");
    const revisionBefore = h.store.getDbRevision();
    const trashed = await call(h, "POST", `/memories/${child}/trash`);
    expect(trashed).toEqual({ status: 200, body: { trashed: child, cascadeTrashedIds: [] } });
    expect(h.store.getDbRevision()).toBeGreaterThan(revisionBefore);
    expect(archivedSourceKeys(h.db, child)).toEqual([archivedLineageKeyOf(origin)]);
    expect(lineageOrphans(h.db)).toEqual([]);

    const removed = await call(h, "DELETE", `/memories/${origin}`);
    expect(removed).toEqual({
      status: 200, body: { deleted: origin, derivedDeletedIds: [], archivePurgedIds: [child], assetCleanup: NO_ASSET_CLEANUP },
    });
    expect(liveNodes(h.db)).toEqual([]);
    expect(archivedIds(h.db)).toEqual([]);
    expect(textCount(h.db, CHILD)).toEqual(NO_TEXT);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 300_000);
});

describe("DELETE /memories/:id — 존재 확인과 삭제가 쓰기 잠금 안", () => {
  /** 잠금을 쥔 채 DELETE 를 보내고, 잠금을 놓기 전까지 응답이 오지 않는지 본 뒤 holderWork 를 하고 놓는다. */
  async function deleteWhileLocked(h: Harness, id: number, holderWork: () => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withMemoryMutationLock(h.store, async () => {
      await gate;
      await holderWork();
    });
    let finished = false;
    const reply = call(h, "DELETE", `/memories/${id}`).then((res) => {
      finished = true;
      return res;
    });
    await Bun.sleep(LOCK_SETTLE_MS);
    expect(finished).toBe(false);
    release();
    await holder;
    return reply;
  }

  test("다른 쓰기 잠금을 쥔 동안 기다렸다가 진행한다", async () => {
    const h = makeHarness();
    const target = await h.store.addNode({ content: "잠금 뒤에 지울 기억", author: OWNER, platform: "dashboard" });

    const reply = await deleteWhileLocked(h, target, async () => {});
    expect(reply).toEqual({
      status: 200, body: { deleted: target, derivedDeletedIds: [], archivePurgedIds: [], assetCleanup: NO_ASSET_CLEANUP },
    });
    expect(liveNodes(h.db)).toEqual([]);
  }, 60_000);

  test("기다리는 사이 잠금 보유자가 지운 노드면 404", async () => {
    const h = makeHarness();
    const target = await h.store.addNode({ content: "잠금 안에서 먼저 지워질 기억", author: OWNER, platform: "dashboard" });

    const reply = await deleteWhileLocked(h, target, async () => {
      expect(await h.store.deleteNode(target)).toEqual({
        deletedId: target, derivedDeletedIds: [], archivePurgedIds: [], assetCleanup: NO_ASSET_CLEANUP,
      });
    });
    expect(reply).toEqual({ status: 404, body: { error: `memory ${target} not found` } });
  }, 60_000);
});
