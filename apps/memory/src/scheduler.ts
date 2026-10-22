/**
 * 백그라운드 백필 스케줄러.
 *
 * 봇은 실시간으로 raw 메모리를 즉시 저장(`/memories`)하고, 본 스케줄러가
 * 일정 간격으로 미분해 `auto_capture` 노드를 N개씩 집어 LLM에 던져
 * atomic 자식 노드들로 분해 + merged_into 엣지로 연결한다.
 *
 * 이렇게 분리하면:
 *   - 디스코드 답글이 1초 안에 ✅ — LLM 속도 영향 0.
 *   - LLM 호출 실패해도 raw는 안 사라짐.
 *   - A1 환경에서 LLM 없이도 봇이 돌아감 — 분해는 PC가 가끔 받아갈 때만.
 *   - 모델 교체/API 전환 시 봇 코드 안 만짐.
 *
 * Phase 2.3 evolver(클러스터링/병합)와 별개 — 본 모듈은 "extract"
 * 단계만 책임진다. 두 모듈이 같은 DB에 차근차근 누적.
 */

import type { MemoryExtractor } from "./memory/extractor.ts";
import type { SqliteMemoryStore } from "./db/store.ts";
import {
  startClockAlignedScheduler,
  type ClockAlignedSchedulerHandle,
  type TryTickResult,
} from "./scheduler-core.ts";
import type { AssetStore } from "./assets/asset-store.ts";
import type { VisionProvider, VisionProviderSettings } from "./llm/vision/index.ts";
import { runVisionBackfillCycle } from "./memory/vision-backfill.ts";
import {
  commitBackfillCandidate,
  prepareBackfillCandidate,
} from "./memory/backfill-extraction.ts";
import type { ChunkingSettings } from "./memory/origin-chunks.ts";
import { extractionTargetKey } from "./db/store-internal/backfill-attempts-sql.ts";
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "./memory/backfill-attempts/ledger.ts";
import {
  BackfillCycleGuard,
  formatRetrySummary,
  type BackfillRetrySummary,
} from "./memory/backfill-attempts/cycle-guard.ts";
import { extractionFingerprint } from "./memory/backfill-attempts/fingerprint.ts";
import { msUntilNextDeepPass } from "./memory/cleanup-deep-pass/deep-pass-schedule.ts";
import { pastCutoffInZone } from "./db/store-internal/helpers.ts";
import { inspectExtractionAttempt } from "./memory/backfill-attempts/targets.ts";

/**
 * 백필 사이클 기본 간격 (분).
 *
 * legacy embedding migration B3 정착 (2026-05-17, [[extractor-final-config-v2-2026-05-17]]):
 * 30분 — extractor 32B가 raw 노드를 차근차근 분해해도 디스코드 답글에는
 * 영향 없고, 본인 매일 사용 흐름에서 1시간 안에 추출 완료를 체감할 수
 * 있다. 0으로 두면 스케줄러 비활성, env `BACKFILL_INTERVAL_MIN`로 override.
 */
export const DEFAULT_BACKFILL_INTERVAL_MIN = 30;

/**
 * env `BACKFILL_INTERVAL_MIN`을 파싱해 사이클 간격(분)을 반환.
 *
 * - 미설정/비숫자/음수 → `DEFAULT_BACKFILL_INTERVAL_MIN` (30).
 * - 0 → 스케줄러 비활성 신호 (호출자가 0이면 안 켬).
 * - 양의 정수 → 그 값.
 */
export function parseBackfillIntervalMin(
  raw: string | undefined,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_BACKFILL_INTERVAL_MIN;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_BACKFILL_INTERVAL_MIN;
  }
  return parsed;
}

