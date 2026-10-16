/**
 * entity-register/process-memo-date.test.ts — 메모 날짜 채우기: 사이클·메모 처리·제안 승인·거절·펫 제출
 * (2026-10-16 yearless-date-cleanup spec 3.5~3.7, 10장 T6). 실제 SQLite + 실제 bge-m3.
 * LLM 자리에는 고정 답을 돌려주는 함수·순수 데이터 답을 넣는다(클래스 가짜 구현 없음).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../db/migrations.ts";
import { SqliteMemoryStore } from "../../../db/store.ts";
import { CleanupProposalsRepository } from "../../../db/store-internal/cleanup-proposals-repository.ts";
import { EventRepository } from "../../../db/store-internal/event-repository.ts";
import { createEmbedder, embeddingDimensionOf } from "../../../embedding/factory.ts";
import type { Embedder } from "../../../embedding/types.ts";
import { EventBus } from "../../../server-internal/event-bus.ts";
import { buildDateOccurrences } from "../../date-occurrences.ts";
import { getStageResult } from "../stage-results-ledger.ts";
import { collectEntityRegisterCandidates } from "./candidate-query.ts";
import { entityRegisterTypeNames } from "./constants.ts";
import { runEntityRegisterCycle, type EntityRegisterCycleDeps } from "./cycle.ts";
import { judgeProfileFromLanguage } from "./judge.ts";
import { loadEntityNameIndex } from "./name-index.ts";
import { processEntityRegisterMemo } from "./process.ts";
import type { EntityRegisterInferFn } from "./prompt.ts";
import {
  approveEntityRegisterProposal, EntityRegisterChoiceError, listEntityRegisterItems, parseEntityRegisterChoices,
  rejectEntityRegisterProposal, validateEntityRegisterPayload, type EntityRegisterProposalPayload,
} from "./proposal.ts";
import { EntityRegisterRecordsRepository } from "./records-repository.ts";
import type { EntityRegisterAiResult } from "./types.ts";

const MODEL = "bge-m3";
let embedder: Embedder; let db: Database; let store: SqliteMemoryStore; let eventBus: EventBus;
let proposals: CleanupProposalsRepository; let records: EntityRegisterRecordsRepository;
beforeAll(async () => { embedder = createEmbedder({ model: MODEL }); await embedder.load(); });
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embeddingDimensionOf(MODEL) });
  store = new SqliteMemoryStore(db, embedder);
  eventBus = new EventBus(new EventRepository(db));
  proposals = new CleanupProposalsRepository(db);
  records = new EntityRegisterRecordsRepository(db);
});
afterEach(() => db.close());

const DEADLINE = "1월 5일까지 제출";
const ANSWER: Omit<EntityRegisterAiResult, "nodeId"> = { entities: [], eventDateText: "1월 5일", eventDate: "2027-01-05", scheduleTitle: null };

function answering(answer: Omit<EntityRegisterAiResult, "nodeId">): EntityRegisterInferFn {
  return async ({ memos }) => ({ kind: "ok", parsed: memos.map((m) => ({ nodeId: m.nodeId, ...answer })) });
}

function cycleDeps(infer: EntityRegisterInferFn, over: Partial<EntityRegisterCycleDeps> = {}): EntityRegisterCycleDeps {
  return { store, infer, eventBus, batchSize: 10, autoApply: true, stageVersion: 1, maxAttemptsPerTarget: 3, perCallInputCap: 30_000, runId: "run_1", ...over };
}

function procDeps(autoApply = true) {
  const allowed = new Set(entityRegisterTypeNames());
  return {
    store, proposals, records, index: loadEntityNameIndex(db, allowed), allowedTypes: allowed, profile: judgeProfileFromLanguage(),
    autoApply, stageVersion: 1, maxAttemptsPerTarget: 3, runId: "run_1",
  };
}

function eventAtOf(nodeId: number): { eventAt: string | null; source: unknown } {
  const row = db.query("SELECT event_at, metadata_json FROM knowledge_nodes WHERE id = ?").get(nodeId) as { event_at: string | null; metadata_json: string | null };
  return { eventAt: row.event_at, source: row.metadata_json ? JSON.parse(row.metadata_json).fieldSources?.event_at : undefined };
}

/** autoApply 를 끈 처리로 메모 날짜 제안 하나를 만든다. */
async function memoDateProposal(content = DEADLINE, answer = ANSWER) {
  const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
  const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10, nodeIds: [nodeId] });
  const out = await processEntityRegisterMemo(procDeps(false), memo!, { nodeId, ...answer });
  const proposal = proposals.findById(out.proposalId!)!;
  return { nodeId, proposal, payload: proposal.payload as unknown as EntityRegisterProposalPayload };
}

