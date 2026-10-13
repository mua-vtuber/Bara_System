/**
 * entity-register/boot-wiring.ts — 부팅 때 설정에서 이 단계 구성과 깊은 패스 게이트 입력을 만든다.
 * index.ts(800줄 상한 초과)에 새 논리를 쌓지 않으려고 여기로 모은다. 같은 함수를 run API 의
 * "가능 여부" 조회도 쓴다(설정이 단일 출처).
 */
import type { MemorySettings } from "../../../settings/memory-settings-types.ts";
import { shouldRunSummaryStage } from "../summary-cycle.ts";
import { cleanupModelKeyMissing, type CleanupDeepPassGateInput } from "../scheduler-gate.ts";
import type { EntityRegisterStageConfig } from "./stage-runner.ts";
import type { CleanupRunContext, TryTickResult } from "../../../scheduler.ts";
import type { CycleStage } from "../cycle-budget.ts";
import { emptyRunAggregates, type CleanupRunsLedger } from "../cleanup-runs-ledger.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { ENTITY_REGISTER_TRIGGER_TIMING } from "./constants.ts";
import { createMemoSavedCleanupTrigger, type MemoSavedCleanupTrigger } from "./per-memo-trigger.ts";

export function entityRegisterStageConfig(settings: MemorySettings): EntityRegisterStageConfig {
  const slot = settings.cleanupDeepPass.entityRegister;
  return { batchSize: slot.batchSize, autoApply: slot.autoApply };
}

/**
 * 깊은 패스 게이트 입력. cleanupLlmAvailable 은 부팅 때 정리 AI 연결을 만든 결과(설정만으로는 알 수 없다),
 * regexAvailable 은 정규식 추출기(regexL0)가 있는지다. 나머지 칸은 전부 설정에서 읽는다.
 */
export function buildCleanupGateInput(
  settings: MemorySettings,
  env: { cleanupLlmAvailable: boolean; cleanupLlmFailureReason?: string | null; regexAvailable: boolean },
): CleanupDeepPassGateInput {
  const cleanup = settings.llm.cleanup;
  const deep = settings.cleanupDeepPass;
  return {
    cleanupEnabled: cleanup.enabled,
    cleanupLlmAvailable: env.cleanupLlmAvailable,
    cleanupLlmFailureReason: env.cleanupLlmFailureReason ?? null,
    intervalDays: cleanup.intervalDays,
    regexStageOn: deep.regexStrengthen.enabled && env.regexAvailable,
    summaryStageOn: shouldRunSummaryStage({
      cleanupEnabled: cleanup.enabled,
      cleanupLlmAvailable: env.cleanupLlmAvailable,
      intervalDays: cleanup.intervalDays,
      summaryEnabled: deep.summary.enabled,
    }),
    personLinkStageOn: deep.personLink.enabled,
    lensDraftStageOn: deep.lensDraft.enabled,
    entityRegisterStageOn: deep.entityRegister.enabled,
    cleanupModelKeyMissing: cleanupModelKeyMissing(cleanup),
  };
}

/** 메모 하나로 처리할 수 있는 단계 중 켜진 것(spec 7.1 — 이 단계와 사람 연결). */
export function memoSavedStages(gate: CleanupDeepPassGateInput): CycleStage[] {
  const stages: CycleStage[] = [];
  if (gate.entityRegisterStageOn) stages.push("entityRegister");
  if (gate.personLinkStageOn) stages.push("personLink");
  return stages;
}

/** 입력 직후 정리 회차가 다른 회차와 겹쳐 열리지 못했을 때 run 기록에 남기는 원인. */
export const MEMO_SAVED_LOST_RACE_STOP_REASON = "다른 정리 회차가 먼저 시작되어 이번 회차는 열지 않음";
/** 입력 직후 정리 회차를 여는 도중 오류가 났을 때 run 기록 원인의 앞머리(뒤에 오류 문장이 붙는다). */
export const MEMO_SAVED_START_FAILED_STOP_REASON = "입력 직후 정리 회차를 여는 중 오류";

interface MemoSavedTriggerArgs {
  settings: MemorySettings;
  gate: CleanupDeepPassGateInput;
  ledger: CleanupRunsLedger;
  scheduler: { tryTickNow(ctx: CleanupRunContext): TryTickResult; isRunning(): boolean };
}

/**
 * 입력 직후 정리 회차 하나를 연다. cleanup_runs.trigger 는 manual/scheduled 만 허용하므로
 * manual + options.reason='memo_saved' 로 남긴다. 다른 회차와 겹쳐 열리지 못하면 방금 만든 run 행을
 * failed 로 닫는다(run API 409 와 같은 정직 기록). 실패는 run 기록·원장에 남고 저장 경로는 기다리지 않는다.
 */
export function memoSavedRunStarter(args: MemoSavedTriggerArgs): (nodeIds: number[]) => TryTickResult {
  const stages = memoSavedStages(args.gate);
  return (nodeIds) => {
    const started = args.ledger.startRun({ trigger: "manual", options: { stages, nodeIds, reason: "memo_saved" } });
    let result: TryTickResult;
    try {
      result = args.scheduler.tryTickNow({ runId: started.runId, stages, nodeIds });
    } catch (e) {
      // 방금 만든 run 행이 running 으로 남지 않게 failed + 원인으로 닫고, 대기열이 다시 시도하도록 다시 던진다.
      const cause = redactSecrets(`${MEMO_SAVED_START_FAILED_STOP_REASON}: ${e instanceof Error ? e.message : String(e)}`);
      args.ledger.finishRun({ runId: started.runId, status: "failed", aggregates: { ...emptyRunAggregates(), stopReason: cause } });
      throw e;
    }
    if (result === "already_running") {
      args.ledger.finishRun({
        runId: started.runId,
        status: "failed",
        aggregates: { ...emptyRunAggregates(), stopReason: MEMO_SAVED_LOST_RACE_STOP_REASON },
      });
    }
    return result;
  };
}

/** 켜진 메모 단위 단계의 batchSize 중 가장 작은 값 — 한 회차에 보낼 메모 수 상한(per-memo-trigger maxPerRun). */
function memoSavedMaxPerRun(settings: MemorySettings, stages: CycleStage[]): number {
  const sizes = stages.map((stage) => {
    if (stage === "entityRegister") return settings.cleanupDeepPass.entityRegister.batchSize;
    if (stage === "personLink") return settings.cleanupDeepPass.personLink.batchSize;
    throw new Error(`memoSavedMaxPerRun: 메모 단위 단계가 아닌 ${stage}`);
  });
  return Math.min(...sizes);
}

/** "입력할 때마다"(llm.cleanup.trigger=on_save) 대기열. interval 이거나 메모 단위 단계가 모두 꺼져 있으면 null. */
export function buildMemoSavedTrigger(args: MemoSavedTriggerArgs): MemoSavedCleanupTrigger | null {
  if (args.settings.llm.cleanup.trigger !== "on_save") return null;
  const stages = memoSavedStages(args.gate);
  if (stages.length === 0) return null;
  return createMemoSavedCleanupTrigger({
    isBusy: () => args.scheduler.isRunning(),
    start: memoSavedRunStarter(args),
    debounceMs: ENTITY_REGISTER_TRIGGER_TIMING.debounceMs,
    busyRetryMs: ENTITY_REGISTER_TRIGGER_TIMING.busyRetryMs,
    maxPerRun: memoSavedMaxPerRun(args.settings, stages),
  });
}
