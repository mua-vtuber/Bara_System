/**
 * server-internal/routes/cleanup-runs.ts — 깊은 패스 실행 단위(run) API (spec 5.B-1).
 *
 * 권위 spec: docs/decisions/2026-07-11-cleanup-ai-efficient-operation-spec.md 단락 5.B-1
 *
 * 3 라우트:
 *   1. POST /api/cleanup-runs           — 202 { runId }. 옵션: stages[]/dryRun/maxCalls/
 *                                         idempotencyKey. 같은 키 재요청 = 같은 runId.
 *   2. GET  /api/cleanup-runs/:id        — 진행 상태 + 단계별 집계.
 *   3. POST /api/cleanup-runs/:id/cancel — AbortSignal 전파(진행 중 호출까지 끊김).
 *                                         취소는 실패가 아니다 — status=cancelled.
 *   4. GET  /api/cleanup-runs/availability — "지금 정리하기" 가능 여부 { available, running, reasons }.
 *                                         스케줄러 배선이 없어도 설정에서 사유를 계산해 답한다.
 *
 * 동시성: 스케줄러 handle 의 원자 tryTickNow('started'|'already_running')를 소비한다 —
 * 별도 단일 비행 boolean 없이 정기 tick 과 수동 run 의 겹침을 한곳에서 막는다.
 * already_running = 409(정직). 스케줄러가 꺼져 있으면 409 + 게이트 사유 배열
 * (scheduler-gate.ts cleanupDeepPassGateReasons 단일 출처 — 스케줄 tick 과 같은 사유).
 *
 * 이 라우트는 HTTP 표면만 맡는다 — run 원장·사이클 실행·취소 신호 배선은 index.ts 가
 * deps 로 주입한다(라우트가 스케줄러·원장에 직접 결합하지 않는다). deps.cleanupRuns 는 요청마다
 * 읽고, 미주입 시 세 라우트가 503(정직한 비활성 — 옛 assetStore/backup 라우트 양식 정합).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import type {
  CleanupRunsLedger,
  CleanupRunOptions,
} from "../../memory/cleanup-deep-pass/cleanup-runs-ledger.ts";
import { emptyRunAggregates } from "../../memory/cleanup-deep-pass/cleanup-runs-ledger.ts";
import type {
  CleanupRunContext,
  TryTickResult,
} from "../../scheduler.ts";
import type { CycleStage } from "../../memory/cleanup-deep-pass/cycle-budget.ts";
import { registerEntityRegisterRecordsRoutes } from "./entity-register-records.ts";
import { cleanupDeepPassGateReasons } from "../../memory/cleanup-deep-pass/scheduler-gate.ts";
import { buildCleanupGateInput } from "../../memory/cleanup-deep-pass/entity-register/boot-wiring.ts";

/** 유효한 단계 이름(stages 필터 검증 단일 출처 — 예산·실행층 vocabulary 정합).
 * 2026-07-19 MCP spec 10.2 — lensDraft 누락 정정(실행층·게이트는 인지하는데 검증
 * 목록에만 빠져 부분 실행 지정이 불가하던 결함). */
const VALID_STAGES: readonly CycleStage[] = [
  "regexStrengthen",
  "summary",
  "personLink",
  "lensDraft",
  "entityRegister",
];

/**
 * run API 가 스케줄러·원장·취소 배선에 접근하는 통로(index.ts 가 주입). 라우트가
 * 이 인터페이스만 알아, 스케줄러 handle·CleanupRunsLedger 구현에 직접 결합하지 않는다.
 */
export interface CleanupRunsRouteDeps {
  /** run 원장(cleanup_runs). startRun idempotency·finishRun·getRun. */
  ledger: CleanupRunsLedger;
  /**
   * 스케줄러 게이트 사유. 스케줄러가 기동 조건을 만족하면 빈 배열, 아니면 사유 배열
   * (cleanupDeepPassGateReasons). 빈 배열이 아니면 POST 가 409 + 사유를 회신한다.
   */
  gateReasons(): string[];
  /**
   * run 사이클을 트리거한다 — 스케줄러 handle 의 tryTickNow(ctx) 를 그대로 위임한다.
   * 'started' 면 사이클이 비동기로 돌기 시작했고, 'already_running' 이면 이미 진행 중이라
   * 이 run 은 겹치지 않게 물러난다(라우트가 409). ctx.cancelSignal 은 registerCancel 이
   * 만든 controller.signal 이다.
   */
  triggerRun(ctx: CleanupRunContext): TryTickResult;
  /**
   * runId 에 대한 취소 controller 를 등록하고 그 signal 을 회신한다(사이클 트리거 전
   * 호출 — ctx.cancelSignal 로 넘겨 실행층이 끼운다). cancel 라우트가 같은 runId 로
   * abort 한다.
   */
  registerCancel(runId: string): AbortSignal;
  /**
   * runId 사이클을 취소한다 — 등록된 controller 를 abort 하고 원장 status 를 cancelled 로
   * 바꾼다. 해당 runId 가 진행 중이 아니면(등록 controller 없음) false 를 회신한다.
   */
  cancelRun(runId: string): boolean;
  /** 깊은 패스 사이클이 도는 중인지(스케줄러 handle 위임). */
  isRunning(): boolean;
  /** "입력할 때마다" 대기열(Task 14). 설정이 interval 이면 undefined. */
  onMemoSaved?: (nodeId: number) => void;
}