describe("자동 채움", () => {
  test("사이클이 연도 없는 날짜 메모를 AI 날짜로 채우고 기록 한 줄을 남긴다", async () => {
    const nodeId = await store.addNode({ content: DEADLINE, sourceType: "auto_capture" });
    const summary = await runEntityRegisterCycle(cycleDeps(answering(ANSWER)));
    // 일정 제목이 없는 답이라 일정은 제목을 적어 승인하는 제안(title_invalid)으로 간다 — 메모 날짜는 그와 따로 자동.
    expect(summary).toMatchObject({ completed: 1, autoApplied: 1, proposalsInserted: 1, failures: 0 });
    expect(eventAtOf(nodeId)).toEqual({ eventAt: "2027-01-05", source: "inferred" });
    const recs = records.listActiveForMemo(nodeId);
    expect(recs.map((r) => [r.itemKind, r.targetType, r.targetId, r.name, r.decidedBy, r.detail.date]))
      .toEqual([["memo_date_filled", "memo", String(nodeId), "1월 5일", "auto", "2027-01-05"]]);
    expect(getStageResult(db, "entity_register", String(nodeId))!.status).toBe("completed");
  }, 300_000);

  test("일정 자동 + 메모 날짜 자동: 기록 두 줄, 달력에는 일정 제목만 뜬다", async () => {
    const nodeId = await store.addNode({ content: DEADLINE, sourceType: "auto_capture" });
    await runEntityRegisterCycle(cycleDeps(answering({ ...ANSWER, scheduleTitle: "서류 제출" })));
    expect(records.listActiveForMemo(nodeId).map((r) => r.itemKind).sort()).toEqual(["memo_date_filled", "schedule_created"]);
    const calendar = await buildDateOccurrences(store, { now: new Date(2027, 0, 1), days: 30, kinds: new Set(["event"]) });
    const onDay = calendar.upcoming.filter((o) => o.date === "2027-01-05");
    expect(onDay.map((o) => o.title)).toEqual(["서류 제출"]);
    expect(onDay.some((o) => o.source.id === nodeId)).toBe(false);
  }, 300_000);

  test("같은 지문으로 두 번 처리하면 두 번째는 already_processed, 기록은 한 줄", async () => {
    const nodeId = await store.addNode({ content: DEADLINE, sourceType: "auto_capture" });
    const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
    expect((await processEntityRegisterMemo(procDeps(), memo!, { nodeId, ...ANSWER })).ledger).toBe("completed");
    expect((await processEntityRegisterMemo(procDeps(), memo!, { nodeId, ...ANSWER })).ledger).toBe("already_processed");
    expect(records.listActiveForMemo(nodeId)).toHaveLength(1);
  }, 300_000);

  test("자동 반영 참고 줄에 memo_date 가 실린다(같은 메모의 다른 항목이 제안으로 갈 때)", async () => {
    await store.findOrCreatePersonByName("이몽룡");
    const content = "몽룡이가 1월 5일까지 제출하래";
    const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
    const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
    const out = await processEntityRegisterMemo(procDeps(), memo!, { nodeId, ...ANSWER, entities: [{ type: "person", name: "몽룡" }] });
    expect(out.autoApplied).toBe(1);
    const payload = proposals.findById(out.proposalId!)!.payload as unknown as EntityRegisterProposalPayload;
    expect(payload.autoApplied).toEqual([{ type: "memo_date", name: "2027-01-05", action: "memo_date" }]);
    expect(payload.memoDate).toBeNull();
  }, 300_000);
});