export interface BackfillSchedulerOptions {
  /** 한 사이클 간격 (밀리초). 60_000 미만이면 즉시 실패. */
  intervalMs: number;
  /** 한 사이클당 처리할 미분해 raw 노드 최대 수. 기본 10. */
  batchSize?: number;
  /** importance 하한. 이 값 미만 raw 노드는 건너뜀. 기본 0. */
  minImportance?: number;
  /**
   * 청크 설정(settings.chunking). 저장 경로와 같은 기준으로 긴 원문을 판정해, 긴 원문 후보는
   * 추출하지 않고 재청크한다(WP-B1-31). 생략하면 저장 경로에 청크 설정이 없을 때와 같은
   * chunkDocument 기본 한도를 쓴다.
   */
  chunking?: ChunkingSettings;
  /**
   * 실패 기록·재시도 규칙(2026-10-14 backfill-retry-ledger spec 4.4) — settings.llm.extractor.backfill 의
   * maxAttempts·retryDelayMin·retryMaxDelayMin. 필수다: 빠진 채 기록 없이 돌면 실패 대상이 매 주기 CPU 를 잡는다.
   */
  retry: { policy: BackfillRetryPolicy };
  /** 사이클마다 호출되는 콜백 (관측·테스트용). */
  onCycleComplete?: (summary: BackfillCycleSummary) => void;
  /** 로그 출력 prefix. 기본 "[memory-api scheduler]". */
  logPrefix?: string;
  /** 사이클 시작 오프셋 (분). extractor=0, vision=floor(intervalMin/2). 기본 0. */
  offsetMin?: number;
  /** 현재 시각 주입 (테스트용). 미주입 시 Date.now. */
  now?: () => number;
  /** setTimeout 주입 (테스트용). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 주입 (테스트용). */
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface BackfillCycleSummary {
  startedAt: string;
  durationMs: number;
  candidatesFound: number;
  processed: number;
  storedNodes: number;
  bumpedNodes: number;
  failures: number;
  /**
   * WP-B1-08R (Minor 3) — long origins re-chunked instead of extracted this cycle
   * (WP-B1-31). Already counted in the cycle's log line; now exposed on the summary too
   * so callers other than the log (tickNow/onCycleComplete consumers) can see it.
   */
  rechunked: number;
  /** WP-B1-08R (Minor 3) — candidates whose prepared LLM result could not be used and was discarded. */
  discarded: number;
  /**
   * 실패 기록 요약(2026-10-14 spec 4.5) — 대기·멈춤 수와 주기 중단 사유. 실패 기록을 쓰지 않는 주기(정리 깊은 패스의
   * 형식 어댑터, 아직 연결 전인 캡션)는 null.
   */
  retry: BackfillRetrySummary | null;
}

/**
 * 깊은 패스 run API(spec 5.B-1) 가 tickNow/tryTickNow 에 실어 보내는 실행 컨텍스트.
 * 정기 tick 은 이 컨텍스트 없이(undefined) 돌고, 수동 run 은 stages/dryRun/maxCalls/
 * cancelSignal + runId 를 실어 사이클이 그 옵션대로 돌게 한다. extractor·vision
 * runCycle 은 이 인자를 무시한다(그 갈래엔 run 개념이 없다) — 깊은 패스만 소비한다.
 */
export interface CleanupRunContext {
  /** 이 실행의 cleanup_runs.run_id — 사이클이 결과 집계를 이 run 에 기록한다. */
  runId: string;
  /** 부분 실행 단계 필터(생략 시 켜진 단계 전부). */
  stages?: string[];
  /** dryRun — LLM 호출 0, 후보 검출 + 입력 추정만. */
  dryRun?: boolean;
  /** 이번 run 한정 호출 수 상한 덮어쓰기. */
  maxCalls?: number;
  /** run 취소 AbortSignal(cancel 라우트가 abort → 실행층 모든 호출 signal 전파). */
  cancelSignal?: AbortSignal;
  /** 이 메모들만 후보로(입력 직후 정리·펫 바로 정리). 메모 단위 단계(entityRegister·personLink)만 읽는다. */
  nodeIds?: number[];
}

export type { TryTickResult };

/** 세 백필 스케줄러의 핸들 — 골격 핸들을 BackfillCycleSummary·CleanupRunContext 로 고정한 것. */
export type BackfillSchedulerHandle = ClockAlignedSchedulerHandle<BackfillCycleSummary, CleanupRunContext>;

/**
 * 빈 사이클 요약 — stop() 후 tickNow 가 회신하는 표시용 0건 묶음.
 */
function emptySummary(): BackfillCycleSummary {
  return {
    startedAt: new Date().toISOString(),
    durationMs: 0,
    candidatesFound: 0,
    processed: 0,
    storedNodes: 0,
    bumpedNodes: 0,
    failures: 0,
    rechunked: 0,
    discarded: 0,
    retry: null,
  };
}

/**
 * 스케줄러 런타임 골격 — 시계 정렬·겹침 방지·정지 시 진행 중 사이클 기다리기·60초 미만 거부는
 * scheduler-core.ts 의 startClockAlignedScheduler 가 맡는다(문서 OCR 도 같은 골격을 다른 요약 타입으로 쓴다).
 * 여기 세 스케줄러는 요약 타입 BackfillCycleSummary·실행 컨텍스트 CleanupRunContext 로 부른다(동작 불변).
 */
function startGenericBackfillScheduler(args: {
  intervalMs: number;
  intervalMin: number;
  offsetMin: number;
  logPrefix: string;
  runCycle: (ctx?: CleanupRunContext) => Promise<BackfillCycleSummary>;
  nextDelayMs?: (nowMs: number) => number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}): BackfillSchedulerHandle {
  return startClockAlignedScheduler<BackfillCycleSummary, CleanupRunContext>({ ...args, emptySummary });
}

/**
 * setTimeout 재예약 기반 백필 스케줄러를 시작. 즉시 한 번 트리거하지 않고,
 * 다음 경계(KST 자정 anchor + offset)에 첫 사이클이 돈다. 정지하려면 반환된
 * 핸들의 `stop()`.
 *
 * Phase 11e T7 (DCL-1) — 런타임 골격은 `startGenericBackfillScheduler` 가 책임지고,
 * 이 함수는 extractor 전용 한 사이클(raw 후보 조회 → 후보별 준비·저장 → 요약)을
 * `runCycle` 콜백으로 넘긴다. 후보 한 건의 LLM 호출은 쓰기 잠금 밖, 저장은 잠금 안
 * 재확인 뒤다(WP-B1-07 — memory/backfill-extraction.ts). 후보 조회 기준
 * (auto_capture/minImportance), skipHashtagWiring, merged_into 엣지는 옛 흐름 그대로다.
 * 청크가 필요한 긴 원문 후보는 추출하지 않고 잠금 안에서 재청크한다(WP-B1-31). 재청크 실패는
 * 다른 후보 실패와 같이 노드 id·원인을 로그에 남기고 failures 로 세며, 재청크 실패도 실패 기록
 * 규칙(spec 4.3)을 따른다 — 감싼 원인으로 분류한다.
 */
export function startBackfillScheduler(
  extractor: MemoryExtractor,
  store: SqliteMemoryStore,
  options: BackfillSchedulerOptions,
): BackfillSchedulerHandle {
  const batchSize = options.batchSize ?? 10;
  const minImportance = options.minImportance ?? 0;
  const logPrefix = options.logPrefix ?? "[memory-api scheduler]";
  // 주기 시작 시각·막힘 판정 기준 시각은 주입 시계 하나에서 나온다(미주입 시 Date.now).
  const clock = options.now ?? Date.now;

  async function runCycle(): Promise<BackfillCycleSummary> {
    const startedAtMs = clock(); // 주기 시작 시각(요약용). guard 는 clock 을 직접 받아 막힘 기준은 생성 때, 다음 시도는 실패 순간에 읽는다.
    const startedAt = new Date(startedAtMs).toISOString();
    let processed = 0;
    let storedNodes = 0;
    let bumpedNodes = 0;
    let failures = 0;
    let discarded = 0;
    let rechunked = 0;

    // 2026-10-14 spec 4.5 — 주기 시작: 후보가 아닌 줄 정리 + 지문이 바뀐 줄 해제. 그다음 막힌 대상을 후보 SQL 안에서 뺀다.
    const guard = new BackfillCycleGuard({
      ledger: new BackfillAttemptsLedger(store.getRawDb()),
      kind: "extraction",
      policy: options.retry.policy,
      logPrefix,
      clock,
    });
    const { pruned, fingerprintCleared } = await guard.reconcile((row) => inspectExtractionAttempt(store, extractor.attemptIdentity, row));
    if (pruned > 0 || fingerprintCleared > 0) {
      console.log(`${logPrefix} extraction ledger reconcile: pruned=${pruned} fingerprintCleared=${fingerprintCleared}`);
    }

    const candidates = await store.getBackfillCandidates({
      limit: batchSize,
      minImportance,
      excludeBlockedAt: guard.now,
    });

    for (const listedCandidate of candidates) {
      const targetKey = extractionTargetKey(listedCandidate.id);
      try {
        // WP-B1-07 — LLM 호출은 쓰기 잠금 밖(준비), 저장은 잠금 안에서 후보를 다시 확인한
        // 뒤에만 한다. 후보가 준비 뒤 바뀌면 LLM 결과를 버리고 이유를 남긴다 — 추출 완료
        // 표시를 하지 않으므로 다음 주기에 다시 판정한다(버림은 실패가 아니라 기록하지 않는다).
        const prepared = await prepareBackfillCandidate(
          extractor, store, listedCandidate.id, options.chunking,
        );
        if (prepared === null) continue;
        const outcome = await commitBackfillCandidate(
          extractor, store, prepared, () => guard.recordSuccess(targetKey, `node ${listedCandidate.id}`),
        );
        if (outcome.kind === "discarded") {
          discarded += 1;
          console.warn(
            `${logPrefix} backfill result discarded for node ${listedCandidate.id}: ${outcome.reason}`,
          );
          continue;
        }
        if (outcome.kind === "rechunked") {
          rechunked += 1;
          console.log(
            `${logPrefix} long origin ${listedCandidate.id} re-chunked into ${outcome.chunkNodeIds.length} chunks — chunks are extracted next cycle`,
          );
          continue;
        }
        storedNodes += outcome.storedNodeIds.length;
        bumpedNodes += outcome.bumpedNodeIds.length;
        processed += 1;
        // 성공 저장은 끝났지만 지난 실패 줄을 지우지 못했다면(guard 가 크게 알리고 중단 사유를 정했다) 주기를 끝낸다.
        if (guard.isStopped) break;
      } catch (e) {
        failures += 1;
        console.error(
          `${logPrefix} backfill failed for node ${listedCandidate.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
        const verdict = guard.recordFailure(
          {
            targetKey,
            nodeId: listedCandidate.id,
            fingerprint: extractionFingerprint(extractor.attemptIdentity, listedCandidate.content),
            label: `node ${listedCandidate.id}`,
          },
          e,
        );
        // 연결 실패·설정 문제·취소 — 남은 후보도 같은 결과일 테니 건드리지 않고 주기를 끝낸다(spec 4.3).
        if (verdict === "stop") break;
      }
    }

    const retry = guard.summary();
    const summary: BackfillCycleSummary = {
      startedAt,
      durationMs: clock() - startedAtMs,
      candidatesFound: candidates.length,
      processed,
      storedNodes,
      bumpedNodes,
      failures,
      rechunked,
      discarded,
      retry,
    };

    if (candidates.length > 0) {
      console.log(
        `${logPrefix} cycle: ${processed}/${candidates.length} processed, +${storedNodes} nodes, ${bumpedNodes} bumped, ${rechunked} rechunked, ${discarded} discarded, ${failures} fail in ${summary.durationMs}ms, ${formatRetrySummary(retry)}`,
      );
    }
    options.onCycleComplete?.(summary);
    return summary;
  }

  const scheduler = startGenericBackfillScheduler({
    intervalMs: options.intervalMs,
    intervalMin: Math.round(options.intervalMs / 60_000),
    offsetMin: options.offsetMin ?? 0,
    logPrefix,
    runCycle,
    now: options.now,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });

  console.log(
    `${logPrefix} started (interval=${Math.round(options.intervalMs / 1000)}s, batch=${batchSize})`,
  );

  return scheduler;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 깊은 패스 Task 4 — 정규식 강화 깊은 패스 스케줄러 (intervalDays 주기)
// ─────────────────────────────────────────────────────────────────────────────

export interface CleanupDeepPassSchedulerOptions {
  /** 사이클 주기 (일). >=1 이어야 한다(호출자가 미리 게이트). */
  intervalDays: number;
  /**
   * 한 사이클 실행 콜백 (void). 깊은 패스는 자체 요약 타입(RegexStrengthenCycleSummary)을
   * 쓰므로, 여기서는 결과를 묻지 않는 void 콜백으로 받아 골격에 BackfillCycleSummary 로
   * 감싼다(아래 wrap). 후보 0·LLM 미가용 등 graceful 분기는 콜백 내부 책임.
   *
   * ctx = 수동 run 컨텍스트(spec 5.B-1). 정기 tick 은 undefined(켜진 단계 전부·정상 예산·
   * 취소 신호 없음), 수동 run 은 stages/dryRun/maxCalls/cancelSignal + runId 를 실어 보낸다.
   */
  runCycle: (ctx?: CleanupRunContext) => Promise<void>;
  /**
   * 마지막 전체 실행의 시작 시각(설정 시간대 "YYYY-MM-DD HH:MM:SS") 또는 null — 실행 기록
   * (CleanupRunsLedger.lastFullRunStartedAt)을 읽는다. 다음 정기 실행을 이 기록 기준으로 잡아,
   * 서버를 다시 켜도 주기가 처음부터 다시 세지지 않는다(deep-pass-schedule.ts). 예약할 때마다 새로 읽는다.
   */
  lastFullRunStartedAt: () => string | null;
  /** 로그 출력 prefix. 기본 "[cleanup-deep-pass scheduler]". */
  logPrefix?: string;
  /** 현재 시각 주입 (테스트용). 미주입 시 Date.now. */
  now?: () => number;
  /** setTimeout 주입 (테스트용). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 주입 (테스트용). */
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Phase 7 깊은 패스 Task 4 — 정규식 강화 깊은 패스 스케줄러를 시작.
 *
 * extractor·vision 스케줄러와 *같은 런타임 골격*(`startGenericBackfillScheduler`)을
 * 공유한다 — 재예약·overlap 가드·stop/tickNow/lastSummary 를 다시 작성하지 않는다(DCL-1 정합).
 * 깊은 패스 전용 = 다음 실행 시각 계산뿐이다. 주기가 *일* 단위라 "오늘 자정 + 주기" 격자를 쓰면
 * 주기 안에 재시작할 때마다 날짜가 다시 세져 한 번도 돌지 않는다(2026-10-22 실측). 그래서
 * 실행 기록의 마지막 전체 실행 + intervalDays 의 자정으로 잡는다(msUntilNextDeepPass).
 *
 * 깊은 패스 사이클(runRegexStrengthenCycle)은 자체 요약 타입을 쓰는 void 흐름이라,
 * 골격이 요구하는 BackfillCycleSummary 로 빈 요약을 감싼다(emptySummary). 깊은 패스의
 * 진짜 사이클 요약·로그는 runRegexStrengthenCycle 이 직접 책임진다 — 이 래퍼는 골격
 * 재예약을 위한 형식 어댑터일 뿐이다.
 *
 * 안전: 골격은 intervalMs<60_000 이면 throw 한다. intervalDays>=1 이면 1440*60_000ms =
 * 하루로 그 선보다 한참 위라 안전하지만, 호출자(index.ts)가 intervalDays>=1 을 *구성
 * 전에* 게이트하므로 throw 에 의존하지 않는다(graceful 비활성 + 명시 로그가 책임).
 */
export function startCleanupDeepPassScheduler(
  options: CleanupDeepPassSchedulerOptions,
): BackfillSchedulerHandle {
  const logPrefix = options.logPrefix ?? "[cleanup-deep-pass scheduler]";
  const intervalMin = options.intervalDays * 1440;

  // 깊은 패스는 자체 요약 타입을 쓰는 void 사이클이라, 골격이 요구하는
  // BackfillCycleSummary 로 빈 요약을 감싼다(형식 어댑터 — 실제 요약·로그는
  // runRegexStrengthenCycle 책임).
  const runCycle = async (ctx?: CleanupRunContext): Promise<BackfillCycleSummary> => {
    await options.runCycle(ctx);
    return emptySummary();
  };

  const scheduler = startGenericBackfillScheduler({
    intervalMs: intervalMin * 60_000,
    intervalMin,
    offsetMin: 0,
    logPrefix,
    runCycle,
    nextDelayMs: (nowMs) => {
      const last = options.lastFullRunStartedAt();
      const delay = msUntilNextDeepPass(nowMs, options.intervalDays, last);
      console.log(
        `${logPrefix} next run at ${pastCutoffInZone(nowMs + delay)} (intervalDays=${options.intervalDays}, last full run=${last ?? "none"})`,
      );
      return delay;
    },
    now: options.now,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });

  console.log(
    `${logPrefix} started (intervalDays=${options.intervalDays})`,
  );

  return scheduler;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11e G2-3 (T7 / DCL-1) — vision(VLM 캡션) 백필 스케줄러
// ─────────────────────────────────────────────────────────────────────────────

export interface VisionBackfillSchedulerOptions {
  /** 한 사이클 간격 (밀리초). 60_000 미만이면 즉시 실패 (extractor 와 같은 안전선). */
  intervalMs: number;
  /** 한 사이클당 캡션할 미캡션 이미지 최대 수. 기본 10. */
  batchSize?: number;
  /**
   * 캡션 프롬프트 글 (settings.llm.vision.captionPrompt). 빈 값이면 caption-flow 가
   * 개정된 한국어 검색용 default 를 쓴다 (Phase 11e G2-4).
   */
  captionPrompt?: string;
  /** 실패 기록·재시도 규칙(2026-10-14 spec 4.4) — settings.llm.vision.backfill 의 세 칸. 필수. */
  retry: { policy: BackfillRetryPolicy };
  /** 사이클마다 호출되는 콜백 (관측·테스트용). */
  onCycleComplete?: (summary: BackfillCycleSummary) => void;
  /** 로그 출력 prefix. 기본 "[memory-api vision-scheduler]". */
  logPrefix?: string;
  /** 사이클 시작 오프셋 (분). extractor=0, vision=floor(intervalMin/2). 기본 0. */
  offsetMin?: number;
  /** 현재 시각 주입 (테스트용). 미주입 시 Date.now. */
  now?: () => number;
  /** setTimeout 주입 (테스트용). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 주입 (테스트용). */
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Phase 11e G2-3 (T7 / DCL-1) — VLM 캡션 백필 스케줄러를 시작.
 *
 * extractor 스케줄러(`startBackfillScheduler`)와 *런타임 골격*(setInterval·intervalMs
 * 가드·overlap 방지·stop/tickNow/lastSummary)을 `startGenericBackfillScheduler` 로
 * 공유하고, vision 전용은 *한 사이클 내용*뿐이다:
 *   - 후보 조회 = `store.getUncaptionedImageCandidates`(has_caption_auto=0 / created_at
 *     ASC / batchSize) — extractor 의 raw/minImportance 후보와 다른 점.
 *   - 처리 = 각 후보를 `runVisionBackfillCycle` 가 assetStore 원본 로드 →
 *     applyVlmCaptionFlow({ forceCall: true }) → image_caption 자식 + has_caption_auto=1.
 *
 * mode='backfill' 모드가 미캡션 이미지(신규 업로드 + 기존 소급)를 같은 풀로 흡수한다 —
 * 별도 일회성 도구 없이 스케줄러 주기가 소진까지 줍는다(spec §10.4).
 *
 * graceful: provider=null(미설정·로드 실패)은 호출자(index.ts)가 스케줄러 자체를 안
 * 켜고 명시 로그를 남기는 책임 — 이 함수는 provider 가 가용한 갈래에서만 가동한다.
 * 단 사이클 안 개별 캡션 실패(VLM throw)는 warn + has_caption_auto=0 유지(다음 주기
 * 재시도) — 실패를 성공으로 위장 안 함(runVisionBackfillCycle 책임).
 *
 * intervalMs<60_000 throw 가드를 extractor 와 같이 승계 — 1분 미만 주기는 VLM 과부하.
 */
export function startVisionBackfillScheduler(
  store: SqliteMemoryStore,
  assetStore: AssetStore,
  visionSettings: VisionProviderSettings,
  provider: VisionProvider,
  options: VisionBackfillSchedulerOptions,
): BackfillSchedulerHandle {
  const batchSize = options.batchSize ?? 10;
  const logPrefix = options.logPrefix ?? "[memory-api vision-scheduler]";

  async function runCycle(): Promise<BackfillCycleSummary> {
    const summary = await runVisionBackfillCycle({
      store,
      assetStore,
      visionSettings,
      provider,
      batchSize,
      captionPrompt: options.captionPrompt,
      logPrefix,
      retry: options.retry,
      now: options.now,
    });
    options.onCycleComplete?.(summary);
    return summary;
  }

  const scheduler = startGenericBackfillScheduler({
    intervalMs: options.intervalMs,
    intervalMin: Math.round(options.intervalMs / 60_000),
    offsetMin: options.offsetMin ?? 0,
    logPrefix,
    runCycle,
    now: options.now,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });

  console.log(
    `${logPrefix} started (interval=${Math.round(options.intervalMs / 1000)}s, batch=${batchSize})`,
  );

  return scheduler;
}
