/**
 * 정규식 강화 깊은 패스 스케줄러(Phase 7 깊은 패스 Task 4) 구조 테스트.
 *
 * startCleanupDeepPassScheduler 는 extractor·vision 스케줄러와 같은 런타임 골격
 * (startGenericBackfillScheduler)을 공유하되 주기가 *일* 단위(intervalDays)다.
 * 실제 LLM·실제 타이머를 가동하지 않는다 — setTimeout/clearTimeout/now 를 주입하고
 * runCycle 콜백은 호출 횟수를 세는 데이터 sink(인터페이스 가짜 구현체 아님 / mock 객체
 * 금지 규칙 정합)로 둔다.
 *
 * 검증:
 *   - 첫 delay 가 msUntilNextBoundary(now, intervalDays*1440, 0) 와 일치(자정 격자 정렬).
 *   - 주입 타이머가 발화하면 runCycle 콜백이 불리고 다음 경계로 재예약된다.
 *   - stop() 이 진행 중 타이머를 clearTimeout 으로 취소하고 신규 등록을 멈춘다.
 *   - tickNow() 가 runCycle 을 즉시 한 번 가동한다.
 */

import { describe, expect, test } from "bun:test";
import { startCleanupDeepPassScheduler } from "./scheduler.ts";
import { msUntilNextBoundary } from "./schedule-timing.ts";
import { shouldRunSummaryStage } from "./memory/cleanup-deep-pass/summary-cycle.ts";
import { shouldRunCleanupDeepPass } from "./memory/cleanup-deep-pass/scheduler-gate.ts";

