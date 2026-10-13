/**
 * run-cycle-runner.ts — 깊은 패스 한 사이클 오케스트레이션 (spec 5.B-1 / 4.A-5).
 *
 * 권위 spec: docs/decisions/2026-07-11-cleanup-ai-efficient-operation-spec.md 단락 5.B-1
 *
 * 4단계(정규식 강화 / 요약 / 사람 연결)를 단일 실행층(CleanupLlmExecutor) 경유로 순차
 * 가동하고, 사이클 전역 usage·예산을 공유하며, 종료 시 사이클 요약을 로그로 남긴다. 이
 * 오케스트레이션을 index.ts 인라인 클로저에서 이 모듈로 추출해, 스케줄러 정기 tick 과
 * 수동 run API 가 *같은 통로*로 사이클을 돌린다(spec "수동/정기 한 통로").
 *
 * run 컨텍스트(CleanupRunContext) 소비:
 *   - runId 존재 → cleanup_runs 원장에 이 사이클을 기록(정기 tick 도 runId 를 받아 기록).
 *   - stages → 부분 실행(그 단계만). 생략 시 켜진 단계 전부.
 *   - maxCalls → 이번 사이클 한정 호출 수 상한 덮어쓰기(budget.maxCallsPerCycle override).
 *   - cancelSignal → 실행층 모든 호출에 signal 주입(cancel 라우트 abort → 진행 중 호출 끊김).
 *   - dryRun → LLM 호출 0. 단계 사이클을 안 부르고 후보 검출 + 입력 토큰 추정만 회신.
 *
 * dryRun 후보 검출은 각 단계 모듈의 detect*DryRun() 순수 함수(spec 원문 재사용 — 실
 * 사이클과 같은 후보 쿼리·원장 필터·프롬프트 추정)를 켜진 단계·stages 필터대로 부른다
 * (DCL-6 실측 도구). LLM 은 절대 안 부른다.
 */

import type { Database } from "bun:sqlite";
import {
  CircuitBreaker,
  CleanupLlmExecutor,
  createUsageAccumulator,
} from "./cleanup-llm-executor.ts";
import type { ObservableLlmClient } from "../../llm/types.ts";
import type { EventPublisher } from "../events/event-contract.ts";
import {
  CycleBudget,
  formatCycleSummary,
  type CleanupBudgetConfig,
  type CycleStage,
  type StageCycleRecord,
} from "./cycle-budget.ts";
import { CleanupConfigError } from "./stage-execution.ts";
import { createInputEstimateHook } from "./input-estimate.ts";
import { cleanupStageLlmLimitsOf } from "./stage-constants.ts";
import { redactSecrets } from "./redact-secrets.ts";
import {
  runRegexStrengthenCycle,
  createRegexInferFn,
  detectRegexDryRun,
} from "./regex-strengthen-cycle.ts";
import {
  runSummaryCycle,
  createSummaryInferFn,
  detectSummaryDryRun,
} from "./summary-cycle.ts";
import {
  runPersonLinkInferCycle,
  createOllamaPersonLinkInferFn,
  detectPersonLinkDryRun,
} from "../person-link-infer-cycle.ts";
import {
  runLensDraftCycle,
  createLensDraftInferFn,
  detectLensDraftDryRun,
} from "./lens-draft-cycle.ts";
import {
  runEntityRegisterStage,
  detectEntityRegisterStageDryRun,
  type EntityRegisterStageConfig,
} from "./entity-register/stage-runner.ts";
import type { CleanupRunContext } from "../../scheduler.ts";
import type { RegexL0Extractor } from "../regex-l0/extractor.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import type { Embedder } from "../../embedding/types.ts";
import {
  CleanupRunsLedger,
  emptyRunAggregates,
  type CleanupRunAggregates,
  type CleanupRunStageAggregate,
} from "./cleanup-runs-ledger.ts";

/** 정규식 강화 단계 설정(index.ts settings.cleanupDeepPass.regexStrengthen). */
export interface RegexStageConfig {
  batchSize: number;
  overmatchThreshold: number;
  overmatchSampleSize: number;
}

