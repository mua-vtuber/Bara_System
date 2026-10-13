/**
 * server-internal/routes/cleanup-runs.test.ts — 깊은 패스 run API 통합 검증 (spec 5.B-1).
 *
 * 격리 양식: registerCleanupRunsRoutes 직접 호출 + 실 SQLite(:memory:) 위 실
 * CleanupRunsLedger + 주입 trigger/cancel(스케줄러 handle 대역 — 가짜 클래스 아님,
 * 순수 함수 sink). 실 Hono app · mock 클래스 0.
 *
 * run API 는 HTTP 표면만 맡고 사이클 실행·취소 신호 배선은 deps 로 주입되므로, 이
 * 테스트는 라우트 계약(생성·조회·취소·idempotency·409 경로)을 검증한다. dryRun 이
 * LLM 을 안 부르는지는 trigger 대역이 넘겨받은 ctx.dryRun 을 실 사이클처럼 소비할 때
 * infer 호출 카운터가 0 임으로 실증한다.
 *
 * 검증 가족:
 *   (a) POST → 202 { runId } + running 행 생성
 *   (b) 같은 idempotencyKey 재요청 = 같은 runId (새 행·재트리거 없음)
 *   (c) GET /:id → 진행 상태 + 집계 / 없는 id 404
 *   (d) POST /:id/cancel → abort 전파 + status cancelled / 이미 종료 400 / 통로 없음 409
 *   (e) 스케줄러 OFF → 409 + 사유 배열
 *   (f) already_running → 409 (tryTickNow 대역이 already_running 회신)
 *   (g) dryRun → trigger 대역이 dryRun 사이클을 돌려 infer 호출 0 실증
 *   (h) stages/maxCalls 무효 = 400
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { runMigrations } from "../../db/migrations.ts";
import { registerCleanupRunsRoutes } from "./cleanup-runs.ts";
import type { MemoryApiDeps } from "../types.ts";
import {
  CleanupRunsLedger,
  type CleanupRunAggregates,
} from "../../memory/cleanup-deep-pass/cleanup-runs-ledger.ts";
import type {
  CleanupRunContext,
  TryTickResult,
} from "../../scheduler.ts";
import type { CleanupRunsRouteDeps } from "./cleanup-runs.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings-types.ts";

const EMPTY_AGG: CleanupRunAggregates = {
  stageAggregates: [],
  totalCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  missingUsageCalls: 0,
  reachedDimensions: [],
  durationMs: 0,
};

/**
 * 테스트 하네스 — 실 ledger + 주입 스케줄러 대역. trigger 는 tryTickNow 를 흉내:
 * runningResult 로 'started'|'already_running' 을 정하고, 'started' 면 fakeCycle 을
 * 동기 실행해(테스트 결정성) ctx 를 기록하며, ctx.dryRun 이면 infer 를 안 부른다
 * (LLM 0 실증). cancel 은 registerCancel 이 만든 controller 를 abort 한다.
 */
function makeHarness(opts?: {
  gateReasons?: string[];
  triggerResult?: TryTickResult;
  running?: boolean;
}) {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  runMigrations(db);
  const ledger = new CleanupRunsLedger(db);

  const controllers = new Map<string, AbortController>();
  const seenCtx: CleanupRunContext[] = [];
  let inferCalls = 0;

  const triggerResult: TryTickResult = opts?.triggerResult ?? "started";

  const routeDeps: CleanupRunsRouteDeps = {
    ledger,
    gateReasons: () => opts?.gateReasons ?? [],
    isRunning: () => opts?.running ?? false,
    triggerRun: (ctx) => {
      seenCtx.push(ctx);
      if (triggerResult === "already_running") {
        return "already_running";
      }
      // 실 사이클 대역 — dryRun 이면 infer 를 절대 안 부른다(후보 검출·추정만).
      if (ctx.dryRun) {
        ledger.finishRun({
          runId: ctx.runId,
          status: "completed",
          aggregates: {
            ...EMPTY_AGG,
            stageAggregates: [
              {
                stage: "regexStrengthen",
                processed: 2,
                completed: 0,
                completedNoop: 0,
                failures: 0,
                terminal: 0,
                estimatedInputTokens: 240,
              },
            ],
          },
        });
      } else {
        inferCalls += 1; // 실 실행 = 최소 한 번 infer(대역).
        ledger.finishRun({
          runId: ctx.runId,
          status: ctx.cancelSignal?.aborted ? "cancelled" : "completed",
          aggregates: EMPTY_AGG,
        });
      }
      return "started";
    },
    registerCancel: (runId) => {
      const ctrl = new AbortController();
      controllers.set(runId, ctrl);
      return ctrl.signal;
    },
    cancelRun: (runId) => {
      const ctrl = controllers.get(runId);
      if (!ctrl) return false;
      ctrl.abort();
      ledger.finishRun({ runId, status: "cancelled", aggregates: EMPTY_AGG });
      return true;
    },
  };

  const deps = { cleanupRuns: routeDeps } as unknown as MemoryApiDeps;
  const app = new Hono({ strict: false });
  registerCleanupRunsRoutes(app, deps);

  return {
    app,
    ledger,
    routeDeps,
    seenCtx: () => seenCtx,
    inferCalls: () => inferCalls,
    controllers,
    close: () => db.close(),
  };
}

