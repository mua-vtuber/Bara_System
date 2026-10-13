/**
 * migrate-entity-register-keys.ts — 항목·일정 자동 등록 단계 합류 때의 기존 설정 이관.
 *
 * stageAllocation 은 단계별 비율이고 합이 1.0 이어야 한다(validateStageAllocation). 기존
 * 파일에는 네 칸만 있어 기본값 병합이 entityRegister 0.2 를 더하면 합이 1.2 가 되어 로드가
 * 멈춘다. 그래서 병합 전에 기존 네 비율에 0.8 을 곱하고 entityRegister 0.2 를 더한다 —
 * 사용자 비율의 상대 크기를 지키고 합 1.0 을 유지한다(2026-10-10 사용자 결정).
 *
 * migrate-legacy-keys.ts 가 이미 800줄을 넘어 이 단계는 별 파일로 두고 그쪽은 호출만 한다.
 */

import { ENTITY_REGISTER_BATCH_SIZE_MAX } from "../memory/cleanup-deep-pass/stage-constants";

/** 새 단계 몫(2026-10-10 사용자 결정). 나머지 네 단계는 (1 - 이 값)을 곱한다. */
export const ENTITY_REGISTER_ALLOCATION_SHARE = 0.2;

const OLD_STAGE_KEYS = ["regexStrengthen", "summary", "personLink", "lensDraft"] as const;

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = parent[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function migrateEntityRegisterAllocation(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const deep = objectAt(migrated, "cleanupDeepPass");
  const budget = deep ? objectAt(deep, "budget") : null;
  const alloc = budget ? objectAt(budget, "stageAllocation") : null;
  if (!alloc || "entityRegister" in alloc) return;
  const keep = 1 - ENTITY_REGISTER_ALLOCATION_SHARE;
  for (const key of OLD_STAGE_KEYS) {
    if (!(key in alloc)) continue;
    const ratio = alloc[key];
    if (typeof ratio !== "number" || Number.isNaN(ratio)) {
      throw new Error(
        `cleanupDeepPass.budget.stageAllocation.${key} 는 숫자여야 함(받은 값: ${String(ratio)}) — 항목·일정 자동 등록 배분 이관을 멈춘다`,
      );
    }
    alloc[key] = ratio * keep;
  }
  alloc.entityRegister = ENTITY_REGISTER_ALLOCATION_SHARE;
  warnings.push(
    "항목·일정 자동 등록(2026-10-10) — stageAllocation 네 비율에 0.8 을 곱하고 entityRegister 0.2 를 더했다(상대 비율 보존, 합 1.0).",
  );
}

/**
 * 정리 AI 를 이미 켜 둔 기존 설치는 새 단계도 켠다. 기본값(entityRegister.enabled=false)만 병합하면
 * 사용자가 설정을 다시 저장할 때까지 단계가 조용히 한 번도 돌지 않는다. 파일에 llm.cleanup.enabled 가
 * true 이고 cleanupDeepPass.entityRegister.enabled 칸이 아직 없을 때만 true 를 넣는다(autoApply 등 다른
 * 칸은 기본값 병합에 맡긴다). 칸이 이미 있으면 사용자 값이므로 건드리지 않는다(멱등).
 */
export function migrateEntityRegisterEnabledForCleanupOn(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const llm = objectAt(migrated, "llm");
  const cleanup = llm ? objectAt(llm, "cleanup") : null;
  if (!cleanup || cleanup.enabled !== true) return;
  if ("cleanupDeepPass" in migrated && !objectAt(migrated, "cleanupDeepPass")) return;
  const deep = objectAt(migrated, "cleanupDeepPass") ?? {};
  if ("entityRegister" in deep && !objectAt(deep, "entityRegister")) return;
  const stage = objectAt(deep, "entityRegister") ?? {};
  if ("enabled" in stage) return;
  stage.enabled = true;
  deep.entityRegister = stage;
  migrated.cleanupDeepPass = deep;
  warnings.push(
    "항목·일정 자동 등록(2026-10-10) — 정리 AI(llm.cleanup.enabled)가 켜진 기존 설치라 cleanupDeepPass.entityRegister.enabled 를 true 로 켰다.",
  );
}

/**
 * batchSize 상한(ENTITY_REGISTER_BATCH_SIZE_MAX) 도입 전에 더 큰 값을 저장한 설치는 스키마 검증이
 * 로드를 멈추므로 상한으로 내린다. 숫자가 아닌 값은 건드리지 않고 검증이 사유를 말하게 둔다. 멱등.
 */
export function migrateEntityRegisterBatchSizeCap(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const deep = objectAt(migrated, "cleanupDeepPass");
  const stage = deep ? objectAt(deep, "entityRegister") : null;
  if (!stage) return;
  const size = stage.batchSize;
  if (typeof size !== "number" || !(size > ENTITY_REGISTER_BATCH_SIZE_MAX)) return;
  stage.batchSize = ENTITY_REGISTER_BATCH_SIZE_MAX;
  warnings.push(
    `cleanupDeepPass.entityRegister.batchSize ${size} 는 상한 ${ENTITY_REGISTER_BATCH_SIZE_MAX} 를 넘어 ${ENTITY_REGISTER_BATCH_SIZE_MAX} 로 내렸다.`,
  );
}
