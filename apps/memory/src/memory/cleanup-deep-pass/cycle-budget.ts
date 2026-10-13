/**
 * cycle-budget.ts — 깊은 패스 한 사이클의 4차원 예산 + 단계별 배분 + 요약 로그 (spec 4.A-5).
 *
 * v1 의 "호출 수 상한 = 지갑 상한" 은 정직하지 않았다 — 호출당 입력 크기가 가변이라
 * 호출 수만으로는 금액이 안 잡힌다. 그래서 4차원(호출 수·추정 입력 토큰·출력 토큰·시간)을
 * 사이클 단위로 걸고, 각 차원을 단계별 비율(stageAllocation)로 나눈다. 정규식 단계가
 * 후보 폭주로 전 예산을 소진해 뒤 단계(요약·사람 연결)를 굶기는 것을 이 배분이 막는다.
 *
 * 예산은 CleanupLlmExecutor 의 BudgetHook 계약(check/commit)을 구현한다. 사이클 전체가
 * *하나의* CycleBudget 를 공유하고, 각 단계는 hookForStage(stage) 로 자기 슬라이스 뷰를
 * 받는다 — 한 호출 직전 check(추정 입력) 로 사이클 상한과 단계 슬라이스를 둘 다 검사하고,
 * 호출 성공 뒤 commit(결과) 으로 출력 토큰·호출 수를 사후 확정 차원에 누적한다.
 *
 * 예산 도달은 silent fallback 이 아니다 — 도달 차원·수치를 BudgetDecision 으로 실어
 * 단계 글루가 남은 후보를 이월(원장 미기록 → 다음 사이클 재등장)하고 로그를 남긴다.
 * 도달 차원은 reachedDimensions() 에 누적돼 사이클 요약 한 블록에 노출된다.
 */

import type { LlmChatResult } from "../../llm/types.ts";
import type {
  BudgetDecision,
  BudgetHook,
  UsageAccumulator,
} from "./cleanup-llm-executor.ts";

// ── 단계 식별 ────────────────────────────────────────────────────────────────

/**
 * 예산 배분 단위 단계. relation_discovery 는 summary 사이클 안에서 함께 도므로 배분은
 * summary 슬라이스를 공유한다(별 슬라이스 아님). lensDraft 는 C-2b 에서 합류한 4번째
 * 단계다 — 자기 배분 슬라이스를 갖는다(구조화 초안이 다른 단계와 별 예산 흐름).
 */
export type CycleStage =
  | "regexStrengthen"
  | "summary"
  | "personLink"
  | "lensDraft"
  | "entityRegister";

/** 예산 배분·집계·검증이 도는 전 단계 목록(단일 출처 — 새 단계 합류 시 여기 더한다). */
const CYCLE_STAGES: readonly CycleStage[] = [
  "regexStrengthen",
  "summary",
  "personLink",
  "lensDraft",
  "entityRegister",
];

/** 단계별 배분 비율(각 차원을 이 비율로 나눈다 — 합 1.0). */
export type StageAllocation = Record<CycleStage, number>;

/** 예산 설정(spec 4.A 표) — 4 사이클 차원 + 호출당 입력 상한 + 단계별 배분. */
export interface CleanupBudgetConfig {
  /** 사이클 호출 수 상한(재시도 제외한 대상 호출 — 호출 전 결정적 검사). */
  maxCallsPerCycle: number;
  /** 사이클 추정 입력 토큰 누적 상한(입력이 지출 주축 — 호출 전 추정 검사). */
  maxEstimatedInputTokensPerCycle: number;
  /** 사이클 출력 토큰 누적 상한(사후 확정 — 초과 시 이후 호출 차단). */
  maxOutputTokensPerCycle: number;
  /** 사이클 시간 상한 ms(강모델 지연·재시도 폭주의 자정 격자 침범 차단). */
  maxDurationMsPerCycle: number;
  /**
   * 호출당 입력 상한(A-6 소비 — 여기서는 키만 담아 단일 출처로 둔다). A-6 입력 추정
   * 훅이 이 값으로 분할/terminal 판정을 한다. 예산 판정 자체는 사이클 4차원 소관.
   */
  maxEstimatedInputTokensPerCall: number;
  /** 각 차원을 단계별로 나누는 비율(합 1.0 — 어긋나면 설정 로드 loud fail). */
  stageAllocation: StageAllocation;
}

/** stageAllocation 합 1.0 강제의 허용 오차(부동소수 합산 오차 흡수). */
const ALLOCATION_SUM_EPSILON = 1e-6;