async function postRun(app: Hono, body: unknown) {
  return app.request("/api/cleanup-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/cleanup-runs — 생성 (spec 5.B-1)", () => {
  test("(a) 202 + runId + running 행 생성(트리거 전 = running, 대역이 completed 로 확정)", async () => {
    const h = makeHarness();
    const res = await postRun(h.app, {});
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(typeof body.runId).toBe("string");
    // 대역 trigger 가 동기 실행해 completed 로 확정.
    const row = h.ledger.getRun(body.runId);
    expect(row?.status).toBe("completed");
    expect(row?.trigger).toBe("manual");
    h.close();
  });

  test("(b) 같은 idempotencyKey 재요청 = 같은 runId (재트리거 없음)", async () => {
    const h = makeHarness();
    const r1 = await postRun(h.app, { idempotencyKey: "key-X" });
    const r2 = await postRun(h.app, { idempotencyKey: "key-X" });
    const b1 = (await r1.json()) as { runId: string };
    const b2 = (await r2.json()) as { runId: string };
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(b2.runId).toBe(b1.runId);
    // 트리거는 첫 요청에서만(재요청은 기존 runId 만 회신).
    expect(h.seenCtx().length).toBe(1);
    h.close();
  });

  test("(e) 스케줄러 OFF → 409 + 사유 배열", async () => {
    const h = makeHarness({
      gateReasons: ["llm.cleanup.enabled=false", "켜진 단계 0"],
    });
    const res = await postRun(h.app, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reasons: string[] };
    expect(body.reasons).toEqual(["llm.cleanup.enabled=false", "켜진 단계 0"]);
    // 게이트 OFF 면 원장에 run 행도 안 만든다(트리거 전 차단).
    expect(h.seenCtx().length).toBe(0);
    h.close();
  });

  test("(f) already_running → 409 + 방금 만든 run 은 failed 로 확정", async () => {
    const h = makeHarness({ triggerResult: "already_running" });
    const res = await postRun(h.app, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; runId: string };
    expect(typeof body.runId).toBe("string");
    expect(h.ledger.getRun(body.runId)?.status).toBe("failed");
    h.close();
  });

  test("(g) dryRun → infer 호출 0(LLM 미호출) + dryRunEstimate 집계", async () => {
    const h = makeHarness();
    const res = await postRun(h.app, { dryRun: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    // dryRun 사이클은 infer 를 안 부른다.
    expect(h.inferCalls()).toBe(0);
    // ctx.dryRun 이 전달됐다.
    expect(h.seenCtx()[0]?.dryRun).toBe(true);
    const row = h.ledger.getRun(body.runId);
    expect(row?.status).toBe("completed");
    expect(row?.aggregates?.stageAggregates[0]?.estimatedInputTokens).toBe(240);
    h.close();
  });

  test("(h) stages/maxCalls 무효 = 400", async () => {
    const h = makeHarness();
    const bad1 = await postRun(h.app, { stages: ["bogus"] });
    expect(bad1.status).toBe(400);
    const bad2 = await postRun(h.app, { maxCalls: 0 });
    expect(bad2.status).toBe(400);
    const bad3 = await postRun(h.app, { maxCalls: 2.5 });
    expect(bad3.status).toBe(400);
    const bad4 = await postRun(h.app, { dryRun: "yes" });
    expect(bad4.status).toBe(400);
    // 유효 조합은 통과.
    const ok = await postRun(h.app, {
      stages: ["summary", "personLink"],
      maxCalls: 3,
    });
    expect(ok.status).toBe(202);
    const ctx = h.seenCtx()[0]!;
    expect(ctx.stages).toEqual(["summary", "personLink"]);
    expect(ctx.maxCalls).toBe(3);
    h.close();
  });

  test("(h2) lensDraft 단계 지정 유효 = 202 (2026-07-19 누락 정정)", async () => {
    const h = makeHarness();
    const res = await postRun(h.app, { stages: ["lensDraft"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(typeof body.runId).toBe("string");
    const ctx = h.seenCtx()[0]!;
    expect(ctx.stages).toEqual(["lensDraft"]);
    h.close();
  });

  test("(h3) 없는 단계 조합 = 400 (lensDraft 포함 유효 목록 확인)", async () => {
    const h = makeHarness();
    const badStages = await postRun(h.app, {
      stages: ["regexStrengthen", "summary", "personLink", "lensDraft", "bogus"],
    });
    expect(badStages.status).toBe(400);
    const errMsg = await badStages.text();
    expect(errMsg).toContain("regexStrengthen");
    expect(errMsg).toContain("summary");
    expect(errMsg).toContain("personLink");
    expect(errMsg).toContain("lensDraft");
    h.close();
  });

  test("(h4) entityRegister 단계 지정 유효 = 202", async () => {
    const h = makeHarness();
    const res = await postRun(h.app, { stages: ["entityRegister"] });
    expect(res.status).toBe(202);
    expect(h.seenCtx()[0]!.stages).toEqual(["entityRegister"]);
    h.close();
  });
});

describe("GET /api/cleanup-runs/availability — 지금 정리할 수 있는지", () => {
  test("배선이 있고 도는 중이 아니면 가능", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/cleanup-runs/availability");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, running: false, reasons: [] });
    h.close();
  });

  test("이미 도는 중이면 불가 + 사유", async () => {
    const h = makeHarness({ running: true });
    const res = await h.app.request("/api/cleanup-runs/availability");
    expect(await res.json()).toEqual({ available: false, running: true, reasons: ["이미 정리 중"] });
    h.close();
  });

  test("스케줄러 배선 없음 + 정리 AI 꺼짐 → 그 설정 키를 사유로", async () => {
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.llm.cleanup.enabled = false;
    const deps = { getSettings: () => settings } as unknown as MemoryApiDeps;
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, deps);
    const res = await app.request("/api/cleanup-runs/availability");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; running: boolean; reasons: string[] };
    expect(body.available).toBe(false);
    expect(body.running).toBe(false);
    expect(body.reasons).toContain("llm.cleanup.enabled=false");
  });

  test("스케줄러 배선 없음 + 정리 AI 모델 빈칸 → 빈 키 이름을 사유로", async () => {
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.llm.cleanup.enabled = true;
    settings.llm.cleanup.provider = "anthropic";
    settings.llm.cleanup.anthropicModel = "";
    const deps = { getSettings: () => settings } as unknown as MemoryApiDeps;
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, deps);
    const body = (await (await app.request("/api/cleanup-runs/availability")).json()) as { reasons: string[] };
    expect(body.reasons).toContain("정리 AI 모델이 설정되지 않음 (llm.cleanup.anthropicModel)");
  });

  test("설정상 사유가 없는데 배선이 없으면 다시 시작 사유", async () => {
    const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
    settings.llm.cleanup.enabled = true;
    settings.llm.cleanup.provider = "anthropic";
    settings.llm.cleanup.anthropicModel = "claude-sonnet-4-6";
    settings.cleanupDeepPass.entityRegister.enabled = true;
    const deps = { getSettings: () => settings } as unknown as MemoryApiDeps;
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, deps);
    const body = (await (await app.request("/api/cleanup-runs/availability")).json()) as {
      available: boolean;
      reasons: string[];
    };
    expect(body.available).toBe(false);
    expect(body.reasons).toHaveLength(1);
    expect(body.reasons[0]).toContain("다시 시작");
  });

  test("스케줄러 배선도 설정 조회 배선도 없으면 503 + 이유", async () => {
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, {} as unknown as MemoryApiDeps);
    const res = await app.request("/api/cleanup-runs/availability");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("getSettings");
  });
});

