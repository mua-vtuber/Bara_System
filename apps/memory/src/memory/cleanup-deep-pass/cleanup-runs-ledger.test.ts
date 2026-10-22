/**
 * cleanup-runs-ledger.test.ts — 실행 단위 원장 CRUD 검증 (spec 5.B-1).
 *
 * 실 SQLite(:memory:) + 실 migrations 로 검증한다 — mock 클래스 0. startRun 의
 * idempotency 재사용(같은 키 = 같은 runId), finishRun 상태 전이 + 집계 저장,
 * getRun 파싱, statusOf 취소 판정 자료를 본다.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { runMigrations } from "../../db/migrations.ts";
import {
  CleanupRunsLedger,
  STALE_RUN_STOP_REASON,
  type CleanupRunAggregates,
} from "./cleanup-runs-ledger.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);
  return db;
}

/** 결정적 runId 생성기 — 호출마다 순번 id. */
function seqIdGen(): () => string {
  let n = 0;
  return () => `run_${++n}`;
}

const SAMPLE_AGGREGATES: CleanupRunAggregates = {
  stageAggregates: [
    {
      stage: "regexStrengthen",
      processed: 3,
      completed: 2,
      completedNoop: 1,
      failures: 0,
      terminal: 0,
      estimatedInputTokens: 120,
    },
  ],
  totalCalls: 2,
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  missingUsageCalls: 0,
  reachedDimensions: [],
  durationMs: 500,
};

test("startRun 이 running 행을 만들고 created=true 를 회신한다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const res = ledger.startRun({
    trigger: "manual",
    options: { dryRun: false },
    idGen: seqIdGen(),
  });
  expect(res).toEqual({ runId: "run_1", created: true });
  const row = ledger.getRun("run_1");
  expect(row?.status).toBe("running");
  expect(row?.trigger).toBe("manual");
  expect(row?.options).toEqual({ dryRun: false });
  expect(row?.aggregates).toBeNull();
  expect(row?.finishedAt).toBeNull();
  db.close();
});

test("같은 idempotencyKey 재요청 = 같은 runId (created=false), 새 행 안 만듦", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  const first = ledger.startRun({
    trigger: "manual",
    options: { dryRun: true },
    idempotencyKey: "key-A",
    idGen,
  });
  const second = ledger.startRun({
    trigger: "manual",
    options: { dryRun: true },
    idempotencyKey: "key-A",
    idGen,
  });
  expect(first).toEqual({ runId: "run_1", created: true });
  expect(second).toEqual({ runId: "run_1", created: false });
  const count = db
    .query("SELECT COUNT(*) AS n FROM cleanup_runs")
    .get() as { n: number };
  expect(count.n).toBe(1);
  db.close();
});

test("idempotencyKey 없는 run 은 매번 새 runId", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  const a = ledger.startRun({ trigger: "scheduled", options: {}, idGen });
  const b = ledger.startRun({ trigger: "scheduled", options: {}, idGen });
  expect(a.runId).toBe("run_1");
  expect(b.runId).toBe("run_2");
  db.close();
});

test("finishRun 이 status·finished_at·집계를 확정한다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  ledger.startRun({ trigger: "manual", options: {}, idGen });
  ledger.finishRun({
    runId: "run_1",
    status: "completed",
    aggregates: SAMPLE_AGGREGATES,
  });
  const row = ledger.getRun("run_1");
  expect(row?.status).toBe("completed");
  expect(row?.finishedAt).not.toBeNull();
  expect(row?.aggregates).toEqual(SAMPLE_AGGREGATES);
  db.close();
});

test("취소는 실패가 아니다 — status=cancelled 로 확정, 집계 보존", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  ledger.startRun({ trigger: "manual", options: {}, idGen });
  ledger.finishRun({
    runId: "run_1",
    status: "cancelled",
    aggregates: { ...SAMPLE_AGGREGATES, durationMs: 200 },
  });
  const row = ledger.getRun("run_1");
  expect(row?.status).toBe("cancelled");
  expect(row?.aggregates?.durationMs).toBe(200);
  db.close();
});

