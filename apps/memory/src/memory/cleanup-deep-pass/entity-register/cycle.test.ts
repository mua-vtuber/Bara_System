/**
 * entity-register/cycle.test.ts — 정리 사이클(cycle.ts)·메모 하나 처리(process.ts) 통합 시험.
 * 실제 SQLite + 실제 bge-m3. LLM 자리에는 고정 답을 돌려주는 함수를 넣는다(클래스 가짜 구현 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { CleanupProposalsRepository } from "../../../db/store-internal/cleanup-proposals-repository.ts";
import { createEmbedder, embeddingDimensionOf } from "../../../embedding/factory.ts";
import type { Embedder } from "../../../embedding/types.ts";
import { EventRepository } from "../../../db/store-internal/event-repository.ts";
import { EventBus } from "../../../server-internal/event-bus.ts";
import { CleanupConfigError } from "../stage-execution.ts";
import { getStageResult, recordStageRetryable } from "../stage-results-ledger.ts";
import { collectEntityRegisterCandidates } from "./candidate-query.ts";
import { getTypeSubcategories } from "../../concept-type-vocabulary.ts";
import { ENTITY_REGISTER_LIMITS, entityRegisterTypeNames } from "./constants.ts";
import { detectEntityRegisterDryRun, entityRegisterStageRecord, runEntityRegisterCycle, type EntityRegisterCycleDeps } from "./cycle.ts";
import { judgeProfileFromLanguage } from "./judge.ts";
import { loadEntityNameIndex } from "./name-index.ts";
import { processEntityRegisterMemo } from "./process.ts";
import { entityRegisterFixedOverheadTokens, estimateEntityRegisterMemoTokens, type EntityRegisterInferFn } from "./prompt.ts";
import { EntityRegisterRecordsRepository } from "./records-repository.ts";
import type { EntityRegisterAiResult } from "./types.ts";

const MODEL = "bge-m3";
let embedder: Embedder; let db: Database; let store: SqliteMemoryStore; let eventBus: EventBus;
beforeAll(async () => { embedder = createEmbedder({ model: MODEL }); await embedder.load(); });
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  eventBus = new EventBus(new EventRepository(db));
});
afterEach(() => db.close());

/** 메모 본문 → 고정 답. 묶음에 든 메모만 답한다. */
function answering(byContent: Record<string, Omit<EntityRegisterAiResult, "nodeId">>, calls: number[][] = []): EntityRegisterInferFn {
  return async ({ memos }) => {
    calls.push(memos.map((m) => m.nodeId));
    return { kind: "ok", parsed: memos.flatMap((m) => (byContent[m.content] ? [{ nodeId: m.nodeId, ...byContent[m.content]! }] : [])) };
  };
}

function deps(infer: EntityRegisterInferFn, over: Partial<EntityRegisterCycleDeps> = {}): EntityRegisterCycleDeps {
  return { store, infer, eventBus, batchSize: 10, autoApply: true, stageVersion: 1, maxAttemptsPerTarget: 3, perCallInputCap: 30_000, runId: "run_1", ...over };
}

const WEDDING = "민수가 11월 3일 결혼한다더라";
const MONGRYONG = "엄마 아빠는 몽룡이랑 같이 지내고 계신다";

test("one cycle: clean names auto-register, a similar name becomes a proposal, the ledger records both", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const wedding = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const mongryong = await store.addNode({ content: MONGRYONG, sourceType: "auto_capture" });
  const summary = await runEntityRegisterCycle(deps(answering({
    [WEDDING]: { entities: [{ type: "person", name: "민수" }], eventDateText: "11월 3일", eventDate: "2026-11-03", scheduleTitle: "민수 결혼" },
    [MONGRYONG]: { entities: [{ type: "person", name: "몽룡" }], eventDateText: null, eventDate: null, scheduleTitle: null },
  })));
  expect(summary).toMatchObject({ candidatesFound: 2, completed: 2, autoApplied: 2, proposalsInserted: 1, failures: 0 });
  expect(getStageResult(db, "entity_register", String(wedding))!.status).toBe("completed");
  expect(getStageResult(db, "entity_register", String(mongryong))!.status).toBe("completed");
  expect((db.query("SELECT kind FROM cleanup_proposals").all() as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["entity_register"]);
}, 300_000);

