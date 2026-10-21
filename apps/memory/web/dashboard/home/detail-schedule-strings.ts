/** 홈 상세 "일정 아님" 버튼 문구. i18n-ready 로 한 곳에 모은다. */
export const DETAIL_SCHEDULE_STRINGS = {
  hideButton: "일정 아님",
  showButton: "일정으로 다시 보기",
  hideConfirm: (isAutoSchedule: boolean) =>
    "이 기억을 일정 목록에서 뺀다.\n" +
    "기억 내용과 날짜는 그대로 남고, 날짜로 찾는 검색에도 계속 나온다.\n" +
    (isAutoSchedule ? "자동으로 만든 일정 항목은 휴지통으로 옮겨진다(휴지통에서 복원 가능).\n" : "") +
    "\n진행할까?",
  hideDone: (revertedSchedule: boolean) =>
    revertedSchedule ? "일정에서 뺐습니다 — 자동 일정 항목은 휴지통으로 이동" : "일정에서 뺐습니다",
  showDone: "일정 목록에 다시 표시합니다",
  failed: (detail: string) => `일정 표시 변경 실패: ${detail}`,
} as const;
