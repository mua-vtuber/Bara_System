import { causeOrEmpty } from "./messages-service-core.ts";

/** Texts of the recent questions and saves the Pet keeps on this PC (`recent-history.ts`): the "방금 받은 답"
 * list and the "저장 확인" list of handled saves. `messages.ts` re-exports this section as `messages.recent`. */
export const recentMessages = {
  recent: {
    answersHeading: "최근 질문과 답",
    answersEmpty: "아직 펫에서 받은 답이 없어요.",
    questionLabel: "질문",
    savesHeading: "최근 처리된 저장",
    savesEmpty: "아직 펫에서 처리된 저장이 없어요.",
    openMemory: "저장된 기억 열기",
    savedAs: (label: string) => `${label}로 분류해 저장했어요.`,
    savedPlain: "분류 없이 저장했어요.",
    entityPatched: "기존 엔티티 항목을 갱신했어요.",
    classificationFailed: (reason: string) => `저장했지만 분류에 실패했어요. 원인: ${causeOrEmpty(reason)}`,
    rejected: (reason: string) => `저장하지 않았어요. 원인: ${causeOrEmpty(reason)}`,
    rejectedNoReason: "저장하지 않았어요. 서버가 원인을 알려주지 않았어요.",
    confirmedByUser: "저장 결과를 받지 못해 직접 확인하고 정리했어요.",
    unreadable: (key: string) => `최근 기록을 읽지 못했어요. 저장된 값의 형식이 맞지 않아요. 저장 위치: ${key}`,
    recordFailed: (reason: string) => `결과는 처리됐지만 최근 기록 목록에 남기지 못했어요. 원인: ${causeOrEmpty(reason)}`,
  },
};