test("a format error splits the batch and a memo that keeps failing becomes terminal after three attempts", async () => {
  const good = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const bad = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const calls: number[][] = [];
  const infer: EntityRegisterInferFn = async ({ memos }) => {
    calls.push(memos.map((m) => m.nodeId));
    if (memos.some((m) => m.nodeId === bad)) return { kind: "deterministic", reason: "형식 오류" };
    return { kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, entities: [{ type: "creature", name: "금목서" }], eventDateText: null, eventDate: null, scheduleTitle: null })) };
  };
  for (let i = 0; i < 3; i++) await runEntityRegisterCycle(deps(infer));
  expect(calls[0]).toEqual([good, bad]);
  expect(calls.slice(1, 3)).toEqual([[good], [bad]]);
  const last = await runEntityRegisterCycle(deps(infer));
  expect(last.candidatesFound).toBe(0);
  expect(getStageResult(db, "entity_register", String(bad))!.status).toBe("terminal_failure");
}, 300_000);

test("a batch whose answer cannot be used is resent memo by memo, and the split is counted, logged and kept in failureReasons", async () => {
  const a = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const b = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const calls: number[][] = [];
  const infer: EntityRegisterInferFn = async ({ memos }) => {
    calls.push(memos.map((m) => m.nodeId));
    if (memos.length > 1) return { kind: "deterministic", reason: "entity_register 응답 파싱 실패: 잘린 JSON" };
    return { kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null })) };
  };
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  let summary;
  try {
    summary = await runEntityRegisterCycle(deps(infer));
  } finally {
    console.warn = origWarn;
  }
  expect(calls).toEqual([[a, b], [a], [b]]);
  expect(summary).toMatchObject({ completedNoop: 2, failures: 0, batchesSplit: 1, memosResentAlone: 2 });
  expect(summary.failureReasons).toEqual([expect.stringContaining(`메모 2개(${a},${b})를 하나씩 다시 보냄 — entity_register 응답 파싱 실패: 잘린 JSON`)]);
  expect(warned).toEqual([expect.stringContaining("하나씩 다시 보냄")]);
  // 사유 개수 상한에 밀려도 남도록 run 집계 한 줄에도 수로 싣는다.
  expect(entityRegisterStageRecord(summary)).toMatchObject({ batchesSplit: 1, memosResentAlone: 2 });
}, 300_000);

test("the terminal memo's reason reaches the cycle summary and the run-level stage record", async () => {
  const bad = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const infer: EntityRegisterInferFn = async () => ({ kind: "deterministic", reason: "형식 오류" });
  await runEntityRegisterCycle(deps(infer));
  await runEntityRegisterCycle(deps(infer));
  const third = await runEntityRegisterCycle(deps(infer));
  expect(third).toMatchObject({ candidatesFound: 1, failures: 1, terminal: 1 });
  expect(third.failureReasons).toEqual([expect.stringContaining(`메모 ${bad}: 형식 오류`)]);
  expect(entityRegisterStageRecord(third)).toEqual({
    stage: "entityRegister", processed: 1, completed: 0, completedNoop: 0, failures: 1, terminal: 1,
    autoApplied: 0, proposed: 0, alreadyProcessed: 0, batchesSplit: 0, memosResentAlone: 0, failureReasons: third.failureReasons,
  });
}, 300_000);

test("a memo the response leaves out is resent alone in the same cycle", async () => {
  const first = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const second = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const calls: number[][] = [];
  const infer: EntityRegisterInferFn = async ({ memos }) => {
    calls.push(memos.map((m) => m.nodeId));
    // 묶음일 때는 첫 메모만 답하고, 하나만 보내면 답한다.
    const answered = memos.length > 1 ? memos.slice(0, 1) : memos;
    return { kind: "ok", parsed: answered.map((m) => ({ nodeId: m.nodeId, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null })) };
  };
  const summary = await runEntityRegisterCycle(deps(infer));
  expect(calls).toEqual([[first, second], [second]]);
  expect(summary).toMatchObject({ coverageMisses: 1, completedNoop: 2, failures: 0 });
  expect(getStageResult(db, "entity_register", String(second))!.status).toBe("completed_noop");
}, 300_000);

test("reprocessing after a stageVersion bump creates no duplicate schedule and keeps ignores", async () => {
  const memo = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const infer = answering({ [WEDDING]: { entities: [{ type: "person", name: "민수" }], eventDateText: "11월 3일", eventDate: "2026-11-03", scheduleTitle: "민수 결혼" } });
  await runEntityRegisterCycle(deps(infer));
  const records = new EntityRegisterRecordsRepository(db);
  records.addIgnore(memo, "entity", "민수", "reverted");
  db.run("DELETE FROM node_person_edges");
  await runEntityRegisterCycle(deps(infer, { stageVersion: 2 }));
  expect((db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content = '민수 결혼'").get() as { n: number }).n).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM node_person_edges").get() as { n: number }).n).toBe(0);
  expect(getStageResult(db, "entity_register", String(memo))!.stageVersion).toBe(2);
}, 300_000);