/** 요약 단계 설정(settings.cleanupDeepPass.summary). */
export interface SummaryStageConfig {
  atomicThreshold: number;
  batchSize: number;
  relationConfidenceThreshold: number;
  firstParagraphMaxChars: number;
}

/** 사람 연결 단계 설정(settings.cleanupDeepPass.personLink). */
export interface PersonLinkStageConfig {
  batchSize: number;
  autoApply: boolean;
}

/** 렌즈 소비 단계 설정(settings.cleanupDeepPass.lensDraft). */
export interface LensDraftStageConfig {
  batchSize: number;
}

/** 신뢰성 설정(settings.cleanupDeepPass.reliability). */
export interface ReliabilityConfig {
  circuitBreakerThreshold: number;
  retryMaxPerCall: number;
  retryBaseDelayMs: number;
  maxAttemptsPerTarget: number;
  /** 죽은 run 회수 나이 문턱 ms — 사이클 시작마다 이 나이를 넘긴 running 행을 failed 로. */
  staleRunReclaimMs: number;
}

/**
 * dryRun 단계별 후보 검출 결과 한 줄. 후보 수 + 추정 입력 토큰만 담는다(LLM 미호출).
 */
export interface DryRunStageEstimate {
  stage: CycleStage;
  candidatesFound: number;
  estimatedInputTokens: number;
}

/** 사이클 오케스트레이션 의존 묶음(index.ts 부팅 배선이 채운다). */
export interface RunCycleDeps {
  store: SqliteMemoryStore;
  embedder: Embedder;
  regexL0: RegexL0Extractor | undefined;
  /** 이벤트 발행 표면(EventBus 가 구현). 사이클이 검토 게이트·정보성 이벤트를 흘린다. */
  eventBus: EventPublisher;
  cleanupObservable: ObservableLlmClient;
  /** run 원장(cleanup_runs). 정기·수동 사이클이 이 원장에 run 행을 남긴다. */
  ledger: CleanupRunsLedger;
  budgetConfig: CleanupBudgetConfig;
  reliability: ReliabilityConfig;
  regexStage: RegexStageConfig;
  summaryStage: SummaryStageConfig;
  personLinkStage: PersonLinkStageConfig;
  lensDraftStage: LensDraftStageConfig;
  /** 항목·일정 자동 등록 단계 설정(settings.cleanupDeepPass.entityRegister). */
  entityRegisterStage: EntityRegisterStageConfig;
  /** 관계 엣지 자동 반영 게이트(settings.cleanupDeepPass.relationDiscovery.autoApply). */
  relationAutoApply: boolean;
  /** 각 단계 자기 게이트 결과(index.ts 가 부팅 시점 계산해 넘긴다). */
  regexStageOn: boolean;
  summaryStageOn: boolean;
  personLinkStageOn: boolean;
  lensDraftStageOn: boolean;
  entityRegisterStageOn: boolean;
  /** 로그 prefix(테스트 주입). 기본 "[memory-api]". */
  logPrefix?: string;
  /** 현재 시각(테스트 주입). 기본 Date.now. */
  now?: () => number;
}

/** stages 필터가 이 단계를 포함하는지(생략 = 전 단계 통과). */
function stageIncluded(stage: CycleStage, filter: CycleStage[] | undefined): boolean {
  return filter === undefined || filter.includes(stage);
}

/**
 * StageCycleRecord + usage 를 run 집계로 정규화한다. 단계별 estimatedInputTokens 는 실
 * 실행 경로에서 개별 단계 추정 합을 따로 세지 않으므로 0 으로 둔다(dryRun 이 실측 도구 —
 * 실 실행 집계는 usage 의 확정 inputTokens 가 권위).
 */
