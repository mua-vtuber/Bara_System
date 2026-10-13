/**
 * memories-edit-split.test.ts — 메시지 수정이 다른 출처의 기억을 덮지 않고 분리한다(WP-B1-20T T5, 설계 5.6, C1).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 Hono 라우트(POST /memories, PATCH·DELETE /memories/by-source,
 * POST /search). 백필은 실제 startBackfillScheduler 사이클이 실제 MemoryExtractor·OllamaClient 로 이 파일이 띄운
 * 루프백 HTTP 서버(Ollama /api/chat 응답 형식)를 부른다. 출처 행은 실제 NodeSourceRepository 로 읽는다.
 *
 *  - C1: Discord 원문 O 에 같은 본문 대시보드 저장이 흡수돼 있으면, 메시지 수정은 O 를 덮지 않는다 — O 의 본문·검색은
 *    그대로이고 새 기억 N 이 새 본문과 그 메시지 출처를 갖는다. 메시지를 지우면 N 만 지워지고 대시보드 저장은 남는다.
 *  - 출처가 그 메시지 하나뿐이면 지금처럼 같은 id 로 고치고, 이후 메시지 삭제가 그 기억을 지운다.
 *  - 같은 본문의 두 메시지: M1 수정은 분리하고, M2 삭제 뒤 옛 본문 기억이 지워진다.
 *  - 새 본문이 이미 있는 기억이면 그 기억이 메시지 출처를 받는다(reused).
 *  - expectedRevision 409 는 분리 전에 나고 아무것도 쓰지 않는다(SL-6).
 *  - 분리한 N 은 수정 요청 안에서 LLM 을 부르지 않고 추출 대기로 남아, 백필이 뒤에 추출한다(B1-08, D9).
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { startBackfillScheduler, type BackfillCycleSummary } from "../../scheduler.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { EditBySourceResult } from "../../api-client-types.ts";
import { buildMemoryApi } from "../../server.ts";
import { MESSAGE_EDIT_SPLIT_REASON_PREFIX } from "./memories-edit-split.ts";

const EXTRACTION_MODEL = "extraction-fixture";
const AUTHOR = "owner";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const CHANNEL_ID = "channel-1";
const GUILD_ID = "guild-1";
const JSON_HEADERS = { "Content-Type": "application/json" };

const ORIGINAL = "팀 회식 장소는 강남역 고깃집으로 정했다. 예약은 총무가 맡는다.";
const EDITED = "팀 회식 장소를 홍대 파스타집으로 바꿨다. 예약은 총무가 맡는다.";
const EDITED_FACT = "팀 회식 장소는 홍대 파스타집이다";

const DASHBOARD_KEY = sourceKeyOf({ kind: "direct_save", channel: "dashboard", actor: AUTHOR });
const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface LoopbackLlm {
  server: ReturnType<typeof Bun.serve>;
  /** 다음 /api/chat 응답이 돌려줄 추출 항목. */
  items: unknown[];
  /** 받은 /api/chat 요청 수. */
  calls: number;
}

/** 실제 OllamaClient 가 부르는 루프백 서버 — Ollama /api/chat 응답 형식으로 items 를 돌려준다. */
function startLoopbackLlm(): LoopbackLlm {
  const llm: Omit<LoopbackLlm, "server"> = { items: [], calls: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }
      llm.calls += 1;
      return Response.json({
        model: EXTRACTION_MODEL,
        message: { role: "assistant", content: JSON.stringify(llm.items) },
        done: true,
      });
    },
  });
  return Object.assign(llm, { server });
}

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  llm: LoopbackLlm;
  extractor: MemoryExtractor;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.llm.server.stop(true);
    h.db.close();
  }
});

/** 추출기는 백필 전용 — 저장 라우트는 plain 갈래(설정 mode backfill)라 저장 중 LLM 을 부르지 않는다. */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "backfill";
  const llm = startLoopbackLlm();
  const extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: `http://127.0.0.1:${llm.server.port}`, model: EXTRACTION_MODEL }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    extractor, getSettings: () => settings,
  });
  const h = { app, db, store, llm, extractor };
  harnesses.push(h);
  return h;
}