test("a configuration failure stops the cycle loudly; a budget stop leaves the memos for later", async () => {
  await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  await expect(runEntityRegisterCycle(deps(async () => ({ kind: "config", reason: "401 키 거부" })))).rejects.toBeInstanceOf(CleanupConfigError);
  const out = await runEntityRegisterCycle(deps(async () => ({ kind: "budget", dimension: "calls", detail: "0/0" })));
  expect(out.completed).toBe(0);
  expect(db.query("SELECT COUNT(*) AS n FROM cleanup_stage_results").get()).toEqual({ n: 0 });
}, 300_000);

test("nodeIds restricts the cycle to those memos", async () => {
  await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const target = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const calls: number[][] = [];
  await runEntityRegisterCycle(deps(answering({}, calls), { nodeIds: [target] }));
  expect(calls).toEqual([[target]]);
}, 300_000);

test("a batch size below one is refused with the setting name instead of looping", async () => {
  await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  await expect(runEntityRegisterCycle(deps(answering({}), { batchSize: 0 }))).rejects.toThrow("batchSize");
}, 300_000);

test("an auto-apply refused because the state changed is recorded as a counted failure with its reason, not skipped", async () => {
  const content = "강남목련서점에서 책을 샀다";
  const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
  const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
  // 판정이 본 색인에는 있지만 DB 에서는 사라진 항목 — 판정과 쓰기 사이에 지워진 경우와 같다.
  const index = { byType: new Map([["place", [{ typeName: "place", id: "ent_gone", name: "강남목련서점", aliases: [] }]]]) };
  const proc = {
    store, proposals: new CleanupProposalsRepository(db), records: new EntityRegisterRecordsRepository(db),
    index, allowedTypes: new Set(["place"]), profile: judgeProfileFromLanguage(),
    autoApply: true, stageVersion: 1, maxAttemptsPerTarget: 3, runId: "run_1",
  };
  const result: EntityRegisterAiResult = { nodeId, entities: [{ type: "place", name: "강남목련서점" }], eventDateText: null, eventDate: null, scheduleTitle: null };
  const out = await processEntityRegisterMemo(proc, memo!, result);
  expect(out).toMatchObject({ nodeId, autoApplied: 0, proposalId: null, ledger: "deterministic_failure" });
  expect(out.error).toContain("ent_gone");
  const row = getStageResult(db, "entity_register", String(nodeId))!;
  expect(row).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
  expect(row.lastError).toContain("ent_gone");
  expect((db.query("SELECT COUNT(*) AS n FROM cleanup_proposals").get() as { n: number }).n).toBe(0);
}, 300_000);

const none = { eventDateText: null, eventDate: null, scheduleTitle: null };

test("a duplicate answer for one memo is a format error: the batch is resent one memo at a time", async () => {
  const a = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const b = await store.addNode({ content: "보리밥 먹고 싶다", sourceType: "auto_capture" });
  const calls: number[][] = [];
  const infer: EntityRegisterInferFn = async ({ memos }) => {
    calls.push(memos.map((m) => m.nodeId));
    const answers: EntityRegisterAiResult[] = memos.map((m) => ({ nodeId: m.nodeId, entities: [], ...none }));
    // 묶음일 때는 a 의 답을 하나 더 준다(서로 다른 답) — 어느 쪽도 믿지 않아야 한다.
    if (memos.length > 1) answers.push({ nodeId: a, entities: [{ type: "creature", name: "금목서" }], ...none });
    return { kind: "ok", parsed: answers };
  };
  const summary = await runEntityRegisterCycle(deps(infer));
  expect(calls).toEqual([[a, b], [a], [b]]);
  expect(summary).toMatchObject({ completedNoop: 2, completed: 0, autoApplied: 0, failures: 0 });
}, 300_000);

test("a memo answered twice even when sent alone counts an attempt instead of being completed", async () => {
  const a = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const infer: EntityRegisterInferFn = async ({ memos }) => ({
    kind: "ok", parsed: [...memos, ...memos].map((m) => ({ nodeId: m.nodeId, entities: [], ...none })),
  });
  const summary = await runEntityRegisterCycle(deps(infer));
  expect(summary).toMatchObject({ completedNoop: 0, failures: 1 });
  const row = getStageResult(db, "entity_register", String(a))!;
  expect(row).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
  expect(row.lastError).toContain("둘 이상");
}, 300_000);