/** stageAllocation 검증 결과(설정 로드 검증이 소비). */
export type StageAllocationValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * stageAllocation 이 합 1.0(±epsilon) + 전 단계 비율 0 이상인지 검증한다. 어긋나면
 * loud fail 사유를 실어 회신한다 — 설정 로드 시점(getMemorySettings)이 이 결과로
 * throw 해 잘못된 배분이 조용히 뒤 단계를 굶기는 것을 막는다(spec 4.A-5).
 */
export function validateStageAllocation(
  alloc: StageAllocation,
): StageAllocationValidation {
  let sum = 0;
  for (const stage of CYCLE_STAGES) {
    const ratio = alloc[stage];
    if (typeof ratio !== "number" || Number.isNaN(ratio)) {
      return {
        ok: false,
        error: `stageAllocation.${stage} 는 숫자여야 함(받은 값: ${String(ratio)})`,
      };
    }
    if (ratio < 0) {
      return {
        ok: false,
        error: `stageAllocation.${stage} 는 0 이상이어야 함(받은 값: ${ratio})`,
      };
    }
    sum += ratio;
  }
  if (Math.abs(sum - 1) > ALLOCATION_SUM_EPSILON) {
    return {
      ok: false,
      error: `stageAllocation 합이 1.0 이 아님(실제 합 ${sum}) — 각 차원을 단계별로 나누는 비율이라 합이 1.0 이어야 함(spec 4.A-5)`,
    };
  }
  return { ok: true };
}

// ── 사이클 예산 상태 ─────────────────────────────────────────────────────────

/** 단계별 사후 확정 누적(호출 수·출력 토큰) + 추정 입력 누적 + 검사 대기 추정. */
interface StageTally {
  calls: number;
  outputTokens: number;
  estimatedInputTokens: number;
  /**
   * 직전 check 가 통과시킨 이 호출의 추정 입력 토큰(commit 이 확정 누적). check→commit
   * 은 한 executor.run 안에서 짝이고 단계가 순차라 stash 가 겹치지 않는다 — block 된
   * 추정은 stash 하지 않아(안 쓴 예산은 안 센다) 누적에 안 들어간다.
   */
  pendingEstimatedInput: number;
}

function emptyTally(): StageTally {
  return {
    calls: 0,
    outputTokens: 0,
    estimatedInputTokens: 0,
    pendingEstimatedInput: 0,
  };
}

/**
 * 한 사이클 4차원 예산 상태. 사이클 전체가 이 객체 하나를 공유하고, 각 단계는
 * hookForStage 로 자기 슬라이스 뷰를 받는다. now() 는 주입(테스트가 결정적 시계를
 * 넣어 실 대기 없이 시간 차원을 검증) — 기본은 Date.now.
 */
export class CycleBudget {
  private readonly config: CleanupBudgetConfig;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly tallies: Record<CycleStage, StageTally>;
  /** 도달한 예산 차원 목록(요약 로그용 — "단계:차원" 문자열, 중복 제거). */
  private readonly reached = new Set<string>();

  constructor(config: CleanupBudgetConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
    this.startedAt = now();
    this.tallies = {
      regexStrengthen: emptyTally(),
      summary: emptyTally(),
      personLink: emptyTally(),
      lensDraft: emptyTally(),
      entityRegister: emptyTally(),
    };
  }

  /** 한 단계의 예산 뷰(BudgetHook) 를 만든다 — executor 에 주입. */
  hookForStage(stage: CycleStage): BudgetHook {
    return {
      check: (estimatedInputTokens: number): BudgetDecision =>
        this.check(stage, estimatedInputTokens),
      commit: (result: LlmChatResult): void => this.commit(stage, result),
    };
  }

  /**
   * 한 호출 직전 4차원 검사. 사이클 상한과 단계 슬라이스를 둘 다 본다 — 어느 하나라도
   * 넘기면 block(도달 차원·수치). 검사 순서는 호출 전 결정 가능한 차원 우선
   * (시간 → 호출 수 → 추정 입력). 출력 토큰은 commit 뒤에만 확정되므로 이미 누적된 값으로
   * 검사한다. estimatedInputTokens 는 이 호출의 추정 입력(A-6 훅 산출 / T4 기본 0).
   */
  private check(stage: CycleStage, estimatedInputTokens: number): BudgetDecision {
    const tally = this.tallies[stage];
    const ratio = this.config.stageAllocation[stage];

    // 1) 시간(사이클 전역 — 단계 배분 없음). 강모델 지연이 자정 격자를 침범하기 전에 끊는다.
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.config.maxDurationMsPerCycle) {
      return this.block(
        stage,
        "maxDurationMsPerCycle",
        `${elapsed}ms/${this.config.maxDurationMsPerCycle}ms`,
      );
    }

