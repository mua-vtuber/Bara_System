/**
 * cleanup-runs-ledger.ts — 깊은 패스 실행 단위(run) 원장 CRUD (spec 5.B-1).
 *
 * 권위 spec: docs/decisions/2026-07-11-cleanup-ai-efficient-operation-spec.md 단락 5.B-1
 *
 * cleanup_runs 테이블(v40)에 실행 단위 행을 남긴다 — 수동 run API 와 정기 스케줄 tick 이
 * 한 통로로 진행·집계·취소를 기록해, 두 실행이 같은 관측면에 수렴한다("수동/정기 한 통로").
 *
 * 상태 흐름: startRun 이 status='running' 행을 넣고, 사이클이 끝나면 finishRun 이
 * status 를 completed|cancelled|failed 로 바꾸며 단계별 집계(aggregates_json)를 채운다.
 * idempotencyKey 가 주어지면 UNIQUE 충돌 시 기존 runId 를 그대로 돌려줘 중복 실행을 막는다
 * (같은 키 재요청 = 같은 runId). 취소는 실패가 아니다 — 완료분 원장(cleanup_stage_results)은
 * 그대로 유효하고 run status 만 cancelled 로 남는다.
 *
 * 이 모듈은 순수 SQL 원장이다 — LLM·스케줄러·HTTP 를 모른다. run 사이클 실행은 상위
 * (index.ts run-cycle-runner)가, HTTP 표면은 routes/cleanup-runs.ts 가 맡는다.
 */

import type { Database } from "bun:sqlite";
import type { CycleStage } from "./cycle-budget.ts";
import { nowKst, pastCutoffInZone } from "../../db/store-internal/helpers.ts";

/** 죽은 run 회수(reclaimStaleRuns)가 failed 로 닫는 run 에 남기는 원인. */
export const STALE_RUN_STOP_REASON = "서버 재시작 등으로 멈춰 있던 run 을 실패로 정리함";

/** run trigger 두 값 — 수동 run API / 정기 스케줄 tick. */
export type CleanupRunTrigger = "manual" | "scheduled";

/** run status 네 값 — 진행 / 정상 종료 / 사용자 취소 / 결함 중단. */
export type CleanupRunStatus = "running" | "completed" | "cancelled" | "failed";

/**
 * run 요청 옵션(options_json 원문). run API 가 받은 stages/dryRun/maxCalls 를 그대로
 * 담아 조회 시 무슨 옵션으로 돌았는지 관측한다. 부재 칸은 넣지 않는다(요청 원문 보존).
 */
export interface CleanupRunOptions {
  /** 부분 실행 단계 필터 — 생략 시 켜진 단계 전부. */
  stages?: CycleStage[];
  /** dryRun — LLM 호출 0, 후보 검출 + 추정만. */
  dryRun?: boolean;
  /** 이번 run 한정 호출 수 상한 덮어쓰기. */
  maxCalls?: number;
  /** 이 메모들만 후보로 삼는다(메모 단위 단계 — entityRegister·personLink). */
  nodeIds?: number[];
  /** 입력 직후 정리 회차 표시. */
  reason?: "memo_saved";
}

/**
 * 한 단계의 run 집계 한 줄. StageCycleRecord(요약 로그)와 같은 처리량 축 + 호출·토큰
 * 누적을 담아 GET /:id 응답이 단계별 진행을 회신한다. dryRun 은 processed=후보 수 +
 * estimatedInputTokens 만 채우고 나머지는 0(LLM 미호출).
 */
export interface CleanupRunStageAggregate {
  stage: CycleStage | "dryRunEstimate";
  /** 처리 시도한 대상 수(dryRun=검출된 후보 수). */
  processed: number;
  /** 산출 있음(completed) 수. */
  completed: number;
  /** 정상 회신 + 산출 0(completed_noop) 수. */
  completedNoop: number;
  /** 산출 못 낸 대상 수(retryable/terminal 대기). */
  failures: number;
  /** terminal_failure 확정 수. */
  terminal: number;
  /** 추정 입력 토큰(dryRun 실측 도구 — DCL-6 예산 확정 자료). */
  estimatedInputTokens: number;
  /** 자동 반영한 항목·연결·일정 수(entityRegister 만 채운다). */
  autoApplied?: number;
  /** 만든 정리 제안 수(entityRegister 만 채운다). */
  proposed?: number;
  /** 다른 처리(펫 제출 등)가 같은 내용으로 먼저 끝내 건너뛴 대상 수(entityRegister 만 채운다). */
  alreadyProcessed?: number;
  /** 답을 쓸 수 없어 메모 하나씩 다시 보낸 묶음 수(entityRegister 만 채운다 — 사유 개수 상한과 무관하게 남는다). */
  batchesSplit?: number;
  /** 그렇게 하나씩 다시 보낸 메모 수(entityRegister 만 채운다). */
  memosResentAlone?: number;
  /** 처리 불가·실패 사유(entityRegister 만 채운다). */
  failureReasons?: string[];
}

