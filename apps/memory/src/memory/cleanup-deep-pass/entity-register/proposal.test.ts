/**
 * entity-register/proposal.test.ts — 정리 제안 entity_register(spec 6장) 통합 시험. 실제 SQLite + 실제 bge-m3.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { CleanupProposalsRepository } from "../../../db/store-internal/cleanup-proposals-repository.ts";
import { createEmbedder, embeddingDimensionOf } from "../../../embedding/factory.ts";
import type { Embedder } from "../../../embedding/types.ts";
import { entityRegisterFingerprint } from "../stage-fingerprint.ts";
import { applyMemoChanges } from "./apply.ts";
import { judgeMemo, judgeProfileFromLanguage } from "./judge.ts";
import {
  approveEntityRegisterProposal, buildEntityRegisterProposal, insertEntityRegisterProposal, listEntityRegisterItems,
  EntityRegisterChoiceError, EntityRegisterProposalNotPendingError, parseEntityRegisterChoices, rejectEntityRegisterProposal, validateEntityRegisterPayload, type EntityRegisterProposalPayload,
} from "./proposal.ts";
import { EntityRegisterRecordsRepository } from "./records-repository.ts";

const MODEL = "bge-m3";
let embedder: Embedder; let db: Database; let store: SqliteMemoryStore;
let proposals: CleanupProposalsRepository; let records: EntityRegisterRecordsRepository;
beforeAll(async () => { embedder = createEmbedder({ model: MODEL }); await embedder.load(); });
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  proposals = new CleanupProposalsRepository(db);
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

async function proposalFor(content: string, entities: Array<{ type: string; name: string }>, schedule?: { dateText: string; date: string; title: string }) {
  const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
  const node = (await store.getNode(nodeId))!;
  const index = { byType: new Map([["person", (await store.listPersons({ limit: 100 })).map((p) => ({ typeName: "person", id: p.personId, name: p.displayName, aliases: p.aliases }))]]) };
  const j = judgeMemo({
    memo: { nodeId, content, createdAt: node.createdAt, alreadyLinked: [] },
    result: { nodeId, entities, eventDateText: schedule?.dateText ?? null, eventDate: schedule?.date ?? null, scheduleTitle: schedule?.title ?? null },
    index, allowedTypes: new Set(["person", "place"]), ignoredNames: new Set(), scheduleIgnored: false, activeSchedule: null,
    autoApply: true, profile: judgeProfileFromLanguage(),
  });
  const payload = buildEntityRegisterProposal(j, {
    inputFingerprint: entityRegisterFingerprint({ content, createdAt: node.createdAt }), stageVersion: 1, runId: "run_1", autoApplied: [],
  })!;
  const id = insertEntityRegisterProposal(proposals, payload);
  return { nodeId, id, payload, createdAt: node.createdAt };
}

test("only undecided items enter the proposal, and the payload validates", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const { payload } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }], { dateText: "다음 주", date: "2026-10-17", title: "x" });
  expect(payload.items.map((i) => i.reason)).toEqual(["similar"]);
  expect(validateEntityRegisterPayload(payload as unknown as Record<string, unknown>)).toEqual({ ok: true });
  expect(listEntityRegisterItems(payload as unknown as Record<string, unknown>).map((i) => i.group)).toEqual(["entities"]);
}, 120_000);

test("a payload missing nodeId is refused with the field name", () => {
  expect(validateEntityRegisterPayload({ items: [] })).toEqual({ ok: false, message: expect.stringContaining("nodeId") });
});

test("approving 'same as 이몽룡' links and remembers 몽룡 as an alias", async () => {
  const mongryongPerson = await store.findOrCreatePersonByName("이몽룡");
  const { id, payload, nodeId } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  const choices = parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: 0 } } }, payload);
  const result = await approveEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)!, choices });
  expect(result.status).toBe("applied");
  expect((await store.getPerson(mongryongPerson.personId))!.aliases).toContain("몽룡");
  expect((await store.listNodePersonEdges({ nodeId })).map((e) => e.personId)).toEqual([mongryongPerson.personId]);
  expect(proposals.findById(id)!.status).toBe("applied");
  expect(proposals.listJournal(id).map((e) => [e.itemKey, e.status])).toEqual([["entity:0", "applied"]]);
}, 120_000);

test("a stale proposal is refused when the memo text changed", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const { id, payload, nodeId } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  db.run("UPDATE knowledge_nodes SET content = '엄마 아빠는 몽룡이랑 같이 지내신다' WHERE id = ?", [nodeId]);
  const result = await approveEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)!, choices: parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: 0 } } }, payload) });
  expect(result.status).toBe("needs_revision");
  expect(result.staleReason).toContain("메모");
  expect(result.appliedCount).toBe(0);
  expect(result.items).toEqual([{ itemKey: "entity:0", status: "skipped", detail: result.staleReason }]);
}, 120_000);

test("choosing 'new' fails for that item when the same name appeared meanwhile", async () => {
  await store.findOrCreatePersonByName("민수");
  const { id, payload } = await proposalFor("민수형한테 축의금 10만원 보냈다", [{ type: "person", name: "민수형" }]);
  const createIndex = payload.items[0]!.options.findIndex((o) => o.kind === "create");
  await store.findOrCreatePersonByName("민수형");
  const result = await approveEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)!, choices: parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: createIndex } } }, payload) });
  expect(result.items[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("민수형") });
}, 120_000);

test("a schedule that appeared meanwhile refuses the whole approval: no ignore, record or schedule write", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const { id, payload, nodeId, createdAt } = await proposalFor(
    "몽룡이가 다음 주에 이사 간대", [{ type: "person", name: "몽룡" }], { dateText: "다음 주", date: "2026-10-17", title: "몽룡 이사" },
  );
  expect(payload.schedule).not.toBeNull();
  expect(payload.schedule!.existingScheduleNodeId).toBeNull();
  // 제안 뒤 같은 메모에 일정이 생겼다(다른 경로의 반영) — 제안의 "새 일정" 요청은 오래됐다.
  await applyMemoChanges(
    { store, records, memo: { nodeId, content: "몽룡이가 다음 주에 이사 간대", createdAt }, runId: null, proposalId: null, decidedBy: "auto" },
    { entities: [], schedule: { title: "이사", date: "2026-10-18", dateText: "다음 주", replaceNodeId: null } },
  );
  const ignoreIndex = payload.items[0]!.options.findIndex((o) => o.kind === "ignore");
  const choices = parseEntityRegisterChoices(
    { choices: { "entity:0": { optionIndex: ignoreIndex }, schedule: { accept: true, date: "2026-10-17", title: "몽룡 이사" } } }, payload,
  );
  const result = await approveEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)!, choices });
  expect(result.status).toBe("needs_revision");
  expect(result.appliedCount).toBe(0);
  expect(result.staleReason).toContain("일정");
  expect(result.items.map((i) => i.status)).toEqual(["failed", "failed"]);
  // 무시 선택도 기록하지 않는다 — 일부만 반영하지 않는다.
  expect(records.ignoredNameKeys(nodeId).size).toBe(0);
  expect(records.listActiveForMemo(nodeId).map((r) => r.itemKind)).toEqual(["schedule_created"]);
  expect(proposals.findById(id)!.status).toBe("needs_revision");
}, 120_000);

test("a newer proposal for the same memo supersedes the pending one", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const first = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  const second = insertEntityRegisterProposal(proposals, first.payload);
  expect(proposals.findById(first.id)!.status).toBe("needs_revision");
  expect(proposals.findById(second)!.status).toBe("pending");
}, 120_000);

test("rejecting records every item as ignored", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const { id, nodeId } = await proposalFor("몽룡이가 다음 주에 이사 간대", [{ type: "person", name: "몽룡" }], { dateText: "다음 주", date: "2026-10-17", title: "몽룡 이사" });
  await rejectEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)! });
  expect([...records.ignoredNameKeys(nodeId)]).toEqual(["몽룡"]);
  expect(records.isScheduleIgnored(nodeId)).toBe(true);
  expect(proposals.findById(id)!.status).toBe("rejected");
}, 120_000);

test("a failure that is not a refusal surfaces, rolls back and leaves the proposal pending", async () => {
  const mongryongPerson = await store.findOrCreatePersonByName("이몽룡");
  const { id, payload, nodeId } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  db.run("CREATE TRIGGER forced_record_failure BEFORE INSERT ON entity_register_records BEGIN SELECT RAISE(ABORT, 'forced record failure'); END");
  const choices = parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: 0 } } }, payload);
  await expect(approveEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)!, choices })).rejects.toThrow("forced record failure");
  expect(proposals.findById(id)!.status).toBe("pending");
  expect(proposals.listJournal(id)).toEqual([]);
  expect((await store.getPerson(mongryongPerson.personId))!.aliases).not.toContain("몽룡");
  expect(await store.listNodePersonEdges({ nodeId })).toEqual([]);
}, 120_000);

test("zero chosen items is refused before any write and keeps the proposal pending", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const { id, payload } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  expect(() => parseEntityRegisterChoices({ choices: {} }, payload)).toThrow("고른 항목 없음");
  await expect(approveEntityRegisterProposal({ store, proposals, records, proposal: proposals.findById(id)!, choices: new Map() }))
    .rejects.toBeInstanceOf(EntityRegisterChoiceError);
  expect(proposals.findById(id)!.status).toBe("pending");
  expect(proposals.listJournal(id)).toEqual([]);
}, 120_000);

test("a double approve applies once; the second is refused and the first result stays", async () => {
  const mongryongPerson = await store.findOrCreatePersonByName("이몽룡");
  const { id, payload } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  const choices = parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: 0 } } }, payload);
  const stale = proposals.findById(id)!;
  const [first, second] = await Promise.allSettled([
    approveEntityRegisterProposal({ store, proposals, records, proposal: stale, choices }),
    approveEntityRegisterProposal({ store, proposals, records, proposal: stale, choices }),
  ]);
  expect(first.status).toBe("fulfilled");
  expect(second.status === "rejected" && second.reason instanceof EntityRegisterProposalNotPendingError).toBe(true);
  expect(proposals.findById(id)!.status).toBe("applied");
  expect(proposals.listJournal(id).map((e) => [e.itemKey, e.status])).toEqual([["entity:0", "applied"]]);
  expect((await store.getPerson(mongryongPerson.personId))!.aliases.filter((a) => a === "몽룡")).toHaveLength(1);
}, 120_000);

test("approve then reject: the approve wins and the reject is refused without ignore records", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const { id, payload, nodeId } = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  const stale = proposals.findById(id)!;
  const approving = approveEntityRegisterProposal({
    store, proposals, records, proposal: stale, choices: parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: 0 } } }, payload),
  });
  const rejecting = rejectEntityRegisterProposal({ store, proposals, records, proposal: stale });
  expect((await approving).status).toBe("applied");
  await expect(rejecting).rejects.toBeInstanceOf(EntityRegisterProposalNotPendingError);
  expect(proposals.findById(id)!.status).toBe("applied");
  expect(records.ignoredNameKeys(nodeId).size).toBe(0);
}, 120_000);

test("superseding happens with the insert: exactly one pending proposal per memo", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const first = await proposalFor("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }]);
  insertEntityRegisterProposal(proposals, first.payload);
  insertEntityRegisterProposal(proposals, first.payload);
  expect(proposals.findPendingIdsByNode("entity_register", first.nodeId)).toHaveLength(1);
}, 120_000);

describe("choice parsing", () => {
  const payload = {
    nodeId: 1, inputFingerprint: "f".repeat(64), stageVersion: 1, runId: null, autoApplied: [],
    items: [{ itemKey: "entity:0", type: "person", name: "몽룡", reason: "similar", options: [{ kind: "ignore" }] }],
    schedule: null,
  } as EntityRegisterProposalPayload;
  test("an option index out of range or an unknown item key is a 400-level error", () => {
    expect(() => parseEntityRegisterChoices({ choices: { "entity:0": { optionIndex: 3 } } }, payload)).toThrow("entity:0");
    expect(() => parseEntityRegisterChoices({ choices: { "entity:9": { optionIndex: 0 } } }, payload)).toThrow("entity:9");
    expect(() => parseEntityRegisterChoices({}, payload)).toThrow("choices");
  });
});