    // 2) 호출 수 — 사이클 상한 + 단계 슬라이스.
    const callSlice = Math.floor(this.config.maxCallsPerCycle * ratio);
    if (this.totalCalls() >= this.config.maxCallsPerCycle) {
      return this.block(
        stage,
        "maxCallsPerCycle",
        `사이클 ${this.totalCalls()}/${this.config.maxCallsPerCycle}`,
      );
    }
    if (tally.calls >= callSlice) {
      return this.block(
        stage,
        "maxCallsPerCycle(단계 슬라이스)",
        `${stage} ${tally.calls}/${callSlice}`,
      );
    }

    // 3) 추정 입력 토큰 — 사이클 상한 + 단계 슬라이스. 이 호출 추정을 더해 넘치는지 본다.
    const inputSlice = Math.floor(
      this.config.maxEstimatedInputTokensPerCycle * ratio,
    );
    const projectedCycle = this.totalEstimatedInput() + estimatedInputTokens;
    if (projectedCycle > this.config.maxEstimatedInputTokensPerCycle) {
      return this.block(
        stage,
        "maxEstimatedInputTokensPerCycle",
        `사이클 ${projectedCycle}/${this.config.maxEstimatedInputTokensPerCycle}`,
      );
    }
    const projectedStage = tally.estimatedInputTokens + estimatedInputTokens;
    if (projectedStage > inputSlice) {
      return this.block(
        stage,
        "maxEstimatedInputTokensPerCycle(단계 슬라이스)",
        `${stage} ${projectedStage}/${inputSlice}`,
      );
    }

    // 4) 출력 토큰(사후 확정) — 이미 누적된 값으로 검사. 사이클 상한 + 단계 슬라이스.
    const outputSlice = Math.floor(
      this.config.maxOutputTokensPerCycle * ratio,
    );
    if (this.totalOutput() >= this.config.maxOutputTokensPerCycle) {
      return this.block(
        stage,
        "maxOutputTokensPerCycle",
        `사이클 ${this.totalOutput()}/${this.config.maxOutputTokensPerCycle}`,
      );
    }
    if (tally.outputTokens >= outputSlice) {
      return this.block(
        stage,
        "maxOutputTokensPerCycle(단계 슬라이스)",
        `${stage} ${tally.outputTokens}/${outputSlice}`,
      );
    }

    // 전 차원 통과 — 이 호출 추정을 commit 이 확정 누적하도록 stash(block 갈래는 stash 0).
    tally.pendingEstimatedInput = estimatedInputTokens;
    return { blocked: false };
  }

  /**
   * 한 호출 성공 뒤 사후 확정 차원 누적 — 호출 수 + 출력 토큰. usage 가 null 이면 출력
   * 토큰을 0 으로 두지 않고(위장 금지) 호출 수만 센다 — 출력 상한은 정직하게 미측정분을
   * 안 세는 쪽이 안전(과소 카운트가 조용한 초과보다 눈에 띈다). 입력 추정은 check 전에
   * recordEstimatedInput 로 별도 누적(추정은 호출 전 값이라 commit 이 아니라 검사 시점 근처).
   */
  private commit(stage: CycleStage, result: LlmChatResult): void {
    const tally = this.tallies[stage];
    tally.calls += 1;
    // check 가 통과시킨 이 호출의 추정 입력을 확정 누적(다음 호출 예산 판정 근거).
    tally.estimatedInputTokens += tally.pendingEstimatedInput;
    tally.pendingEstimatedInput = 0;
    if (result.usage !== null) {
      tally.outputTokens += result.usage.outputTokens;
    }
  }

  /**
   * 추정 입력 토큰을 단계 누적에 직접 더한다. 정상 호출 경로는 check→commit 짝이
   * 자동 누적하므로 이 함수를 안 쓴다. dryRun(B-1 — LLM 호출 0, 추정만) 처럼 commit
   * 이 없는 경로가 추정 지출을 예산에 반영할 때 쓴다. block 된(안 쓴) 추정은 넣지 않는다.
   */
  recordEstimatedInput(stage: CycleStage, estimatedInputTokens: number): void {
    this.tallies[stage].estimatedInputTokens += estimatedInputTokens;
  }

  /** 도달 차원 기록 + block 판정 회신(중복 차원은 Set 이 흡수). */
  private block(stage: CycleStage, dimension: string, detail: string): BudgetDecision {
    this.reached.add(`${stage}:${dimension}`);
    return { blocked: true, dimension, detail };
  }

  private totalCalls(): number {
    return CYCLE_STAGES.reduce((sum, s) => sum + this.tallies[s].calls, 0);
  }

  private totalOutput(): number {
    return CYCLE_STAGES.reduce((sum, s) => sum + this.tallies[s].outputTokens, 0);
  }

  private totalEstimatedInput(): number {
    return CYCLE_STAGES.reduce(
      (sum, s) => sum + this.tallies[s].estimatedInputTokens,
      0,
    );
  }

  /** 도달한 예산 차원 목록("단계:차원" — 요약 로그가 소비). */
  reachedDimensions(): string[] {
    return [...this.reached];
  }
}

