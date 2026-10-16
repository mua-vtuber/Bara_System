/**
 * entity-register/apply-memo-date.test.ts — 메모 날짜 채우기 반영(2026-10-16 yearless-date-cleanup spec 3.5·3.6).
 * 실제 SQLite + 실제 bge-m3(일정 노드 임베딩). 가짜 저장소·가짜 AI 없음.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../../embedding/factory.ts";
import type { Embedder } from "../../../embedding/types.ts";
import { EntityRegisterRecordsRepository, emptyRecordDetail } from "./records-repository.ts";
import { applyMemoChanges, type ApplyContext } from "./apply.ts";

const MODEL = "bge-m3";
let embedder: Embedder;
let db: Database;
let store: SqliteMemoryStore;
let records: EntityRegisterRecordsRepository;

beforeAll(async () => {
  embedder = createEmbedder({ model: MODEL });
  await embedder.load();
});
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

async function memoCtx(content: string): Promise<ApplyContext> {
  const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
  const node = (await store.getNode(nodeId))!;
  return { store, records, memo: { nodeId, content, createdAt: node.createdAt }, runId: "run_1", proposalId: null, decidedBy: "auto" };
}

function memoMeta(nodeId: number): { eventAt: string | null; source: unknown } {
  const row = db.query("SELECT event_at, metadata_json FROM knowledge_nodes WHERE id = ?").get(nodeId) as { event_at: string | null; metadata_json: string | null };
  const meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  return { eventAt: row.event_at, source: meta.fieldSources?.event_at };
}

test("an empty memo date is filled as inferred with one memo_date_filled record", async () => {
  const ctx = await memoCtx("1월 5일까지 제출");
  const out = await applyMemoChanges(ctx, { entities: [], schedule: null, memoDate: { date: "2027-01-05", dateText: "1월 5일" } });
  expect(memoMeta(ctx.memo.nodeId)).toEqual({ eventAt: "2027-01-05", source: "inferred" });
  expect(out.memoDateRecordId).not.toBeNull();
  const rec = records.get(out.memoDateRecordId!)!;
  expect(rec).toMatchObject({
    itemKind: "memo_date_filled", targetType: "memo", targetId: String(ctx.memo.nodeId), name: "1월 5일", decidedBy: "auto", status: "active",
  });
  expect(rec.detail).toEqual({ ...emptyRecordDetail(), date: "2027-01-05" });
  expect(out.skipped).toEqual([]);
}, 120_000);

test("a date written between judgement and apply is kept: no write, no record, a skipped reason", async () => {
  const ctx = await memoCtx("1월 5일까지 제출");
  expect(await store.setEventAt(ctx.memo.nodeId, "2026-01-05", "system")).toBe(true);
  const out = await applyMemoChanges(ctx, { entities: [], schedule: null, memoDate: { date: "2027-01-05", dateText: "1월 5일" } });
  expect(memoMeta(ctx.memo.nodeId)).toEqual({ eventAt: "2026-01-05", source: "system" });
  expect(out.memoDateRecordId).toBeNull();
  expect(out.skipped).toEqual([{ memoName: "1월 5일", type: "memo_date", reason: "메모 날짜가 그 사이 채워짐(출처 system)" }]);
  expect(records.listActiveForMemo(ctx.memo.nodeId)).toEqual([]);
}, 120_000);

test("an old event_at without a field source is never overwritten", async () => {
  const ctx = await memoCtx("1월 5일까지 제출");
  db.run("UPDATE knowledge_nodes SET event_at = '2026-01-05' WHERE id = ?", [ctx.memo.nodeId]);
  const out = await applyMemoChanges(ctx, { entities: [], schedule: null, memoDate: { date: "2027-01-05", dateText: "1월 5일" } });
  expect(memoMeta(ctx.memo.nodeId)).toEqual({ eventAt: "2026-01-05", source: undefined });
  expect(out.skipped[0]!.reason).toBe("메모 날짜가 그 사이 채워짐(출처 기록 없음)");
  expect(out.memoDateRecordId).toBeNull();
}, 120_000);

test("a memo that vanished before the write stops the whole apply with the memo id", async () => {
  const ctx = await memoCtx("지은이랑 1월 5일 만나기로 함");
  db.run("DELETE FROM knowledge_nodes WHERE id = ?", [ctx.memo.nodeId]);
  await expect(applyMemoChanges(ctx, { entities: [], schedule: null, memoDate: { date: "2027-01-05", dateText: "1월 5일" } }))
    .rejects.toThrow(`메모 ${ctx.memo.nodeId} 에 날짜 2027-01-05 를 쓰지 못함`);
  expect(records.listActiveForMemo(ctx.memo.nodeId)).toEqual([]);
}, 120_000);

test("a later schedule links only to entity targets, not to an earlier memo-date record", async () => {
  const ctx = await memoCtx("지은이랑 1월 5일 만나기로 함");
  await applyMemoChanges(ctx, {
    entities: [{ memoName: "지은", type: "person", action: { kind: "create", name: "지은", aliasFromMemo: null } }],
    schedule: null,
  });
  records.insert({
    runId: "run_1", proposalId: null, sourceNodeId: ctx.memo.nodeId, itemKind: "memo_date_filled", targetType: "memo",
    targetId: String(ctx.memo.nodeId), name: "1월 5일", decidedBy: "auto", detail: { ...emptyRecordDetail(), date: "2027-01-05" },
  });
  const out = await applyMemoChanges(ctx, {
    entities: [],
    schedule: { title: "지은 만남", date: "2027-01-05", dateText: "1월 5일", replaceNodeId: null },
  });
  const personId = (db.query("SELECT person_id FROM persons WHERE display_name = '지은'").get() as { person_id: string }).person_id;
  expect((await store.listNodePersonEdges({ nodeId: out.scheduleNodeId! })).map((e) => e.personId)).toEqual([personId]);
  expect(db.query("SELECT COUNT(*) AS n FROM node_concept_edges WHERE node_id = ?").get(out.scheduleNodeId!)).toEqual({ n: 0 });
}, 120_000);