function toAggregates(
  records: StageCycleRecord[],
  usage: ReturnType<typeof createUsageAccumulator>,
  reachedDimensions: string[],
  durationMs: number,
): CleanupRunAggregates {
  const stageAggregates: CleanupRunStageAggregate[] = records.map((r) => ({
    stage: r.stage,
    processed: r.processed,
    completed: r.completed,
    completedNoop: r.completedNoop,
    failures: r.failures,
    terminal: r.terminal,
    estimatedInputTokens: 0,
    ...(r.autoApplied !== undefined ? { autoApplied: r.autoApplied } : {}),
    ...(r.proposed !== undefined ? { proposed: r.proposed } : {}),
    ...(r.alreadyProcessed !== undefined ? { alreadyProcessed: r.alreadyProcessed } : {}),
    ...(r.batchesSplit !== undefined ? { batchesSplit: r.batchesSplit } : {}),
    ...(r.memosResentAlone !== undefined ? { memosResentAlone: r.memosResentAlone } : {}),
    ...(r.failureReasons !== undefined ? { failureReasons: r.failureReasons } : {}),
  }));
  return {
    stageAggregates,
    totalCalls: usage.totalCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    missingUsageCalls: usage.missingUsageCalls,
    reachedDimensions,
    durationMs,
  };
}

/**
 * dryRun 단계별 후보 검출 — 켜진 단계·stages 필터대로 각 단계 detect*DryRun() 을 부른다.
 * LLM 은 절대 안 부른다(순수 조회 + 프롬프트 추정). 꺼진 단계·필터 밖 단계는 건너뛴다.
 */
async function detectDryRunStages(
  deps: RunCycleDeps,
  db: Database,
  stagesFilter: CycleStage[] | undefined,
): Promise<DryRunStageEstimate[]> {
  const out: DryRunStageEstimate[] = [];
  if (
    deps.regexStageOn &&
    deps.regexL0 !== undefined &&
    stageIncluded("regexStrengthen", stagesFilter)
  ) {
    const r = detectRegexDryRun({
      db,
      extractor: deps.regexL0,
      batchSize: deps.regexStage.batchSize,
      stageVersion: cleanupStageLlmLimitsOf("regex_strengthen").stageVersion,
    });
    out.push({ stage: "regexStrengthen", ...r });
  }
  if (deps.summaryStageOn && stageIncluded("summary", stagesFilter)) {
    const s = detectSummaryDryRun({
      db,
      atomicThreshold: deps.summaryStage.atomicThreshold,
      batchSize: deps.summaryStage.batchSize,
      stageVersion: cleanupStageLlmLimitsOf("summary").stageVersion,
    });
    out.push({ stage: "summary", ...s });
  }
  if (deps.entityRegisterStageOn && stageIncluded("entityRegister", stagesFilter)) {
    out.push({
      stage: "entityRegister",
      ...detectEntityRegisterStageDryRun({
        store: deps.store,
        config: deps.entityRegisterStage,
        perCallInputCap: deps.budgetConfig.maxEstimatedInputTokensPerCall,
      }),
    });
  }
  if (deps.personLinkStageOn && stageIncluded("personLink", stagesFilter)) {
    const p = await detectPersonLinkDryRun({
      db,
      store: deps.store,
      batchSize: deps.personLinkStage.batchSize,
      stageVersion: cleanupStageLlmLimitsOf("person_link").stageVersion,
    });
    out.push({ stage: "personLink", ...p });
  }
  if (deps.lensDraftStageOn && stageIncluded("lensDraft", stagesFilter)) {
    const l = await detectLensDraftDryRun({
      deps: { store: deps.store },
      batchSize: deps.lensDraftStage.batchSize,
      stageVersion: cleanupStageLlmLimitsOf("lens_draft").stageVersion,
    });
    out.push({ stage: "lensDraft", ...l });
  }
  return out;
}

/**
 * 깊은 패스 사이클 실행 함수를 만든다. 반환된 (ctx?) => Promise<void> 를 스케줄러
 * runCycle 로 넘긴다 — 정기 tick 은 ctx 없이(켜진 단계 전부·정상 예산), 수동 run 은
 * ctx 로 옵션을 실어 같은 통로를 돌린다.
 */