/** Discord 봇이 보내는 모양(platform discord, messageId·channelId·guildId·source·user_id 칸)으로 저장한다. */
async function postDiscord(h: Harness, content: string, messageId: string): Promise<number> {
  const res = await h.app.request("/memories", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({
      content, platform: PLATFORM, author: AUTHOR, force: true,
      metadata: { source: DISCORD_SOURCE, user_id: "user-1", messageId, channelId: CHANNEL_ID, guildId: GUILD_ID },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { id: number }).id;
}

/** 대시보드 저장 — 같은 본문이면 저장 경로가 기존 노드로 흡수한다. */
async function postDashboard(h: Harness, content: string): Promise<number> {
  const res = await h.app.request("/memories", {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ content, platform: "dashboard", author: AUTHOR, force: true }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { id: number }).id;
}

async function patchBySource(h: Harness, messageId: string, content: string, extra: Record<string, unknown> = {}) {
  return await h.app.request("/memories/by-source", {
    method: "PATCH", headers: JSON_HEADERS,
    body: JSON.stringify({ messageId, platform: PLATFORM, content, editor: "discord-owner", source: PLATFORM, ...extra }),
  });
}

async function editBySource(h: Harness, messageId: string, content: string): Promise<EditBySourceResult> {
  const res = await patchBySource(h, messageId, content);
  expect(res.status).toBe(200);
  return await res.json() as EditBySourceResult;
}

async function deleteBySource(h: Harness, messageId: string) {
  const res = await h.app.request(`/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  return await res.json() as { deletedIds: number[]; derivedDeletedIds: number[]; keptIds: number[] };
}

async function searchIds(h: Harness, query: string): Promise<number[]> {
  const res = await h.app.request("/search", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ query, limit: 20 }) });
  expect(res.status).toBe(200);
  return (await res.json() as { results: Array<{ id: number }> }).results.map((r) => r.id);
}

function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return (db.query(sql).get(...params) as { c: number }).c;
}

/** 대시보드 저장이 흡수된 Discord 원문 O — 출처 행 {대시보드, 메시지}. */
async function sharedOrigin(h: Harness, messageId: string): Promise<number> {
  const origin = await postDiscord(h, ORIGINAL, messageId);
  expect(await postDashboard(h, ORIGINAL)).toBe(origin);
  expect(sourceKeys(h.db, origin)).toEqual([messageKey(messageId), DASHBOARD_KEY].sort());
  return origin;
}

async function runBackfill(h: Harness): Promise<BackfillCycleSummary> {
  const handle = startBackfillScheduler(h.extractor, h.store, { intervalMs: 60_000, batchSize: 10 });
  try {
    return await handle.tickNow();
  } finally {
    await handle.stop();
  }
}

describe("PATCH /memories/by-source 분리 규칙", () => {
  test("C1: 대시보드 저장이 흡수된 원문은 덮지 않고 새 기억으로 분리하며, 메시지 삭제는 새 기억만 지운다", async () => {
    const h = makeHarness();
    const origin = await sharedOrigin(h, "msg-c1");

    const body = await editBySource(h, "msg-c1", EDITED);
    expect(body).toMatchObject({ changed: true, matchedCount: 1, editedCount: 0, editedIds: [], skippedIds: [], revisions: [] });
    expect(body.splits).toHaveLength(1);
    const [split] = body.splits;
    expect(split).toMatchObject({ fromNodeId: origin, reused: false });
    const created = split!.newNodeId;
    expect(created).not.toBe(origin);

    // 원문은 본문·출처(대시보드)·검색 그대로, 메시지 표시만 거뒀다.
    const kept = (await h.store.getNode(origin))!;
    expect(kept.content).toBe(ORIGINAL);
    expect(sourceKeys(h.db, origin)).toEqual([DASHBOARD_KEY]);
    expect(kept.metadata).not.toHaveProperty("messageId");
    expect(kept.metadata).not.toHaveProperty("channelId");
    expect(kept.metadata).not.toHaveProperty("guildId");
    expect(await searchIds(h, ORIGINAL)).toContain(origin);

    // 새 기억은 새 본문과 그 메시지 출처·표시, 원문 작성자·통로를 갖는다.
    const split1 = (await h.store.getNode(created))!;
    expect(split1.content).toBe(EDITED);
    expect(split1.sourceType).toBe("auto_capture");
    expect(split1.author).toBe(AUTHOR);
    expect(split1.platform).toBe(PLATFORM);
    expect(split1.metadata).toMatchObject({
      messageId: "msg-c1", channelId: CHANNEL_ID, guildId: GUILD_ID, source: DISCORD_SOURCE, user_id: "user-1",
    });
    expect(sourceKeys(h.db, created)).toEqual([messageKey("msg-c1")]);
    expect(await searchIds(h, EDITED)).toContain(created);

    // 수정 이력 E -> N 한 줄, 분리 표시가 있는 사유.
    const revisions = h.db.query(
      "SELECT old_node_id, new_node_id, revision_type, reason, old_content, new_content, editor FROM memory_revisions",
    ).all();
    expect(revisions).toEqual([{
      old_node_id: origin, new_node_id: created, revision_type: "manual",
      reason: `${MESSAGE_EDIT_SPLIT_REASON_PREFIX}: external source edit`,
      old_content: ORIGINAL, new_content: EDITED, editor: "discord-owner",
    }]);

    // 메시지 삭제 — 새 기억만 지워지고 대시보드 저장은 남는다. 새 본문이 수정 이력에 남지 않는다.
    const deleted = await deleteBySource(h, "msg-c1");
    expect(deleted.deletedIds).toEqual([created]);
    expect(deleted.keptIds).toEqual([]);
    expect(await h.store.getNode(created)).toBeNull();
    expect((await h.store.getNode(origin))!.content).toBe(ORIGINAL);
    expect(await searchIds(h, ORIGINAL)).toContain(origin);
    expect(await searchIds(h, EDITED)).not.toContain(created);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM memory_revisions WHERE new_node_id = ? OR old_node_id = ?", created, created)).toBe(0);
  }, 120_000);

  test("출처가 그 메시지 하나뿐이면 같은 id 로 고치고, 이후 메시지 삭제가 그 기억을 지운다", async () => {
    const h = makeHarness();
    const origin = await postDiscord(h, ORIGINAL, "msg-single");

    const body = await editBySource(h, "msg-single", EDITED);
    expect(body).toMatchObject({ changed: true, editedCount: 1, editedIds: [origin], splits: [] });
    expect(body.revisions).toHaveLength(1);
    expect((await h.store.getNode(origin))!.content).toBe(EDITED);
    expect(sourceKeys(h.db, origin)).toEqual([messageKey("msg-single")]);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE source_type = 'auto_capture'")).toBe(1);

    const deleted = await deleteBySource(h, "msg-single");
    expect(deleted.deletedIds).toEqual([origin]);
    expect(await h.store.getNode(origin)).toBeNull();
  }, 120_000);

  test("같은 본문의 두 메시지: M1 수정은 분리하고, M2 삭제 뒤 옛 본문 기억이 지워진다", async () => {
    const h = makeHarness();
    const shared = await postDiscord(h, ORIGINAL, "msg-m1");
    expect(await postDiscord(h, ORIGINAL, "msg-m2")).toBe(shared);
    expect(sourceKeys(h.db, shared)).toEqual([messageKey("msg-m1"), messageKey("msg-m2")]);

    const body = await editBySource(h, "msg-m1", EDITED);
    expect(body.editedIds).toEqual([]);
    expect(body.splits).toHaveLength(1);
    const created = body.splits[0]!.newNodeId;
    expect(body.splits[0]).toEqual({ fromNodeId: shared, newNodeId: created, reused: false });
    expect((await h.store.getNode(shared))!.content).toBe(ORIGINAL);
    expect(sourceKeys(h.db, shared)).toEqual([messageKey("msg-m2")]);
    expect(sourceKeys(h.db, created)).toEqual([messageKey("msg-m1")]);
    // 옛 기억의 표시는 처음 저장한 M1 을 가리켰다 — M1 행이 떠났으므로 거둔다.
    expect((await h.store.getNode(shared))!.metadata).not.toHaveProperty("messageId");

    const afterM2 = await deleteBySource(h, "msg-m2");
    expect(afterM2.deletedIds).toEqual([shared]);
    expect(await h.store.getNode(shared)).toBeNull();
    expect(await searchIds(h, ORIGINAL)).not.toContain(shared);
    expect((await h.store.getNode(created))!.content).toBe(EDITED);

    const afterM1 = await deleteBySource(h, "msg-m1");
    expect(afterM1.deletedIds).toEqual([created]);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
  }, 120_000);

  test("새 본문이 이미 있는 기억이면 그 기억이 메시지 출처를 받는다(reused)", async () => {
    const h = makeHarness();
    const existing = await postDashboard(h, EDITED);
    const origin = await sharedOrigin(h, "msg-reuse");

    const body = await editBySource(h, "msg-reuse", EDITED);
    expect(body.splits).toEqual([{ fromNodeId: origin, newNodeId: existing, reused: true }]);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes WHERE content = ?", EDITED)).toBe(1);
    expect(sourceKeys(h.db, existing)).toEqual([messageKey("msg-reuse"), DASHBOARD_KEY].sort());
    expect(sourceKeys(h.db, origin)).toEqual([DASHBOARD_KEY]);
    expect((await h.store.getNode(origin))!.content).toBe(ORIGINAL);

    // 메시지를 지워도 두 기억 모두 대시보드 출처로 남는다.
    const deleted = await deleteBySource(h, "msg-reuse");
    expect(deleted.deletedIds).toEqual([]);
    expect(deleted.keptIds).toEqual([existing]);
    expect((await h.store.getNode(existing))!.content).toBe(EDITED);
    expect((await h.store.getNode(origin))!.content).toBe(ORIGINAL);
  }, 120_000);

  test("expectedRevision 이 어긋나면 분리 전에 409 를 돌려주고 아무것도 쓰지 않는다", async () => {
    const h = makeHarness();
    const origin = await sharedOrigin(h, "msg-conflict");
    const snapshot = () => ({
      nodes: count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes"),
      revisions: count(h.db, "SELECT COUNT(*) AS c FROM memory_revisions"),
      sources: h.db.query("SELECT node_id, source_key FROM memory_node_sources ORDER BY node_id, source_key").all(),
      metadata: (h.db.query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?").get(origin) as { metadata_json: string }).metadata_json,
    });
    const before = snapshot();

    const res = await patchBySource(h, "msg-conflict", EDITED, { expectedRevision: 3 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONFLICT", conflicts: [{ nodeId: origin, currentRevision: 0 }] });
    expect(snapshot()).toEqual(before);
    expect((await h.store.getNode(origin))!.content).toBe(ORIGINAL);
  }, 120_000);

  test("분리한 새 기억은 수정 요청 안에서 LLM 을 부르지 않고 추출 대기로 남아 백필이 뒤에 추출한다", async () => {
    const h = makeHarness();
    const origin = await sharedOrigin(h, "msg-backfill");
    // 원문을 먼저 추출해 둔다 — 뒤 백필의 후보가 분리한 새 기억뿐이게.
    h.llm.items = [{ content: "팀 회식 장소는 강남역 고깃집이다", memoryType: "episode", importance: 0.8 }];
    expect(await runBackfill(h)).toMatchObject({ processed: 1, failures: 0 });
    expect((await h.store.getNode(origin))!.metadata.extracted).toBe(1);
    const callsBeforeEdit = h.llm.calls;

    const body = await editBySource(h, "msg-backfill", EDITED);
    const created = body.splits[0]!.newNodeId;
    expect(h.llm.calls).toBe(callsBeforeEdit);
    expect((await h.store.getNode(created))!.metadata).not.toHaveProperty("extracted");
    expect((await h.store.getBackfillCandidates({ limit: 50 })).map((n) => n.id)).toEqual([created]);

    h.llm.items = [{ content: EDITED_FACT, memoryType: "episode", importance: 0.8 }];
    expect(await runBackfill(h)).toMatchObject({ processed: 1, storedNodes: 1, failures: 0 });
    const extracted = (await h.store.getNode(created))!;
    expect(extracted.metadata.extracted).toBe(1);
    const [child] = extracted.metadata.extractedTo as number[];
    expect((await h.store.getNode(child!))!.content).toBe(EDITED_FACT);
    expect(h.db.query("SELECT target_id FROM knowledge_edges WHERE source_id = ? AND relation = 'merged_into'").all(child!))
      .toEqual([{ target_id: created }]);
    expect((await h.store.getBackfillCandidates({ limit: 50 })).map((n) => n.id)).toEqual([]);

    // 메시지 삭제는 새 기억과 그 추출 자식을 지우고, 대시보드 저장 원문과 그 추출은 남긴다.
    const deleted = await deleteBySource(h, "msg-backfill");
    expect(deleted.deletedIds).toEqual([created]);
    expect(deleted.derivedDeletedIds).toEqual([child!]);
    expect((await h.store.getNode(origin))!.content).toBe(ORIGINAL);
  }, 120_000);
});
