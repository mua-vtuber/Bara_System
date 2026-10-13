/**
 * 정리 AI 칸의 정리 시점·항목·일정 자동 등록 문구(2026-10-10 spec 7.1, 2026-10-11 화면 단순화).
 * i18n-ready 로 한 곳에 모은다(settings-restart-labels.ts 관례).
 */
export const CLEANUP_EXTRA_LABELS = {
  triggerGroupLabel: "정리 시점",
  triggerInterval: "기간마다",
  triggerOnSave: "바로",
  /** 정리 주기 칸 뒤 단위 글 — "바로"여도 정규식 강화·요약은 이 주기로 돈다. */
  intervalUnitInterval: "일마다 정리",
  intervalUnitOnSave: "일마다 나머지 정리",
  onSaveWarning: "펫의 \"입력한 메모 바로 정리\"와 겹치면 같은 메모를 두 번 정리합니다. 서버와 펫 중 한 곳만 켜 두세요.",
  autoApplyLabel: "확실한 것은 바로 반영",
  autoApplyHelp: "끄면 기존 항목 연결·새 항목·확실한 일정도 모두 정리 제안으로 받아 직접 승인합니다.",
  implementationGroupTitle: "항목·일정 자동 등록 세부값",
  batchSizeTitle: "한 번에 보낼 메모 수",
  invalidTrigger: (value: string) => `llm.cleanup.trigger 값이 interval/on_save 가 아님 — "${value}". 설정 파일 검토 필요.`,
  invalidAutoApply: (value: string) => `cleanupDeepPass.entityRegister.autoApply 가 boolean 아님 — "${value}". 설정 파일 검토 필요.`,
} as const;
