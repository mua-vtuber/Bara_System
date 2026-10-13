/**
 * scheduler-core.ts — 시계 정렬 스케줄러 골격 (scheduler.ts 에서 꺼냄, 2026-10-11 document-ocr spec D11·T3).
 *
 * 추출 백필·이미지 캡션 백필·정리 깊은 패스·문서 OCR 네 스케줄러가 같은 런타임 메커니즘을 쓴다. 각자 다른 점은
 * 한 사이클 내용(runCycle)과 요약 타입(S)·실행 컨텍스트 타입(C)뿐이다. 그래서 요약 타입을 일반화해 한 곳에 둔다
 * (옛 startGenericBackfillScheduler 와 동작이 같다 — 요약 타입만 매개변수가 됐다).
 *
 * 공유 동작:
 *  - `intervalMs < 60_000` 이면 즉시 throw (AI 과부하 차단 안전선).
 *  - 즉시 트리거 안 함 — 다음 경계(설정 시간대 자정 격자 + offset)에 첫 사이클이 setTimeout 으로 돌고, 사이클이 끝나면
 *    다음 경계로 다시 예약한다(시계 정렬). 서버 켠 시각이 아니라 격자 기준으로 정렬된다.
 *  - 겹침 방지 — 진행 중 사이클이 있으면 그 결과를 기다린다(중복 가동 차단). running 이 단일 출처.
 *  - stop() 후 tickNow → 즉시 빈 요약(emptySummary) / 진행 중 사이클은 끝까지 기다린 뒤 멈춤.
 *  - lastSummary() — 마지막 사이클 요약.
 */

import { msUntilNextBoundary } from "./schedule-timing.ts";

/**
 * tryTickNow 원자 회신 — 'started'(이번 호출이 사이클을 가동함) / 'already_running'(이미 진행 중 사이클이 있어
 * 이 호출은 겹치지 않게 물러남). run API 동시성 게이트가 이 값으로 409(already_running)를 정한다.
 */
export type TryTickResult = "started" | "already_running";

export interface ClockAlignedSchedulerHandle<S, C> {
  /** 스케줄러 정지 — 진행 중 사이클은 끝까지 기다리고 멈춤. */
  stop(): Promise<void>;
  /** 다음 사이클 즉시 강제 실행 — 진행 중 사이클이 있으면 그 결과를 기다린다(overlap 방지). */
  tickNow(ctx?: C): Promise<S>;
  /**
   * 원자 트리거 — 진행 중 사이클이 없으면 ctx 로 사이클을 *비동기* 가동하고 즉시 'started'. 이미 진행 중이면
   * 'already_running'. 사이클 자체의 완료·집계 기록은 사이클 내부가 책임진다.
   */
  tryTickNow(ctx: C): TryTickResult;
  /** 지금 사이클이 진행 중인지(정기 tick·수동 실행 모두). */
  isRunning(): boolean;
  /** 마지막 사이클 요약. */
  lastSummary(): S | null;
}

export interface ClockAlignedSchedulerArgs<S, C> {
  /** 사이클 간격 (ms). 60_000 미만이면 throw. */
  intervalMs: number;
  /** 사이클 간격 (분). msUntilNextBoundary 격자 계산용. */
  intervalMin: number;
  /** 경계 격자 오프셋 (분). */
  offsetMin: number;
  logPrefix: string;
  /** 한 사이클 처리 콜백 — 후보 조회 + 처리 + 요약 회신. */
  runCycle: (ctx?: C) => Promise<S>;
  /** stop() 뒤 tickNow 가 돌려줄 0건 요약. */
  emptySummary: () => S;
  /** 현재 시각 주입 (테스트용). 미주입 시 Date.now. */
  now?: () => number;
  /** setTimeout 주입 (테스트용). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout 주입 (테스트용). setTimeoutFn 과 짝. */
  clearTimeoutFn?: (handle: unknown) => void;
}

export function startClockAlignedScheduler<S, C>(
  args: ClockAlignedSchedulerArgs<S, C>,
): ClockAlignedSchedulerHandle<S, C> {
  if (args.intervalMs < 60_000) {
    throw new Error(
      `intervalMs must be >= 60000 (got ${args.intervalMs}). Tighter intervals risk hammering the LLM.`,
    );
  }
  const logPrefix = args.logPrefix;
  const now = args.now ?? (() => Date.now());
  const schedule = args.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    args.clearTimeoutFn ??
    ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let last: S | null = null;
  let running = false;
  let stopped = false;
  let inflight: Promise<S> | null = null;
  let pendingTimer: unknown | null = null;

  async function tick(ctx?: C): Promise<S> {
    if (stopped) {
      return args.emptySummary();
    }
    if (running) {
      // 이미 진행 중인 사이클이 있으면 그것의 결과 기다림 — overlap 방지.
      return inflight as Promise<S>;
    }
    running = true;
    inflight = (async () => {
      const summary = await args.runCycle(ctx);
      last = summary;
      return summary;
    })();
    try {
      return await inflight;
    } finally {
      running = false;
      inflight = null;
    }
  }

  /**
   * running 플래그를 단일 출처로 재사용해 겹침을 막는다. tick 이 running 재확인·설정을 원자로 하므로(JS 단일
   * 스레드 — check 와 set 사이 yield 없음) 두 트리거가 겹치지 않는다. 사이클 throw 는 로그로만 남긴다.
   */
  function tryTickNow(ctx: C): TryTickResult {
    if (stopped || running) {
      return "already_running";
    }
    void tick(ctx).catch((e) => {
      console.error(
        `${logPrefix} tryTickNow cycle error: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    return "started";
  }

  // 시계 정렬 다음-경계 재예약. 사이클 throw 도 다음 경계로 흐름 끊김 차단.
  function scheduleNext(): void {
    if (stopped) return;
    const delay = msUntilNextBoundary(now(), args.intervalMin, args.offsetMin);
    pendingTimer = schedule(() => {
      pendingTimer = null;
      void tick()
        .catch((e) => {
          console.error(
            `${logPrefix} unhandled cycle error: ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .then(() => scheduleNext());
    }, delay);
  }

  scheduleNext();

  return {
    async stop() {
      stopped = true;
      if (pendingTimer !== null) {
        cancel(pendingTimer);
        pendingTimer = null;
      }
      if (inflight) {
        // 진행 중 사이클의 실패는 그 사이클의 로그·상태가 이미 알린다 — 정지 절차는 끝나기만 기다린다.
        try { await inflight; } catch { /* 사이클 오류는 tick 호출부가 기록함 */ }
      }
    },
    async tickNow(ctx?: C) {
      return tick(ctx);
    },
    tryTickNow,
    isRunning() {
      return running;
    },
    lastSummary() {
      return last;
    },
  };
}

/** 다음 정기 사이클 시각(ms epoch) — 상태 화면의 "다음 처리" 표시용. 골격과 같은 격자 계산. */
export function nextClockAlignedRunAt(nowMs: number, intervalMin: number, offsetMin: number): number {
  return nowMs + msUntilNextBoundary(nowMs, intervalMin, offsetMin);
}
