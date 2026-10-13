/**
 * cycle-budget.test.ts — 4차원 예산 판정 + 단계별 배분 + 사이클 요약 (spec 4.A-5).
 *
 * 순수 함수·순수 상태 객체만 검증한다(DB·LLM 의존 0 / mock 객체 0). 예산은
 * CleanupLlmExecutor 의 BudgetHook 계약(check/commit)을 구현하므로, 여기서는 도달 판정·
 * 단계별 슬라이스·차원별 상한을 데이터 fixture 로 검증한다.
 *
 * 검증 축(spec 4.A-5):
 *   - stageAllocation 합 1.0 강제(어긋나면 loud fail — 설정 로드 검증이 소비).
 *   - 4차원(호출 수·추정 입력·출력·시간) 각각 도달 시 block + 도달 차원·수치.
 *   - 단계별 배분: 한 단계가 자기 슬라이스를 소진해도 다른 단계 슬라이스는 남는다.
 *   - commit 이 출력 토큰·호출 수를 사후 확정 차원에 반영.
 *   - 사이클 요약 로그 한 블록이 spec 항목(단계별 건수·호출·토큰·도달 차원·시간) 포함.
 */

import { expect, test } from "bun:test";
import type { LlmChatResult } from "../../llm/types.ts";
import {
  CycleBudget,
  formatCycleSummary,
  validateStageAllocation,
  type CleanupBudgetConfig,
  type CycleStage,
  type StageCycleRecord,
} from "./cycle-budget.ts";

// ── 공통 fixture ─────────────────────────────────────────────────────────────

/** 다섯 단계 균등 배분(합 1.0). */
const EVEN_ALLOC = {
  regexStrengthen: 0.2,
  summary: 0.2,
  personLink: 0.2,
  lensDraft: 0.2,
  entityRegister: 0.2,
};

/** 넉넉한 기본 예산 config(테스트가 필요한 차원만 좁힌다). */
function budgetConfig(overrides: Partial<CleanupBudgetConfig> = {}): CleanupBudgetConfig {
  return {
    maxCallsPerCycle: 1000,
    maxEstimatedInputTokensPerCycle: 10_000_000,
    maxOutputTokensPerCycle: 10_000_000,
    maxDurationMsPerCycle: 3_600_000,
    maxEstimatedInputTokensPerCall: 100_000,
    stageAllocation: EVEN_ALLOC,
    ...overrides,
  };
}

