/**
 * run-cycle-runner.test.ts — 깊은 패스 사이클 오케스트레이션 검증 (spec 5.B-1).
 *
 * 실 :memory: SQLite(실 기준 스키마 · sqlite-vec) + 실 Bgem3Embedder + 실 EventBus 로
 * 돈다 — mock 클래스 0. 빈 DB 라 각 단계 후보가 0 이므로 실행층(LLM)은 어느 경로에서도
 * 불리지 않는다. 그 사실을 tripwire observable client(불리면 throw — 함수 sink 이지
 * 가짜 데이터 클래스가 아님)로 확증한다. dryRun 도 같은 빈 DB 에서 후보 0·추정 0 을
 * 회신하며 LLM 을 안 부른다(LLM-0 실증).
 *
 * 검증:
 *   - 실 run(ctx.runId) → run 행 running→completed, LLM 미호출
 *   - dryRun → completed + dryRunEstimate 집계(빈 DB 라 전부 0), LLM 미호출
 *   - stages 필터 → 필터 밖 단계는 사이클을 안 부른다(빈 DB 라 부작용은 없지만 dryRun
 *     집계 항목 유무로 확인)
 *   - 정기 tick(ctx 없음이 아니라 runId 만 있는 실행)도 run 행을 남긴다
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { CleanupRunsLedger } from "./cleanup-runs-ledger.ts";
import { createRunCycle, type RunCycleDeps } from "./run-cycle-runner.ts";
import type { LlmChatResult, ObservableLlmClient } from "../../llm/types.ts";
import { LlmRequestError } from "../../llm/errors.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {
  // embedder 는 프로세스 단위 — 별도 해제 없음.
});

/** 불리면 throw 하는 tripwire — 빈 DB 라 실행층이 절대 안 불려야 함을 확증한다. */
function tripwireClient(): ObservableLlmClient {
  const fail = (): never => {
    throw new Error("LLM 이 불렸다 — 빈 DB dryRun/실행 경로는 LLM 을 안 불러야 한다");
  };
  return {
    name: "tripwire",
    chat: fail,
    chatDetailed: fail,
  } as unknown as ObservableLlmClient;
}

function makeStore(): { db: Database; store: SqliteMemoryStore } {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  return { db, store };
}

function makeDeps(store: SqliteMemoryStore, ledger: CleanupRunsLedger): RunCycleDeps {
  const eventBus = new EventBus(new EventRepository(store.getRawDb()));
  return {
    store,
    embedder,
    regexL0: undefined, // regex 단계는 extractor 부재로 자연 skip.
    eventBus,
    cleanupObservable: tripwireClient(),
    ledger,
    budgetConfig: {
      maxCallsPerCycle: 10,
      maxEstimatedInputTokensPerCycle: 100000,
      maxOutputTokensPerCycle: 100000,
      maxDurationMsPerCycle: 600000,
      maxEstimatedInputTokensPerCall: 8000,
      stageAllocation: {
        regexStrengthen: 0.2,
        summary: 0.2,
        personLink: 0.2,
        lensDraft: 0.2,
        entityRegister: 0.2,
      },
    },
    reliability: {
      circuitBreakerThreshold: 5,
      retryMaxPerCall: 2,
      retryBaseDelayMs: 2000,
      maxAttemptsPerTarget: 3,
      staleRunReclaimMs: 3600000,
    },
    regexStage: { batchSize: 20, overmatchThreshold: 0.3, overmatchSampleSize: 100 },
    summaryStage: {
      atomicThreshold: 3,
      batchSize: 20,
      relationConfidenceThreshold: 0.7,
      firstParagraphMaxChars: 300,
    },
    personLinkStage: { batchSize: 50, autoApply: true },
    lensDraftStage: { batchSize: 20 },
    entityRegisterStage: { batchSize: 10, autoApply: true },
    relationAutoApply: true,
    // regexL0 부재라 regex 단계는 실질 OFF, summary·personLink·lensDraft 는 ON(빈 DB 라 후보 0).
    regexStageOn: false,
    summaryStageOn: true,
    personLinkStageOn: true,
    lensDraftStageOn: true,
    entityRegisterStageOn: true,
  };
}

