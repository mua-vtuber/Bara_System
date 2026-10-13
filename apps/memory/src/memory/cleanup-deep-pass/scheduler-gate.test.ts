/**
 * scheduler-gate.test.ts — 깊은 패스 스케줄러 기동 게이트 순수 함수 검증(spec 5.B-2).
 *
 * 초점: (a) 슬롯 공통 조건 + "켜진 단계 1개 이상" 기동 판정, (b) 옛 게이트가 막던
 * "정규식 OFF + 요약만 ON" 조합이 이제 가동, (c) 기존에 돌던 조합 보존, (d) 사유 배열이
 * 어느 조건이 빠졌는지 정직하게 낸다.
 */

import { describe, expect, test } from "bun:test";
import {
  cleanupDeepPassGateReasons,
  shouldRunCleanupDeepPass,
  type CleanupDeepPassGateInput,
} from "./scheduler-gate.ts";

/** 슬롯 공통 조건 충족 + 세 단계 모두 ON 기본. 테스트가 필요한 칸만 덮는다. */
function base(overrides: Partial<CleanupDeepPassGateInput> = {}): CleanupDeepPassGateInput {
  return {
    cleanupEnabled: true,
    cleanupLlmAvailable: true,
    intervalDays: 7,
    regexStageOn: true,
    summaryStageOn: true,
    personLinkStageOn: true,
    lensDraftStageOn: true,
    entityRegisterStageOn: true,
    cleanupModelKeyMissing: null,
    ...overrides,
  };
}

describe("shouldRunCleanupDeepPass — 기동 게이트", () => {
  test("슬롯 조건 충족 + 세 단계 ON → 기동", () => {
    expect(shouldRunCleanupDeepPass(base())).toBe(true);
  });

  test("정규식 OFF + 요약만 ON → 이제 기동(옛 게이트가 막던 조합)", () => {
    expect(
      shouldRunCleanupDeepPass(
        base({ regexStageOn: false, summaryStageOn: true, personLinkStageOn: false, lensDraftStageOn: false, entityRegisterStageOn: false }),
      ),
    ).toBe(true);
  });

  test("정규식만 ON(요약·사람 OFF) → 기동(기존 조합 보존)", () => {
    expect(
      shouldRunCleanupDeepPass(
        base({ regexStageOn: true, summaryStageOn: false, personLinkStageOn: false, lensDraftStageOn: false, entityRegisterStageOn: false }),
      ),
    ).toBe(true);
  });

  test("사람 연결만 ON → 기동", () => {
    expect(
      shouldRunCleanupDeepPass(
        base({ regexStageOn: false, summaryStageOn: false, personLinkStageOn: true, lensDraftStageOn: false, entityRegisterStageOn: false }),
      ),
    ).toBe(true);
  });

  test("렌즈 소비만 ON → 기동", () => {
    expect(
      shouldRunCleanupDeepPass(
        base({
          regexStageOn: false,
          summaryStageOn: false,
          personLinkStageOn: false,
          lensDraftStageOn: true,
          entityRegisterStageOn: false,
        }),
      ),
    ).toBe(true);
  });

  test("켜진 단계 0 → 안 켬(슬롯은 준비됐어도 할 일 없음)", () => {
    expect(
      shouldRunCleanupDeepPass(
        base({ regexStageOn: false, summaryStageOn: false, personLinkStageOn: false, lensDraftStageOn: false, entityRegisterStageOn: false }),
      ),
    ).toBe(false);
  });

  test("슬롯 OFF → 단계 상태 무관하게 안 켬", () => {
    expect(shouldRunCleanupDeepPass(base({ cleanupEnabled: false }))).toBe(false);
  });

  test("LLM 미구성 → 안 켬", () => {
    expect(shouldRunCleanupDeepPass(base({ cleanupLlmAvailable: false }))).toBe(false);
  });

  test("intervalDays<1 → 안 켬(하루 미만 주기 금지)", () => {
    expect(shouldRunCleanupDeepPass(base({ intervalDays: 0 }))).toBe(false);
  });
});

describe("cleanupDeepPassGateReasons — 정직한 비활성 사유", () => {
  test("슬롯 OFF 면 그 사유 하나만(잡음 차단)", () => {
    const reasons = cleanupDeepPassGateReasons(
      base({ cleanupEnabled: false, intervalDays: 0 }),
    );
    expect(reasons).toEqual(["llm.cleanup.enabled=false"]);
  });

  test("슬롯 ON + LLM 미구성 + 주기<1 → 두 사유", () => {
    const reasons = cleanupDeepPassGateReasons(
      base({ cleanupLlmAvailable: false, intervalDays: 0 }),
    );
    expect(reasons).toContain("cleanup LLM 클라이언트 구성 실패");
    expect(reasons.some((r) => r.includes("intervalDays<1"))).toBe(true);
  });

  test("슬롯 준비 + 단계 전부 OFF → 켜진 단계 0 사유", () => {
    const reasons = cleanupDeepPassGateReasons(
      base({ regexStageOn: false, summaryStageOn: false, personLinkStageOn: false, lensDraftStageOn: false, entityRegisterStageOn: false }),
    );
    expect(reasons.some((r) => r.includes("켜진 단계 0"))).toBe(true);
  });

  test("an empty cleanup model name stops the deep pass and names the key", () => {
    const input = base({ cleanupModelKeyMissing: "llm.cleanup.anthropicModel" });
    expect(shouldRunCleanupDeepPass(input)).toBe(false);
    expect(cleanupDeepPassGateReasons(input)).toContain("정리 AI 모델이 설정되지 않음 (llm.cleanup.anthropicModel)");
  });

  test("the entity-register stage alone is enough to start the deep pass", () => {
    const input = base({ regexStageOn: false, summaryStageOn: false, personLinkStageOn: false, lensDraftStageOn: false, entityRegisterStageOn: true });
    expect(shouldRunCleanupDeepPass(input)).toBe(true);
  });

  test("정상 기동 조건이면 사유 0", () => {
    expect(cleanupDeepPassGateReasons(base())).toEqual([]);
  });
});
