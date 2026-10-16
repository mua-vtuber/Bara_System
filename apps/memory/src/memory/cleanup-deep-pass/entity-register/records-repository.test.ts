import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { EntityRegisterRecordsRepository, MEMO_DATE_IGNORE_NAME_KEY, SCHEDULE_IGNORE_NAME_KEY, emptyRecordDetail } from "./records-repository.ts";

let db: Database;
let repo: EntityRegisterRecordsRepository;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 8 });
  repo = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

function insertMemo(content: string): number {
  db.run(
    `INSERT INTO knowledge_nodes (content, created_at, last_accessed_at) VALUES (?, '2026-10-10 09:00:00', '2026-10-10 09:00:00')`,
    [content],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

test("records round-trip and the recent list is newest first with the memo text", () => {
  const memo = insertMemo("민수가 11월 3일 결혼한다더라");
  const a = repo.insert({ runId: "r1", proposalId: null, sourceNodeId: memo, itemKind: "entity_created", targetType: "person", targetId: "psn_1", name: "민수", decidedBy: "auto", detail: emptyRecordDetail() });
  const b = repo.insert({ runId: "r1", proposalId: null, sourceNodeId: memo, itemKind: "entity_linked", targetType: "place", targetId: "plc_1", name: "무지개의원", decidedBy: "auto", detail: emptyRecordDetail() });
  const page = repo.listActive({ decidedBy: "auto", limit: 10, offset: 0 });
  expect(page.total).toBe(2);
  expect(page.records.map((r) => r.id)).toEqual([b, a]);
  expect(page.records[0]!.memoContent).toBe("민수가 11월 3일 결혼한다더라");
  expect(repo.get(a)!.stage).toBe("entity_register");
});

test("a reverted record leaves the active list and cannot be reverted twice", () => {
  const memo = insertMemo("x");
  const id = repo.insert({ runId: null, proposalId: null, sourceNodeId: memo, itemKind: "entity_created", targetType: "person", targetId: "p", name: "x", decidedBy: "auto", detail: emptyRecordDetail() });
  expect(repo.markReverted(id, emptyRecordDetail())).toBe(true);
  expect(repo.markReverted(id, emptyRecordDetail())).toBe(false);
  expect(repo.listActive({ decidedBy: "auto", limit: 10, offset: 0 }).total).toBe(0);
});

test("the active schedule is found only while its node still exists", () => {
  const memo = insertMemo("민수 결혼 11월 3일");
  db.run(`INSERT INTO knowledge_nodes (content, event_at, created_at, last_accessed_at) VALUES ('민수 결혼', '2026-11-03', '2026-10-10 09:00:00', '2026-10-10 09:00:00')`);
  const scheduleId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  const detail = { ...emptyRecordDetail(), scheduleNodeId: scheduleId, date: "2026-11-03" };
  const recordId = repo.insert({ runId: null, proposalId: null, sourceNodeId: memo, itemKind: "schedule_created", targetType: "schedule", targetId: String(scheduleId), name: "민수 결혼", decidedBy: "auto", detail });
  expect(repo.activeScheduleForMemo(memo)).toEqual({ recordId, nodeId: scheduleId, date: "2026-11-03", title: "민수 결혼" });
  db.run("DELETE FROM knowledge_nodes WHERE id = ?", [scheduleId]);
  expect(repo.activeScheduleForMemo(memo)).toBeNull();
});

test("ignores are kept per memo and per kind", () => {
  repo.addIgnore(1, "entity", "민수", "ignored");
  repo.addIgnore(1, "entity", "민수", "reverted");
  repo.addIgnore(1, "schedule", SCHEDULE_IGNORE_NAME_KEY, "ignored");
  expect([...repo.ignoredNameKeys(1)]).toEqual(["민수"]);
  expect(repo.isScheduleIgnored(1)).toBe(true);
  expect(repo.isScheduleIgnored(2)).toBe(false);
  expect(repo.isMemoDateIgnored(1)).toBe(false);
});

test("a memo-date ignore is its own kind and does not mark the schedule or names ignored", () => {
  repo.addIgnore(3, "memo_date", MEMO_DATE_IGNORE_NAME_KEY, "reverted");
  expect(repo.isMemoDateIgnored(3)).toBe(true);
  expect(repo.isScheduleIgnored(3)).toBe(false);
  expect([...repo.ignoredNameKeys(3)]).toEqual([]);
  expect(repo.isMemoDateIgnored(4)).toBe(false);
});

test("a memo-date record round-trips with the date in the shared detail", () => {
  const memo = insertMemo("1월 5일까지 제출");
  const id = repo.insert({
    runId: "r1", proposalId: null, sourceNodeId: memo, itemKind: "memo_date_filled", targetType: "memo",
    targetId: String(memo), name: "1월 5일", decidedBy: "auto", detail: { ...emptyRecordDetail(), date: "2027-01-05" },
  });
  const rec = repo.get(id)!;
  expect(rec.itemKind).toBe("memo_date_filled");
  expect(rec.detail.date).toBe("2027-01-05");
  expect(repo.activeScheduleForMemo(memo)).toBeNull();
});

test("an older live schedule is still found when the newest schedule node has no date", () => {
  const memo = insertMemo("일정 두 개");
  db.run(`INSERT INTO knowledge_nodes (content, event_at, created_at, last_accessed_at) VALUES ('옛 일정', '2026-11-03', '2026-10-10 09:00:00', '2026-10-10 09:00:00')`);
  const olderNode = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.run(`INSERT INTO knowledge_nodes (content, created_at, last_accessed_at) VALUES ('날짜 없는 일정', '2026-10-10 09:00:00', '2026-10-10 09:00:00')`);
  const newerNode = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  const base = { runId: null, proposalId: null, sourceNodeId: memo, itemKind: "schedule_created" as const, targetType: "schedule", decidedBy: "auto" as const, detail: emptyRecordDetail() };
  const olderRecord = repo.insert({ ...base, targetId: String(olderNode), name: "옛 일정" });
  repo.insert({ ...base, targetId: String(newerNode), name: "날짜 없는 일정" });
  expect(repo.activeScheduleForMemo(memo)).toEqual({ recordId: olderRecord, nodeId: olderNode, date: "2026-11-03", title: "옛 일정" });
});

test("a schedule record whose target id is not an integer string stops with the record id", () => {
  const memo = insertMemo("일정");
  const id = repo.insert({ runId: null, proposalId: null, sourceNodeId: memo, itemKind: "schedule_created", targetType: "schedule", targetId: "12abc", name: "x", decidedBy: "auto", detail: emptyRecordDetail() });
  expect(() => repo.activeScheduleForMemo(memo)).toThrow(`entity_register_records.id=${id}`);
});

describe("detail_json shape is checked on read", () => {
  function insertRaw(detailJson: string): number {
    db.run(
      `INSERT INTO entity_register_records (stage, source_node_id, item_kind, target_type, target_id, name, decided_by, detail_json)
       VALUES ('entity_register', 1, 'entity_created', 'person', 'p', 'n', 'auto', ?)`,
      [detailJson],
    );
    return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }
  const valid = (): Record<string, unknown> => ({ ...emptyRecordDetail() });
  const cases: Array<[string, string, string]> = [
    ["null", "null", "root"],
    ["a string", JSON.stringify("abc"), "root"],
    ["an array", "[1,2]", "root"],
    ["an empty object", "{}", "edges"],
    ["edges not an array", JSON.stringify({ ...valid(), edges: "notarray" }), "edges"],
    ["an unknown edge table", JSON.stringify({ ...valid(), edges: [{ table: "nope" }] }), "edges[0]"],
    ["an edge with a wrong field type", JSON.stringify({ ...valid(), edges: [{ table: "node_person_edges", nodeId: "1", personId: "p", relation: "mentions" }] }), "edges[0]"],
    ["createdRow missing", JSON.stringify((({ createdRow: _c, ...rest }) => rest)(valid())), "createdRow"],
    ["createdRow wrong shape", JSON.stringify({ ...valid(), createdRow: { typeName: "person" } }), "createdRow"],
    ["aliasAdded wrong shape", JSON.stringify({ ...valid(), aliasAdded: { typeName: "person", id: "p" } }), "aliasAdded"],
    ["scheduleNodeId not an integer", JSON.stringify({ ...valid(), scheduleNodeId: "5" }), "scheduleNodeId"],
    ["date not a string", JSON.stringify({ ...valid(), date: 20261103 }), "date"],
    ["deletedRowSnapshot an array", JSON.stringify({ ...valid(), deletedRowSnapshot: [] }), "deletedRowSnapshot"],
    ["keptRowReason missing", JSON.stringify((({ keptRowReason: _k, ...rest }) => rest)(valid())), "keptRowReason"],
  ];
  for (const [label, json, field] of cases) {
    test(`${label} → 형식 오류: ${field}`, () => {
      const id = insertRaw(json);
      expect(() => repo.get(id)).toThrow(`entity_register_records.id=${id} detail_json 형식 오류: ${field}`);
    });
  }

  test("a full detail with every edge kind reads back as written", () => {
    const detail = {
      edges: [
        { table: "node_person_edges", nodeId: 3, personId: "psn_1", relation: "mentions" },
        { table: "node_concept_edges", nodeId: 3, conceptId: "c1", role: "mention" },
        { table: "entity_concept_edges", entityId: "e1", conceptId: "c1", role: "identity" },
      ],
      createdRow: { typeName: "person", id: "psn_1" },
      aliasAdded: { typeName: "person", id: "psn_1", alias: "민수형" },
      scheduleNodeId: 9,
      date: "2026-11-03",
      deletedRowSnapshot: { entity_id: "psn_1" },
      keptRowReason: "다른 기억이 연결됨",
    };
    const id = insertRaw(JSON.stringify(detail));
    expect(repo.get(id)!.detail).toEqual(detail as never);
  });
});

describe("inputs are checked before touching the database", () => {
  const record = () => ({ runId: null, proposalId: null, sourceNodeId: 1, itemKind: "entity_created" as const, targetType: "person", targetId: "p", name: "x", decidedBy: "auto" as const, detail: emptyRecordDetail() });

  test("sourceNodeId must be a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => repo.insert({ ...record(), sourceNodeId: bad })).toThrow("sourceNodeId");
      expect(() => repo.listActiveForMemo(bad)).toThrow("sourceNodeId");
      expect(() => repo.activeScheduleForMemo(bad)).toThrow("sourceNodeId");
      expect(() => repo.addIgnore(bad, "entity", "a", "ignored")).toThrow("sourceNodeId");
      expect(() => repo.ignoredNameKeys(bad)).toThrow("sourceNodeId");
      expect(() => repo.isScheduleIgnored(bad)).toThrow("sourceNodeId");
    }
  });

  test("name and targetId must not be empty", () => {
    expect(() => repo.insert({ ...record(), name: "" })).toThrow("name");
    expect(() => repo.insert({ ...record(), name: "   " })).toThrow("name");
    expect(() => repo.insert({ ...record(), targetId: "" })).toThrow("targetId");
  });

  test("listActive limit must be a positive integer and offset a non-negative integer", () => {
    for (const bad of [0, -1, 2.5]) {
      expect(() => repo.listActive({ decidedBy: "auto", limit: bad, offset: 0 })).toThrow("limit");
    }
    expect(() => repo.listActive({ decidedBy: "auto", limit: 10, offset: -1 })).toThrow("offset");
  });
});
