/**
 * cleanup-external/entity-register-submit.test.ts — 펫·MCP 의 entity_register 제출이 서버 사이클과 같은
 * 판정 함수(processEntityRegisterMemo)를 지나는지(spec 8장, D7) 실제 SQLite + 실제 bge-m3 로 확인한다.
 * LLM 자리(서버 사이클 쪽)에는 고정 답을 돌려주는 함수를 넣는다(클래스 가짜 구현 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { createEmbedder, embeddingDimensionOf } from "../../embedding/factory.ts";
import type { Embedder } from "../../embedding/types.ts";
import { runEntityRegisterCycle } from "../../memory/cleanup-deep-pass/entity-register/cycle.ts";
import { getStageResult } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import { CLEANUP_PROPOSALS_READY_EVENT } from "../../memory/person-link-infer-cycle.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { EventBus } from "../event-bus.ts";
import type { MemoryApiDeps } from "../types.ts";
import { listExternalCandidates } from "./candidates.ts";
import { submitExternalProposal } from "./proposals.ts";

const MODEL = "bge-m3";
const ER_VERSION = CLEANUP_STAGE_LLM_LIMITS.entity_register.stageVersion;
let embedder: Embedder; let db: Database; let store: SqliteMemoryStore; let eventBus: EventBus;
let settings: MemorySettings; let deps: MemoryApiDeps;
beforeAll(async () => { embedder = createEmbedder({ model: MODEL }); await embedder.load(); });
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  eventBus = new EventBus(new EventRepository(db));
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  deps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    getSettings: () => settings,
  };
});
afterEach(() => db.close());

const MONGRYONG = "엄마 아빠는 몽룡이랑 같이 지내고 계신다";
const MONGRYONG_OTHER = "주말에 몽룡이가 집에 들러 저녁을 먹고 갔다";
const MONGRYONG_ANSWER = { entities: [{ type: "person", name: "몽룡" }], eventDateText: null, eventDate: null, scheduleTitle: null };

async function refOf(nodeId: number) {
  const [cand] = (await listExternalCandidates(deps, "entityRegister", 10, [nodeId])).candidates;
  if (!cand) throw new Error(`test: 메모 ${nodeId} 가 entityRegister 후보로 나오지 않음`);
  return { stage: "entityRegister", targetKey: cand.targetKey, inputFingerprint: cand.inputFingerprint, stageVersion: cand.stageVersion };
}

test("a pet submission is judged by the same code as the server cycle (D7)", async () => {
  // 서버 단계 스위치(enabled)는 기본값 false 그대로 — 외부 표면은 이 스위치를 보지 않는다.
  expect(settings.cleanupDeepPass.entityRegister.enabled).toBe(false);
  await store.findOrCreatePersonByName("이몽룡");
  const viaPet = await store.addNode({ content: MONGRYONG, sourceType: "auto_capture" });
  const viaServer = await store.addNode({ content: MONGRYONG_OTHER, sourceType: "auto_capture" });
  expect(viaServer).not.toBe(viaPet);

  const list = await listExternalCandidates(deps, "entityRegister", 10, [viaPet]);
  expect(list.shared?.instruction).toContain("JSON 객체 하나만");
  expect(list.candidates.map((c) => c.targetKey)).toEqual([String(viaPet)]);
  const out = await submitExternalProposal(deps, {
    kind: "entity_register",
    payload: { nodeId: viaPet, ...MONGRYONG_ANSWER },
    candidate: await refOf(viaPet),
  });
  expect(out).toMatchObject({ ok: true, autoApplied: 0 });
  const proposal = new CleanupProposalsRepository(db).findById((out as { proposalId: string }).proposalId)!;
  expect((proposal.payload.items as Array<{ reason: string }>).map((i) => i.reason)).toEqual(["similar"]);
  expect(getStageResult(db, "entity_register", String(viaPet))!.status).toBe("completed");

  // 다른 메모·같은 AI 답을 서버 사이클로 돌린 결과와 판정이 같다. 펫이 처리한 메모는 서버 사이클이 건너뛴다.
  const inferred: number[] = [];
  const summary = await runEntityRegisterCycle({
    store, eventBus, batchSize: 10, autoApply: true, stageVersion: ER_VERSION, maxAttemptsPerTarget: 3, perCallInputCap: 30_000, runId: "r",
    infer: async ({ memos }) => {
      inferred.push(...memos.map((m) => m.nodeId));
      return { kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, ...MONGRYONG_ANSWER })) };
    },
  });
  expect(inferred).toEqual([viaServer]);
  expect(summary.proposalsInserted).toBe(1);
  const serverProposal = db.query("SELECT payload_json FROM cleanup_proposals WHERE payload_json ->> '$.nodeId' = ?").get(viaServer) as { payload_json: string };
  expect(JSON.parse(serverProposal.payload_json).items).toEqual(proposal.payload.items);
}, 300_000);

test("a memo the server cycle processed is no longer a candidate, and a late pet submission for it is refused", async () => {
  const memo = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const ref = await refOf(memo);
  await runEntityRegisterCycle({
    store, eventBus, batchSize: 10, autoApply: true, stageVersion: ER_VERSION, maxAttemptsPerTarget: 3, perCallInputCap: 30_000, runId: "r",
    infer: async ({ memos }) => ({ kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null })) }),
  });
  expect((await listExternalCandidates(deps, "entityRegister", 10, [memo])).candidates).toEqual([]);
  const late = await submitExternalProposal(deps, {
    kind: "entity_register",
    payload: { nodeId: memo, entities: [{ type: "creature", name: "금목서" }], eventDateText: null, eventDate: null, scheduleTitle: null },
    candidate: ref,
  });
  expect(late).toMatchObject({ ok: false, httpStatus: 409 });
}, 300_000);

test("a pet submission for an already processed memo is refused", async () => {
  const memo = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const ref = await refOf(memo);
  const submit = () => submitExternalProposal(deps, {
    kind: "entity_register",
    payload: { nodeId: memo, entities: [{ type: "creature", name: "금목서" }], eventDateText: null, eventDate: null, scheduleTitle: null },
    candidate: ref,
  });
  expect(await submit()).toMatchObject({ ok: true, proposalId: null, autoApplied: 1 });
  expect(await submit()).toMatchObject({ ok: false, httpStatus: 409 });
  expect((await listExternalCandidates(deps, "entityRegister", 10, [memo])).candidates).toEqual([]);
}, 300_000);

test("autoApply follows the server setting: off turns a clean name into a proposal", async () => {
  settings.cleanupDeepPass.entityRegister.autoApply = false;
  const memo = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const out = await submitExternalProposal(deps, {
    kind: "entity_register",
    payload: { nodeId: memo, entities: [{ type: "creature", name: "금목서" }], eventDateText: null, eventDate: null, scheduleTitle: null },
    candidate: await refOf(memo),
  });
  expect(out).toMatchObject({ ok: true, autoApplied: 0 });
  expect((out as { proposalId: string | null }).proposalId).not.toBeNull();
}, 300_000);

test("a malformed answer is a 400 naming the field, and a nodeId that is not the candidate is refused", async () => {
  const memo = await store.addNode({ content: "x 메모", sourceType: "auto_capture" });
  const ref = await refOf(memo);
  expect(await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo, entities: "x" }, candidate: ref }))
    .toMatchObject({ ok: false, httpStatus: 400, message: expect.stringContaining("entities") });
  expect(await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo, entities: [] }, candidate: ref }))
    .toMatchObject({ ok: false, httpStatus: 400, message: expect.stringContaining("eventDateText") });
  expect(await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo + 1, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null }, candidate: ref }))
    .toMatchObject({ ok: false, httpStatus: 400, message: expect.stringContaining("nodeId") });
  // 형식 오류는 원장을 건드리지 않는다 — 같은 후보가 그대로 남는다.
  expect(getStageResult(db, "entity_register", String(memo))).toBeNull();
}, 300_000);

test("a changed memo or a stale stageVersion is refused with the current values", async () => {
  const memo = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const ref = await refOf(memo);
  const payload = { nodeId: memo, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null };
  expect(await submitExternalProposal(deps, { kind: "entity_register", payload, candidate: { ...ref, stageVersion: ref.stageVersion + 1 } }))
    .toMatchObject({ ok: false, httpStatus: 409, current: { stageVersion: ref.stageVersion } });
  db.query("UPDATE knowledge_nodes SET content = ? WHERE id = ?").run("보리밥 먹고 싶다 정말", memo);
  const stale = await submitExternalProposal(deps, { kind: "entity_register", payload, candidate: ref });
  expect(stale).toMatchObject({ ok: false, httpStatus: 409 });
  expect((stale as { current: { inputFingerprint: string } }).current.inputFingerprint).not.toBe(ref.inputFingerprint);
}, 300_000);

test("without the settings wiring the submission is a 503 naming getSettings", async () => {
  const memo = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const ref = await refOf(memo);
  delete deps.getSettings;
  expect(await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null }, candidate: ref }))
    .toMatchObject({ ok: false, httpStatus: 503, message: expect.stringContaining("getSettings") });
  expect(getStageResult(db, "entity_register", String(memo))).toBeNull();
}, 300_000);

const WEDDING = "민수가 11월 3일 결혼한다더라";
const WEDDING_ANSWER = { entities: [{ type: "person", name: "민수" }], eventDateText: "11월 3일", eventDate: "2026-11-03", scheduleTitle: "민수 결혼" };
const countSchedules = () => (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content = '민수 결혼'").get() as { n: number }).n;

test("two concurrent submissions for the same memo apply once; the other caller is told it was already processed", async () => {
  const memo = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const ref = await refOf(memo);
  const submit = () => submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo, ...WEDDING_ANSWER }, candidate: ref });
  const results = await Promise.all([submit(), submit()]);
  const ok = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok) as Array<{ httpStatus: number; message: string }>;
  expect(ok).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatchObject({ httpStatus: 409, message: expect.stringContaining("이미 처리") });
  expect(getStageResult(db, "entity_register", String(memo))!.status).toBe("completed");
  expect(countSchedules()).toBe(1);
}, 300_000);

test("a cycle that reaches a memo after a pet submission completed it skips it and leaves the ledger alone", async () => {
  const memo = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const ref = await refOf(memo);
  const summary = await runEntityRegisterCycle({
    store, eventBus, batchSize: 10, autoApply: true, stageVersion: ER_VERSION, maxAttemptsPerTarget: 3, perCallInputCap: 30_000, runId: "r",
    nodeIds: [memo],
    // 사이클이 후보를 고른 뒤 AI 답을 기다리는 동안 펫 제출이 같은 메모를 먼저 끝낸다.
    infer: async ({ memos }) => {
      expect(await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo, ...WEDDING_ANSWER }, candidate: ref }))
        .toMatchObject({ ok: true });
      return { kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, ...WEDDING_ANSWER })) };
    },
  });
  expect(summary).toMatchObject({ candidatesFound: 1, alreadyProcessed: 1, completed: 0, failures: 0, autoApplied: 0 });
  const ledger = getStageResult(db, "entity_register", String(memo))!;
  expect(ledger.status).toBe("completed");
  expect(ledger.attemptCount).toBe(0);
  expect(countSchedules()).toBe(1);
}, 300_000);

test("a pet submission that creates a proposal emits the proposals-ready event like the server cycle", async () => {
  deps.eventBus = eventBus;
  await store.findOrCreatePersonByName("이몽룡");
  const memo = await store.addNode({ content: MONGRYONG, sourceType: "auto_capture" });
  const countEvents = () => (db.query("SELECT COUNT(*) AS n FROM events WHERE type = ?").get(CLEANUP_PROPOSALS_READY_EVENT) as { n: number }).n;
  const out = await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: memo, ...MONGRYONG_ANSWER }, candidate: await refOf(memo) });
  expect((out as { proposalId: string | null }).proposalId).not.toBeNull();
  expect(countEvents()).toBe(1);

  // 제안 없이 자동 반영만 된 제출은 알리지 않는다.
  const plain = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const out2 = await submitExternalProposal(deps, {
    kind: "entity_register",
    payload: { nodeId: plain, entities: [{ type: "creature", name: "금목서" }], eventDateText: null, eventDate: null, scheduleTitle: null },
    candidate: await refOf(plain),
  });
  expect(out2).toMatchObject({ ok: true, proposalId: null });
  expect(countEvents()).toBe(1);
}, 300_000);

test("a pet submission fills a yearless memo date exactly like the server cycle (yearless-date-cleanup 3.9)", async () => {
  const DEADLINE = "1월 5일까지 제출";
  // 일정 제목까지 주어 일정도 자동 — 제안 없이 메모 날짜·일정 두 기록이 남는 모양을 두 경로에서 비교한다.
  const answer = { entities: [], eventDateText: "1월 5일", eventDate: "2027-01-05", scheduleTitle: "서류 제출" };
  const viaPet = await store.addNode({ content: DEADLINE, sourceType: "auto_capture" });
  const out = await submitExternalProposal(deps, { kind: "entity_register", payload: { nodeId: viaPet, ...answer }, candidate: await refOf(viaPet) });
  expect(out).toMatchObject({ ok: true, autoApplied: 2, proposalId: null });

  const viaServer = await store.addNode({ content: DEADLINE, sourceType: "auto_capture" });
  await runEntityRegisterCycle({
    store, eventBus, batchSize: 10, autoApply: true, stageVersion: ER_VERSION, maxAttemptsPerTarget: 3, perCallInputCap: 30_000, runId: "r",
    infer: async ({ memos }) => ({ kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, ...answer })) }),
  });
  const shape = (nodeId: number) => ({
    node: db.query("SELECT event_at, metadata_json ->> '$.fieldSources.event_at' AS source FROM knowledge_nodes WHERE id = ?").get(nodeId),
    records: db.query(
      "SELECT item_kind, target_type, name, decided_by, detail_json ->> '$.date' AS date FROM entity_register_records WHERE source_node_id = ? ORDER BY item_kind",
    ).all(nodeId),
  });
  expect(shape(viaPet)).toEqual({
    node: { event_at: "2027-01-05", source: "inferred" },
    records: [
      { item_kind: "memo_date_filled", target_type: "memo", name: "1월 5일", decided_by: "auto", date: "2027-01-05" },
      { item_kind: "schedule_created", target_type: "schedule", name: "서류 제출", decided_by: "auto", date: "2027-01-05" },
    ],
  });
  expect(shape(viaServer)).toEqual(shape(viaPet));
}, 300_000);