/**
 * run 종료 집계(aggregates_json). 단계별 집계 + 누적 호출·토큰 + 도달 예산 차원.
 * dryRun 은 stageAggregates 에 dryRunEstimate 항목만, calls/토큰은 0(추정만 채움).
 */
export interface CleanupRunAggregates {
  stageAggregates: CleanupRunStageAggregate[];
  totalCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  missingUsageCalls: number;
  /** 도달한 예산 차원 목록(빈 배열 = 상한 미도달). */
  reachedDimensions: string[];
  /** 사이클 소요 시간 ms. */
  durationMs: number;
  /**
   * run 이 failed 로 멈춘 원인(단계 이름 + 원인 문장). GET /api/cleanup-runs/:id 가 그대로 돌려줘
   * 사용자가 서버 로그 없이 원인을 본다(spec 9장 "원인을 표시한다"). 설정 키 이름만 담고 값은 담지 않는다.
   */
  stopReason?: string;
}

/** 빈 집계 — 호출·토큰 0. 조기 중단·취소·트리거 안 됨·죽은 run 회수가 원장에 남기는 같은 값의 단일 출처. */
export function emptyRunAggregates(durationMs = 0): CleanupRunAggregates {
  return {
    stageAggregates: [],
    totalCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingUsageCalls: 0,
    reachedDimensions: [],
    durationMs,
  };
}

/** GET /:id 응답에 실릴 run 행 전체(옵션·집계는 파싱된 형). */
export interface CleanupRunRow {
  runId: string;
  trigger: CleanupRunTrigger;
  status: CleanupRunStatus;
  startedAt: string;
  finishedAt: string | null;
  options: CleanupRunOptions;
  aggregates: CleanupRunAggregates | null;
  idempotencyKey: string | null;
}

/** startRun 결과 — 새로 만들었는지(created) 아니면 idempotency 재사용인지(reused). */
export interface StartRunResult {
  runId: string;
  created: boolean;
}

/** DB 행 raw 형(내부 매핑용). */
interface RawRunRow {
  run_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  options_json: string;
  aggregates_json: string;
  idempotency_key: string | null;
}

/**
 * cleanup_runs 원장. 생성자에 raw db 핸들을 받아 순수 SQL 로 CRUD 한다(store facade 밖
 * — cleanup-proposals-repository 선례처럼 repository 직접 가동, 새 테이블이 store 합류 밖).
 */