/** 정리 AI 자리에 고정 답을 돌려주는 연결(함수 묶음 — prompt.test.ts 와 같은 관례). */
function fixedAnswerClient(text: (userContent: string) => string, calls: string[]): ObservableLlmClient {
  return {
    name: "fixture",
    chat: async () => "unused",
    chatDetailed: async (messages): Promise<LlmChatResult> => {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      calls.push(user);
      return {
        text: text(user),
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  } as ObservableLlmClient;
}

describe("createRunCycle — 실 실행 (빈 DB · LLM 미호출)", () => {
  test("실 run(ctx.runId) → running→completed, LLM 안 불림", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const runCycle = createRunCycle(makeDeps(store, ledger));

    const { runId } = ledger.startRun({ trigger: "manual", options: {} });
    expect(ledger.statusOf(runId)).toBe("running");
    // tripwire client 가 안 throw = LLM 미호출(빈 DB 후보 0).
    await runCycle({ runId });
    expect(ledger.statusOf(runId)).toBe("completed");
    const row = ledger.getRun(runId);
    expect(row?.aggregates).not.toBeNull();
    db.close();
  });

  test("dryRun → completed + dryRunEstimate 집계(빈 DB 후보 0), LLM 안 불림", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const runCycle = createRunCycle(makeDeps(store, ledger));

    const { runId } = ledger.startRun({ trigger: "manual", options: { dryRun: true } });
    await runCycle({ runId, dryRun: true });
    const row = ledger.getRun(runId);
    expect(row?.status).toBe("completed");
    // 켜진 단계(summary·entityRegister·personLink·lensDraft)마다 dryRunEstimate 항목이 잡히고, 빈 DB 라 후보 0.
    const stages = row?.aggregates?.stageAggregates ?? [];
    const stageNames = stages.map((s) => s.stage).sort();
    expect(stageNames).toEqual(["entityRegister", "lensDraft", "personLink", "summary"]);
    for (const s of stages) {
      expect(s.processed).toBe(0);
      expect(s.estimatedInputTokens).toBe(0);
    }
    db.close();
  });

  test("stages 필터 → 필터 밖 단계는 dryRun 집계에서 빠진다", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const runCycle = createRunCycle(makeDeps(store, ledger));

    const { runId } = ledger.startRun({
      trigger: "manual",
      options: { dryRun: true, stages: ["summary"] },
    });
    await runCycle({ runId, dryRun: true, stages: ["summary"] });
    const stages = ledger.getRun(runId)?.aggregates?.stageAggregates ?? [];
    expect(stages.map((s) => s.stage)).toEqual(["summary"]);
    db.close();
  });

  test("사이클 시작이 죽은 run 을 회수한다 — 이번 run 자신은 안 건드림", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const runCycle = createRunCycle(makeDeps(store, ledger));

    // 이전 프로세스가 사이클 도중 죽어 running 으로 굳은 행(1시간 문턱 훨씬 초과).
    db.prepare(
      `INSERT INTO cleanup_runs (run_id, trigger, status, started_at, options_json, idempotency_key)
       VALUES ('dead_run', 'scheduled', 'running', '2020-01-01 00:00:00', '{}', NULL)`,
    ).run();

    const { runId } = ledger.startRun({ trigger: "manual", options: {} });
    await runCycle({ runId });

    // 죽은 행은 failed 로 회수되고, 이번 run 은 정상 completed 로 끝난다.
    expect(ledger.statusOf("dead_run")).toBe("failed");
    expect(ledger.statusOf(runId)).toBe("completed");
    db.close();
  });

  test("dryRun 경로도 죽은 run 을 회수한다(LLM 0 유지)", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const runCycle = createRunCycle(makeDeps(store, ledger));
    db.prepare(
      `INSERT INTO cleanup_runs (run_id, trigger, status, started_at, options_json, idempotency_key)
       VALUES ('dead_run', 'scheduled', 'running', '2020-01-01 00:00:00', '{}', NULL)`,
    ).run();

    const { runId } = ledger.startRun({ trigger: "manual", options: { dryRun: true } });
    // tripwire client 가 안 throw = 회수 경로가 LLM 을 안 부른다.
    await runCycle({ runId, dryRun: true });

    expect(ledger.statusOf("dead_run")).toBe("failed");
    expect(ledger.statusOf(runId)).toBe("completed");
    db.close();
  });

  test("정기 tick 도 runId 를 받으면 run 행을 completed 로 남긴다", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const runCycle = createRunCycle(makeDeps(store, ledger));

    const { runId } = ledger.startRun({ trigger: "scheduled", options: {} });
    await runCycle({ runId });
    const row = ledger.getRun(runId);
    expect(row?.trigger).toBe("scheduled");
    expect(row?.status).toBe("completed");
    db.close();
  });

  test("stages:[entityRegister] dryRun → 그 단계 하나만 후보·추정을 세고 LLM 은 안 부른다", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    await store.addNode({ content: "민수가 11월 3일 결혼한다더라", sourceType: "auto_capture" });
    const runCycle = createRunCycle(makeDeps(store, ledger));

    const { runId } = ledger.startRun({ trigger: "manual", options: { dryRun: true, stages: ["entityRegister"] } });
    await runCycle({ runId, dryRun: true, stages: ["entityRegister"] });
    const stages = ledger.getRun(runId)?.aggregates?.stageAggregates ?? [];
    expect(stages).toHaveLength(1);
    expect(stages[0]!.stage).toBe("entityRegister");
    expect(stages[0]!.processed).toBe(1);
    expect(stages[0]!.estimatedInputTokens).toBeGreaterThan(0);
    db.close();
  });

  test("stages:[entityRegister] 실 실행 → 후보를 실제로 처리하고 자동·제안·실패를 run 집계에 남긴다", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    const memo = await store.addNode({ content: "민수가 11월 3일 결혼한다더라", sourceType: "auto_capture" });
    const calls: string[] = [];
    const deps = makeDeps(store, ledger);
    deps.cleanupObservable = fixedAnswerClient(
      () => JSON.stringify([{ nodeId: memo, entities: [{ type: "person", name: "민수" }], eventDateText: null, eventDate: null, scheduleTitle: null }]),
      calls,
    );
    const runCycle = createRunCycle(deps);

    const { runId } = ledger.startRun({ trigger: "manual", options: { stages: ["entityRegister"] } });
    await runCycle({ runId, stages: ["entityRegister"] });
    const row = ledger.getRun(runId);
    expect(row?.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(row?.aggregates?.totalCalls).toBe(1);
    expect(row?.aggregates?.stageAggregates).toEqual([
      {
        stage: "entityRegister",
        processed: 1,
        completed: 1,
        completedNoop: 0,
        failures: 0,
        terminal: 0,
        estimatedInputTokens: 0,
        alreadyProcessed: 0,
        batchesSplit: 0,
        memosResentAlone: 0,
        autoApplied: 1,
        proposed: 0,
        failureReasons: [],
      },
    ]);
    expect((db.query("SELECT COUNT(*) AS n FROM persons WHERE display_name = '민수'").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("ctx.nodeIds → 그 메모만 정리하고 다른 후보는 남긴다", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    await store.addNode({ content: "금목서를 키우고 있다", sourceType: "auto_capture" });
    const target = await store.addNode({ content: "민수가 왔다", sourceType: "auto_capture" });
    const calls: string[] = [];
    const deps = makeDeps(store, ledger);
    deps.cleanupObservable = fixedAnswerClient(
      () => JSON.stringify([{ nodeId: target, entities: [{ type: "person", name: "민수" }], eventDateText: null, eventDate: null, scheduleTitle: null }]),
      calls,
    );
    const runCycle = createRunCycle(deps);

    const { runId } = ledger.startRun({ trigger: "manual", options: { stages: ["entityRegister"] } });
    await runCycle({ runId, stages: ["entityRegister"], nodeIds: [target] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("민수가 왔다");
    expect(calls[0]).not.toContain("금목서");
    expect(ledger.getRun(runId)?.aggregates?.stageAggregates[0]?.processed).toBe(1);
    db.close();
  });

  test("멈춘 원인에 실린 키·토큰은 가려서 남기고 상태 코드·단계 이름은 남긴다", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    await store.addNode({ content: "민수가 왔다", sourceType: "auto_capture" });
    const deps = makeDeps(store, ledger);
    const body =
      "Incorrect API key provided: sk-proj-abc...wxyz. Authorization: Bearer abc.def.ghi x-api-key: sk-ant-xxxx";
    deps.cleanupObservable = {
      name: "fixture",
      chat: async () => "unused",
      chatDetailed: async () => {
        throw new LlmRequestError({ provider: "openai_compatible", message: `HTTP 401: ${body}`, status: 401, code: "invalid_api_key", retryAfterMs: null, timedOut: false });
      },
    } as ObservableLlmClient;
    const runCycle = createRunCycle(deps);

    const { runId } = ledger.startRun({ trigger: "manual", options: { stages: ["entityRegister"] } });
    await runCycle({ runId, stages: ["entityRegister"] });
    const reason = ledger.getRun(runId)?.aggregates?.stopReason ?? "";
    expect(reason).toContain("entityRegister 단계에서 설정 결함으로 중단");
    expect(reason).toContain("401");
    for (const secret of ["sk-proj-abc", "wxyz", "abc.def.ghi", "sk-ant-xxxx"]) expect(reason).not.toContain(secret);
    expect(reason).toContain("[가림]");
    db.close();
  });

  test("entityRegister 설정 결함(401) → 사이클 전체가 멈추고 run 은 failed", async () => {
    const { db, store } = makeStore();
    const ledger = new CleanupRunsLedger(db);
    await store.addNode({ content: "민수가 왔다", sourceType: "auto_capture" });
    const deps = makeDeps(store, ledger);
    deps.cleanupObservable = {
      name: "fixture",
      chat: async () => "unused",
      chatDetailed: async () => {
        throw new LlmRequestError({ provider: "anthropic", message: "401 invalid x-api-key", status: 401, code: "authentication_error", retryAfterMs: null, timedOut: false });
      },
    } as ObservableLlmClient;
    const runCycle = createRunCycle(deps);

    const stages = ["entityRegister", "personLink", "lensDraft"];
    const { runId } = ledger.startRun({ trigger: "manual", options: { stages: ["entityRegister", "personLink", "lensDraft"] } });
    // entityRegister 가 401 로 사이클을 멈추면 뒤 단계(personLink·lensDraft)는 돌지 않는다.
    await runCycle({ runId, stages });
    const row = ledger.getRun(runId);
    expect(row?.status).toBe("failed");
    // 원인이 서버 로그만이 아니라 run 기록(GET /api/cleanup-runs/:id 가 돌려주는 행)에 남는다.
    expect(row?.aggregates?.stopReason).toContain("entityRegister 단계에서 설정 결함으로 중단");
    expect(row?.aggregates?.stopReason).toContain("401");
    const names = (row?.aggregates?.stageAggregates ?? []).map((s) => s.stage);
    expect(names).not.toContain("personLink");
    expect(names).not.toContain("lensDraft");
    db.close();
  });
});