describe("판정과 쓰기 사이에 다른 값이 들어옴", () => {
  test("원장은 completed(실패 아님), 메모 날짜는 그 값 그대로, 사유는 사이클 결과에 따로 센다", async () => {
    const content = "민수가 1월 5일까지 제출하래";
    const nodeId = await store.addNode({ content, sourceType: "auto_capture" });
    // 다른 쓰기 경로(의미 추출의 setEventAt — 기억 쓰기 잠금을 잡지 않음)를 실제 SQLite 트리거로 재현한다:
    // 같은 반영 트랜잭션에서 사람 행이 들어가는 순간(판정 뒤, 메모 날짜 쓰기 전) 메모 날짜가 system 으로 채워진다.
    db.run(
      `CREATE TEMP TRIGGER slip_memo_date AFTER INSERT ON persons BEGIN
         UPDATE knowledge_nodes SET event_at = '2026-01-05',
           metadata_json = json_set(COALESCE(NULLIF(metadata_json, ''), '{}'), '$.fieldSources.event_at', 'system')
         WHERE id = ${nodeId};
       END`,
    );
    const summary = await runEntityRegisterCycle(cycleDeps(answering({ ...ANSWER, entities: [{ type: "person", name: "민수" }] })));
    expect(summary).toMatchObject({ completed: 1, failures: 0, autoApplied: 1, memoDateSkipped: 1, skippedByGate: 0 });
    expect(summary.failureReasons).toEqual([`메모 ${nodeId}: 메모 날짜 '1월 5일' 채우지 않음 — 메모 날짜가 그 사이 채워짐(출처 system)`]);
    expect(getStageResult(db, "entity_register", String(nodeId))!.status).toBe("completed");
    expect(eventAtOf(nodeId)).toEqual({ eventAt: "2026-01-05", source: "system" });
    expect(records.listActiveForMemo(nodeId).map((r) => r.itemKind)).toEqual(["entity_created"]);
  }, 300_000);
});