export class CleanupRunsLedger {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * run 행을 status='running' 으로 만든다. idempotencyKey 가 주어졌고 같은 키 행이 이미
   * 있으면 새로 만들지 않고 그 runId 를 돌려준다(created=false) — 같은 키 재요청 = 같은
   * runId. 키가 없으면 항상 새 행(created=true).
   *
   * idGen 은 runId 생성기(주입 — 테스트 결정성). 미주입 시 crypto.randomUUID.
   */
  startRun(input: {
    trigger: CleanupRunTrigger;
    options: CleanupRunOptions;
    idempotencyKey?: string | null;
    idGen?: () => string;
  }): StartRunResult {
    const key =
      input.idempotencyKey !== undefined && input.idempotencyKey !== null
        ? input.idempotencyKey
        : null;

    // idempotency 재사용 — 같은 키 행이 있으면 그 runId 를 그대로 회신(상태 무관: 진행
    // 중이면 겹침 방지, 완료됐어도 같은 결과 조회로 이어짐).
    if (key !== null) {
      const existing = this.db
        .query("SELECT run_id FROM cleanup_runs WHERE idempotency_key = ?")
        .get(key) as { run_id: string } | null;
      if (existing) {
        return { runId: existing.run_id, created: false };
      }
    }

    const idGen = input.idGen ?? (() => crypto.randomUUID());
    const runId = idGen();
    // started_at 을 명시 INSERT 한다 — schema DEFAULT (datetime('now','localtime'))
    // 는 SQLite 자체 localtime 이라 OS/런타임 TZ 환경변수에 좌우된다(Windows 네이티브
    // bun.exe 가 WSL bash 의 TZ 를 상속받지 못해 UTC 로 떨어지는 실측 함정 —
    // helpers.ts nowInZone 주석 근거 동일). nowKst() 가 애플리케이션 설정 시간대를
    // Intl 로 명시 계산하므로 knowledge_nodes.created_at 등 다른 저장 시각과 같은
    // zone 을 보장한다(리뷰 지적 — doctor.ts stalled 판정이 이 값을 그 zone 가정으로
    // 파싱하므로, INSERT 쪽이 어긋나 있으면 판정도 최대 9시간 어긋난다).
    this.db
      .prepare(
        `INSERT INTO cleanup_runs (run_id, trigger, status, started_at, options_json, idempotency_key)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(runId, input.trigger, nowKst(), JSON.stringify(input.options), key);
    return { runId, created: true };
  }

  /**
   * run 을 종료 상태로 확정한다 — status(completed|cancelled|failed) + finished_at +
   * 집계. WHERE 에 status='running' CAS 가드를 건다(Task 29 minor 마감) — 확정은
   * running 행에서만 성립하고, 이미 종료된 행은 절대 재역전되지 않는다. 이 가드가
   * 없으면 stalled 회수(reclaimStaleRuns)가 failed 로 확정한 죽은 run 을, 좀비
   * 프로세스의 뒤늦은 finishRun 이 completed 로 되뒤집을 수 있다.
   *
   * @returns true = 이 호출이 running→종료 전이를 실제로 수행했다. false = 0행
   *   갱신(행이 없거나 이미 종료됨) — 원장은 바뀌지 않았다. 조용한 성공으로
   *   위장하지 않도록 결과를 정직하게 돌려준다(T32 원장 정직성 규칙과 같은 정신).
   *   부작용: 취소 라우트가 먼저 cancelled 로 확정한 run 은 사이클 종료부의 뒤늦은
   *   finishRun(실측 집계 포함)이 거부돼 취소 시점의 집계가 그대로 남는다 — 재역전
   *   차단이 우선이고, 확정 후 집계 보강은 이 원장의 계약이 아니다.
   */
  finishRun(input: {
    runId: string;
    status: Exclude<CleanupRunStatus, "running">;
    aggregates: CleanupRunAggregates;
  }): boolean {
    // startRun 과 같은 이유로 SQLite 내장 datetime('now','localtime') 대신 nowKst()
    // 를 명시 삽입한다 — started_at·finished_at 이 같은 zone 이어야 duration 계산도
    // 정합이 맞는다(한쪽만 고치면 두 칸이 서로 다른 zone 으로 갈리는 새 함정이 생긴다).
    const result = this.db
      .prepare(
        `UPDATE cleanup_runs
         SET status = ?, finished_at = ?, aggregates_json = ?
         WHERE run_id = ? AND status = 'running'`,
      )
      .run(input.status, nowKst(), JSON.stringify(input.aggregates), input.runId);
    return result.changes > 0;
  }

  /**
   * 죽은 run 회수 — 시작 후 maxRunAgeMs 를 넘긴 status='running' 행을 failed 로 확정한다.
   * 사이클 시작마다 한 번 부르는 저렴한 쿼리다(spec 5-3 잔여 D-D).
   *
   * 왜 필요한가: 사이클 도중 프로세스가 죽으면(SIGKILL·OOM·A1 재부팅) finishRun 이
   * 영영 안 불려 그 행이 'running' 으로 굳는다. 겹침 방지 자물쇠는 프로세스 메모리
   * (scheduler running 플래그)라 재시작으로 풀리지만, 원장에 남은 행은 두 가지를
   * 실제로 막는다:
   *   1. idempotency_key 가 UNIQUE 라, 죽은 run 이 키를 쥔 채 남으면 같은 키의 재요청이
   *      영원히 그 죽은 runId 를 돌려받는다(created=false → 사이클 트리거 없음). 정기
   *      회차가 고정 키를 쓰면 그 키는 재시작 뒤에도 영구 봉쇄된다.
   *   2. doctor cleanup 점검이 계속 unhealthy 로 남아 진짜 정체와 구분되지 않는다.
   *
   * 회수 상태는 failed 다 — completed 로 위장하면 하지 않은 처리를 한 것처럼 남기고,
   * cancelled 는 사용자 취소를 뜻하므로 둘 다 거짓이 된다. 죽은 프로세스가 남긴 미완
   * 실행은 정직하게 실패다. 대상별 결과 원장(cleanup_stage_results)은 손대지 않는다 —
   * 죽기 전 완료분은 그대로 유효하고, 미완 대상은 지문·재시도 규칙이 알아서 재평가한다.
   *
   * @param maxRunAgeMs 이 시간을 넘겨 running 인 행을 죽은 run 으로 본다.
   * @param now 현재 시각 ms(테스트 주입). 기본 Date.now.
   * @returns 회수한 runId 목록(빈 배열 = 회수 대상 없음 — 정상).
   */
  reclaimStaleRuns(maxRunAgeMs: number, now: number = Date.now()): string[] {
    // 컷오프를 started_at 과 *같은 zone* 문자열로 만든다 — 저장 시각이 nowKst() 로
    // 설정 시간대에 적히므로, UTC 로 컷오프를 만들면 최대 9시간 어긋난다(helpers.ts
    // pastCutoffInZone 주석의 P3 G3-b 실버그와 같은 함정). "YYYY-MM-DD HH:MM:SS" 는
    // 자릿수가 고정이라 사전식 비교가 곧 시간 비교다.
    const cutoff = pastCutoffInZone(now - maxRunAgeMs);
    const stale = this.db
      .query(
        "SELECT run_id FROM cleanup_runs WHERE status = 'running' AND started_at < ?",
      )
      .all(cutoff) as { run_id: string }[];
    if (stale.length === 0) return [];

    const aggregates: CleanupRunAggregates = { ...emptyRunAggregates(), stopReason: STALE_RUN_STOP_REASON };
    // finishRun CAS 결과로 거른다 — SELECT 와 UPDATE 사이에 다른 경로가 먼저
    // 확정한 행은 회수한 것이 아니므로 목록에 싣지 않는다(회수 건수 정직 보고).
    const reclaimed: string[] = [];
    for (const row of stale) {
      if (this.finishRun({ runId: row.run_id, status: "failed", aggregates })) {
        reclaimed.push(row.run_id);
      }
    }
    return reclaimed;
  }

  /**
   * 마지막 "전체 실행"의 시작 시각(설정 시간대 "YYYY-MM-DD HH:MM:SS") 또는 없으면 null.
   * 정기 실행 예약의 기준점이다(deep-pass-schedule.ts) — 서버 재시작과 무관하게 남는 기록이라
   * 재시작해도 일정이 밀리지 않는다.
   *
   * 전체 실행 = 켜진 단계 전부를 대상 제한 없이 실제로 돌린 run. 그래서 다음은 세지 않는다:
   *  - 단계를 골랐거나(stages) 메모를 정한(nodeIds) 부분 실행 — 메모 저장 직후 정리가 여기 든다.
   *    이것까지 세면 저장이 잦을 때 전체 정리가 영영 밀린다.
   *  - dryRun — AI 를 부르지 않은 추정 실행.
   *  - failed — 끝까지 못 간 실행(재시작으로 멈춘 run 회수 포함). 다음 자정에 다시 시도한다.
   * cancelled 는 센다 — 사용자가 일부러 멈춘 실행을 다음 자정에 바로 다시 돌리지 않는다.
   */
  lastFullRunStartedAt(): string | null {
    const row = this.db
      .query(
        `SELECT MAX(started_at) AS started_at FROM cleanup_runs
         WHERE status IN ('completed', 'cancelled')
           AND json_extract(options_json, '$.stages') IS NULL
           AND json_extract(options_json, '$.nodeIds') IS NULL
           AND COALESCE(json_extract(options_json, '$.dryRun'), 0) = 0`,
      )
      .get() as { started_at: string | null } | null;
    return row?.started_at ?? null;
  }

  /** run 한 건 조회(파싱된 형) 또는 없으면 null. */
  getRun(runId: string): CleanupRunRow | null {
    const raw = this.db
      .query("SELECT * FROM cleanup_runs WHERE run_id = ?")
      .get(runId) as RawRunRow | null;
    if (!raw) return null;
    return this.mapRow(raw);
  }

  /** run status 가 'running' 인지(취소 가능 여부 판정 자료). 없으면 null. */
  statusOf(runId: string): CleanupRunStatus | null {
    const raw = this.db
      .query("SELECT status FROM cleanup_runs WHERE run_id = ?")
      .get(runId) as { status: string } | null;
    return raw ? (raw.status as CleanupRunStatus) : null;
  }

  private mapRow(raw: RawRunRow): CleanupRunRow {
    return {
      runId: raw.run_id,
      trigger: raw.trigger as CleanupRunTrigger,
      status: raw.status as CleanupRunStatus,
      startedAt: raw.started_at,
      finishedAt: raw.finished_at,
      options: JSON.parse(raw.options_json) as CleanupRunOptions,
      aggregates:
        raw.aggregates_json && raw.aggregates_json !== "{}"
          ? (JSON.parse(raw.aggregates_json) as CleanupRunAggregates)
          : null,
      idempotencyKey: raw.idempotency_key,
    };
  }
}