/** 설정상 막는 사유가 없는데 스케줄러 배선이 없을 때 — 부팅 때 정리 AI 연결 구성 실패는 서버 로그에만 남는다. */
const RESTART_NEEDED_REASON =
  "설정이 바뀌었거나 정리 AI 연결 구성에 실패함 — 서버를 다시 시작한 뒤 확인(서버 로그에 사유)";

/**
 * GET /api/cleanup-runs/availability — 스케줄러 유무와 상관없이 의미 있는 답을 준다. 배선이 있으면
 * 도는 중인지만 보고, 없으면 현재 설정으로 게이트 사유(키 이름 포함)를 계산한다. 설정상 사유가 없으면
 * "다시 시작" 사유를 보인다 — 거짓 "가능"을 보이지 않는다. /:id 보다 먼저 등록해야 한다.
 */
function registerAvailabilityRoute(app: Hono, deps: MemoryApiDeps): void {
  app.get("/api/cleanup-runs/availability", (c) => {
    const runs = deps.cleanupRuns;
    if (runs) {
      const running = runs.isRunning();
      return c.json({ available: !running, running, reasons: running ? ["이미 정리 중"] : [] });
    }
    const settings = deps.getSettings?.();
    if (!settings) {
      return err(c, 503, "설정 조회 배선 없음(getSettings) — 정리 가능 여부를 알 수 없음");
    }
    const reasons = cleanupDeepPassGateReasons(
      buildCleanupGateInput(settings, {
        cleanupLlmAvailable: true,
        regexAvailable: deps.regexL0 !== undefined,
      }),
    );
    if (reasons.length === 0) reasons.push(RESTART_NEEDED_REASON);
    return c.json({ available: false, running: false, reasons });
  });
}

/** POST body 파싱 결과(검증 통과) 또는 오류 메시지. */
type ParsedOptions =
  | { ok: true; options: CleanupRunOptions; idempotencyKey: string | null }
  | { ok: false; message: string };

/**
 * POST body 를 CleanupRunOptions 로 파싱·검증한다. stages 는 VALID_STAGES 부분집합만,
 * maxCalls 는 1 이상 정수만, dryRun 은 boolean, idempotencyKey 는 비어 있지 않은 문자열.
 * 무효 값은 loud 하게 400(조용한 무시 금지 — 사용자가 오타를 즉시 발견).
 */
function parseOptions(body: unknown): ParsedOptions {
  const b = (body ?? {}) as Record<string, unknown>;
  const options: CleanupRunOptions = {};

  if (b.stages !== undefined) {
    if (
      !Array.isArray(b.stages) ||
      !b.stages.every(
        (s): s is CycleStage =>
          typeof s === "string" && VALID_STAGES.includes(s as CycleStage),
      )
    ) {
      return {
        ok: false,
        message: `stages 어긋남 — ${VALID_STAGES.join("/")} 부분집합 배열이어야 함`,
      };
    }
    options.stages = b.stages as CycleStage[];
  }

  if (b.dryRun !== undefined) {
    if (typeof b.dryRun !== "boolean") {
      return { ok: false, message: "dryRun 은 boolean 이어야 함" };
    }
    options.dryRun = b.dryRun;
  }

  if (b.maxCalls !== undefined) {
    if (
      typeof b.maxCalls !== "number" ||
      !Number.isInteger(b.maxCalls) ||
      b.maxCalls < 1
    ) {
      return { ok: false, message: "maxCalls 는 1 이상 정수여야 함" };
    }
    options.maxCalls = b.maxCalls;
  }

  let idempotencyKey: string | null = null;
  if (b.idempotencyKey !== undefined) {
    if (typeof b.idempotencyKey !== "string" || b.idempotencyKey.trim().length === 0) {
      return { ok: false, message: "idempotencyKey 는 비어 있지 않은 문자열이어야 함" };
    }
    idempotencyKey = b.idempotencyKey;
  }

  return { ok: true, options, idempotencyKey };
}