export function createRunCycle(
  deps: RunCycleDeps,
): (ctx?: CleanupRunContext) => Promise<void> {
  const logPrefix = deps.logPrefix ?? "[memory-api]";
  const now = deps.now ?? (() => Date.now());
  const db: Database = deps.store.getRawDb();

  return async (ctx?: CleanupRunContext): Promise<void> => {
    const cycleStartedAt = now();
    const stagesFilter = ctx?.stages as CycleStage[] | undefined;

    // run 원장 기록 — 정기 tick 도 runId 를 받으면 행을 남긴다(수동/정기 한 통로).
    // runId 없는 순수 정기 tick(옛 호환)은 원장 없이 돈다.
    const runId = ctx?.runId;
    const recordRun = runId !== undefined;

    // 죽은 run 회수(spec 5-3 잔여 D-D) — 사이클 시작마다 한 번, 나이 문턱을 넘긴
    // running 행을 failed 로 확정한다. 프로세스가 죽으면 finishRun 이 안 불려 행이
    // 'running' 으로 굳고, 그 행이 쥔 idempotency 키가 UNIQUE 라 같은 키의 재요청이
    // 영원히 죽은 runId 만 돌려받는다(사이클 트리거 없음 = 큐 봉쇄).
    //
    // 이번 run 자신은 방금 startRun 으로 만들어져 나이가 0 이라 문턱에 안 걸린다 —
    // 회수 대상은 오직 문턱을 넘긴 옛 행이다. 회수는 관측 가능해야 하므로(조용한
    // 처리 금지) 건수를 로그로 남긴다.
    const reclaimed = deps.ledger.reclaimStaleRuns(deps.reliability.staleRunReclaimMs);
    if (reclaimed.length > 0) {
      console.warn(
        `${logPrefix} cleanup 죽은 run ${reclaimed.length}건 회수(failed 확정) — ${reclaimed.join(", ")}. 이전 프로세스가 사이클 중 종료된 흔적이다.`,
      );
    }

    // ── dryRun: LLM 호출 0. 후보 검출 + 추정만 회신하고 원장에 dryRunEstimate 집계 기록. ──
    if (ctx?.dryRun) {
      const estimates = await detectDryRunStages(deps, db, stagesFilter);
      const stageAggregates: CleanupRunStageAggregate[] = estimates.map((e) => ({
        stage: e.stage,
        processed: e.candidatesFound,
        completed: 0,
        completedNoop: 0,
        failures: 0,
        terminal: 0,
        estimatedInputTokens: e.estimatedInputTokens,
      }));
      const durationMs = now() - cycleStartedAt;
      const aggregates: CleanupRunAggregates = {
        ...emptyRunAggregates(durationMs),
        stageAggregates,
      };
      if (recordRun) {
        deps.ledger.finishRun({ runId, status: "completed", aggregates });
      }
      const totalCand = estimates.reduce((s, e) => s + e.candidatesFound, 0);
      const totalEst = estimates.reduce((s, e) => s + e.estimatedInputTokens, 0);
      console.log(
        `[cleanup-deep-pass] dryRun 요약 — 단계 ${estimates.length}개, 후보 ${totalCand}, 추정 입력토큰 ${totalEst} (LLM 호출 0 · DCL-6 실측)`,
      );
      return;
    }

    // ── 실 실행: 사이클 전역 usage·예산 공유 + 단계별 executor. ──
    const usage = createUsageAccumulator();
    // maxCalls run 옵션 = 이번 사이클 한정 호출 수 상한 덮어쓰기(다른 예산 차원은 설정 유지).
    const budgetConfig: CleanupBudgetConfig =
      ctx?.maxCalls !== undefined
        ? { ...deps.budgetConfig, maxCallsPerCycle: ctx.maxCalls }
        : deps.budgetConfig;
    const budget = new CycleBudget(budgetConfig);
    const stageRecords: StageCycleRecord[] = [];

    // 지금 도는 단계 — run 이 멈추면 원인에 단계 이름을 붙인다(executor 를 만드는 때가 단계 시작).
    // 원인 문장에는 공급자 응답 본문 일부가 실릴 수 있어, run 기록에 남기기 전에 비밀 모양을 가린다.
    let currentStage: CycleStage | null = null;
    const stopReasonOf = (kind: string, e: unknown): string =>
      redactSecrets(`${currentStage ?? "단계 시작 전"} 단계에서 ${kind}: ${e instanceof Error ? e.message : String(e)}`);
    const makeStageExecutor = (stage: CycleStage): CleanupLlmExecutor => {
      currentStage = stage;
      return new CleanupLlmExecutor({
        client: deps.cleanupObservable,
        usage,
        breaker: new CircuitBreaker(deps.reliability.circuitBreakerThreshold),
        retryMaxPerCall: deps.reliability.retryMaxPerCall,
        retryBaseDelayMs: deps.reliability.retryBaseDelayMs,
        budgetHook: budget.hookForStage(stage),
        inputEstimateHook: createInputEstimateHook(),
        // spec 5.B-1 — cancel 전파. run cancel 라우트가 abort → 진행 중 호출까지 끊김.
        ...(ctx?.cancelSignal !== undefined ? { cancelSignal: ctx.cancelSignal } : {}),
      });
    };

    try {
      // 단계 1 — 정규식 강화. 자기 게이트 + stages 필터 둘 다 통과해야 돈다.
      if (
        deps.regexStageOn &&
        deps.regexL0 !== undefined &&
        stageIncluded("regexStrengthen", stagesFilter)
      ) {
        const regexSummary = await runRegexStrengthenCycle({
          db,
          extractor: deps.regexL0,
          infer: createRegexInferFn(makeStageExecutor("regexStrengthen")),
          eventBus: deps.eventBus,
          batchSize: deps.regexStage.batchSize,
          overmatchThreshold: deps.regexStage.overmatchThreshold,
          overmatchSampleSize: deps.regexStage.overmatchSampleSize,
          stageVersion: cleanupStageLlmLimitsOf("regex_strengthen").stageVersion,
          maxAttemptsPerTarget: deps.reliability.maxAttemptsPerTarget,
          perCallInputCap: budgetConfig.maxEstimatedInputTokensPerCall,
        });
        stageRecords.push({
          stage: "regexStrengthen",
          processed: regexSummary.candidatesFound,
          completed: regexSummary.completed,
          completedNoop: regexSummary.completedNoop,
          failures: regexSummary.inferFailures,
          terminal: 0,
        });
      }
      // 단계 2 — 요약.
      if (deps.summaryStageOn && stageIncluded("summary", stagesFilter)) {
        const summarySummary = await runSummaryCycle({
          db,
          store: deps.store,
          embedder: deps.embedder,
          infer: createSummaryInferFn(makeStageExecutor("summary")),
          eventBus: deps.eventBus,
          atomicThreshold: deps.summaryStage.atomicThreshold,
          batchSize: deps.summaryStage.batchSize,
          relationConfidenceThreshold: deps.summaryStage.relationConfidenceThreshold,
          firstParagraphMaxChars: deps.summaryStage.firstParagraphMaxChars,
          stageVersion: cleanupStageLlmLimitsOf("summary").stageVersion,
          maxAttemptsPerTarget: deps.reliability.maxAttemptsPerTarget,
          relationAutoApply: deps.relationAutoApply,
        });
        stageRecords.push({
          stage: "summary",
          processed:
            summarySummary.chunkSummariesCreated +
            summarySummary.relationSummariesCreated,
          completed:
            summarySummary.chunkSummariesCreated +
            summarySummary.relationSummariesCreated,
          completedNoop: 0,
          failures: summarySummary.inferFailures,
          terminal: 0,
        });
      }
      // 단계 2.5 — 항목·일정 자동 등록(2026-10-10 spec). 본체는 entity-register/stage-runner.ts.
      // 메모 단위 단계 순서: 항목 등록이 새 사람을 만든 뒤 사람 연결이 돈다.
      if (deps.entityRegisterStageOn && stageIncluded("entityRegister", stagesFilter)) {
        stageRecords.push(
          await runEntityRegisterStage({
            store: deps.store,
            executor: makeStageExecutor("entityRegister"),
            eventBus: deps.eventBus,
            config: deps.entityRegisterStage,
            maxAttemptsPerTarget: deps.reliability.maxAttemptsPerTarget,
            perCallInputCap: budgetConfig.maxEstimatedInputTokensPerCall,
            runId: runId ?? null,
            ...(ctx?.nodeIds ? { nodeIds: ctx.nodeIds } : {}),
          }),
        );
      }
      // 단계 3 — 사람 연결.
      if (deps.personLinkStageOn && stageIncluded("personLink", stagesFilter)) {
        const personSummary = await runPersonLinkInferCycle({
          db,
          store: deps.store,
          infer: createOllamaPersonLinkInferFn(makeStageExecutor("personLink")),
          eventBus: deps.eventBus,
          batchSize: deps.personLinkStage.batchSize,
          autoApply: deps.personLinkStage.autoApply,
          stageVersion: cleanupStageLlmLimitsOf("person_link").stageVersion,
          maxAttemptsPerTarget: deps.reliability.maxAttemptsPerTarget,
          perCallInputCap: budgetConfig.maxEstimatedInputTokensPerCall,
          ...(ctx?.nodeIds ? { nodeIds: ctx.nodeIds } : {}),
        });
        stageRecords.push({
          stage: "personLink",
          processed: personSummary.candidatesFound,
          completed: personSummary.completed,
          completedNoop: personSummary.completedNoop,
          failures: personSummary.inferFailures,
          terminal: 0,
        });
      }
      // 단계 4 — 렌즈 소비(구조화 초안). 자동 적용 0 — 통과분 전부 검토 제안으로.
      if (deps.lensDraftStageOn && stageIncluded("lensDraft", stagesFilter)) {
        const lensSummary = await runLensDraftCycle({
          deps: { store: deps.store },
          infer: createLensDraftInferFn(makeStageExecutor("lensDraft")),
          eventBus: deps.eventBus,
          batchSize: deps.lensDraftStage.batchSize,
          stageVersion: cleanupStageLlmLimitsOf("lens_draft").stageVersion,
          maxAttemptsPerTarget: deps.reliability.maxAttemptsPerTarget,
          perCallInputCap: budgetConfig.maxEstimatedInputTokensPerCall,
        });
        stageRecords.push({
          stage: "lensDraft",
          processed: lensSummary.candidatesFound,
          completed: lensSummary.completed,
          completedNoop: lensSummary.completedNoop,
          failures: lensSummary.inferFailures,
          terminal: 0,
        });
      }
    } catch (e) {
      // 설정 결함(400/401/403)은 사이클 통째 중단 — 대상별 실패로 위장하지 않고 loud.
      if (e instanceof CleanupConfigError) {
        const durationMs = now() - cycleStartedAt;
        const aggregates: CleanupRunAggregates = {
          ...toAggregates(stageRecords, usage, budget.reachedDimensions(), durationMs),
          stopReason: stopReasonOf("설정 결함으로 중단", e),
        };
        console.error(
          `${logPrefix} cleanup deep-pass 사이클 중단 — 설정 결함: ${e.message}`,
        );
        console.log(
          formatCycleSummary({
            records: stageRecords,
            usage,
            reachedDimensions: budget.reachedDimensions(),
            durationMs,
          }),
        );
        // run 은 failed 로 확정(설정 결함 중단 — 정직한 실패 상태).
        if (recordRun) {
          deps.ledger.finishRun({ runId, status: "failed", aggregates });
        }
        return;
      }
      // 그 외 예외는 run 을 failed 로 남기고 rethrow(골격이 로그).
      if (recordRun) {
        deps.ledger.finishRun({
          runId,
          status: "failed",
          aggregates: {
            ...toAggregates(stageRecords, usage, budget.reachedDimensions(), now() - cycleStartedAt),
            stopReason: stopReasonOf("오류로 중단", e),
          },
        });
      }
      throw e;
    }

    const durationMs = now() - cycleStartedAt;
    console.log(
      formatCycleSummary({
        records: stageRecords,
        usage,
        reachedDimensions: budget.reachedDimensions(),
        durationMs,
      }),
    );

    // 취소 여부 판정 — cancel 라우트가 이미 status 를 cancelled 로 바꿨으면 그대로 존중
    // (완료로 덮지 않는다). 아니면 completed 확정.
    if (recordRun) {
      const status = ctx?.cancelSignal?.aborted ? "cancelled" : "completed";
      deps.ledger.finishRun({
        runId,
        status,
        aggregates: toAggregates(
          stageRecords,
          usage,
          budget.reachedDimensions(),
          durationMs,
        ),
      });
    }
  };
}