/** chatDetailed 결과 하나(usage 지정). */
function result(outputTokens: number, inputTokens = 0): LlmChatResult {
  return {
    text: "x",
    stopReason: "stop",
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

// ── stageAllocation 합 1.0 강제 ──────────────────────────────────────────────

test("stageAllocation 합 1.0 이면 통과", () => {
  const r = validateStageAllocation(EVEN_ALLOC);
  expect(r.ok).toBe(true);
});

test("stageAllocation 합이 1.0 에서 벗어나면 loud fail(도달 수치 명시)", () => {
  const r = validateStageAllocation({
    regexStrengthen: 0.5,
    summary: 0.3,
    personLink: 0.3,
    lensDraft: 0,
    entityRegister: 0,
  });
  expect(r.ok).toBe(false);
  // 실제 합(1.1)을 사유에 노출.
  if (!r.ok) expect(r.error).toContain("1.1");
});

test("stageAllocation 부동소수 오차(합 0.9999999)는 통과(epsilon 허용)", () => {
  const r = validateStageAllocation({
    regexStrengthen: 0.2,
    summary: 0.2,
    personLink: 0.1999999,
    lensDraft: 0.2000001,
    entityRegister: 0.2,
  });
  expect(r.ok).toBe(true);
});

test("stageAllocation 음수 비율은 loud fail", () => {
  const r = validateStageAllocation({
    regexStrengthen: -0.1,
    summary: 0.6,
    personLink: 0.5,
    lensDraft: 0,
    entityRegister: 0,
  });
  expect(r.ok).toBe(false);
});

// ── 4차원 도달 판정 ──────────────────────────────────────────────────────────

test("maxCallsPerCycle 도달 → block(dimension=maxCallsPerCycle)", () => {
  const budget = new CycleBudget(
    budgetConfig({ maxCallsPerCycle: 2, stageAllocation: { regexStrengthen: 1, summary: 0, personLink: 0, lensDraft: 0, entityRegister: 0 } }),
    () => 0,
  );
  const hook = budget.hookForStage("regexStrengthen");
  // 2 호출까지 통과, commit 으로 호출 수 누적.
  expect(hook.check(0).blocked).toBe(false);
  hook.commit(result(10));
  expect(hook.check(0).blocked).toBe(false);
  hook.commit(result(10));
  const decision = hook.check(0);
  expect(decision.blocked).toBe(true);
  if (decision.blocked) expect(decision.dimension).toBe("maxCallsPerCycle");
});

test("maxEstimatedInputTokensPerCycle 도달 → block(추정 입력 호출 전 검사)", () => {
  const budget = new CycleBudget(
    budgetConfig({
      maxEstimatedInputTokensPerCycle: 100,
      stageAllocation: { regexStrengthen: 1, summary: 0, personLink: 0, lensDraft: 0, entityRegister: 0 },
    }),
    () => 0,
  );
  const hook = budget.hookForStage("regexStrengthen");
  // 추정 입력 60 통과 → 누적 60.
  expect(hook.check(60).blocked).toBe(false);
  budget.recordEstimatedInput("regexStrengthen", 60);
  // 다음 호출 추정 60 이면 60+60=120 > 100 → block.
  const decision = hook.check(60);
  expect(decision.blocked).toBe(true);
  if (decision.blocked) expect(decision.dimension).toBe("maxEstimatedInputTokensPerCycle");
});

test("maxOutputTokensPerCycle 도달 → block(commit 사후 확정 후 다음 호출 차단)", () => {
  const budget = new CycleBudget(
    budgetConfig({
      maxOutputTokensPerCycle: 100,
      stageAllocation: { regexStrengthen: 1, summary: 0, personLink: 0, lensDraft: 0, entityRegister: 0 },
    }),
    () => 0,
  );
  const hook = budget.hookForStage("regexStrengthen");
  expect(hook.check(0).blocked).toBe(false);
  hook.commit(result(120)); // 출력 120 > 100.
  const decision = hook.check(0);
  expect(decision.blocked).toBe(true);
  if (decision.blocked) expect(decision.dimension).toBe("maxOutputTokensPerCycle");
});

test("maxDurationMsPerCycle 도달 → block(주입 시계로 경과 판정)", () => {
  let now = 1000;
  const budget = new CycleBudget(
    budgetConfig({ maxDurationMsPerCycle: 500 }),
    () => now,
  );
  const hook = budget.hookForStage("regexStrengthen");
  expect(hook.check(0).blocked).toBe(false);
  now = 1600; // 시작 1000 + 600 > 500.
  const decision = hook.check(0);
  expect(decision.blocked).toBe(true);
  if (decision.blocked) expect(decision.dimension).toBe("maxDurationMsPerCycle");
});

// ── 단계별 배분(슬라이스 굶김 차단) ───────────────────────────────────────────

test("단계별 배분 — regexStrengthen 이 자기 슬라이스를 소진해도 summary 슬라이스는 남는다", () => {
  // 호출 상한 10, 배분 regex 0.5 / summary 0.5 / person 0 → 각 슬라이스 5.
  const budget = new CycleBudget(
    budgetConfig({
      maxCallsPerCycle: 10,
      stageAllocation: { regexStrengthen: 0.5, summary: 0.5, personLink: 0, lensDraft: 0, entityRegister: 0 },
    }),
    () => 0,
  );
  const regexHook = budget.hookForStage("regexStrengthen");
  // regex 슬라이스 5 소진.
  for (let i = 0; i < 5; i++) {
    expect(regexHook.check(0).blocked).toBe(false);
    regexHook.commit(result(1));
  }
  // regex 는 자기 슬라이스 도달 → block.
  const regexDecision = regexHook.check(0);
  expect(regexDecision.blocked).toBe(true);
  if (regexDecision.blocked) expect(regexDecision.dimension).toContain("maxCallsPerCycle");
  // summary 슬라이스는 그대로 남아 통과.
  const summaryHook = budget.hookForStage("summary");
  expect(summaryHook.check(0).blocked).toBe(false);
});

test("단계 슬라이스 배분 0 인 단계는 즉시 block", () => {
  const budget = new CycleBudget(
    budgetConfig({
      maxCallsPerCycle: 10,
      stageAllocation: { regexStrengthen: 1, summary: 0, personLink: 0, lensDraft: 0, entityRegister: 0 },
    }),
    () => 0,
  );
  const personHook = budget.hookForStage("personLink");
  expect(personHook.check(0).blocked).toBe(true);
});

// ── 도달 차원 추적(요약 로그 입력) ────────────────────────────────────────────

test("도달한 예산 차원을 누적해 요약에 노출", () => {
  const budget = new CycleBudget(
    budgetConfig({
      maxCallsPerCycle: 1,
      stageAllocation: { regexStrengthen: 1, summary: 0, personLink: 0, lensDraft: 0, entityRegister: 0 },
    }),
    () => 0,
  );
  const hook = budget.hookForStage("regexStrengthen");
  hook.check(0);
  hook.commit(result(1));
  hook.check(0); // 도달.
  expect(budget.reachedDimensions().length).toBeGreaterThan(0);
});

// ── 사이클 요약 로그 ─────────────────────────────────────────────────────────

test("formatCycleSummary — 단계별 건수·호출·토큰·도달 차원·시간을 한 블록에 담는다", () => {
  const records: StageCycleRecord[] = [
    {
      stage: "regexStrengthen",
      processed: 5,
      completed: 3,
      completedNoop: 1,
      failures: 1,
      terminal: 0,
    },
    {
      stage: "summary",
      processed: 2,
      completed: 2,
      completedNoop: 0,
      failures: 0,
      terminal: 0,
    },
  ];
  const line = formatCycleSummary({
    records,
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      missingUsageCalls: 2,
      totalCalls: 7,
    },
    reachedDimensions: ["regexStrengthen:maxCallsPerCycle"],
    durationMs: 4200,
  });
  // 단계 이름.
  expect(line).toContain("regexStrengthen");
  expect(line).toContain("summary");
  // 단계별 건수.
  expect(line).toContain("completed 3");
  expect(line).toContain("terminal 0");
  // 호출 수(재시도 포함).
  expect(line).toContain("호출 7");
  // 토큰(입력·출력·캐시).
  expect(line).toContain("입력 1200");
  expect(line).toContain("출력 340");
  expect(line).toContain("캐시읽기 100");
  expect(line).toContain("캐시쓰기 50");
  // usage 미제공 건수.
  expect(line).toContain("usage미제공 2");
  // 도달 차원.
  expect(line).toContain("maxCallsPerCycle");
  // 시간.
  expect(line).toContain("4200");
});

test("formatCycleSummary — 도달 차원 없으면 '없음' 명시(0건 위장 금지)", () => {
  const line = formatCycleSummary({
    records: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      missingUsageCalls: 0,
      totalCalls: 0,
    },
    reachedDimensions: [],
    durationMs: 10,
  });
  expect(line).toContain("도달 차원 없음");
});

// ── 타입 sanity: CycleStage 5종 ──────────────────────────────────────────────

test("CycleStage 5종이 stageAllocation 키와 1:1", () => {
  const stages: CycleStage[] = [
    "regexStrengthen",
    "summary",
    "personLink",
    "lensDraft",
    "entityRegister",
  ];
  for (const s of stages) {
    expect(s in EVEN_ALLOC).toBe(true);
  }
});

test("an allocation missing entityRegister is refused with the stage name", () => {
  const result = validateStageAllocation({ regexStrengthen: 0.25, summary: 0.25, personLink: 0.25, lensDraft: 0.25 } as never);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("stageAllocation.entityRegister");
});