export function registerCleanupRunsRoutes(app: Hono, deps: MemoryApiDeps): void {
  // 최근 자동 등록 목록·되돌리기(entity-register-records.ts) — 스케줄러가 꺼져 있어도 지난 기록을
  // 보고 되돌릴 수 있어야 해서, 스케줄러 배선(deps.cleanupRuns) 유무와 상관없이 등록한다.
  registerEntityRegisterRecordsRoutes(app, deps);
  // "지금 정리하기" 가능 여부도 스케줄러가 꺼진 상태에서 사유를 답해야 하므로 아래 /:id 라우트보다
  // 먼저 등록한다(같은 모양의 경로라 /:id 가 먼저면 "availability" 를 run id 로 받는다).
  registerAvailabilityRoute(app, deps);
  const api = new Hono({ strict: false });

  // 배선(deps.cleanupRuns)은 요청마다 읽는다. index.ts 는 createMemoryApi(이 등록) *뒤에*
  // setCleanupRuns 로 배선을 채우므로, 등록 시점에 한 번 읽으면 운영에서 늘 미주입으로 굳는다.
  // 미주입(스케줄러 미기동)이면 세 라우트 503(정직한 비활성).
  const disabled = (c: Context) =>
    err(
      c,
      503,
      "cleanup run API 비활성 — 깊은 패스 스케줄러 배선이 없다(llm.cleanup.enabled 및 단계 게이트 확인)",
    );

  // ── POST /api/cleanup-runs — 202 { runId } ─────────────────────────────────
  api.post("/api/cleanup-runs", async (c) => {
    const d = deps.cleanupRuns;
    if (!d) return disabled(c);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // 빈 본문 = 기본 옵션(켜진 단계 전부·실 실행). JSON 파싱 실패만 이 분기 —
      // Content-Length 0 은 정상(옵션 없는 run).
      body = {};
    }
    const parsed = parseOptions(body);
    if (!parsed.ok) {
      return err(c, 400, parsed.message);
    }

    // 스케줄러 게이트 — 꺼져 있으면 409 + 사유 배열(정직한 비활성 / 스케줄 tick 과 같은 사유).
    const reasons = d.gateReasons();
    if (reasons.length > 0) {
      return c.json(
        { error: "cleanup 깊은 패스 스케줄러 비활성", reasons },
        409,
      );
    }

    // idempotency — 같은 키 재요청이면 원장이 기존 runId 를 돌려준다(created=false).
    // 이 경우 사이클을 새로 트리거하지 않고 기존 runId 만 회신한다(중복 실행 방지).
    const start = d.ledger.startRun({
      trigger: "manual",
      options: parsed.options,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (!start.created) {
      return c.json({ runId: start.runId }, 202);
    }

    // 취소 controller 등록 후 사이클 트리거(cancelSignal 을 실행층이 끼운다).
    const cancelSignal = d.registerCancel(start.runId);
    const ctx: CleanupRunContext = {
      runId: start.runId,
      cancelSignal,
      ...(parsed.options.stages !== undefined ? { stages: parsed.options.stages } : {}),
      ...(parsed.options.dryRun !== undefined ? { dryRun: parsed.options.dryRun } : {}),
      ...(parsed.options.maxCalls !== undefined ? { maxCalls: parsed.options.maxCalls } : {}),
    };
    const trigger = d.triggerRun(ctx);
    if (trigger === "already_running") {
      // 이미 진행 중 사이클이 있어 이 run 은 겹치지 않게 물러난다. 방금 만든 running
      // 행을 failed 로 확정한다(정직 — 트리거 안 됨을 원장에도 남긴다).
      d.ledger.finishRun({
        runId: start.runId,
        status: "failed",
        aggregates: emptyRunAggregates(),
      });
      return c.json(
        { error: "이미 진행 중인 깊은 패스 사이클이 있다(정기 tick 또는 다른 run)", runId: start.runId },
        409,
      );
    }

    // 'started' — 사이클이 비동기로 돈다. 진행·집계는 GET 으로 조회.
    return c.json({ runId: start.runId }, 202);
  });

  // ── GET /api/cleanup-runs/:id — 진행 상태 + 단계별 집계 ─────────────────────
  api.get("/api/cleanup-runs/:id", (c) => {
    const d = deps.cleanupRuns;
    if (!d) return disabled(c);
    const id = c.req.param("id");
    const row = d.ledger.getRun(id);
    if (!row) {
      return err(c, 404, "run 없음 — id 확인");
    }
    return c.json(row);
  });

  // ── POST /api/cleanup-runs/:id/cancel — AbortSignal 전파 ────────────────────
  api.post("/api/cleanup-runs/:id/cancel", (c) => {
    const d = deps.cleanupRuns;
    if (!d) return disabled(c);
    const id = c.req.param("id");
    const row = d.ledger.getRun(id);
    if (!row) {
      return err(c, 404, "run 없음 — id 확인");
    }
    // 이미 종료된 run(completed/cancelled/failed)은 취소 대상이 아니다(400 정직).
    if (row.status !== "running") {
      return err(c, 400, `이미 종료된 run — status: ${row.status}`);
    }
    const cancelled = d.cancelRun(id);
    if (!cancelled) {
      // running 인데 controller 가 없다 = 이 프로세스가 트리거한 run 이 아님(재시작 후
      // 조회 등). 정직하게 409 로 알린다 — 조용한 성공 위장 금지.
      return err(
        c,
        409,
        "취소 통로 없음 — 이 서버 프로세스가 트리거한 run 이 아니거나 이미 종료됨",
      );
    }
    return c.json({ cancelled: id });
  });

  app.route("/", api);
}
