/**
 * entity-register/revert.test.ts — 자동 등록 되돌리기(spec 7.3) 통합 시험. 실제 SQLite + 실제 bge-m3.
 * 준비 코드·memoCtx 도우미는 apply.test.ts 와 같다.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { createEmbedder, embeddingDimensionOf } from "../../../embedding/factory.ts";
import type { Embedder } from "../../../embedding/types.ts";
import { EntityRegisterRecordsRepository } from "./records-repository.ts";
import { applyMemoChanges, type ApplyContext } from "./apply.ts";
import { revertEntityRegisterRecord } from "./revert.ts";

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

function identityConceptOf(entityId: string): string {
  return (db.query("SELECT concept_id FROM entity_concept_edges WHERE entity_id = ? AND role = 'identity'").get(entityId) as { concept_id: string }).concept_id;
}

test("reverting an auto-created person deletes the row and remembers the name as ignored", async () => {
  const ctx = await memoCtx("민수가 11월 3일 결혼한다더라");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } }], schedule: null });
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toEqual({ typeName: "person", id: out.entities[0]!.id });
  expect(result.removedEdges).toBe(1);
  expect(await store.getPerson(out.entities[0]!.id)).toBeNull();
  expect([...records.ignoredNameKeys(ctx.memo.nodeId)]).toEqual(["민수"]);
  const after = records.get(out.entities[0]!.recordId!)!;
  expect(after.status).toBe("reverted");
  expect(after.detail.deletedRowSnapshot).toMatchObject({ display_name: "민수" });
  expect(after.detail.keptRowReason).toBeNull();
}, 120_000);

test("a person the user linked elsewhere in between keeps its row; only this run's link goes", async () => {
  const ctx = await memoCtx("민수가 왔다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } }], schedule: null });
  const other = await store.addNode({ content: "민수랑 밥", sourceType: "auto_capture" });
  await store.addNodePersonEdge(other, out.entities[0]!.id, "mentions", "user_input", other);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toBeNull();
  expect(result.keptRowReason).toContain("연결");
  expect(await store.getPerson(out.entities[0]!.id)).not.toBeNull();
  expect((await store.listNodePersonEdges({ personId: out.entities[0]!.id })).map((e) => e.nodeId)).toEqual([other]);
  const after = records.get(out.entities[0]!.recordId!)!;
  expect(after.detail.keptRowReason).toBe(result.keptRowReason);
  expect(after.detail.deletedRowSnapshot).toBeNull();
}, 120_000);

test("reverting twice is refused", async () => {
  const ctx = await memoCtx("금목서를 키우고 있다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "금목서", type: "creature", action: { kind: "create", name: "금목서", aliasFromMemo: null } }], schedule: null });
  await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  await expect(revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!)).rejects.toMatchObject({ status: 409 });
  await expect(revertEntityRegisterRecord(store, records, 99999)).rejects.toMatchObject({ status: 404 });
}, 120_000);

test("a reverted schedule goes to the trash and can be restored from it", async () => {
  const ctx = await memoCtx("민수가 11월 3일 결혼한다더라");
  const minsu = await store.findOrCreatePersonByName("민수");
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: "민수", type: "person", action: { kind: "link", targetId: minsu.personId, targetName: "민수", addAlias: false } }],
    schedule: { title: "민수 결혼", date: "2026-11-03", dateText: "11월 3일", replaceNodeId: null },
  });
  const scheduleEdges = records.get(out.scheduleRecordId!)!.detail.edges;
  expect(scheduleEdges).toEqual([{ table: "node_person_edges", nodeId: out.scheduleNodeId!, personId: minsu.personId, relation: "mentions" }]);
  const result = await revertEntityRegisterRecord(store, records, out.scheduleRecordId!);
  expect(result.trashedScheduleNodeId).toBe(out.scheduleNodeId);
  // 일정 노드의 연결은 미리 지우지 않고 휴지통 이동(노드 행 삭제의 CASCADE)에 맡긴다 — 사라진 수만 센다.
  expect(result.removedEdges).toBe(1);
  // 메모 쪽 사람 연결(항목 기록)은 그대로다.
  expect((await store.listNodePersonEdges({ nodeId: ctx.memo.nodeId })).map((e) => e.personId)).toEqual([minsu.personId]);
  expect(await store.getNode(out.scheduleNodeId!)).toBeNull();
  expect(records.isScheduleIgnored(ctx.memo.nodeId)).toBe(true);
  expect(records.ignoredNameKeys(ctx.memo.nodeId).size).toBe(0);
  expect(await store.getNode(ctx.memo.nodeId)).not.toBeNull();
  expect(await store.restoreArchived(out.scheduleNodeId!, "test")).not.toBeNull();
  // 확인된 현재 동작: 휴지통은 노드만 보관하고 연결은 보관하지 않아, 되살린 일정에 사람 연결은 돌아오지 않는다.
  expect(await store.listNodePersonEdges({ nodeId: out.scheduleNodeId! })).toEqual([]);
}, 120_000);

test("an auto-created item with no other links loses its row and identity edge; the memo stays", async () => {
  const ctx = await memoCtx("금목서를 키우고 있다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "금목서", type: "creature", action: { kind: "create", name: "금목서", aliasFromMemo: null } }], schedule: null });
  const id = out.entities[0]!.id;
  const conceptId = identityConceptOf(id);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toEqual({ typeName: "creature", id });
  expect(result.removedEdges).toBe(2);
  expect(await store.entitiesRepo.get(id)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM node_concept_edges WHERE concept_id = ?").get(conceptId)).toEqual({ n: 0 });
  expect(records.get(out.entities[0]!.recordId!)!.detail.deletedRowSnapshot).toMatchObject({ name: "금목서", type_name: "creature" });
  expect(await store.getNode(ctx.memo.nodeId)).not.toBeNull();
}, 120_000);

test("an item another memo mentions through its identity concept keeps its row and identity edge", async () => {
  const ctx = await memoCtx("금목서를 키우고 있다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "금목서", type: "creature", action: { kind: "create", name: "금목서", aliasFromMemo: null } }], schedule: null });
  const id = out.entities[0]!.id;
  const conceptId = identityConceptOf(id);
  const other = await store.addNode({ content: "금목서 꽃이 피었다", sourceType: "auto_capture" });
  await store.addNodeConceptEdge(other, conceptId, "mention", "user_input", other);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toBeNull();
  expect(result.keptRowReason).toContain("다른 메모 연결 1개");
  expect(result.removedEdges).toBe(1);
  expect(await store.entitiesRepo.get(id)).not.toBeNull();
  expect(identityConceptOf(id)).toBe(conceptId);
  expect(db.query("SELECT node_id FROM node_concept_edges WHERE concept_id = ?").all(conceptId)).toEqual([{ node_id: other }]);
}, 120_000);

test("reverting a link to an existing person removes only this run's edge and keeps the person", async () => {
  const minsu = await store.findOrCreatePersonByName("민수");
  const ctx = await memoCtx("민수한테 연락했다");
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: "민수", type: "person", action: { kind: "link", targetId: minsu.personId, targetName: "민수", addAlias: false } }],
    schedule: null,
  });
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result).toEqual({ recordId: out.entities[0]!.recordId!, removedEdges: 1, deletedRow: null, keptRowReason: null, removedAlias: null, trashedScheduleNodeId: null, clearedMemoDate: null });
  expect(await store.getPerson(minsu.personId)).not.toBeNull();
  expect(await store.listNodePersonEdges({ nodeId: ctx.memo.nodeId })).toEqual([]);
}, 120_000);

test("a record whose source memo was purged still reverts the rows it created", async () => {
  const ctx = await memoCtx("민수가 왔다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } }], schedule: null });
  await store.trashNodes([ctx.memo.nodeId], "selected_only");
  db.query("UPDATE knowledge_nodes_archive SET archived_at = '2000-01-01 00:00:00' WHERE id = ?").run(ctx.memo.nodeId);
  expect((await store.purgeOldArchive(1)).nodesPurged).toBe(1);
  const listed = records.listActive({ decidedBy: "auto", limit: 10, offset: 0 });
  expect(listed.records.map((r) => [r.id, r.memoContent])).toEqual([[out.entities[0]!.recordId!, null]]);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  // 메모가 지워지며 메모 연결은 이미 사라졌다 — 지울 연결은 0개, 행은 다른 연결이 없어 지운다.
  expect(result.removedEdges).toBe(0);
  expect(result.deletedRow).toEqual({ typeName: "person", id: out.entities[0]!.id });
  expect(await store.getPerson(out.entities[0]!.id)).toBeNull();
  expect([...records.ignoredNameKeys(ctx.memo.nodeId)]).toEqual(["민수"]);
}, 120_000);

// ── 같은 메모의 다른 기록(같은 회차 일정 노드 연결)은 남은 연결로 세지 않는다 ──

const SCHEDULE = { title: "행사", date: "2026-11-03", dateText: "11월 3일", replaceNodeId: null };

async function createWithSchedule(type: string, name: string) {
  const ctx = await memoCtx(`${name} 11월 3일 행사`);
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: name, type, action: { kind: "create", name, aliasFromMemo: null } }], schedule: SCHEDULE });
  const id = out.entities[0]!.id;
  const rowExists = async () => (type === "person" ? (await store.getPerson(id)) !== null : (await store.entitiesRepo.get(id)) !== null);
  return { ctx, id, entityRecordId: out.entities[0]!.recordId!, scheduleRecordId: out.scheduleRecordId!, rowExists };
}

for (const [type, name] of [["person", "민수"], ["creature", "금목서"]] as const) {
  test(`${type}+schedule: undoing the ${type} first deletes its row (no orphan), then the schedule still reverts`, async () => {
    const s = await createWithSchedule(type, name);
    const first = await revertEntityRegisterRecord(store, records, s.entityRecordId);
    expect(first.deletedRow).toEqual({ typeName: type, id: s.id });
    expect(first.keptRowReason).toBeNull();
    expect(await s.rowExists()).toBe(false);
    const second = await revertEntityRegisterRecord(store, records, s.scheduleRecordId);
    expect(second.trashedScheduleNodeId).not.toBeNull();
    expect(records.listActiveForMemo(s.ctx.memo.nodeId)).toEqual([]);
  }, 120_000);

  test(`${type}+schedule: undoing the schedule first, then the ${type}, also deletes the row`, async () => {
    const s = await createWithSchedule(type, name);
    await revertEntityRegisterRecord(store, records, s.scheduleRecordId);
    const result = await revertEntityRegisterRecord(store, records, s.entityRecordId);
    expect(result.deletedRow).toEqual({ typeName: type, id: s.id });
    expect(await s.rowExists()).toBe(false);
  }, 120_000);
}

test("keptRowReason counts other memos' links and names same-memo record links separately", async () => {
  const s = await createWithSchedule("person", "민수");
  const other = await store.addNode({ content: "민수랑 밥", sourceType: "auto_capture" });
  await store.addNodePersonEdge(other, s.id, "mentions", "user_input", other);
  const result = await revertEntityRegisterRecord(store, records, s.entityRecordId);
  expect(result.deletedRow).toBeNull();
  expect(result.keptRowReason).toContain("다른 메모 연결 1개");
  expect(result.keptRowReason).toContain("같은 메모의 다른 자동 등록 연결 1개");
}, 120_000);

// ── 이 회차가 더한 별칭 ──

test("undoing a link to an existing person removes only the alias this run added", async () => {
  const minsu = await store.findOrCreatePersonByName("민수");
  await store.addPersonAlias(minsu.personId, "므스");
  const ctx = await memoCtx("민수형한테 축의금 보냈다");
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: "민수형", type: "person", action: { kind: "link", targetId: minsu.personId, targetName: "민수", addAlias: true } }],
    schedule: null,
  });
  expect((await store.getPerson(minsu.personId))!.aliases).toContain("민수형");
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.removedAlias).toBe("민수형");
  expect((await store.getPerson(minsu.personId))!.aliases).toEqual(["민수", "므스"]);
}, 120_000);

test("a kept run-created person loses the alias taken from the memo", async () => {
  const ctx = await memoCtx("민수형이 왔다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "민수형", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: "민수형" } }], schedule: null });
  const id = out.entities[0]!.id;
  const other = await store.addNode({ content: "민수랑 밥", sourceType: "auto_capture" });
  await store.addNodePersonEdge(other, id, "mentions", "user_input", other);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toBeNull();
  expect(result.removedAlias).toBe("민수형");
  expect((await store.getPerson(id))!.aliases).toEqual(["민수"]);
}, 120_000);

test("undoing a link to an existing item removes only the alias this run added", async () => {
  const entity = await store.entitiesRepo.findOrCreateEntity("creature", "금목서");
  store.entitiesRepo.setKoAliases(entity.id, ["목서"]);
  const ctx = await memoCtx("금목서나무에 물 줬다");
  const out = await applyMemoChanges(ctx, {
    entities: [{ memoName: "금목서나무", type: "creature", action: { kind: "link", targetId: entity.id, targetName: "금목서", addAlias: true } }],
    schedule: null,
  });
  expect((await store.entitiesRepo.get(entity.id))!.koAliases).toEqual(["목서", "금목서나무"]);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.removedAlias).toBe("금목서나무");
  expect((await store.entitiesRepo.get(entity.id))!.koAliases).toEqual(["목서"]);
}, 120_000);

// ── 항목 행 보호: 스냅샷·사실 칸·관계 요약 ──

test("a deleted item's snapshot keeps its entity_attributes rows", async () => {
  const ctx = await memoCtx("목서를 키운다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "목서", type: "creature", action: { kind: "create", name: "금목서", aliasFromMemo: "목서" } }], schedule: null });
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).not.toBeNull();
  expect(result.removedAlias).toBeNull();
  const snapshot = records.get(out.entities[0]!.recordId!)!.detail.deletedRowSnapshot!;
  expect(snapshot.entity_attributes).toEqual([{ attr_key: "ko_aliases", attr_value: JSON.stringify(["목서"]), is_column: 1 }]);
}, 120_000);

test("an item whose fact column the user filled keeps its row", async () => {
  const ctx = await memoCtx("금목서를 키운다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "금목서", type: "creature", action: { kind: "create", name: "금목서", aliasFromMemo: null } }], schedule: null });
  db.query("UPDATE entities SET ko_name = '금목서(꽃나무)' WHERE entity_id = ?").run(out.entities[0]!.id);
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toBeNull();
  expect(result.keptRowReason).toContain("항목 사실(ko_name)");
}, 120_000);

test("a person named in a relation summary keeps its row", async () => {
  const ctx = await memoCtx("민수가 왔다");
  const out = await applyMemoChanges(ctx, { entities: [{ memoName: "민수", type: "person", action: { kind: "create", name: "민수", aliasFromMemo: null } }], schedule: null });
  // 관계 요약의 문서 FK 는 이 시험의 관심사가 아니라, 행 하나를 넣는 동안만 FK 검사를 끈다.
  db.run("PRAGMA foreign_keys = OFF");
  db.query(
    `INSERT INTO relation_summaries (summary_id, from_concept_id, to_concept_id, relation_name, summary_text, confidence, generated_by, source_document_id)
     VALUES ('rs_1', ?, 'cpt_x', '친구', '민수와 x 는 친구', 0.9, 'llm', 'doc_1')`,
  ).run(out.entities[0]!.id);
  db.run("PRAGMA foreign_keys = ON");
  const result = await revertEntityRegisterRecord(store, records, out.entities[0]!.recordId!);
  expect(result.deletedRow).toBeNull();
  expect(result.keptRowReason).toContain("관계 요약 1개");
}, 120_000);

test("a kept item keeps its identity edge while a same-memo schedule node still mentions that concept", async () => {
  const s = await createWithSchedule("creature", "금목서");
  const conceptId = identityConceptOf(s.id);
  db.query("UPDATE entities SET ko_name = '금목서(꽃나무)' WHERE entity_id = ?").run(s.id);
  const scheduleNodeId = records.get(s.scheduleRecordId)!.detail.scheduleNodeId!;
  const result = await revertEntityRegisterRecord(store, records, s.entityRecordId);
  expect(result.deletedRow).toBeNull();
  // 메모 → 개념 연결만 사라지고 identity 엣지는 남는다.
  expect(result.removedEdges).toBe(1);
  expect(identityConceptOf(s.id)).toBe(conceptId);
  // 일정 노드는 여전히 identity 개념을 거쳐 남긴 항목에 닿는다.
  const reached = db.query(
    `SELECT ece.entity_id FROM node_concept_edges nce
       JOIN entity_concept_edges ece ON ece.concept_id = nce.concept_id AND ece.role = 'identity'
      WHERE nce.node_id = ?`,
  ).all(scheduleNodeId);
  expect(reached).toEqual([{ entity_id: s.id }]);
}, 120_000);