test("answers for memos that were not sent are counted, logged as a reason, and discarded", async () => {
  const a = await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
  const infer: EntityRegisterInferFn = async ({ memos }) => ({
    kind: "ok",
    parsed: [...memos.map((m) => ({ nodeId: m.nodeId, entities: [], ...none })), { nodeId: 999_999, entities: [{ type: "person", name: "민수" }], ...none }],
  });
  const summary = await runEntityRegisterCycle(deps(infer));
  expect(summary).toMatchObject({ strayAnswers: 1, completedNoop: 1, failures: 0 });
  expect(summary.failureReasons).toEqual([expect.stringContaining("999999")]);
  expect(getStageResult(db, "entity_register", String(a))!.status).toBe("completed_noop");
  expect((db.query("SELECT COUNT(*) AS n FROM persons").get() as { n: number }).n).toBe(0);
}, 300_000);

test("dry run splits like the cycle: instruction tokens per call plus memo tokens, oversized memos left out", async () => {
  for (const content of ["금목서를 키우고 있다", "보리밥 먹고 싶다", WEDDING]) await store.addNode({ content, sourceType: "auto_capture" });
  await store.addNode({ content: "아주 긴 메모 ".repeat(800), sourceType: "auto_capture" });
  const rows = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
  const memoTokens = rows.slice(0, 3).map(estimateEntityRegisterMemoTokens);
  const overhead = entityRegisterFixedOverheadTokens(entityRegisterTypeNames());
  const cap = overhead + 2 * Math.max(...memoTokens);
  expect(overhead + estimateEntityRegisterMemoTokens(rows[3]!)).toBeGreaterThan(cap);
  // batchSize 2 → [s1,s2], [s3, 긴 메모] → 긴 메모는 상한 초과로 빠지고 호출은 2번.
  const out = detectEntityRegisterDryRun({ db, stageVersion: 1, batchSize: 2, perCallInputCap: cap });
  expect(out).toEqual({ candidatesFound: 4, estimatedInputTokens: 2 * overhead + memoTokens.reduce((s, t) => s + t, 0) });
}, 300_000);

test("a name the row gate refuses is counted as skipped with its reason in the stage record", async () => {
  const folder = getTypeSubcategories("work")[0]!;
  const content = `${folder} 을 읽었다`;
  const memo = await store.addNode({ content, sourceType: "auto_capture" });
  const summary = await runEntityRegisterCycle(deps(answering({ [content]: { entities: [{ type: "work", name: folder }], ...none } })));
  expect(summary).toMatchObject({ skippedByGate: 1, autoApplied: 0, completedNoop: 1 });
  expect(summary.failureReasons).toEqual([expect.stringContaining(`메모 ${memo}: '${folder}'(work) 등록 안 함`)]);
  expect(entityRegisterStageRecord(summary).failureReasons).toEqual(summary.failureReasons);
}, 300_000);

test("a transient executor outcome leaves the memos retryable, not completed", async () => {
  const a = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const summary = await runEntityRegisterCycle(deps(async () => ({ kind: "transient", retryAfterMs: null, reason: "529 과부하" })));
  expect(summary).toMatchObject({ completed: 0, completedNoop: 0, failures: 1 });
  const row = getStageResult(db, "entity_register", String(a))!;
  expect(row.status).toBe("retryable_failure");
  expect(row.nextRetryAt).not.toBeNull();
  expect(row.lastError).toContain("529");
}, 300_000);

test("an apply error that is not a refusal leaves the memo retryable with the cause and writes nothing", async () => {
  const memo = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  db.run("CREATE TRIGGER fail_person_insert BEFORE INSERT ON persons BEGIN SELECT RAISE(ABORT, 'persons 쓰기 실패 시험'); END");
  const summary = await runEntityRegisterCycle(deps(answering({
    [WEDDING]: { entities: [{ type: "person", name: "민수" }], eventDateText: "11월 3일", eventDate: "2026-11-03", scheduleTitle: "민수 결혼" },
  })));
  expect(summary).toMatchObject({ completed: 0, failures: 1, terminal: 0, autoApplied: 0 });
  expect(summary.failureReasons).toEqual([expect.stringContaining("persons 쓰기 실패 시험")]);
  const row = getStageResult(db, "entity_register", String(memo))!;
  expect(row.status).toBe("retryable_failure");
  expect(row.lastError).toContain("persons 쓰기 실패 시험");
  expect((db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE content = '민수 결혼'").get() as { n: number }).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM cleanup_proposals").get() as { n: number }).n).toBe(0);
}, 300_000);