describe("GET /api/cleanup-runs/:id — 조회", () => {
  test("(c) 정상 조회 + 없는 id = 404", async () => {
    const h = makeHarness();
    const created = (await (await postRun(h.app, {})).json()) as { runId: string };
    const res = await h.app.request(`/api/cleanup-runs/${created.runId}`);
    expect(res.status).toBe(200);
    const row = (await res.json()) as { runId: string; status: string };
    expect(row.runId).toBe(created.runId);

    const missing = await h.app.request("/api/cleanup-runs/nope");
    expect(missing.status).toBe(404);
    h.close();
  });
});

describe("GET /api/cleanup-runs/:id — 멈춘 원인", () => {
  test("failed run 의 stopReason 을 응답에 그대로 싣는다", async () => {
    const h = makeHarness({ triggerResult: "already_running" });
    const { runId } = h.ledger.startRun({ trigger: "manual", options: {} });
    h.ledger.finishRun({
      runId,
      status: "failed",
      aggregates: { ...EMPTY_AGG, stopReason: "entityRegister 단계에서 설정 결함으로 중단: 401 invalid x-api-key" },
    });
    const res = await h.app.request(`/api/cleanup-runs/${runId}`);
    expect(res.status).toBe(200);
    const row = (await res.json()) as { status: string; aggregates: { stopReason?: string } };
    expect(row.status).toBe("failed");
    expect(row.aggregates.stopReason).toContain("401");
    h.close();
  });
});

