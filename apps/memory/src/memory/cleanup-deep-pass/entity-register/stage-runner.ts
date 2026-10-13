/**
 * entity-register/stage-runner.ts — run-cycle-runner 가 부르는 이 단계 실행·dryRun 한 곳.
 * run-cycle-runner.ts 가 800줄 상한을 넘지 않게 단계 배선 본체를 여기 둔다.
 * run-cycle-runner 의 타입을 import 하지 않는다(역방향 의존 0) — 필요한 값만 인자로 받는다.
 */
import type { SqliteMemoryStore } from "../../../db/store.ts";
import type { EventPublisher } from "../../events/event-contract.ts";
import type { CleanupLlmExecutor } from "../cleanup-llm-executor.ts";
import type { StageCycleRecord } from "../cycle-budget.ts";
import { cleanupStageLlmLimitsOf } from "../stage-constants.ts";
import { detectEntityRegisterDryRun, entityRegisterStageRecord, runEntityRegisterCycle } from "./cycle.ts";
import { createEntityRegisterInferFn } from "./prompt.ts";

/** 이 단계 설정(settings.cleanupDeepPass.entityRegister 중 사이클이 읽는 칸). */
export interface EntityRegisterStageConfig { batchSize: number; autoApply: boolean }

/** 한 사이클을 돌리고 run 집계 한 줄(자동·제안·실패와 사유)을 돌려준다. 설정 결함은 CleanupConfigError 로 올라간다. */
export async function runEntityRegisterStage(args: {
  store: SqliteMemoryStore; executor: CleanupLlmExecutor; eventBus: EventPublisher; config: EntityRegisterStageConfig;
  maxAttemptsPerTarget: number; perCallInputCap: number; runId: string | null; nodeIds?: readonly number[];
}): Promise<StageCycleRecord> {
  const summary = await runEntityRegisterCycle({
    store: args.store, infer: createEntityRegisterInferFn(args.executor), eventBus: args.eventBus,
    batchSize: args.config.batchSize, autoApply: args.config.autoApply,
    stageVersion: cleanupStageLlmLimitsOf("entity_register").stageVersion,
    maxAttemptsPerTarget: args.maxAttemptsPerTarget, perCallInputCap: args.perCallInputCap, runId: args.runId,
    ...(args.nodeIds ? { nodeIds: args.nodeIds } : {}),
  });
  return entityRegisterStageRecord(summary);
}

/** 후보 수와 추정 입력 토큰만 센다(LLM 호출 0) — 사이클과 같은 묶음 크기·호출당 상한으로 나눈다. */
export function detectEntityRegisterStageDryRun(args: {
  store: SqliteMemoryStore; config: EntityRegisterStageConfig; perCallInputCap: number;
}): { candidatesFound: number; estimatedInputTokens: number } {
  return detectEntityRegisterDryRun({
    db: args.store.getRawDb(), stageVersion: cleanupStageLlmLimitsOf("entity_register").stageVersion,
    batchSize: args.config.batchSize, perCallInputCap: args.perCallInputCap,
  });
}