test("a memo with auto and proposed parts: the proposal carries the auto-applied part and the ledger completes once", async () => {
  await store.findOrCreatePersonByName("이몽룡");
  const content = "민수랑 몽룡이 같이 왔다";
  const memo = await store.addNode({ content, sourceType: "auto_capture" });
  const summary = await runEntityRegisterCycle(deps(answering({
    [content]: { entities: [{ type: "person", name: "민수" }, { type: "person", name: "몽룡" }], ...none },
  })));
  expect(summary).toMatchObject({ completed: 1, autoApplied: 1, proposalsInserted: 1, failures: 0 });
  const rows = db.query("SELECT payload_json FROM cleanup_proposals WHERE kind = 'entity_register'").all() as Array<{ payload_json: string }>;
  expect(rows).toHaveLength(1);
  const payload = JSON.parse(rows[0]!.payload_json) as { nodeId: number; items: Array<{ name: string }>; autoApplied: unknown[] };
  expect(payload.nodeId).toBe(memo);
  expect(payload.items.map((i) => i.name)).toEqual(["몽룡"]);
  expect(payload.autoApplied).toEqual([{ type: "person", name: "민수", action: "created" }]);
  expect(getStageResult(db, "entity_register", String(memo))!.status).toBe("completed");
  expect((db.query("SELECT COUNT(*) AS n FROM cleanup_stage_results").get() as { n: number }).n).toBe(1);
}, 300_000);

test("gate-refused names do not crowd a real failure reason out of the capped list", async () => {
  const picks: Array<{ type: string; name: string }> = [];
  for (const type of entityRegisterTypeNames()) {
    for (const name of getTypeSubcategories(type as Parameters<typeof getTypeSubcategories>[0])) {
      if (!picks.some((p) => p.name === name)) picks.push({ type, name });
    }
  }
  const many = picks.slice(0, ENTITY_REGISTER_LIMITS.failureReasonsKept + 2);
  expect(many.length).toBe(ENTITY_REGISTER_LIMITS.failureReasonsKept + 2);
  const crowded = many.map((p) => p.name).join(", ") + " 을 정리했다";
  await store.addNode({ content: crowded, sourceType: "auto_capture" });
  const failing = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  db.run("CREATE TRIGGER fail_person_insert BEFORE INSERT ON persons BEGIN SELECT RAISE(ABORT, 'persons 쓰기 실패 시험'); END");
  const summary = await runEntityRegisterCycle(deps(answering({
    [crowded]: { entities: many, ...none },
    [WEDDING]: { entities: [{ type: "person", name: "민수" }], ...none },
  })));
  expect(summary.skippedByGate).toBeGreaterThanOrEqual(ENTITY_REGISTER_LIMITS.failureReasonsKept);
  expect(summary.failureReasons).toHaveLength(ENTITY_REGISTER_LIMITS.failureReasonsKept);
  expect(summary.failureReasons[0]).toContain(`메모 ${failing}:`);
  expect(summary.failureReasons[0]).toContain("persons 쓰기 실패 시험");
  expect(summary.failureReasons.slice(1).every((r) => r.includes("등록 안 함"))).toBe(true);
}, 300_000);

test("a provider error carrying a key is masked before it reaches the stage record's failure reasons", async () => {
  await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const leaked = "sk-proj-LEAKEDkey123456";
  const summary = await runEntityRegisterCycle(deps(async () => ({
    kind: "transient", retryAfterMs: null, reason: `401 Incorrect API key provided: ${leaked} (Authorization: Basic dXNlcjpwYXNz)`,
  })));
  const reasons = entityRegisterStageRecord(summary).failureReasons!;
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain("401");
  expect(reasons[0]).not.toContain(leaked);
  expect(reasons[0]).not.toContain("dXNlcjpwYXNz");
}, 300_000);

function procDeps() {
  const allowed = new Set(entityRegisterTypeNames());
  return {
    store, proposals: new CleanupProposalsRepository(db), records: new EntityRegisterRecordsRepository(db),
    index: loadEntityNameIndex(db, allowed), allowedTypes: allowed, profile: judgeProfileFromLanguage(),
    autoApply: true, stageVersion: 1, maxAttemptsPerTarget: 3, runId: "run_1",
  };
}