describe("startCleanupDeepPassScheduler — Phase 7 깊은 패스 Task 4", () => {
  test("첫 delay 가 intervalDays 격자(=intervalDays*1440분) 경계와 일치", () => {
    const captured: { fn: () => void; ms: number }[] = [];
    const nowMs = new Date("2026-06-05T10:07:00+09:00").getTime();
    let runs = 0;

    const handle = startCleanupDeepPassScheduler({
      intervalDays: 7,
      runCycle: async () => {
        runs += 1;
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    // 즉시 가동 X — 다음 경계까지 setTimeout 한 번만 예약. intervalMin = 7*1440 = 10080.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ms).toBe(msUntilNextBoundary(nowMs, 7 * 1440, 0));
    expect(runs).toBe(0);

    void handle.stop();
  });

  test("주입 타이머 발화 → runCycle 가동 + 다음 경계로 재예약", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let nowMs = new Date("2026-06-05T10:07:00+09:00").getTime();
    let runs = 0;

    const handle = startCleanupDeepPassScheduler({
      intervalDays: 1,
      runCycle: async () => {
        runs += 1;
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ms).toBe(msUntilNextBoundary(nowMs, 1 * 1440, 0));

    // mock clock 을 경계로 전진 후 콜백 수동 실행 → 사이클 + 재예약.
    nowMs += captured[0]!.ms;
    captured[0]!.fn();
    // tick().then(scheduleNext) 마이크로태스크 큐가 비워지길 기다린다.
    await new Promise((r) => setTimeout(r, 0));

    expect(runs).toBe(1);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.ms).toBe(msUntilNextBoundary(nowMs, 1 * 1440, 0));

    await handle.stop();
  });

  test("stop() — 진행 중 타이머 clearTimeout + 신규 등록 0", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let cancelled = 0;
    const nowMs = new Date("2026-06-05T10:07:00+09:00").getTime();

    const handle = startCleanupDeepPassScheduler({
      intervalDays: 3,
      runCycle: async () => {},
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {
        cancelled += 1;
      },
    });
    expect(captured).toHaveLength(1);

    await handle.stop();
    expect(cancelled).toBe(1);
    // stop 후 신규 setTimeout 등록 0.
    expect(captured).toHaveLength(1);
  });

  test("tickNow() — runCycle 즉시 한 번 가동", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let runs = 0;
    const nowMs = new Date("2026-06-05T10:07:00+09:00").getTime();

    const handle = startCleanupDeepPassScheduler({
      intervalDays: 7,
      runCycle: async () => {
        runs += 1;
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    await handle.tickNow();
    expect(runs).toBe(1);

    await handle.stop();
  });
});

/**
 * tryTickNow 원자 트리거 — run API 동시성 게이트(spec 5.B-1). run 컨텍스트(runId/stages/
 * dryRun/maxCalls/cancelSignal)를 실어 즉시 'started'|'already_running' 을 회신하고,
 * 사이클은 비동기로 돈다(202 non-blocking). 진행 중이면 겹치지 않게 물러난다.
 */
describe("tryTickNow 원자 트리거 — spec 5.B-1", () => {
  const nowMs = new Date("2026-07-11T10:07:00+09:00").getTime();

  test("한가할 때 tryTickNow → 'started' + 사이클 비동기 가동 + ctx 전달", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let seenCtx: unknown = "unset";
    const handle = startCleanupDeepPassScheduler({
      intervalDays: 7,
      runCycle: async (ctx) => {
        seenCtx = ctx;
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    const ctx = { runId: "run_1", dryRun: false, maxCalls: 5 };
    const res = handle.tryTickNow(ctx);
    expect(res).toBe("started");
    // 비동기 사이클이 마이크로태스크에서 ctx 를 받아 돌았는지.
    await new Promise((r) => setTimeout(r, 0));
    expect(seenCtx).toEqual(ctx);

    await handle.stop();
  });

  test("이미 진행 중이면 tryTickNow → 'already_running'(겹침 방지, 두 번째 ctx 무시)", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let cycleRuns = 0;
    const seenIds: string[] = [];
    const handle = startCleanupDeepPassScheduler({
      intervalDays: 7,
      runCycle: async (ctx) => {
        cycleRuns += 1;
        if (ctx) seenIds.push(ctx.runId);
        await gate; // 첫 사이클을 붙잡아 '진행 중' 상태를 만든다.
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    expect(handle.isRunning()).toBe(false);
    // 첫 트리거 = started(사이클이 gate 에서 대기하며 running 유지).
    expect(handle.tryTickNow({ runId: "run_A" })).toBe("started");
    await new Promise((r) => setTimeout(r, 0));
    // 데이터 초기화가 보는 진행 중 표시.
    expect(handle.isRunning()).toBe(true);
    // 두 번째 트리거 = already_running(첫 사이클 진행 중이라 겹치지 않음).
    expect(handle.tryTickNow({ runId: "run_B" })).toBe("already_running");

    // 첫 사이클 해제 → 딱 한 번만 돌았고 run_A 만 봤다(run_B 무시).
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(cycleRuns).toBe(1);
    expect(seenIds).toEqual(["run_A"]);
    expect(handle.isRunning()).toBe(false);

    await handle.stop();
  });

  test("stop 후 tryTickNow → 'already_running'(신규 가동 차단)", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    const handle = startCleanupDeepPassScheduler({
      intervalDays: 7,
      runCycle: async () => {},
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });
    await handle.stop();
    expect(handle.tryTickNow({ runId: "run_after_stop" })).toBe("already_running");
  });
});

/**
 * Phase 7 요약 단계 Task 7 — 둘째 단계(요약)가 첫 단계(정규식 강화) runCycle 안에
 * 순차로 합류하는지 검증.
 *
 * index.ts 모듈 본체는 top-level await 진입부라 단위 테스트가 어렵다(기존 JSDoc 명시).
 * 그래서 wiring 의 *판단 로직*을 두 갈래로 떼어 검증한다:
 *   (1) shouldRunSummaryStage — 요약 단계 가동 게이트(첫 단계 슬롯 상속 + summary.enabled)
 *       순수 함수. index.ts 의 runCycle 안 분기가 이 함수를 단일 출처로 쓴다.
 *   (2) runCycle 격자 — 정규식 강화 다음에 요약을 *순차로* 잇는 콜백을 만들어, 주입
 *       타이머가 발화하면 두 단계가 순서대로 한 번씩 불리고(게이트 통과), 게이트가
 *       막으면 요약만 건너뛰는지(첫 단계는 그대로) 확인. 실 LLM·실 타이머 0.
 */
describe("요약 단계 wiring — Phase 7 요약 단계 Task 7", () => {
  test("게이트 — 슬롯 4 조건 + summary.enabled 모두 충족해야 요약 단계 가동", () => {
    // 전부 충족 → true.
    expect(
      shouldRunSummaryStage({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 1,
        summaryEnabled: true,
      }),
    ).toBe(true);
  });

  test("게이트 — summary.enabled=false 면 요약만 건너뜀(default OFF)", () => {
    expect(
      shouldRunSummaryStage({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 1,
        summaryEnabled: false,
      }),
    ).toBe(false);
  });

  test("게이트 — cleanup LLM 미가용이면 요약 건너뜀(첫 단계 슬롯 상속)", () => {
    expect(
      shouldRunSummaryStage({
        cleanupEnabled: true,
        cleanupLlmAvailable: false,
        intervalDays: 1,
        summaryEnabled: true,
      }),
    ).toBe(false);
  });

  test("게이트 — 슬롯 enabled=false 또는 intervalDays<1 이면 요약 건너뜀", () => {
    expect(
      shouldRunSummaryStage({
        cleanupEnabled: false,
        cleanupLlmAvailable: true,
        intervalDays: 1,
        summaryEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldRunSummaryStage({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 0,
        summaryEnabled: true,
      }),
    ).toBe(false);
  });

  test("runCycle 격자 — 타이머 발화 시 정규식 강화 다음에 요약 순차 호출(게이트 통과)", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let nowMs = new Date("2026-06-05T10:07:00+09:00").getTime();
    const calls: string[] = [];

    // index.ts runCycle 콜백을 흉내 — 정규식 강화 다음에 게이트 통과 시 요약을 이어 부른다.
    const summaryGate = shouldRunSummaryStage({
      cleanupEnabled: true,
      cleanupLlmAvailable: true,
      intervalDays: 1,
      summaryEnabled: true,
    });
    const handle = startCleanupDeepPassScheduler({
      intervalDays: 1,
      runCycle: async () => {
        calls.push("regex");
        if (summaryGate) calls.push("summary");
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    nowMs += captured[0]!.ms;
    captured[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));

    // 두 단계가 같은 사이클 안 순서대로 한 번씩.
    expect(calls).toEqual(["regex", "summary"]);

    await handle.stop();
  });

  test("runCycle 격자 — 게이트 막히면 요약만 건너뛰고 정규식 강화는 가동", async () => {
    const captured: { fn: () => void; ms: number }[] = [];
    let nowMs = new Date("2026-06-05T10:07:00+09:00").getTime();
    const calls: string[] = [];

    const summaryGate = shouldRunSummaryStage({
      cleanupEnabled: true,
      cleanupLlmAvailable: true,
      intervalDays: 1,
      summaryEnabled: false, // 요약만 OFF.
    });
    const handle = startCleanupDeepPassScheduler({
      intervalDays: 1,
      runCycle: async () => {
        calls.push("regex");
        if (summaryGate) calls.push("summary");
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });

    nowMs += captured[0]!.ms;
    captured[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));

    // 첫 단계는 돌고, 요약은 게이트가 막아 건너뜀.
    expect(calls).toEqual(["regex"]);

    await handle.stop();
  });
});

/**
 * 게이트 재구성 wiring — spec 5.B-2. index.ts runCycle 은 각 단계를 자기 게이트로
 * 판단하고, 스케줄러 기동은 shouldRunCleanupDeepPass(슬롯 공통 + 단계 OR)로 정한다.
 * 옛 게이트가 막던 "정규식 OFF + 요약만 ON" 조합이 이제 가동되는지 + 기존 조합이
 * 보존되는지를 runCycle 격자로 확인한다(실 LLM·실 타이머 0).
 */
describe("게이트 재구성 wiring — spec 5.B-2", () => {
  /** index.ts runCycle 을 흉내 — 각 단계를 자기 게이트대로 순차 호출한다. */
  function runCycleGrid(gates: {
    regexStageOn: boolean;
    summaryStageOn: boolean;
    personLinkStageOn: boolean;
    lensDraftStageOn?: boolean;
  }): string[] {
    const calls: string[] = [];
    if (gates.regexStageOn) calls.push("regex");
    if (gates.summaryStageOn) calls.push("summary");
    if (gates.personLinkStageOn) calls.push("personLink");
    if (gates.lensDraftStageOn) calls.push("lensDraft");
    return calls;
  }

  test("정규식 OFF + 요약만 ON → 기동하고 요약만 돈다(옛 게이트가 막던 조합)", async () => {
    const gates = {
      regexStageOn: false,
      summaryStageOn: true,
      personLinkStageOn: false,
      lensDraftStageOn: false,
    };
    expect(
      shouldRunCleanupDeepPass({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 7,
        ...gates,
        entityRegisterStageOn: false,
        cleanupModelKeyMissing: null,
      }),
    ).toBe(true);

    const captured: { fn: () => void; ms: number }[] = [];
    let nowMs = new Date("2026-07-11T10:07:00+09:00").getTime();
    let calls: string[] = [];
    const handle = startCleanupDeepPassScheduler({
      intervalDays: 1,
      runCycle: async () => {
        calls = runCycleGrid(gates);
      },
      now: () => nowMs,
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return captured.length;
      },
      clearTimeoutFn: () => {},
    });
    nowMs += captured[0]!.ms;
    captured[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual(["summary"]);
    await handle.stop();
  });

  test("세 단계 전부 ON → 정규식·요약·사람 순차(기존 조합 보존)", () => {
    expect(
      runCycleGrid({ regexStageOn: true, summaryStageOn: true, personLinkStageOn: true }),
    ).toEqual(["regex", "summary", "personLink"]);
  });

  test("정규식만 ON → 정규식만(기존 최소 조합 보존)", () => {
    expect(
      runCycleGrid({ regexStageOn: true, summaryStageOn: false, personLinkStageOn: false }),
    ).toEqual(["regex"]);
    expect(
      shouldRunCleanupDeepPass({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 7,
        regexStageOn: true,
        summaryStageOn: false,
        personLinkStageOn: false,
        lensDraftStageOn: false,
        entityRegisterStageOn: false,
        cleanupModelKeyMissing: null,
      }),
    ).toBe(true);
  });

  test("사람 연결만 ON → 사람 연결만 돈다", () => {
    expect(
      runCycleGrid({ regexStageOn: false, summaryStageOn: false, personLinkStageOn: true }),
    ).toEqual(["personLink"]);
  });

  test("단계 전부 OFF → 기동 안 함(슬롯 준비돼도 할 일 없음)", () => {
    expect(
      shouldRunCleanupDeepPass({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 7,
        regexStageOn: false,
        summaryStageOn: false,
        personLinkStageOn: false,
        lensDraftStageOn: false,
        entityRegisterStageOn: false,
        cleanupModelKeyMissing: null,
      }),
    ).toBe(false);
  });

  test("렌즈 소비만 ON → 렌즈 소비만 돈다", () => {
    expect(
      runCycleGrid({
        regexStageOn: false,
        summaryStageOn: false,
        personLinkStageOn: false,
        lensDraftStageOn: true,
      }),
    ).toEqual(["lensDraft"]);
    expect(
      shouldRunCleanupDeepPass({
        cleanupEnabled: true,
        cleanupLlmAvailable: true,
        intervalDays: 7,
        regexStageOn: false,
        summaryStageOn: false,
        personLinkStageOn: false,
        lensDraftStageOn: true,
        entityRegisterStageOn: false,
        cleanupModelKeyMissing: null,
      }),
    ).toBe(true);
  });
});
