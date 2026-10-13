/**
 * memories-revisions.cleanup.test.ts — 영구 삭제된 기억의 본문이 수정 이력(memory_revisions)에 남지 않는다
 * (WP-B1-20T 설계 15절).
 *
 * memory_revisions 는 노드 외래 키가 없어, 한 번이라도 고친 기억을 지워도 old_content·new_content 에 지운
 * 본문이 남았다(지운 Discord 메시지의 글 포함). 이제 노드를 영구 삭제하는 모든 통로가 같은 트랜잭션에서
 * 그 노드를 가리키는 이력 행(old_node_id 또는 new_node_id)을 지운다. 휴지통 이동·복원은 이력을 그대로 둔다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 저장 경로(saveTextInput) + 실제 Hono 라우트(PATCH /memories/:id,
 * DELETE /memories/by-source, DELETE /memories/:id, POST /memories/:id/trash, POST /archive/:id/restore,
 * GET /memories/:id/revisions) + 실제 휴지통 관리(runTrashManagement).
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { runTrashManagement } from "../../memory/trash-manager.ts";
import { buildMemoryApi } from "../../server.ts";
import { saveTextInput } from "../save-input.ts";

const PLATFORM = "discord";
/** 휴지통 보관 기간(설정 trashManagement.retentionDays 기본값과 같은 값을 명시한다). */
const RETENTION_DAYS = 30;
const WARNING_DAYS = 7;
/** 보관 기간보다 오래전 — 이 시각으로 옮겨 둔 보관 행은 휴지통 관리가 영구 삭제한다. */
const LONG_AGO = "2000-01-01 00:00:00";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const app = buildMemoryApi({ store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  const h = { app, db, store };
  harnesses.push(h);
  return h;
}

async function saveDiscord(h: Harness, content: string, messageId: string): Promise<number> {
  const saved = await saveTextInput(h.store, {
    content, source: PLATFORM, author: "owner", force: true,
    extraMetadata: { messageId, channelId: "channel-1", source: "discord-channel" },
  });
  return saved.originNodeId!;
}

async function saveDashboard(h: Harness, content: string): Promise<number> {
  return (await saveTextInput(h.store, { content, source: "dashboard", author: "owner", force: true })).originNodeId!;
}

async function edit(h: Harness, id: number, content: string): Promise<void> {
  const res = await h.app.request(`/memories/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, editor: "owner" }),
  });
  expect(res.status).toBe(200);
}

async function request(h: Harness, method: string, path: string): Promise<Response> {
  const res = await h.app.request(path, { method });
  expect(res.status).toBe(200);
  return res;
}

async function revisionsOf(h: Harness, id: number): Promise<Array<{ oldContent: string | null; newContent: string | null }>> {
  const res = await request(h, "GET", `/memories/${id}/revisions`);
  return (await res.json() as { revisions: Array<{ oldContent: string | null; newContent: string | null }> }).revisions;
}

/** 이력 표 어디에든(본문·이유 칸) 그 글이 남아 있는 행 수. */
function revisionRowsMentioning(db: Database, text: string): number {
  return (db.query(
    `SELECT COUNT(*) AS n FROM memory_revisions
     WHERE instr(COALESCE(old_content, ''), ?) > 0 OR instr(COALESCE(new_content, ''), ?) > 0`,
  ).get(text, text) as { n: number }).n;
}

function revisionRowCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM memory_revisions").get() as { n: number }).n;
}

const ORIGINAL = "이번 주 비공개 모임 장소는 강남역 삼번 출구다";
const EDITED = "이번 주 비공개 모임 장소는 신촌역 이번 출구로 바뀌었다";

describe("영구 삭제 통로는 수정 이력 행을 지운다", () => {
  test("고친 메시지 기억을 출처 삭제하면 그 본문이 이력에 남지 않는다", async () => {
    const h = makeHarness();
    const id = await saveDiscord(h, ORIGINAL, "msg-edited");
    await edit(h, id, EDITED);
    expect(await revisionsOf(h, id)).toEqual([expect.objectContaining({ oldContent: ORIGINAL, newContent: EDITED })]);

    const res = await request(h, "DELETE", `/memories/by-source?messageId=msg-edited&platform=${PLATFORM}`);
    expect(await res.json()).toMatchObject({ deletedIds: [id] });
    expect(revisionRowsMentioning(h.db, ORIGINAL)).toBe(0);
    expect(revisionRowsMentioning(h.db, EDITED)).toBe(0);
    expect(await revisionsOf(h, id)).toEqual([]);
    expect(await h.store.listRecentRevisions()).toEqual([]);
  }, 120_000);

  test("휴지통에 있는 동안 메시지가 지워지면(보관표 정리) 이력도 지워진다", async () => {
    const h = makeHarness();
    const id = await saveDiscord(h, ORIGINAL, "msg-archived-edit");
    await edit(h, id, EDITED);
    await request(h, "POST", `/memories/${id}/trash`);
    expect(revisionRowCount(h.db)).toBe(1);

    const res = await request(h, "DELETE", `/memories/by-source?messageId=msg-archived-edit&platform=${PLATFORM}`);
    expect(await res.json()).toMatchObject({ deletedIds: [], archivePurgedIds: [id] });
    expect(revisionRowsMentioning(h.db, ORIGINAL)).toBe(0);
    expect(revisionRowsMentioning(h.db, EDITED)).toBe(0);
  }, 120_000);

  test("보관 기간이 지나 휴지통 관리가 영구 삭제하면 이력도 지워진다", async () => {
    const h = makeHarness();
    const id = await saveDashboard(h, ORIGINAL);
    await edit(h, id, EDITED);
    await request(h, "POST", `/memories/${id}/trash`);
    h.db.query("UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?").run(LONG_AGO, id);

    const summary = await runTrashManagement(h.store, { retentionDays: RETENTION_DAYS, warningDays: WARNING_DAYS });
    expect(summary.nodesPurged).toBe(1);
    expect(revisionRowCount(h.db)).toBe(0);
    expect(await revisionsOf(h, id)).toEqual([]);
  }, 120_000);

  test("단건 영구 삭제(DELETE /memories/:id)도 이력을 지운다", async () => {
    const h = makeHarness();
    const id = await saveDashboard(h, ORIGINAL);
    await edit(h, id, EDITED);
    await request(h, "DELETE", `/memories/${id}`);
    expect(revisionRowCount(h.db)).toBe(0);
  }, 120_000);

  test("두 노드를 잇는 이력 행은 old_node_id·new_node_id 어느 쪽 노드가 지워져도 지워지고, 남은 노드의 다른 이력은 남는다", async () => {
    const h = makeHarness();
    const kept = await saveDashboard(h, ORIGINAL);
    const replacedBy = await saveDashboard(h, "모임 장소 공지는 새 기억으로 대체됐다");
    const replaced = await saveDashboard(h, "예전 모임 장소 공지는 역 앞 카페였다");
    // 충돌 대체 이력(conflict_supersede) — 한 행이 두 노드를 가리킨다.
    await h.store.insertRevision({
      oldNodeId: kept, newNodeId: replacedBy, revisionType: "conflict_supersede",
      oldContent: ORIGINAL, newContent: "모임 장소 공지는 새 기억으로 대체됐다",
    });
    await h.store.insertRevision({
      oldNodeId: replaced, newNodeId: kept, revisionType: "conflict_supersede",
      oldContent: "예전 모임 장소 공지는 역 앞 카페였다", newContent: ORIGINAL,
    });
    await edit(h, kept, EDITED);
    expect(await revisionsOf(h, kept)).toHaveLength(3);

    await request(h, "DELETE", `/memories/${replacedBy}`); // new_node_id 쪽
    await request(h, "DELETE", `/memories/${replaced}`); // old_node_id 쪽
    expect(revisionRowsMentioning(h.db, "새 기억으로 대체됐다")).toBe(0);
    expect(revisionRowsMentioning(h.db, "역 앞 카페였다")).toBe(0);
    expect(await revisionsOf(h, kept)).toEqual([expect.objectContaining({ oldContent: ORIGINAL, newContent: EDITED })]);
  }, 120_000);
});

describe("휴지통 이동·복원은 이력을 그대로 둔다", () => {
  test("옮기고 되살려도 이력 행과 본문이 그대로다", async () => {
    const h = makeHarness();
    const id = await saveDiscord(h, ORIGINAL, "msg-restore-edit");
    await edit(h, id, EDITED);
    const before = await revisionsOf(h, id);
    expect(before).toHaveLength(1);

    await request(h, "POST", `/memories/${id}/trash`);
    expect(await revisionsOf(h, id)).toEqual(before);
    await request(h, "POST", `/archive/${id}/restore`);
    expect(await revisionsOf(h, id)).toEqual(before);
    expect((await h.store.getNode(id))!.content).toBe(EDITED);
  }, 120_000);
});
