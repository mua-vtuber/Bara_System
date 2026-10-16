/**
 * entity-register/revert-memo-date.test.ts — 메모 날짜 기록 되돌리기(2026-10-16 yearless-date-cleanup spec 3.8, 10장 T7).
 * 실제 SQLite + 실제 저장소. 임베딩이 필요 없는 길이라 모델은 올리지 않는다(저장소에 실제 임베더 구현만 싣는다).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { Bgem3Embedder } from "../../../embedding/bge-m3.ts";
import { emptyRecordDetail, EntityRegisterRecordsRepository } from "./records-repository.ts";
import { EntityRegisterRevertError, revertEntityRegisterRecord } from "./revert.ts";

let db: Database;
let store: SqliteMemoryStore;
let records: EntityRegisterRecordsRepository;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

/** 메모 하나에 정리 AI 가 날짜를 채운 상태(값 inferred + 기록 한 줄). */
async function filledMemo(date = "2027-01-05"): Promise<{ memoId: number; recordId: number }> {
  const memoId = Number(db.query("INSERT INTO knowledge_nodes (content, created_at) VALUES ('1월 5일까지 제출', '2026-10-16 10:00:00')").run().lastInsertRowid);
  expect(await store.setEventAt(memoId, date, "inferred")).toBe(true);
  const recordId = records.insert({
    runId: "run_1", proposalId: null, sourceNodeId: memoId, itemKind: "memo_date_filled", targetType: "memo", targetId: String(memoId),
    name: "1월 5일", decidedBy: "auto", detail: { ...emptyRecordDetail(), date },
  });
  return { memoId, recordId };
}

function memoState(memoId: number): { eventAt: string | null; source: unknown } {
  const row = db.query("SELECT event_at, metadata_json FROM knowledge_nodes WHERE id = ?").get(memoId) as { event_at: string | null; metadata_json: string | null };
  return { eventAt: row.event_at, source: row.metadata_json ? JSON.parse(row.metadata_json).fieldSources?.event_at : undefined };
}

test("a date this stage filled is cleared, the record is reverted and a memo-date ignore is left", async () => {
  const { memoId, recordId } = await filledMemo();
  const result = await revertEntityRegisterRecord(store, records, recordId);
  expect(result).toEqual({
    recordId, removedEdges: 0, deletedRow: null, keptRowReason: null, removedAlias: null, trashedScheduleNodeId: null, clearedMemoDate: "2027-01-05",
  });
  expect(memoState(memoId)).toEqual({ eventAt: null, source: undefined });
  expect(records.get(recordId)!.status).toBe("reverted");
  expect(db.query("SELECT kind, name_key, reason FROM entity_register_ignores WHERE source_node_id = ?").all(memoId))
    .toEqual([{ kind: "memo_date", name_key: "", reason: "reverted" }]);
});

test("a date the user corrected (direct) is kept with the reason", async () => {
  const { memoId, recordId } = await filledMemo();
  expect(await store.setEventAt(memoId, "2027-01-08", "direct")).toBe(true);
  const result = await revertEntityRegisterRecord(store, records, recordId);
  expect(result.clearedMemoDate).toBeNull();
  expect(result.keptRowReason).toBe("메모 날짜가 그 사이 바뀌어 지우지 않음(출처 direct, 값 2027-01-08)");
  expect(memoState(memoId)).toEqual({ eventAt: "2027-01-08", source: "direct" });
  const rec = records.get(recordId)!;
  expect(rec.status).toBe("reverted");
  expect(rec.detail.keptRowReason).toBe(result.keptRowReason);
});

test("a different inferred value written meanwhile is not cleared", async () => {
  const { memoId, recordId } = await filledMemo();
  expect(await store.setEventAt(memoId, "2027-01-09", "inferred")).toBe(true);
  const result = await revertEntityRegisterRecord(store, records, recordId);
  expect(result.clearedMemoDate).toBeNull();
  expect(memoState(memoId)).toEqual({ eventAt: "2027-01-09", source: "inferred" });
});

test("a permanently deleted memo has nothing to clear, the record still reverts", async () => {
  const { memoId, recordId } = await filledMemo();
  db.run("DELETE FROM knowledge_nodes WHERE id = ?", [memoId]);
  const result = await revertEntityRegisterRecord(store, records, recordId);
  expect(result).toMatchObject({ clearedMemoDate: null, keptRowReason: null });
  expect(records.get(recordId)!.status).toBe("reverted");
  expect(records.isMemoDateIgnored(memoId)).toBe(true);
});

test("reverting twice is a 409", async () => {
  const { recordId } = await filledMemo();
  await revertEntityRegisterRecord(store, records, recordId);
  const second = revertEntityRegisterRecord(store, records, recordId);
  await expect(second).rejects.toBeInstanceOf(EntityRegisterRevertError);
  await expect(revertEntityRegisterRecord(store, records, recordId)).rejects.toMatchObject({ status: 409 });
});
