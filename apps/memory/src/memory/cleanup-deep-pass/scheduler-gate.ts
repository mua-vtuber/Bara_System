/**
 * scheduler-gate.ts — 깊은 패스 스케줄러 기동 게이트 + 단계별 자기 게이트 순수 함수.
 *
 * 권위 spec: docs/decisions/2026-07-11-cleanup-ai-efficient-operation-spec.md 단락 5.B-2
 *
 * 배경(정비 이유): 옛 index.ts 게이트는 `regexStrengthen.enabled` 를 스케줄러 전체 전제로
 * 요구해, "정규식 강화 OFF + 요약만 ON" 조합이 아예 가동 불가였다(spec #2 표 게이트 불일치).
 * 코드 주석은 단계 독립을 서술하는데 게이트가 그와 어긋났다. 이 모듈은 그 의도에 게이트를
 * 일치시킨다 — 기동은 슬롯 공통 조건 + "켜진 단계 1개 이상", 각 단계는 사이클 안에서 자기
 * 게이트로 판단. 신규 동작이 아니라 기존에 돌던 조합 동작을 보존하는 정비다.
 *
 * shouldRunSummaryStage 는 요약 단계 자기 게이트로 이미 summary-cycle.ts 에 있다(테스트
 * 동결). 이 모듈은 스케줄러 기동 게이트(공통 조건 + 단계 OR)와 나머지 단계 자기 게이트를
 * 순수 함수로 모은다 — index.ts 배선이 단일 출처로 소비한다(하드코딩·중복 판단 0).
 */

import type { LlmCleanupSlot } from "../../settings/memory-settings-slots.ts";
import { LLM_PROVIDER_SPECS } from "../../llm/provider-registry.ts";

/**
 * 고른 공급자의 모델 칸이 비었으면 그 설정 키 이름(spec 9장 "모델 설정이 비어 있음").
 * 공급자→모델 칸 대응은 공급자 표(LLM_PROVIDER_SPECS) 한 곳 — 표 타입이 Record<LlmProvider, …> 라
 * 새 공급자가 생기면 표에 줄이 없다는 형 오류가 난다.
 */
export function cleanupModelKeyMissing(slot: LlmCleanupSlot): string | null {
  const key = LLM_PROVIDER_SPECS[slot.provider].modelField;
  return slot[key].trim().length === 0 ? `llm.cleanup.${key}` : null;
}

/** 스케줄러 기동 게이트 입력 — 슬롯 공통 조건 + 단계별 토글. */
export interface CleanupDeepPassGateInput {
  /** 슬롯 토글 — settings.llm.cleanup.enabled. */
  cleanupEnabled: boolean;
  /** cleanup LLM 클라이언트 구성 성공 여부(buildLlmClient 결과 !== null). */
  cleanupLlmAvailable: boolean;
  /**
   * 구성 실패 사유(buildLlmClientWithReason 의 reason — 어떤 칸이 비었는지, 키 값 없음). 부팅 때 실제로
   * 구성을 시도한 경로만 채운다. 없으면 사유에 세부 문장을 붙이지 않는다.
   */
  cleanupLlmFailureReason?: string | null;
  /** 깊은 패스 주기 — settings.llm.cleanup.intervalDays(하루 미만 금지). */
  intervalDays: number;
  /** 정규식 강화 단계 자기 게이트 결과(regexStrengthen.enabled && regexL0 가용). */
  regexStageOn: boolean;
  /** 요약 단계 자기 게이트 결과(shouldRunSummaryStage). */
  summaryStageOn: boolean;
  /** 사람 연결 단계 자기 게이트 결과(personLink.enabled). */
  personLinkStageOn: boolean;
  /** 렌즈 초안 단계 자기 게이트 결과(lensDraft.enabled). */
  lensDraftStageOn: boolean;
  /** 항목·일정 자동 등록 단계 자기 게이트 결과(entityRegister.enabled). */
  entityRegisterStageOn: boolean;
  /** 비어 있는 모델 설정 키(없으면 null). 비어 있으면 다른 모델로 바꾸지 않고 기동하지 않는다. */
  cleanupModelKeyMissing: string | null;
}

/**
 * 스케줄러를 기동할지 결정하는 순수 게이트. 슬롯 공통 조건(enabled·LLM·intervalDays>=1)이
 * 모두 참이고, 켜진 단계가 하나 이상이면 기동한다. 어느 단계든 하나만 켜져 있어도 그 단계를
 * 위해 사이클이 돈다 — "정규식 강화 OFF + 요약만 ON" 같은 조합이 이제 정상 가동한다.
 *
 * 슬롯 공통 조건이 하나라도 빠지면(슬롯 OFF·LLM 미구성·주기<1) 단계 상태와 무관하게 안 켠다.
 */
export function shouldRunCleanupDeepPass(input: CleanupDeepPassGateInput): boolean {
  const slotReady =
    input.cleanupEnabled &&
    input.cleanupLlmAvailable &&
    input.intervalDays >= 1 &&
    input.cleanupModelKeyMissing === null;
  const anyStageOn =
    input.regexStageOn ||
    input.summaryStageOn ||
    input.personLinkStageOn ||
    input.lensDraftStageOn ||
    input.entityRegisterStageOn;
  return slotReady && anyStageOn;
}

/**
 * 스케줄러가 안 켜진 사유 배열을 만든다(정직한 비활성 — 0건 위장 금지). run API(B-1)의 409
 * 사유 배열도 이 함수를 재사용해 스케줄 tick 과 수동 run 이 같은 사유를 낸다.
 *
 * cleanupLlm·intervalDays 검사는 슬롯이 켜졌을 때만 의미 있으므로 그 분기 안에 둔다 —
 * enabled=false + intervalDays=0 같은 조합에서 사유가 둘 찍히는 잡음을 차단한다.
 */
export function cleanupDeepPassGateReasons(
  input: CleanupDeepPassGateInput,
): string[] {
  const reasons: string[] = [];
  if (!input.cleanupEnabled) {
    reasons.push("llm.cleanup.enabled=false");
  } else {
    if (!input.cleanupLlmAvailable) {
      const detail = input.cleanupLlmFailureReason;
      reasons.push(detail ? `cleanup LLM 클라이언트 구성 실패 (${detail})` : "cleanup LLM 클라이언트 구성 실패");
    }
    if (input.intervalDays < 1) {
      reasons.push(`llm.cleanup.intervalDays<1 (${input.intervalDays})`);
    }
    if (input.cleanupModelKeyMissing !== null) {
      reasons.push(`정리 AI 모델이 설정되지 않음 (${input.cleanupModelKeyMissing})`);
    }
  }
  // 슬롯 공통 조건은 갖췄으나 켜진 단계가 하나도 없는 경우(모든 단계 토글 OFF).
  if (
    input.cleanupEnabled &&
    input.cleanupLlmAvailable &&
    input.intervalDays >= 1 &&
    !input.regexStageOn &&
    !input.summaryStageOn &&
    !input.personLinkStageOn &&
    !input.lensDraftStageOn &&
    !input.entityRegisterStageOn
  ) {
    reasons.push(
      "켜진 단계 0 (regexStrengthen·summary·personLink·lensDraft·entityRegister 전부 OFF 또는 regexL0 미가용)",
    );
  }
  return reasons;
}