// ── 사이클 요약 로그 ─────────────────────────────────────────────────────────

/**
 * 한 단계의 사이클 처리 건수 기록(요약 로그 입력). 각 cycle 함수가 돌려주는 Summary 를
 * 이 공통 양식으로 정규화해 넘긴다(단계마다 Summary 필드명이 달라 글루가 매핑).
 */
export interface StageCycleRecord {
  stage: CycleStage;
  /** 이번 사이클에 실제 처리 시도한 대상 수. */
  processed: number;
  /** 원장 completed 기록 수(산출 있음). */
  completed: number;
  /** 원장 completed_noop 기록 수(정상 회신 + 산출 0). */
  completedNoop: number;
  /** 일시/결정 실패로 산출 못 낸 대상 수(원장 retryable/terminal 대기). */
  failures: number;
  /** terminal_failure 로 확정된 대상 수(spec — 0건도 위장 없이 표기). */
  terminal: number;
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
  /** 처리 불가·실패 사유(최대 ENTITY_REGISTER_LIMITS.failureReasonsKept 개). */
  failureReasons?: string[];
}

/** 요약 로그 산출 입력(단계 기록 + usage + 도달 차원 + 소요 시간). */
export interface CycleSummaryInput {
  records: StageCycleRecord[];
  usage: UsageAccumulator;
  reachedDimensions: string[];
  durationMs: number;
}

/**
 * 사이클 요약 한 블록 로그 문자열을 만든다(spec 4.A-5). 단계별 처리/completed/noop/실패/
 * terminal, 호출 수(재시도 포함), 입력·출력·캐시 읽기/쓰기 토큰(+usage 미제공 건수),
 * 도달한 예산 차원, 소요 시간을 한 줄에 담는다. 0건도 위장 없이 표기(도달 차원 없으면
 * "없음" 명시).
 */
export function formatCycleSummary(input: CycleSummaryInput): string {
  const stageParts = input.records.map(
    (r) =>
      `${r.stage}(처리 ${r.processed}, completed ${r.completed}, noop ${r.completedNoop}, 실패 ${r.failures}, terminal ${r.terminal}` +
      (r.autoApplied !== undefined || r.proposed !== undefined
        ? `, 자동 ${r.autoApplied ?? 0}, 제안 ${r.proposed ?? 0}`
        : "") +
      (r.alreadyProcessed !== undefined ? `, 이미 처리됨 ${r.alreadyProcessed}` : "") +
      (r.batchesSplit !== undefined ? `, 하나씩 다시 보낸 묶음 ${r.batchesSplit}(메모 ${r.memosResentAlone ?? 0})` : "") +
      ")",
  );
  const stageBlock = stageParts.length > 0 ? stageParts.join(" | ") : "단계 처리 없음";
  const reached =
    input.reachedDimensions.length > 0
      ? input.reachedDimensions.join(", ")
      : "도달 차원 없음";
  const u = input.usage;
  return (
    `[cleanup-deep-pass] 사이클 요약 — ${stageBlock} || ` +
    `호출 ${u.totalCalls}(재시도 포함), ` +
    `입력 ${u.inputTokens} / 출력 ${u.outputTokens} / ` +
    `캐시읽기 ${u.cacheReadTokens} / 캐시쓰기 ${u.cacheWriteTokens} / ` +
    `usage미제공 ${u.missingUsageCalls}, ` +
    `도달 차원: ${reached}, 소요 ${input.durationMs}ms`
  );
}