test("getRun 없는 id = null", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  expect(ledger.getRun("nope")).toBeNull();
  db.close();
});

test("statusOf 가 취소 판정 자료를 준다(running → completed 전이 확인)", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  ledger.startRun({ trigger: "manual", options: {}, idGen });
  expect(ledger.statusOf("run_1")).toBe("running");
  ledger.finishRun({
    runId: "run_1",
    status: "completed",
    aggregates: SAMPLE_AGGREGATES,
  });
  expect(ledger.statusOf("run_1")).toBe("completed");
  expect(ledger.statusOf("nope")).toBeNull();
  db.close();
});

// ── 죽은 run 나이 기반 회수 (spec 5-3 잔여 D-D) ────────────────────────────
// 프로세스가 사이클 중 죽으면 finishRun 이 안 불려 행이 'running' 으로 굳는다.
// 회수가 없으면 그 행이 쥔 idempotency 키(UNIQUE)가 영구 봉쇄돼 같은 키의 재요청이
// 영원히 죽은 runId 만 돌려받는다(사이클 트리거 없음). 아래가 그 봉쇄와 해제를 실증한다.

/** 죽은 프로세스가 남긴 running 행을 주입한다(startRun 후 강제로 started_at 을 늙힘). */
function injectStaleRun(
  db: Database,
  runId: string,
  startedAt: string,
  idempotencyKey: string | null = null,
): void {
  db.prepare(
    `INSERT INTO cleanup_runs (run_id, trigger, status, started_at, options_json, idempotency_key)
     VALUES (?, 'scheduled', 'running', ?, '{}', ?)`,
  ).run(runId, startedAt, idempotencyKey);
}

test("reclaimStaleRuns — 나이 문턱 넘긴 running 행을 failed 로 회수한다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  injectStaleRun(db, "dead_run", "2020-01-01 00:00:00");

  const reclaimed = ledger.reclaimStaleRuns(60 * 60 * 1000);

  expect(reclaimed).toEqual(["dead_run"]);
  const row = ledger.getRun("dead_run");
  // 회수 상태는 failed — completed 로 위장하면 하지 않은 처리를 한 것처럼 남고,
  // cancelled 는 사용자 취소를 뜻하므로 둘 다 거짓이 된다.
  expect(row?.status).toBe("failed");
  expect(row?.finishedAt).not.toBeNull();
  // 회수한 run 에도 원인이 남는다(서버 로그 없이 GET 으로 본다).
  expect(row?.aggregates?.stopReason).toBe(STALE_RUN_STOP_REASON);
  db.close();
});

test("reclaimStaleRuns — 문턱 안쪽의 정상 진행 run 은 건드리지 않는다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  // 방금 시작한 run(나이 0) — 진행 중인 정상 사이클을 회수가 죽이면 안 된다.
  const { runId } = ledger.startRun({
    trigger: "manual",
    options: {},
    idGen: seqIdGen(),
  });

  const reclaimed = ledger.reclaimStaleRuns(60 * 60 * 1000);

  expect(reclaimed).toEqual([]);
  expect(ledger.statusOf(runId)).toBe("running");
  db.close();
});

test("reclaimStaleRuns — 이미 종료된 행은 회수 대상이 아니다(상태 안 덮음)", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  ledger.startRun({ trigger: "manual", options: {}, idGen });
  ledger.finishRun({
    runId: "run_1",
    status: "completed",
    aggregates: SAMPLE_AGGREGATES,
  });
  // 완료 행을 아주 옛날로 늙혀도 status 가 running 이 아니므로 대상 밖이다.
  db.prepare("UPDATE cleanup_runs SET started_at = '2020-01-01 00:00:00' WHERE run_id = ?").run(
    "run_1",
  );

  expect(ledger.reclaimStaleRuns(60 * 60 * 1000)).toEqual([]);
  // 완료 집계가 회수에 덮이지 않는다.
  const row = ledger.getRun("run_1");
  expect(row?.status).toBe("completed");
  expect(row?.aggregates).toEqual(SAMPLE_AGGREGATES);
  db.close();
});