test("an apply error repeated maxAttemptsPerTarget times for the same fingerprint becomes terminal with its cause", async () => {
  const nodeId = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
  db.run("CREATE TRIGGER fail_person_insert BEFORE INSERT ON persons BEGIN SELECT RAISE(ABORT, 'persons 쓰기 실패 시험'); END");
  const result: EntityRegisterAiResult = { nodeId, entities: [{ type: "person", name: "민수" }], ...none };
  const first = await processEntityRegisterMemo(procDeps(), memo!, result);
  expect(first.ledger).toBe("retryable");
  expect(getStageResult(db, "entity_register", String(nodeId))).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
  expect((await processEntityRegisterMemo(procDeps(), memo!, result)).ledger).toBe("retryable");
  expect(getStageResult(db, "entity_register", String(nodeId))).toMatchObject({ status: "retryable_failure", attemptCount: 2 });
  const third = await processEntityRegisterMemo(procDeps(), memo!, result);
  expect(third.ledger).toBe("terminal_failure");
  expect(third.error).toContain("persons 쓰기 실패 시험");
  const row = getStageResult(db, "entity_register", String(nodeId))!;
  expect(row.status).toBe("terminal_failure");
  expect(row.lastError).toContain("persons 쓰기 실패 시험");
  expect(row.nextRetryAt).toBeNull();
}, 300_000);

test("a provider transient failure between apply errors restarts the count, so outages never make a memo terminal", async () => {
  const nodeId = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
  db.run("CREATE TRIGGER fail_person_insert BEFORE INSERT ON persons BEGIN SELECT RAISE(ABORT, 'persons 쓰기 실패 시험'); END");
  const result: EntityRegisterAiResult = { nodeId, entities: [{ type: "person", name: "민수" }], ...none };
  await processEntityRegisterMemo(procDeps(), memo!, result);
  await processEntityRegisterMemo(procDeps(), memo!, result);
  recordStageRetryable(db, {
    stage: "entity_register", targetKey: memo!.targetKey, inputFingerprint: memo!.inputFingerprint, stageVersion: 1,
    nextRetryAt: "2000-01-01 00:00:00", lastError: "529 과부하",
  });
  expect((await processEntityRegisterMemo(procDeps(), memo!, result)).ledger).toBe("retryable");
  expect(getStageResult(db, "entity_register", String(nodeId))).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
}, 300_000);

test("a memo the pet finishes while the cycle's infer is pending keeps its completed ledger when the cycle then fails", async () => {
  const nodeId = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const finishByPet = async () => {
    const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
    const out = await processEntityRegisterMemo(procDeps(), memo!, { nodeId, entities: [], ...none });
    expect(out.ledger).toBe("completed_noop");
  };
  const transient = await runEntityRegisterCycle(deps(async () => {
    await finishByPet();
    return { kind: "transient", retryAfterMs: null, reason: "529 과부하" };
  }));
  expect(getStageResult(db, "entity_register", String(nodeId))!.status).toBe("completed_noop");
  expect(transient).toMatchObject({ candidatesFound: 1, failures: 0, alreadyProcessed: 1, failureReasons: [] });
  expect(entityRegisterStageRecord(transient)).toMatchObject({ processed: 1, failures: 0, alreadyProcessed: 1 });
}, 300_000);

test("a deterministic failure or a missing answer for a memo the pet already finished does not overwrite the ledger", async () => {
  const nodeId = await store.addNode({ content: WEDDING, sourceType: "auto_capture" });
  const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
  const finish = () => processEntityRegisterMemo(procDeps(), memo!, { nodeId, entities: [], ...none });
  const deterministic = await runEntityRegisterCycle(deps(async () => {
    await finish();
    return { kind: "deterministic", reason: "형식 오류" };
  }));
  expect(deterministic).toMatchObject({ failures: 0, alreadyProcessed: 1 });
  expect(getStageResult(db, "entity_register", String(nodeId))).toMatchObject({ status: "completed_noop", attemptCount: 0 });

  db.run("DELETE FROM cleanup_stage_results");
  const missing = await runEntityRegisterCycle(deps(async () => {
    await finish();
    return { kind: "ok", parsed: [] };
  }));
  expect(missing).toMatchObject({ failures: 0, alreadyProcessed: 1, coverageMisses: 1 });
  expect(getStageResult(db, "entity_register", String(nodeId))!.status).toBe("completed_noop");
}, 300_000);