describe("POST /api/cleanup-runs/:id/cancel — 취소 (AbortSignal 전파)", () => {
  test("(d) 진행 중 run 취소 → abort 전파 + status cancelled", async () => {
    // 이 케이스는 사이클이 진행 중이어야 취소 대상이라, trigger 대역이 사이클을 즉시
    // 끝내지 않도록 running 을 유지하는 별도 하네스를 쓴다.
    const db = new Database(":memory:");
    sqliteVec.load(db);
    runMigrations(db);
    const ledger = new CleanupRunsLedger(db);
    const controllers = new Map<string, AbortController>();
    let abortedSeen = false;

    const routeDeps: CleanupRunsRouteDeps = {
      ledger,
      gateReasons: () => [],
      isRunning: () => false,
      // 트리거는 사이클을 '진행 중'으로 두고(원장 running 유지) 즉시 started 만 회신.
      triggerRun: () => "started",
      registerCancel: (runId) => {
        const ctrl = new AbortController();
        ctrl.signal.addEventListener("abort", () => {
          abortedSeen = true;
        });
        controllers.set(runId, ctrl);
        return ctrl.signal;
      },
      cancelRun: (runId) => {
        const ctrl = controllers.get(runId);
        if (!ctrl) return false;
        ctrl.abort();
        ledger.finishRun({ runId, status: "cancelled", aggregates: EMPTY_AGG });
        return true;
      },
    };
    const deps = { cleanupRuns: routeDeps } as unknown as MemoryApiDeps;
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, deps);

    const created = (await (await postRun(app, {})).json()) as { runId: string };
    expect(ledger.getRun(created.runId)?.status).toBe("running");

    const cancelRes = await app.request(`/api/cleanup-runs/${created.runId}/cancel`, {
      method: "POST",
    });
    expect(cancelRes.status).toBe(200);
    expect(abortedSeen).toBe(true);
    expect(ledger.getRun(created.runId)?.status).toBe("cancelled");
    db.close();
  });

  test("(d2) 이미 종료된 run 취소 = 400", async () => {
    const h = makeHarness(); // 대역이 즉시 completed 로 끝냄.
    const created = (await (await postRun(h.app, {})).json()) as { runId: string };
    expect(h.ledger.getRun(created.runId)?.status).toBe("completed");
    const res = await h.app.request(`/api/cleanup-runs/${created.runId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    h.close();
  });

  test("(d3) 없는 run 취소 = 404", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/cleanup-runs/nope/cancel", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    h.close();
  });
});

describe("배선을 등록 뒤에 채워도 라우트가 쓴다(index.ts 부팅 순서)", () => {
  test("registerCleanupRunsRoutes 뒤 deps.cleanupRuns 를 채우면 POST·GET·availability 가 그 배선을 쓴다", async () => {
    const h = makeHarness();
    const lateDeps = {} as unknown as MemoryApiDeps;
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, lateDeps);
    expect((await postRun(app, {})).status).toBe(503);
    // index.ts 는 createMemoryApi(라우트 등록) 뒤에 setCleanupRuns 로 배선을 채운다.
    lateDeps.cleanupRuns = h.routeDeps;
    const res = await postRun(app, { stages: ["entityRegister"] });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect((await app.request(`/api/cleanup-runs/${runId}`)).status).toBe(200);
    const avail = await app.request("/api/cleanup-runs/availability");
    expect(await avail.json()).toEqual({ available: true, running: false, reasons: [] });
    h.close();
  });
});

describe("deps.cleanupRuns 미주입 = 503 (정직한 비활성)", () => {
  test("세 라우트 전부 503", async () => {
    const deps = {} as unknown as MemoryApiDeps;
    const app = new Hono({ strict: false });
    registerCleanupRunsRoutes(app, deps);
    expect((await postRun(app, {})).status).toBe(503);
    expect((await app.request("/api/cleanup-runs/x")).status).toBe(503);
    expect(
      (await app.request("/api/cleanup-runs/x/cancel", { method: "POST" })).status,
    ).toBe(503);
  });
});
