/**
 * 시계 정렬 스케줄러 골격 — 요약 타입이 BackfillCycleSummary 가 아니어도 같은 겹침 방지·정지 동작 (document-ocr spec T3).
 * 실제 골격 함수에 시계·타이머만 주입한다.
 */
import { describe, expect, test } from "bun:test";
import { nextClockAlignedRunAt, startClockAlignedScheduler } from "./scheduler-core.ts";

interface PageSummary {
  pages: number;
}

function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeoutFn: (handle: unknown) => {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
  };
}

describe("startClockAlignedScheduler — 다른 요약 타입", () => {
  test("60초 미만 간격은 거부한다", () => {
    expect(() =>
      startClockAlignedScheduler<PageSummary, undefined>({
        intervalMs: 59_999, intervalMin: 1, offsetMin: 0, logPrefix: "[t]",
        runCycle: async () => ({ pages: 1 }), emptySummary: () => ({ pages: 0 }),
      }),
    ).toThrow("intervalMs must be >= 60000");
  });

  test("겹침 방지: 진행 중이면 tryTickNow 는 already_running, tickNow 는 같은 결과를 기다린다", async () => {
    const timers = manualTimers();
    let release!: () => void;
    let calls = 0;
    const handle = startClockAlignedScheduler<PageSummary, { id: string }>({
      intervalMs: 60_000, intervalMin: 1, offsetMin: 0, logPrefix: "[t]",
      runCycle: async () => {
        calls += 1;
        await new Promise<void>((r) => { release = r; });
        return { pages: 7 };
      },
      emptySummary: () => ({ pages: 0 }),
      now: () => 0,
      ...timers,
    });
    expect(handle.tryTickNow({ id: "a" })).toBe("started");
    expect(handle.isRunning()).toBe(true);
    expect(handle.tryTickNow({ id: "b" })).toBe("already_running");
    const waiting = handle.tickNow();
    release();
    expect(await waiting).toEqual({ pages: 7 });
    expect(calls).toBe(1);
    expect(handle.lastSummary()).toEqual({ pages: 7 });
    expect(handle.isRunning()).toBe(false);
    await handle.stop();
  });

  test("stop 은 진행 중 사이클을 기다리고, 그 뒤 tickNow 는 빈 요약", async () => {
    const timers = manualTimers();
    let release!: () => void;
    let finished = false;
    const handle = startClockAlignedScheduler<PageSummary, undefined>({
      intervalMs: 60_000, intervalMin: 1, offsetMin: 0, logPrefix: "[t]",
      runCycle: async () => {
        await new Promise<void>((r) => { release = r; });
        finished = true;
        return { pages: 2 };
      },
      emptySummary: () => ({ pages: 0 }),
      now: () => 0,
      ...timers,
    });
    void handle.tickNow();
    const stopping = handle.stop();
    expect(finished).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(timers.pending.length).toBe(0);
    expect(await handle.tickNow()).toEqual({ pages: 0 });
  });

  test("다음 실행 시각은 골격과 같은 격자 계산", () => {
    const at = nextClockAlignedRunAt(0, 30, 15);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(30 * 60_000);
  });
});
