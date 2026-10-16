/**
 * 홈 "자동 정리" 칸·entity_register 제안 카드 문구(2026-10-10 spec 7.2·7.3). i18n-ready 로 한 곳에 모은다.
 */
const STAGE_NAMES: Record<string, string> = {
  regexStrengthen: "자동 인식 규칙", summary: "요약", personLink: "사람 연결", lensDraft: "정보 정리", entityRegister: "항목·일정 등록",
};

export const ENTITY_REGISTER_STRINGS = {
  panelTitle: "자동 정리",
  runButton: "지금 정리하기",
  checking: "정리 가능 여부를 확인하는 중...",
  running: "정리하는 중입니다. 창을 닫아도 서버에서 계속됩니다.",
  unavailable: (reasons: string[]) => `지금은 정리할 수 없습니다: ${reasons.join(" · ")}`,
  startFailed: (detail: string) => `정리를 시작하지 못했습니다: ${detail}`,
  pollFailed: (detail: string) => `진행 상태를 읽지 못했습니다(정리는 서버에서 계속될 수 있습니다): ${detail}`,
  finished: (status: string) => (status === "completed" ? "정리를 마쳤습니다." : status === "cancelled" ? "정리가 취소되었습니다." : "정리가 실패로 끝났습니다."),
  stopReason: (reason: string) => `멈춘 원인: ${reason}`,
  stageResult: (stage: string, autoApplied: number, proposed: number, failures: number, alreadyProcessed = 0) =>
    `${STAGE_NAMES[stage] ?? stage}: 자동 반영 ${autoApplied}개 · 제안 ${proposed}개 · 실패 ${failures}개` +
    (alreadyProcessed > 0 ? ` · 이미 처리됨 ${alreadyProcessed}개` : ""),
  stageResultPlain: (stage: string, completed: number, failures: number) => `${STAGE_NAMES[stage] ?? stage}: 처리 ${completed}개 · 실패 ${failures}개`,
  recentTitle: "최근 자동 등록",
  emptyRecent: "자동으로 등록한 항목이 아직 없습니다.",
  listFailed: (detail: string) => `최근 자동 등록을 불러오지 못했습니다: ${detail}`,
  itemKindLabels: { entity_created: "새로 등록", entity_linked: "연결", schedule_created: "일정", memo_date_filled: "메모 날짜" } as Record<string, string>,
  itemKindUnknown: "알 수 없는 기록",
  itemKind(kind: string): string {
    return Object.hasOwn(this.itemKindLabels, kind) ? this.itemKindLabels[kind]! : `${this.itemKindUnknown}: ${kind}`;
  },
  revertButton: "되돌리기",
  reverting: "되돌리는 중...",
  revertFailed: (detail: string) => `되돌리지 못했습니다: ${detail}`,
  alreadyProcessed: (detail: string) => `이미 처리됨: ${detail}`,
  revertDone: (parts: string[]) => (parts.length > 0 ? `되돌렸습니다. ${parts.join(" ")}` : "되돌렸습니다."),
  revertRemovedAlias: (alias: string) => `별칭 '${alias}'을(를) 뺐습니다.`,
  revertKeptRow: (reason: string) => `항목은 남겼습니다: ${reason}`,
  revertDeletedRow: (typeName: string, id: string) => `새로 만든 항목(${typeName} ${id})을 지웠습니다.`,
  revertTrashedSchedule: (nodeId: number) => `일정 메모 #${nodeId}을(를) 휴지통으로 옮겼습니다.`,
  revertClearedMemoDate: (date: string) => `메모 날짜(${date})를 지웠습니다.`,
  fromMemo: "원본 메모",
  noMemo: "원본 메모 없음",
  proposalTitle: "항목·일정 등록",
  proposalTarget: (nodeId: unknown) => `기억 #${String(nodeId)}`,
  /** 제안 항목 제목 — 종류 이름(기본 종류는 한글, 사용자 종류는 그 이름) · 메모 속 이름. */
  itemHeading: (typeLabel: string, name: string) => `${typeLabel} · ${name}`,
  proposalChange: (items: number, hasSchedule: boolean, hasMemoDate = false) =>
    `확인이 필요한 항목 ${items}개${hasSchedule ? " · 일정 1개" : ""}${hasMemoDate ? " · 메모 날짜 1개" : ""}`,
  reasonLabels: {
    homonym: "같은 이름이 여럿 있어 어느 쪽인지 골라 주세요.",
    similar: "비슷한 기존 이름이 있습니다.",
    honorific: "이름 끝에 호칭이 붙었을 수 있습니다.",
    auto_apply_off: "바로 반영이 꺼져 있어 확인을 받습니다.",
  } as Record<string, string>,
  scheduleReasonLabels: {
    relative: "날짜가 상대 표현이라 확인이 필요합니다.",
    mismatch: "본문 날짜와 AI 날짜가 어긋납니다.",
    auto_apply_off: "바로 반영이 꺼져 있어 확인을 받습니다.",
    title_invalid: "일정 제목을 적어 주세요.",
    replace_existing: "이 메모의 기존 일정 날짜와 다릅니다. 바꿀지 골라 주세요.",
  } as Record<string, string>,
  optionLink: (target: string, addAlias: boolean, memoName: string) => `기존 '${target}'와 같음${addAlias ? ` ('${memoName}'를 별명으로 기억)` : ""}`,
  optionCreate: (name: string, alias: string | null) => (alias ? `'${name}'(으)로 새로 등록 ('${alias}'를 별명으로)` : `'${name}'(으)로 새로 등록`),
  optionIgnore: "무시",
  memoDateHeading: (dateText: string) => `메모 날짜 · ${dateText}`,
  memoDateReasonLabels: {
    relative: "연도가 따로 적혀 있어 날짜를 확인해 주세요.",
    mismatch: "본문 날짜와 AI 날짜가 어긋납니다.",
    auto_apply_off: "바로 반영이 꺼져 있어 확인을 받습니다.",
  } as Record<string, string>,
  memoDateAccept: "메모 날짜 채우기",
  memoDateIgnore: "메모 날짜 무시",
  memoDateLabel: "날짜",
  invalidMemoDate: "메모 날짜를 YYYY-MM-DD 형식의 실제 날짜로 적어 주세요.",
  scheduleAccept: "일정 등록",
  scheduleIgnore: "일정 무시",
  scheduleDate: "날짜",
  scheduleTitleLabel: "제목",
  alreadyApplied: " (이미 적용됨)",
  autoActionLabels: { linked: "기존 항목에 연결", created: "새로 등록", schedule: "일정 등록", memo_date: "메모 날짜 채움" } as Record<string, string>,
  autoActionUnknown: "알 수 없는 처리",
  autoAppliedRow(name: string, action: string): string {
    return `${name} (${Object.hasOwn(this.autoActionLabels, action) ? this.autoActionLabels[action] : `${this.autoActionUnknown}: ${action}`})`;
  },
  autoAppliedTitle: "이미 자동 반영된 것(참고)",
  pickAtLeastOne: "적용할 선택을 하나 이상 고르세요.",
  invalidDate: "일정 날짜를 YYYY-MM-DD 형식의 실제 날짜로 적어 주세요.",
  titleRequired: "일정 제목을 적어 주세요.",
  approveRefused: (detail: string) => `승인하지 못했습니다(제안은 그대로 검토 대기입니다): ${detail}`,
  approveFailed: (status: number, detail: string) => `승인에 실패했습니다(HTTP ${status}): ${detail}. 제안은 그대로 두었으니 다시 시도할 수 있습니다.`,
  rejectNotice: "거절하면 이 제안의 이름·일정·메모 날짜가 모두 '무시'로 기록되어, 같은 메모에서 다시 제안하지 않습니다.",
} as const;