test("죽은 run 이 봉쇄한 idempotency 키가 회수 후 다시 트리거 가능해진다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  // 정기 회차가 고정 키로 돌던 중 프로세스가 죽었다.
  injectStaleRun(db, "dead_run", "2020-01-01 00:00:00", "nightly-key");

  // 회수 전: 같은 키 재요청이 죽은 runId 를 돌려준다(created=false → 사이클 안 돎).
  const blocked = ledger.startRun({
    trigger: "scheduled",
    options: {},
    idempotencyKey: "nightly-key",
    idGen: () => "fresh_run",
  });
  expect(blocked).toEqual({ runId: "dead_run", created: false });

  ledger.reclaimStaleRuns(60 * 60 * 1000);

  // 회수 후에도 키 행 자체는 남아 있다(원장 보존) — 회수의 목적은 status 정직화와
  // doctor 정체 신호 해제이며, 이 run 이 failed 로 확정돼 재시도 판단이 가능해진다.
  expect(ledger.statusOf("dead_run")).toBe("failed");
  db.close();
});

test("reclaimStaleRuns — now 주입으로 경계를 결정적으로 넘긴다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const { runId } = ledger.startRun({
    trigger: "scheduled",
    options: {},
    idGen: seqIdGen(),
  });
  // 실제 시계를 기다리지 않고, now 를 2시간 앞으로 주입해 문턱(1시간)을 넘긴다.
  const twoHoursLater = Date.now() + 2 * 60 * 60 * 1000;

  expect(ledger.reclaimStaleRuns(60 * 60 * 1000, twoHoursLater)).toEqual([runId]);
  expect(ledger.statusOf(runId)).toBe("failed");
  db.close();
});

test("finishRun CAS 가드 — 회수로 확정된 run 을 좀비의 뒤늦은 finishRun 이 재역전하지 못한다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  // 죽은 프로세스가 남긴 running 행을 회수 경로가 failed 로 확정한다.
  injectStaleRun(db, "dead_run", "2020-01-01 00:00:00");
  expect(ledger.reclaimStaleRuns(60 * 60 * 1000)).toEqual(["dead_run"]);
  expect(ledger.statusOf("dead_run")).toBe("failed");
  const reclaimedRow = ledger.getRun("dead_run");

  // 좀비 프로세스가 뒤늦게 completed 확정을 시도한다 — CAS 가드가 거부하고
  // false 를 돌려준다(조용한 성공 위장 금지).
  const lateResult = ledger.finishRun({
    runId: "dead_run",
    status: "completed",
    aggregates: SAMPLE_AGGREGATES,
  });
  expect(lateResult).toBe(false);

  // 원장은 한 글자도 안 바뀐다 — status·집계·finished_at 전부 회수 확정 그대로.
  const after = ledger.getRun("dead_run");
  expect(after?.status).toBe("failed");
  expect(after?.aggregates).toEqual(reclaimedRow?.aggregates ?? null);
  expect(after?.finishedAt).toBe(reclaimedRow?.finishedAt ?? null);
  db.close();
});

test("finishRun — running 행 정상 확정은 true, 없는 runId 는 false 를 돌려준다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  ledger.startRun({ trigger: "manual", options: {}, idGen: seqIdGen() });
  expect(
    ledger.finishRun({
      runId: "run_1",
      status: "completed",
      aggregates: SAMPLE_AGGREGATES,
    }),
  ).toBe(true);
  expect(
    ledger.finishRun({
      runId: "nope",
      status: "failed",
      aggregates: SAMPLE_AGGREGATES,
    }),
  ).toBe(false);
  db.close();
});

