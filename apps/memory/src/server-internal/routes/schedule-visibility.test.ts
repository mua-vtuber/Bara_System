/**
 * routes/schedule-visibility.test.ts — POST /memories/:id/schedule-visibility ("일정 아님").
 *
 * 실 SQLite(:memory:) + 실 저장소 + 실 Hono 앱. 모델은 부르지 않는다(노드·기록을 SQL/저장소로 직접 준비).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import {
  SCHEDULE_HIDDEN_KEY, SCHEDULE_OCCURRENCE_KEY, SCHEDULE_SOURCE_NODE_KEY,
} from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { emptyRecordDetail, EntityRegisterRecordsRepository } from "../../memory/cleanup-deep-pass/entity-register/records-repository.ts";
import { buildDateOccurrences } from "../../memory/date-occurrences.ts";
import { EventBus, EVENT_TYPES } from "../event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerScheduleVisibilityRoutes } from "./schedule-visibility.ts";

let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
let app: Hono;
let records: EntityRegisterRecordsRepository;
let graphChanged: number;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const embedder = new Bgem3Embedder();
  store = new SqliteMemoryStore(db, embedder);
  const eventBus = new EventBus(new EventRepository(db));
  graphChanged = 0;
  eventBus.subscribe("test", (record) => { if (record.type === EVENT_TYPES.GRAPH_CHANGED) graphChanged += 1; });
  deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), eventBus };
  app = new Hono();
  registerScheduleVisibilityRoutes(app, deps);
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

function insertNode(content: string, eventAt: string | null, metadata: Record<string, unknown> = {}): number {
  return Number(db.query(
    "INSERT INTO knowledge_nodes (content, memory_type, created_at, event_at, metadata_json) VALUES (?, 'note', '2026-10-10 09:00:00', ?, ?)",
  ).run(content, eventAt, JSON.stringify(metadata)).lastInsertRowid);
}

async function post(id: string | number, body: unknown, raw = false): Promise<Response> {
  return app.request(`/memories/${id}/schedule-visibility`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function listedTitles(): Promise<string[]> {
  const res = await buildDateOccurrences({
    getAllNodes: (limit) => store.getAllNodes(limit), listPersons: (o) => store.listPersons(o),
    entitiesRepo: store.entitiesRepo, entityTypeRegistryDb: store.entityTypeRegistryDb,
  }, { now: new Date(2026, 9, 21, 9, 0, 0), kinds: new Set(["event"]) });
  return [...res.upcoming, ...res.past].map((o) => o.title);
}

describe("POST /memories/:id/schedule-visibility", () => {
  test("flags an ordinary memo, keeps event_at, drops it from the list and records a schedule ignore; unflag restores", async () => {
    const id = insertNode("교훈: Blender 정리 (2026-10-16)", "2026-10-16", { keep: "yes" });
    expect(await listedTitles()).toEqual(["교훈: Blender 정리 (2026-10-16)"]);

    const res = await post(id, { hidden: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeId: id, hidden: true, action: "flagged" });
    const node = await store.getNode(id);
    expect(node?.eventAt).toBe("2026-10-16");
    expect(node?.metadata[SCHEDULE_HIDDEN_KEY]).toBe(true);
    expect(node?.metadata["keep"]).toBe("yes");
    expect(await listedTitles()).toEqual([]);
    expect(records.isScheduleIgnored(id)).toBe(true);
    // 날짜 검색 경로(event_at 칸)는 그대로다.
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE event_at LIKE '2026-10-16%'").get()).toEqual({ n: 1 });
    expect(graphChanged).toBe(1);

    const back = await post(id, { hidden: false });
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ nodeId: id, hidden: false, action: "unflagged" });
    const restored = await store.getNode(id);
    expect(Object.hasOwn(restored!.metadata, SCHEDULE_HIDDEN_KEY)).toBe(false);
    expect(restored?.metadata["keep"]).toBe("yes");
    expect(await listedTitles()).toEqual(["교훈: Blender 정리 (2026-10-16)"]);
  });

  test("rejects bad ids, bad bodies, unknown nodes and nodes without a date", async () => {
    const noDate = insertNode("날짜 없는 메모", null);
    for (const id of ["0", "-1", "abc", "1.5"]) expect((await post(id, { hidden: true })).status).toBe(400);
    const real = insertNode("메모", "2026-10-16");
    expect((await post(real, "{not json", true)).status).toBe(400);
    expect((await post(real, {})).status).toBe(400);
    expect((await post(real, { hidden: "true" })).status).toBe(400);
    expect((await post(9999, { hidden: true })).status).toBe(404);
    expect((await post(9999, { hidden: false })).status).toBe(404);
    const res = await post(noDate, { hidden: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("날짜");
    expect(graphChanged).toBe(0);
  });

  test("an auto-created schedule node is reverted (trashed + ignore) and its source memo is flagged", async () => {
    const memoId = insertNode("민수가 10월 20일 결혼한다더라", "2026-10-20");
    const scheduleId = insertNode("민수 결혼", "2026-10-20", {
      [SCHEDULE_OCCURRENCE_KEY]: true, [SCHEDULE_SOURCE_NODE_KEY]: memoId,
    });
    const recordId = records.insert({
      runId: "run_1", proposalId: null, sourceNodeId: memoId, itemKind: "schedule_created", targetType: "node", targetId: String(scheduleId),
      name: "민수 결혼", decidedBy: "auto", detail: { ...emptyRecordDetail(), scheduleNodeId: scheduleId, date: "2026-10-20" },
    });
    expect(await listedTitles()).toEqual(["민수 결혼"]);

    const res = await post(scheduleId, { hidden: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nodeId: scheduleId, hidden: true, action: "reverted_schedule", revertedRecordId: recordId, sourceMemoFlagged: true,
    });
    expect(await store.getNode(scheduleId)).toBeNull();
    expect(records.get(recordId)?.status).toBe("reverted");
    expect(records.isScheduleIgnored(memoId)).toBe(true);
    const memo = await store.getNode(memoId);
    expect(memo?.eventAt).toBe("2026-10-20");
    expect(memo?.metadata[SCHEDULE_HIDDEN_KEY]).toBe(true);
    expect(await listedTitles()).toEqual([]);
  });

  test("a user-written schedule node without a register record is just flagged", async () => {
    const id = insertNode("#일정: 치과", "2026-10-25", { [SCHEDULE_OCCURRENCE_KEY]: true });
    const res = await post(id, { hidden: true });
    expect(await res.json()).toEqual({ nodeId: id, hidden: true, action: "flagged" });
    expect(await store.getNode(id)).not.toBeNull();
    expect(await listedTitles()).toEqual([]);
  });
});