describe("제안", () => {
  test("자동 반영이 꺼져 있으면 memoDate 제안이 만들어지고 형식 검사를 통과한다", async () => {
    const { payload } = await memoDateProposal();
    expect(payload.memoDate).toEqual({ itemKey: "memo_date", reason: "auto_apply_off", date: "2027-01-05", dateText: "1월 5일" });
    expect(validateEntityRegisterPayload(payload as unknown as Record<string, unknown>)).toEqual({ ok: true });
    // 일정 제목이 없는 답이라 일정 항목(자동 반영 꺼짐보다 제목 없음이 먼저)도 함께 실린다.
    expect(listEntityRegisterItems(payload as unknown as Record<string, unknown>).map((i) => [i.itemKey, i.group]))
      .toEqual([["schedule", "schedule"], ["memo_date", "memo_date"]]);
  }, 300_000);

  test("날짜를 고쳐 승인하면 그 날짜로 채우고 approved 기록·journal applied", async () => {
    const { nodeId, proposal, payload } = await memoDateProposal();
    const choices = parseEntityRegisterChoices({ choices: { memo_date: { accept: true, date: "2027-01-07" } } }, payload);
    const result = await approveEntityRegisterProposal({ store, proposals, records, proposal, choices });
    expect(result.status).toBe("partially_applied");
    expect(eventAtOf(nodeId)).toEqual({ eventAt: "2027-01-07", source: "inferred" });
    expect(records.listActiveForMemo(nodeId).map((r) => [r.itemKind, r.decidedBy, r.detail.date])).toEqual([["memo_date_filled", "approved", "2027-01-07"]]);
    expect(proposals.listJournal(proposal.id).map((e) => [e.itemKey, e.status]).sort())
      .toEqual([["memo_date", "applied"], ["schedule", "skipped"]]);
  }, 300_000);

  test("승인 전에 메모 날짜가 채워졌으면 그 항목만 failed", async () => {
    const { nodeId, proposal, payload } = await memoDateProposal();
    await store.setEventAt(nodeId, "2026-01-05", "direct");
    const choices = parseEntityRegisterChoices({ choices: { memo_date: { accept: true, date: "2027-01-05" } } }, payload);
    const result = await approveEntityRegisterProposal({ store, proposals, records, proposal, choices });
    expect(result.items.find((i) => i.itemKey === "memo_date"))
      .toEqual({ itemKey: "memo_date", status: "failed", detail: "메모 날짜가 이미 채워져 있음 — 제안이 오래됨" });
    expect(eventAtOf(nodeId)).toEqual({ eventAt: "2026-01-05", source: "direct" });
    expect(records.listActiveForMemo(nodeId)).toEqual([]);
  }, 300_000);

  test("accept:false 는 메모 날짜 무시 기록을 남기고, 다시 판정하면 ignored", async () => {
    const { nodeId, proposal, payload } = await memoDateProposal();
    const choices = parseEntityRegisterChoices({ choices: { memo_date: { accept: false } } }, payload);
    const result = await approveEntityRegisterProposal({ store, proposals, records, proposal, choices });
    expect(result.items.find((i) => i.itemKey === "memo_date")).toEqual({ itemKey: "memo_date", status: "applied", detail: "무시로 기록" });
    expect(records.isMemoDateIgnored(nodeId)).toBe(true);
    db.run("DELETE FROM cleanup_stage_results");
    const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
    const out = await processEntityRegisterMemo(procDeps(), memo!, { nodeId, ...ANSWER });
    expect(out.autoApplied).toBe(0);
    // 다시 만든 제안에는 (고르지 않은) 일정만 남고 메모 날짜는 없다 — 판정이 ignored 라서.
    const again = proposals.findById(out.proposalId!)!.payload as unknown as EntityRegisterProposalPayload;
    expect(again.memoDate).toBeNull();
    expect(eventAtOf(nodeId).eventAt).toBeNull();
  }, 300_000);

  test("제안 거절은 메모 날짜 무시 기록도 남긴다", async () => {
    const { nodeId, proposal } = await memoDateProposal();
    await rejectEntityRegisterProposal({ store, proposals, records, proposal });
    expect(records.isMemoDateIgnored(nodeId)).toBe(true);
    expect(proposals.findById(proposal.id)!.status).toBe("rejected");
  }, 300_000);

  test("실제 날짜가 아닌 선택 날짜는 EntityRegisterChoiceError", async () => {
    const { payload } = await memoDateProposal();
    expect(() => parseEntityRegisterChoices({ choices: { memo_date: { accept: true, date: "2027-13-01" } } }, payload)).toThrow(EntityRegisterChoiceError);
    expect(() => parseEntityRegisterChoices({ choices: { memo_date: { accept: true } } }, payload)).toThrow(EntityRegisterChoiceError);
  }, 300_000);
});

describe("옛 제안·형식 검사(순수)", () => {
  const base = {
    nodeId: 3, inputFingerprint: "a".repeat(64), stageVersion: 1, runId: null, items: [], autoApplied: [],
    schedule: { itemKey: "schedule", reason: "relative", title: "t", date: null, dateText: "다음 주", existingScheduleNodeId: null },
  };

  test("memoDate 칸이 없는 옛 payload 는 통과하고 메모 날짜 항목이 없다", () => {
    expect(validateEntityRegisterPayload(base)).toEqual({ ok: true });
    expect(listEntityRegisterItems(base).map((i) => i.group)).toEqual(["schedule"]);
    expect(() => parseEntityRegisterChoices({ choices: { memo_date: { accept: false } } }, base as unknown as EntityRegisterProposalPayload))
      .toThrow("이 제안에 없는 항목");
  });

  test("memoDate 칸이 있는데 모양이 틀리면 400 메시지", () => {
    expect(validateEntityRegisterPayload({ ...base, memoDate: { itemKey: "x" } })).toEqual({ ok: false, message: expect.stringContaining("memoDate") });
    expect(validateEntityRegisterPayload({ ...base, memoDate: { itemKey: "memo_date", reason: "bogus", date: null, dateText: "1월 5일" } }))
      .toEqual({ ok: false, message: expect.stringContaining("memoDate") });
    expect(validateEntityRegisterPayload({ ...base, memoDate: null })).toEqual({ ok: true });
  });
});