test("options 원문 보존 — stages/maxCalls 왕복", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  const idGen = seqIdGen();
  ledger.startRun({
    trigger: "manual",
    options: { stages: ["summary", "personLink"], maxCalls: 5, dryRun: false },
    idGen,
  });
  const row = ledger.getRun("run_1");
  expect(row?.options).toEqual({
    stages: ["summary", "personLink"],
    maxCalls: 5,
    dryRun: false,
  });
  db.close();
});

/** run 하나를 만들어 종료 상태·시작 시각을 정한다(예약 기준점 검증용 데이터 준비). */
function seedRun(
  db: Database,
  ledger: CleanupRunsLedger,
  run: { id: string; startedAt: string; status: "running" | "completed" | "cancelled" | "failed"; trigger?: "manual" | "scheduled"; options?: Record<string, unknown> },
): void {
  ledger.startRun({ trigger: run.trigger ?? "scheduled", options: run.options ?? {}, idGen: () => run.id });
  if (run.status !== "running") {
    ledger.finishRun({ runId: run.id, status: run.status, aggregates: SAMPLE_AGGREGATES });
  }
  db.prepare("UPDATE cleanup_runs SET started_at = ? WHERE run_id = ?").run(run.startedAt, run.id);
}

test("lastFullRunStartedAt — 기록이 없으면 null", () => {
  const ledger = new CleanupRunsLedger(freshDb());
  expect(ledger.lastFullRunStartedAt()).toBeNull();
});

test("lastFullRunStartedAt — 정기·수동 전체 실행 중 가장 늦은 completed/cancelled 시작 시각", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  seedRun(db, ledger, { id: "a", startedAt: "2026-10-08 00:00:01", status: "completed" });
  seedRun(db, ledger, { id: "b", startedAt: "2026-10-15 14:20:00", status: "completed", trigger: "manual" });
  seedRun(db, ledger, { id: "c", startedAt: "2026-10-12 00:00:01", status: "cancelled" });
  expect(ledger.lastFullRunStartedAt()).toBe("2026-10-15 14:20:00");

  seedRun(db, ledger, { id: "d", startedAt: "2026-10-16 00:00:01", status: "cancelled" });
  expect(ledger.lastFullRunStartedAt()).toBe("2026-10-16 00:00:01");
});

test("lastFullRunStartedAt — 실패·진행 중·부분 실행·dryRun 은 기준점이 아니다", () => {
  const db = freshDb();
  const ledger = new CleanupRunsLedger(db);
  seedRun(db, ledger, { id: "full", startedAt: "2026-10-08 00:00:01", status: "completed" });
  seedRun(db, ledger, { id: "failed", startedAt: "2026-10-15 00:00:01", status: "failed" });
  seedRun(db, ledger, { id: "running", startedAt: "2026-10-16 00:00:01", status: "running" });
  seedRun(db, ledger, {
    id: "memo",
    startedAt: "2026-10-17 10:00:00",
    status: "completed",
    trigger: "manual",
    options: { stages: ["entityRegister"], nodeIds: [5], reason: "memo_saved" },
  });
  seedRun(db, ledger, { id: "stages", startedAt: "2026-10-18 10:00:00", status: "completed", trigger: "manual", options: { stages: ["summary"] } });
  seedRun(db, ledger, { id: "dry", startedAt: "2026-10-19 10:00:00", status: "completed", trigger: "manual", options: { dryRun: true } });
  expect(ledger.lastFullRunStartedAt()).toBe("2026-10-08 00:00:01");

  // dryRun:false 를 명시한 수동 실행은 전체 실행이다.
  seedRun(db, ledger, { id: "manual", startedAt: "2026-10-20 10:00:00", status: "completed", trigger: "manual", options: { dryRun: false, maxCalls: 5 } });
  expect(ledger.lastFullRunStartedAt()).toBe("2026-10-20 10:00:00");
});
