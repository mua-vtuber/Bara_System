import { CORE_DEFAULT_PORT, INPUT_MAX_CHARS, LOCAL_INSTALL_MARGIN_BYTES, LOCAL_INSTALL_MODEL_BYTES, QUESTION_MAX_CHARS,
  type CaptureKind, type ProgressStage } from "../shared/contracts.ts";
import nativeHost from "../shared/native-host.json";
import { EXISTING_CHOICE_LABEL } from "./messages-labels.ts";
import { recentMessages } from "./messages-recent.ts";
import { serviceAiMessages } from "./messages-service-ai.ts";
import { causeOrEmpty, serviceCoreMessages, withCause, withCauseThen } from "./messages-service-core.ts";
import { serviceInstallMessages } from "./messages-service-install.ts";
import { serviceReleaseMessages } from "./messages-service-release.ts";
import { selfUpdateMessages } from "./messages-self-update.ts";
import { installLockMessages } from "./messages-install-lock.ts";
import { guideMessages } from "./messages-guide.ts";
import type { SquirrelErrorCode } from "./squirrel/squirrel-errors.ts";

export const labels: Record<CaptureKind, string> = {
  idea: "아이디어", decision: "결정", question: "궁금한 것", preference: "취향·선호", task: "할 일", information: "정보·경험",
};

/** Shared between `hostErrors.HOST_FEEDBACK_UNAVAILABLE` (a native command found no feedback to
 * return) and `feedback.noFeedback` (the screen's own empty state), so the wording stays one text. */
const NO_FEEDBACK_TEXT = "아직 보여줄 결과가 없어요. 펫에게 입력하거나 물어보세요.";

/** Decimal gigabytes (1,000,000,000 bytes) with one decimal place, rounded the way `round` says: a space still
 * needed is rounded up and a free space down, so neither reads as more room than there is. */
const gigabytes = (bytes: number, round: (value: number) => number) => (round(bytes / 100_000_000) / 10).toFixed(1);
/** A drive's shortfall as the free-space texts write it (`connectionErrors.INSTALL_DISK_LOW`, `backupErrors.BACKUP_DISK_LOW`):
 * the space still needed rounded up and the free space rounded down, both in decimal gigabytes. */
const shortfall = (missingBytes: number, freeBytes: number) =>
  ({ missing: gigabytes(missingBytes, Math.ceil), free: gigabytes(freeBytes, Math.floor) });
/** The backup folder's name under Documents, the host's own (`native-host.json` `contract.backupFolderName`). */
const BACKUP_FOLDER = nativeHost.contract.backupFolderName;

export const messages = {
  guide: guideMessages,
  common: {
    title: "바라", subtitle: "가볍게 남기고, 편하게 물어봐요.",
    input: "입력하기", question: "질문하기", settings: "연결과 설정", cleanup: "기억 정리",
    save: "기억해두기", ask: "물어보기", cancel: "취소", close: "닫기", search: "질문",
    inputLabel: "새 기억", noCategory: "분류 없음", categoryLabel: "기억 분류", contentLabel: "기억 내용",
  },
  main: {
    petLabel: "바라에게 기록 남기기", petTitle: "클릭해서 입력창 열기·닫기 · 끌어서 옮기기",
    settingsButton: "설정", navigationLabel: "주요 기능", minimizeWindow: "최소화",
    openDashboard: "대시보드 열기", openingDashboard: "대시보드를 여는 중이에요.", dashboardOpened: "브라우저에서 대시보드를 열었어요.",
    checkConnection: "연결 확인", connectStorage: "기억을 보관할 곳을 연결하면 준비가 끝나요.",
  },
  composer: {
    inputHeading: "한 줄이어도 괜찮아요.", inputIntro: "정리는 나중에. 지금은 떠오른 그대로 남겨요.",
    questionHeading: "무엇이 궁금해요?", questionIntro: "남겨둔 기억에서 함께 찾아볼게요.",
    inputPlaceholder: "방금 떠오른 생각, 잊고 싶지 않은 일…", questionPlaceholder: "어떤 기억을 찾아볼까요?",
    classifyAutomatically: "알아서 분류", uncategorized: "분류 없이", questionHint: "질문은 새 기억으로 저장하지 않아요.",
    storageFailure: "초안을 보관하지 못했어요. 내용을 복사해 두세요.", sourcesHeading: "찾아본 기억",
    saving: "기억을 저장하고 있어요.", pendingCheck: "저장을 확인할 기록이 있어요.",
    checkSave: "저장 여부 확인", stopSending: "전송 중단", confirmSaved: "저장된 것을 확인했어요.",
    confirmSavedTitle: "검색으로 저장을 확인했나요?",
    confirmSavedBody: "확인한 기록의 전송 보관함을 정리해요. 새로 쓰는 초안은 그대로 남아요.",
    confirmSavedAction: "확인했어요", cleanConfirmed: "확인한 기록을 보관함에서 정리했어요.",
    restoreDraft: "내용을 초안으로 가져오기", restoreDraftTitle: "초안으로 다시 가져올까요?",
    restoreDraftBody: "이미 저장되었을 수도 있어요. 검색으로 확인한 뒤 다시 보내 주세요. 현재 초안이 있으면 끝에 이어 붙여요.",
    restoreDraftAction: "초안으로 가져오기", draftRestored: "내용을 초안으로 가져왔어요. 아직 다시 보내지는 않았어요.",
    searching: "기억을 찾아보고 있어요.", savingMemory: "기억을 남기고 있어요.", foundMemories: "관련된 기억을 찾았어요.",
    keyboardHint: "Enter로 보내기 · Shift+Enter로 줄바꿈",
    saved: "저장된 기억을 확인했어요.", savedAs: (label: string) => `${label}로 분류했어요.`,
    entityPatchSaved: "엔티티 항목을 갱신한 것을 확인했어요.",
    statusUnknown: (reason: string) => `상태를 확인하지 못했습니다: ${reason}. 저장 중일 수도, 이미 끝났을 수도 있습니다.`,
    cancelNotDelivered: (reason: string) => `중단 요청이 서버에 전달되지 않았습니다: ${reason}`,
  },
  settings: {
    heading: "기억을 보관할 곳", intro: "처음 한 번 연결해두면, 다음부터는 바라에게 바로 말하면 돼요.",
    connectionDetails: "연결 설정", autoStartHeading: "자동 실행", aiOptional: "AI 없이도 기억 저장·검색은 쓸 수 있어요.",
    localDescription: "이 PC에 기억을 보관해요. 필요한 프로그램과 모델은 자동으로 준비할게요.",
    /** The amounts are the install's own free-space check (`LOCAL_INSTALL_*_BYTES`, `src/service/install/disk-space.ts`). */
    localRequirements: `처음 준비할 때 인터넷으로 모델 약 ${gigabytes(LOCAL_INSTALL_MODEL_BYTES, Math.ceil)}GB를 내려받아요. ` +
      `여유 공간이 ${Math.ceil((LOCAL_INSTALL_MODEL_BYTES + LOCAL_INSTALL_MARGIN_BYTES) / 1_000_000_000)}GB쯤 필요해요. 기존 데이터는 덮어쓰지 않아요.`,
    remoteDescription: "이미 준비한 Ubuntu 서버에 바라를 설치해요. 서버 주소와 접속 키가 필요해요.",
    serverUrlPlaceholder: `https://… 또는 http://127.0.0.1:${CORE_DEFAULT_PORT}`, connectionPlaceholder: "연결 토큰 또는 대시보드 접속 링크",
    serverAddress: "바라 서버 주소", connectionInfo: "연결 정보", enrollmentHint: "토큰이 없다면 기존 대시보드에서 연결 요청을 승인할 수 있어요.",
    sshConnection: "SSH로 서버에 연결", hostPlaceholder: "서버 IP 또는 도메인", userPlaceholder: "예: ubuntu",
    keyPlaceholder: "SSH 키 파일을 선택해 주세요", findKey: "찾기", fingerprintTrust: "서버의 지문과 일치하는 것을 확인했어요",
    inspectServer: "서버 연결 확인", preparingSsh: "서버 연결을 준비하고 있어요.", knownServer: "확인한 서버예요.",
    verifyFingerprint: "서버에서 안내받은 지문과 같은지 확인해 주세요.",
    hostLabel: "서버 주소", userLabel: "접속 계정", sshPortLabel: "접속 포트", keyLabel: "SSH 키", serverPortLabel: "바라 서버 포트",
    prepareLocal: "이 PC에 준비하기", stopSetup: "준비 중단",
    localChoice: "이 컴퓨터", localChoiceDescription: "펫과 기억을 함께",
    remoteChoice: "내 외부 서버", remoteChoiceDescription: "새 서버에 설치",
    existingChoice: EXISTING_CHOICE_LABEL, existingChoiceDescription: "사용하던 기억에 연결",
    installRemote: "서버에 설치하고 연결", connectExisting: "기존 바라에 연결",
    verifyBeforeInstall: "서버 연결 확인을 누르고 서버 지문을 확인해 주세요.", connected: "기억에 연결했어요.",
    connectionApproved: "연결을 승인받았어요.",
    aiHeading: "답변 AI와 기억 정리", noAiSearch: "AI 없이 기억 검색", ollamaThisPc: "Ollama · 이 PC의 AI",
    compatibleApi: "LM Studio 또는 호환 API", aiAddress: "AI 주소", modelName: "사용할 모델 이름",
    optionalApiKey: "필요한 경우에만 입력", defaultModel: "비워두면 연결한 AI의 기본 모델",
    saveAi: "AI 설정 저장", aiSaved: "답변 AI와 기억 정리 설정을 저장했어요.",
    aiLoading: "저장된 AI 설정을 불러오고 있어요.", aiLoaded: "저장된 AI 설정이에요.", aiSaving: "AI 설정을 저장하고 있어요.",
    aiUnsaved: "변경한 내용이 아직 저장되지 않았어요. AI 설정 저장을 눌러 주세요.",
    answerAiSaved: "답변 AI 설정을 저장했어요.", answerAiSavedCleanupPending: "답변 AI 설정을 저장했어요. 기억 정리 변경 내용은 AI 설정 저장을 눌러 주세요.",
    answerAi: "질문에 답할 AI", model: "모델", apiKey: "API 키", cleanupAi: "기억 정리에 사용할 AI",
    cleanupNotSet: "선택하지 않음", claudeCodeProvider: "Claude Code", codexProvider: "Codex", ollamaProvider: "Ollama",
    cleanupProviderHint: "Claude Code와 Codex는 이 PC에 설치하고 로그인한 상태에서 연결할 수 있어요.", cleanupModel: "정리 모델",
    cleanupOnSaveHeading: "입력한 메모 바로 정리",
    cleanupOnSavePreference: "메모를 저장하면 정리 주기를 기다리지 않고 바로 정리하기",
    cleanupOnSaveHelp: "서버의 \"입력할 때마다\" 정리와 같은 일을 하니, 서버와 펫 중 한 곳만 켜 두세요.",
    cleanupOnSaveDone: (submitted: number, failed: number) => `제출 ${submitted}건${failed > 0 ? `, 실패 ${failed}건` : ""}`,
    cleanupOnSaveLastFailure: (detail: string, at: string) => `마지막 바로 정리 실패 ${at}: ${detail}`,
    cleanupOnSaveTimedOut: "시간 한도 안에 끝나지 않아 멈췄어요.",
    cleanupOnSaveOutcome: { done: "완료", failed: "실패", skipped: "건너뜀" },
    cleanupOnSaveLast: (outcome: string, detail: string, at: string) => `마지막 바로 정리 ${at} - ${outcome}: ${detail}`,
    autoStarted: "Windows에 로그인하면 바라가 함께 켜져요.", autoStartOff: "자동 실행을 껐어요.", autoStartPreference: "Windows에 로그인하면 바라를 함께 켜기",
    savedConnection: "연결 정보가 안전하게 보관되어 있어요.", savedApiKey: "키가 안전하게 보관되어 있어요.",
    findAi: "이 PC의 AI 찾기", findingAi: "이 PC에서 AI를 찾고 있어요.",
    foundAi: "찾은 AI를 누르면 질문에 답할 AI로 고르고 모델 목록을 보여드려요.",
    foundNoAi: "이 PC에서 실행 중인 AI를 찾지 못했어요. AI 없이도 기억 저장·검색은 쓸 수 있어요. Ollama나 LM Studio를 켠 뒤 다시 찾거나, 고급 설정에서 주소를 직접 입력해 주세요.",
    serverNames: { ollama: "Ollama", "lm-studio": "LM Studio", jan: "Jan", "llama-cpp": "llama.cpp" },
    discoveredServer: (name: string, models: number) => models === 0 ? `${name} · 설치된 모델 없음` : `${name} · 모델 ${models}개`,
    pickedServer: (name: string) => `${name}을(를) 골랐어요. 모델을 확인한 뒤 AI 설정 저장을 눌러 주세요.`,
    pickModel: "모델을 골라 주세요", modelNotListed: (model: string) => `${model} (지금 목록에 없음)`,
    cliFound: (name: string) => `${name} · 설치됨`, cliNotFound: (name: string) => `${name} · 이 PC에서 찾지 못함`,
    aiAdvanced: "고급 설정 · 주소와 모델 직접 입력", loadModels: "이 주소의 모델 불러오기",
    keyNotForThisServer: "저장된 API 키는 이전 주소용이라 이 주소에는 쓰이지 않아요. 이 AI에 키가 필요하면 고급 설정에서 다시 입력해 주세요.",
    answerStatusLabel: "답변 AI 상태", cleanupStatusLabel: "기억 정리 AI 상태", checkingAi: "저장한 설정으로 연결을 확인하고 있어요.",
    slotUnsaved: "변경한 내용이 아직 저장되지 않았어요.", slotSavedUnchecked: "저장했어요. 아직 연결은 확인하지 않았어요.",
    slotUsable: (message: string) => `저장했고 사용할 수 있어요. ${message}`, slotNotUsable: (message: string) => `저장했지만 아직 쓸 수 없어요. ${message}`,
  },
  onboarding: {
    titles: { storage: "기억을 어디에 보관할까요?", ai: "어떤 AI를 쓸까요?", check: "연결을 확인할게요", display: "바라를 어떻게 둘까요?" },
    intros: {
      storage: "이 컴퓨터에 새로 준비하거나, 사용 중인 바라나 외부 서버에 연결해요.",
      ai: "질문에 답하고 기억을 정리할 AI를 골라요. 나중에 연결해도 괜찮아요.",
      check: "저장소와 고른 AI가 실제로 동작하는지 각각 확인해요.",
      display: "펫을 화면에 둘지, 작업 표시줄 아이콘만 둘지 골라요.",
    },
    progress: (step: number, total: number, intro: string) => `${step} / ${total} · ${intro}`,
    next: "다음", back: "이전", recheck: "다시 확인", finish: "시작하기", checking: "확인하고 있어요.",
    skipSetup: "나중에 하기", laterNotice: "처음 설정을 마쳤어요. 남은 항목은 설정에서 언제든 바꿀 수 있어요.",
    resume: "처음 설정 이어 하기",
    aiLater: "AI 없이도 기억 저장과 검색은 쓸 수 있어요. 바꾸려면 언제든 설정에서 다시 고를 수 있어요.",
    storageLabel: "기억 저장소", later: "나중에 연결",
    showPet: "펫으로 보기", showPetDescription: "화면에 다람쥐가 있어요",
    trayOnly: "트레이로만 사용", trayOnlyDescription: "작업 표시줄 아이콘에서 써요",
    trayHint: "어느 쪽이든 작업 표시줄의 바라 아이콘으로 입력·검색·설정을 열 수 있어요. 아이콘이 보이지 않으면 작업 표시줄의 숨겨진 아이콘(^)을 확인해 주세요.",
    progressNotSaved: "설정 진행 상황을 저장하지 못했어요. 다음에 열면 처음 단계부터 보일 수 있어요.",
    done: "준비가 끝났어요. 펫이나 작업 표시줄 아이콘에서 기록을 남겨 보세요.",
  },
  memory: {
    genericLabel: "기억", sourceLabel: (id: number) => `원문 보기 · #${id}`,
    originalHeading: "기억 원문", saveEdit: "수정 저장", edit: "수정하기", dashboard: "대시보드에서 보기",
    content: "내용", category: "분류", emptyContent: "내용을 입력해 주세요.", savingEdit: "수정한 내용을 저장하고 있어요.",
    edited: "수정했어요.",
    updated: "기억을 수정했어요.", preserveTags: "기존 태그는 본문을 수정해도 함께 보관해요.",
    editConflict: "다른 곳에서 먼저 수정되어 충돌했습니다. 최신 내용을 다시 불러온 뒤 다시 시도해 주세요.",
    captureConflict: "AI 분류와 충돌해 저장하지 못했습니다. 최신 내용을 다시 불러온 뒤 다시 시도해 주세요.",
    editRereadFailed: (reason?: string) => withCauseThen("수정은 서버에 저장됐지만 최신 내용을 다시 불러오지 못했습니다", reason, "최신 내용을 다시 불러와 확인해 주세요."),
    editRevisionMissing: "수정 기준 버전을 알 수 없어 저장하지 않았습니다. 기억을 다시 불러온 뒤 수정해 주세요.",
    audienceMissing: "이 기억이 어느 서버에 있는지 알 수 없어 저장하지 않았습니다. 기억을 다시 불러온 뒤 수정해 주세요.",
    editReloadFailed: (reason: string) => withCause("최신 내용을 다시 불러오지 못해 저장을 계속할 수 없습니다. 다시 시도해 주세요.", reason),
    editableBodyMissing: "서버가 태그를 뺀 수정용 본문을 보내지 않아 저장하지 않았습니다. 수정용 본문을 지원하는 버전으로 서버를 업데이트해 주세요.",
    reloadLatest: "최신 내용 다시 불러오기", reloadingLatest: "최신 내용을 불러오고 있어요.",
    reloadedLatest: "최신 내용을 불러왔어요. 위의 최신 내용을 확인하고 수정한 내용을 다시 저장해 주세요.",
    unknownCategory: (kind: string) => `알 수 없는 분류(${kind})`,
    unknownCategoryHint: "펫이 아직 모르는 새 분류예요. 펫 업데이트가 필요할 수 있어요. 내용 확인과 수정은 그대로 할 수 있어요.",
    nothingToSave: "바뀐 내용이나 분류가 없어 저장하지 않았어요.",
    latestServerCategory: (label: string) => `서버의 최신 분류: ${label}. 저장하면 위에서 고른 분류로 바뀌어요.`,
  },
  cleanup: {
    heading: "기억을 한 번 다듬어볼까요?",
    intro: "연결한 AI가 살펴보고 정리할 내용을 제안해요. 변경할 내용은 직접 확인할 수 있어요.",
    create: "정리 제안 만들기", progress: "정리할 기억을 살펴보고 있어요.", cancel: "중단하기",
    review: "검토할 내용 보기", settingsHint: "정리에 사용할 AI는 연결과 설정에서 선택할 수 있어요.",
    submitted: (count: number) => `정리 제안 ${count}건을 만들었어요.`,
    /** The result paragraph under the buttons, built from the run's counts (`cleanupResultText`). */
    resultCounts: (submitted: number, noFinding: number) =>
      (submitted > 0 ? `검토할 정리 제안 ${submitted}건을 만들었어요.` : "새로 만든 정리 제안은 없어요.")
      + (noFinding > 0 ? ` ${noFinding}건은 살펴봤지만 고칠 곳이 없었어요.` : ""),
    resultSkipped: (skipped: number, reasons?: string) => `${skipped}건은 처리하지 못해 건너뛰었어요.${reasons ? ` 이유: ${reasons}` : ""}`,
    /** The result paragraph's sentence for proposals the cleanup server's quality checks turned down (`rejections`). */
    resultRejected: (rejected: number, reasons?: string) => `${rejected}건은 정리 AI가 낸 규칙이 품질 검사를 통과하지 못해 버렸어요.${reasons ? ` 이유: ${reasons}` : ""}`,
    /** The notice over the screen when candidates were skipped; the reasons stand in the result paragraph only. */
    submittedWithFailures: (count: number, skipped: number) => `정리 제안 ${count}건을 만들었고 ${skipped}건은 건너뛰었어요. 이유는 아래에 적어 두었어요.`,
    /** The notice when candidates were skipped and the server also turned proposals down; counts only. */
    submittedWithFailuresAndRejections: (count: number, skipped: number, rejected: number) =>
      `정리 제안 ${count}건을 만들었고 ${skipped}건은 건너뛰었으며 ${rejected}건은 품질 검사에서 버렸어요. 이유는 아래에 적어 두었어요.`,
    /** The notice when the server turned proposals down and nothing was skipped; the reasons stand in the result paragraph only. */
    submittedWithRejections: (count: number, rejected: number) => `정리 제안 ${count}건을 만들었고 ${rejected}건은 품질 검사에서 버렸어요. 이유는 아래에 적어 두었어요.`,
    /** Korean for each quality check the cleanup server runs on a proposed rule (the harness reasons of
     * bara apps/memory/src/memory/cleanup-deep-pass/regex-strengthen-harness.ts). A reason without an entry is
     * shown with the server's own sentence (`cleanupRejectionReason`). */
    rejectionReasons: {
      compile: "규칙이 정규식으로 읽히지 않았습니다",
      self_match: "규칙이 정리 AI가 든 예문조차 잡지 못했습니다",
      overmatch: "규칙이 관계없는 글까지 너무 많이 잡았습니다",
      redundant: "이미 있거나 검토를 기다리는 규칙이 같은 글을 잡습니다",
      validity: "규칙의 점수·분류·극성 값이 정해진 범위를 벗어났습니다",
    } as Readonly<Record<string, string>>,
    notConfigured: "정리에 사용할 AI가 아직 선택되지 않았습니다. 연결과 설정에서 선택해 주세요.",
    cancelFailed: (reason: string) => `정리 중단 요청이 전달되지 않았습니다: ${reason}`,
    /** Korean cause for the failure codes a cleanup run reports: the server's cleanup tool codes
     * (bara apps/memory/src/mcp/tools-cleanup.ts), the Pet's own candidate check, the three ways a
     * request to the cleanup server (`MCP_FAILURE_CODES`, `src/service/mcp.ts`) gets no answer, and the
     * failures of a request to the cleanup AI's own server (`CLEANUP_AI_FAILURE_CODES`,
     * `src/service/cleanup.ts`) whose cause is one fixed fact. A code
     * without an entry is shown with the cause sentence that came with it (`cleanupFailureReason`); the
     * server's `INTERNAL`, the Pet's `MCP_REQUEST_UNEXPECTED` and the cleanup AI's `CLEANUP_AI_RESPONSE` and
     * `CLEANUP_AI_REQUEST_UNEXPECTED` are left out on purpose, because only their sentences name what
     * actually failed. */
    failureReasons: {
      DISABLED: "서버에서 이 정리 단계가 꺼져 있습니다",
      FORBIDDEN: "연결 토큰에 정리 도구 권한이 없습니다",
      INVALID_INPUT: "서버가 정리 요청 형식을 거부했습니다",
      NOT_FOUND: "정리 대상이 서버에 없습니다",
      STALE_CANDIDATE: "후보를 살펴보는 사이 서버의 기억이 바뀌었습니다",
      CANDIDATE_INVALID: "서버가 보낸 정리 후보를 읽지 못했습니다",
      MCP_NETWORK: "정리 서버에 연결하지 못했습니다",
      MCP_TIMEOUT: "정리 서버가 제한 시간 안에 응답하지 않았습니다",
      MCP_REDIRECT: "정리 서버가 다른 주소로 이동하라고 응답했습니다",
      CLEANUP_AI_NETWORK: "정리 AI 서버에 연결하지 못했습니다",
      CLEANUP_AI_TIMEOUT: "정리 AI 서버가 제한 시간 안에 응답하지 않았습니다",
      CLEANUP_AI_REDIRECT: "정리 AI 서버가 다른 주소로 이동하라고 응답했습니다",
      CLEANUP_AI_AUTH_REQUIRED: "정리 AI 서버가 인증을 거부했습니다. AI 서버의 인증키가 맞는지 확인해 주세요",
      CLEANUP_AI_FORBIDDEN: "정리 AI 서버가 이 요청을 허용하지 않았습니다. 인증키에 이 모델을 쓸 권한이 있는지 확인해 주세요",
      CLEANUP_AI_HTTP_FAILED: "정리 AI 서버가 요청을 처리하지 못했습니다. AI 서버 주소와 모델 이름을 확인해 주세요",
    } as Readonly<Record<string, string>>,
    failureWithCause: (code: string, cause: string) => `${code}: ${causeOrEmpty(cause)}`,
  },
  drafts: {
    unreadableDraft: "보관한 초안을 읽지 못했어요. 입력한 내용을 복사해 두세요.",
    unreadableOutbox: "저장을 확인할 기록을 읽지 못했어요. 앱을 다시 열어 주세요.",
    confirmPrevious: "먼저 이전 기록의 저장 여부를 확인해 주세요.", tooManyPending: "확인이 필요한 기록이 많아요. 이전 기록의 저장 여부부터 확인해 주세요.",
    activeSending: "진행 중인 전송을 먼저 확인해 주세요.",
  },
  errors: {
    unknown: "저장 여부를 아직 확인하지 못했어요. 같은 내용을 다시 보내기 전에 검색으로 확인해 주세요.",
    desktopOnly: "실제 연결과 기록은 설치한 바라 펫에서 사용할 수 있어요.",
    fallback: "작업을 완료하지 못했어요. 연결 상태를 확인해 주세요.",
    credentials: "인증정보가 포함된 대시보드 접속 링크 또는 연결 토큰을 입력해 주세요.",
    /** The wording around the OS error number is the host's own (`native-host.json` `text.startupStatusSuffix`), so
     * a startup dialog and an error shown on screen always say it the same way. */
    withStatus: (text: string, status: number) => `${text}${nativeHost.text.startupStatusSuffix.replace("{status}", String(status))}`,
    withCode: (code: string) => `작업을 완료하지 못했어요. (오류 코드 ${code})`,
    unexpectedNative: "펫 프로그램이 예상하지 못한 오류로 작업을 끝내지 못했어요. 앱을 다시 열어도 계속되면 개발자 도구의 오류 기록을 확인해 주세요.",
  },
  /** Korean text for each progress stage the host forwards (`pet-progress`, `src/ui/bridge.ts`
   * `onProgress`), keyed by the stages listed in `src/shared/native-host.json`
   * `contract.progressStages` (same list as `PROGRESS_STAGES`). Previously drawn natively by
   * `src-tauri/src/policy.rs` `progress_label`; now the host only forwards the stage name and
   * the screen looks up its own text here. */
  progress: {
    prepare: "서버 데이터와 저장소를 준비하고 있어요.",
    models: "한국어 사전과 검색 모델을 준비하고 있어요. 처음에는 시간이 걸릴 수 있어요.",
    server: "메모리 서버를 시작하고 있어요.",
    "host-key": "서버의 SSH 지문을 확인하고 있어요.",
    preflight: "서버 환경과 권한을 확인하고 있어요.",
    transfer: "서버 파일을 전송하고 있어요.",
    dependencies: "서버 의존성을 설치하고 있어요.",
    service: "메모리 서비스를 시작하고 있어요.",
    search: "관련 기억을 찾고 있어요.",
    answer: "기억을 바탕으로 답하고 있어요.",
    classify: "기억을 분류하고 있어요.",
    cleanup: "정리 후보를 살펴보고 있어요.",
    "update-backup": "업데이트 전에 기억을 백업하는 중이에요…",
    "restore-verify": "고른 백업이 온전한지 확인하고 있어요.",
    "restore-data": "백업에서 기억을 되살리고 있어요. 검색 색인을 다시 계산해서 오래 걸릴 수 있어요.",
    "restore-switch": "되살린 기억으로 바꾸고 있어요.",
    "server-update": "서버 업데이트 중이에요. 끝날 때까지 저장과 질문이 잠시 기다려요.",
    "self-update-download": "새 버전 설치 파일을 받고 있어요.",
    "self-update-verify": "받은 설치 파일을 확인하고 있어요.",
  } satisfies Record<ProgressStage, string> as Readonly<Record<ProgressStage, string>>,
  /** A stage's byte progress (`ProgressEvent.detail`), built by `src/ui/progress-text.ts`. Sizes are whole
   * decimal megabytes; `total` is null when the download did not say how big it is. */
  downloadProgress: {
    models: (part: number, parts: number, loaded: number, total: number | null) =>
      `모델 받는 중 (${part}/${parts}) · ${loaded}MB${total === null ? "" : ` / ${total}MB`}`,
    barLabel: "모델 내려받기 진행률",
  },
  /** Texts of the native host's own error codes (`src-tauri/src/host_error.rs`), keyed by the codes listed in
   * `src/shared/native-host.json` `contract.hostErrorCodes`. */
  hostErrors: {
    HOST_WINDOW_NOT_ALLOWED: "이 창에서는 할 수 없는 작업이에요.",
    HOST_INVALID_REQUEST: "펫 화면이 보낸 요청의 형식이 올바르지 않아 처리하지 않았어요. 앱을 다시 열어 주세요.",
    HOST_REQUEST_TOO_LARGE: "보내려는 내용이 너무 커서 처리하지 않았어요. 내용을 줄여서 다시 보내 주세요.",
    HOST_WINDOW_MISSING: "바라 펫 창을 찾지 못했어요. 앱을 다시 열어 주세요.",
    HOST_WINDOW_OPERATION_FAILED: "바라 펫 창을 열거나 닫지 못했어요. 앱을 다시 열어 주세요.",
    HOST_STATE_LOCK_FAILED: "펫 프로그램의 내부 상태를 읽지 못했어요. 앱을 다시 열어 주세요.",
    HOST_TASK_FAILED: "작업을 실행하던 중 펫 프로그램에 문제가 생겨 끝내지 못했어요. 결과를 확인한 뒤 다시 시도해 주세요.",
    HOST_DATA_DIR_FAILED: "펫 데이터 폴더를 준비하지 못했어요. 사용자 폴더(LOCALAPPDATA)의 권한과 여유 공간을 확인해 주세요.",
    HOST_RESOURCE_DIR_FAILED: "펫 설치 폴더를 찾지 못했어요. 바라 펫을 다시 설치해 주세요.",
    HOST_SERVICE_MISSING: "펫 제어 프로그램 파일이 설치 폴더에 없어요. 바라 펫을 다시 설치해 주세요.",
    HOST_RUNTIME_MISSING: "펫 실행에 필요한 Bun 런타임이 설치 폴더에 없어요. 바라 펫을 다시 설치해 주세요.",
    HOST_SERVICE_START_FAILED: "펫 제어 프로그램을 시작하지 못했어요. 백신 프로그램이 막고 있지 않은지 확인한 뒤 다시 시도해 주세요.",
    HOST_JOB_FAILED: "펫 제어 프로그램을 관리 대상으로 등록하지 못해 시작을 멈췄어요. 다시 시도해 주세요.",
    HOST_SERVICE_STOPPED: "펫 제어 프로그램이 멈춰서 작업을 끝내지 못했어요. 결과를 확인한 뒤 다시 시도해 주세요.",
    HOST_SERVICE_DISCONNECTED: "펫 제어 프로그램과의 연결이 끊겨 작업을 끝내지 못했어요. 결과를 확인한 뒤 다시 시도해 주세요.",
    HOST_SERVICE_NOT_CONNECTED: "펫 제어 프로그램이 연결되어 있지 않아 요청을 보내지 못했어요. 다시 시도해 주세요.",
    HOST_SERVICE_WRITE_FAILED: "펫 제어 프로그램에 요청을 전달하지 못했어요. 다시 시도해 주세요.",
    HOST_SERVICE_PIPE_STALLED: "펫 제어 프로그램이 요청을 받지 않아 멈췄어요. 결과가 반영되었는지 확인한 뒤 다시 시도하면 새로 시작해요.",
    HOST_DUPLICATE_REQUEST: "같은 요청이 이미 진행 중이에요. 끝날 때까지 기다려 주세요.",
    HOST_SERVICE_UNRESPONSIVE: "펫 제어 프로그램이 작업 중 한동안 살아 있다는 신호를 보내지 않아 멈췄어요. 결과가 반영되었는지 확인한 뒤 다시 시도하면 새로 시작해요.",
    HOST_SERVICE_ERROR_REDACTED: "작업을 끝내지 못했어요. 오류 내용에 인증정보나 확인할 수 없는 값이 있어 화면에 표시하지 않았어요.",
    HOST_DASHBOARD_LINK_INVALID: "서버가 보낸 대시보드 주소가 안전하지 않거나 올바르지 않아 열지 않았어요.",
    HOST_BROWSER_OPEN_FAILED: "브라우저를 열지 못했어요. 기본 브라우저 설정을 확인해 주세요.",
    HOST_TEXT_CATALOG_INVALID: "펫 프로그램의 문구 파일을 읽지 못했어요. 바라 펫을 다시 설치해 주세요.",
    HOST_INSTANCE_GUARD_FAILED: "바라 펫이 이미 실행 중인지 확인하지 못했어요. 앱을 다시 열어 주세요.",
    HOST_BUILD_FAILED: "바라 펫 창을 준비하지 못했어요. 바라 펫을 다시 설치해 주세요.",
    // The panic dialog is the only place this code is shown; the screen reuses its exact text.
    HOST_FATAL_PANIC: nativeHost.text.startup.HOST_FATAL_PANIC,
    HOST_AUTOSTART_REGISTRY_FAILED: "로그인 시 자동 실행 설정을 저장하지 못했어요. 다시 시도해 주세요.",
    HOST_AUTOSTART_READ_FAILED: "로그인 시 자동 실행 설정을 Windows에서 읽지 못했어요. 다시 시도해 주세요.",
    HOST_AUTOSTART_READ_INVALID: "로그인 시 자동 실행 설정을 읽지 못했어요. 설정을 다시 저장해 주세요.",
    HOST_WINDIR_MISSING: "Windows 시스템 폴더 위치(WINDIR)를 확인하지 못했어요. Windows 환경 변수를 확인해 주세요.",
    HOST_SSH_UNAVAILABLE: "Windows PowerShell을 찾지 못해 OpenSSH를 준비할 수 없어요. Windows 설치 상태를 확인해 주세요.",
    HOST_SSH_INSTALL_DENIED: "OpenSSH 설치에 필요한 관리자 권한 요청을 거부해 설치하지 못했어요. 다시 시도하고 권한 요청을 허용해 주세요.",
    HOST_SSH_INSTALL_START_FAILED: "OpenSSH 설치를 시작하지 못했어요. 다시 시도해 주세요.",
    HOST_SSH_INSTALL_CANCELLED: "OpenSSH 준비를 중단했어요.",
    HOST_SSH_INSTALL_TIMEOUT: "OpenSSH 준비가 제한 시간 안에 끝나지 않았어요. 설치는 백그라운드에서 계속돼요. 잠시 뒤 다시 눌러 이어서 기다려 주세요.",
    HOST_SSH_INSTALL_FAILED: "OpenSSH 설치가 실패했어요. Windows 선택적 기능과 네트워크 연결을 확인해 주세요.",
    HOST_SSH_INSTALL_BUSY: "OpenSSH 준비를 이미 기다리고 있어요. 앞의 준비가 끝나거나 중단된 뒤 다시 눌러 주세요.",
    HOST_SSH_INSTALL_WAIT_FAILED: "OpenSSH 설치가 끝났는지 Windows에서 확인하지 못했어요. 잠시 뒤 다시 눌러 주세요.",
    HOST_SSH_PICKER_UNAVAILABLE: "Windows 파일 선택 창을 열지 못했어요. Windows 설치 상태를 확인해 주세요.",
    HOST_SSH_PICKER_FAILED: "파일 선택 창을 실행하지 못했어요. 다시 시도해 주세요.",
    HOST_SSH_PICKER_DECODE_FAILED: "선택한 파일 경로를 해석하지 못했어요. 다른 폴더의 키 파일로 다시 선택해 주세요.",
    HOST_SSH_KEY_NOT_FOUND: "선택한 SSH 키 파일을 찾지 못했어요. 파일이 그대로 있는지 확인한 뒤 다시 선택해 주세요.",
    HOST_BACKUP_FOLDER_UNAVAILABLE: "Windows에서 문서 폴더 위치를 확인하지 못해 백업 폴더를 열 수 없어요. 바라를 다시 실행한 뒤 시도해 주세요.",
    HOST_BACKUP_FOLDER_FAILED: `문서 폴더에 "${BACKUP_FOLDER}" 폴더를 만들지 못했어요. 문서 폴더의 권한과 여유 공간을 확인해 주세요.`,
    HOST_BACKUP_FOLDER_OPEN_FAILED: `Windows 탐색기로 "${BACKUP_FOLDER}" 폴더를 열지 못했어요. 문서 폴더에서 직접 열어 주세요.`,
    HOST_UPDATE_BUBBLE_STATE: "업데이트 말풍선이 이미 다른 단계로 바뀌어 이 동작을 하지 않았어요. 펫 오른쪽 아래 화살표 버튼으로 다시 시작해 주세요.",
    HOST_UPDATE_PATH_REFUSED: "확인을 마친 업데이트 폴더 밖의 파일이라 설치 파일을 실행하지 않았어요.",
    HOST_UPDATE_LAUNCH_FAILED: "설치 파일을 실행하지 못했어요. 백신 프로그램이 막고 있지 않은지 확인한 뒤 화살표 버튼으로 다시 시도해 주세요.",
    HOST_UPDATE_ALREADY_STARTED: "설치 파일이 이미 실행됐거나 펫이 끝나는 중이라 설치 파일을 한 번 더 실행하지 않았어요.",
    // The host raises these itself as bubbles; their one text lives in native-host.json `text.hostNotice`.
    ...nativeHost.text.hostNotice,
    HOST_FEEDBACK_UNAVAILABLE: NO_FEEDBACK_TEXT,
  } as Readonly<Record<string, string>>,
  /** The text the native host draws by itself, before or outside the screen (tray menu,
   * startup-error dialog). Re-exported from `src/shared/native-host.json` `text` so the same
   * value never has a second, drifting copy in this file; Rust reads the JSON directly via
   * `include_str!` (`src-tauri/src/native_host.rs`). */
  nativeHost: nativeHost.text,
  /** Texts of the service error codes raised while connecting to or preparing a memory server, keyed by
   * the code the service sends, so one cause reads the same wherever it is raised. */
  connectionErrors: {
    AUTH_REJECTED: "서버가 저장된 연결 토큰을 받아들이지 않았습니다. 토큰이 회수되었거나 다른 서버의 토큰일 수 있습니다. 연결과 설정에서 다시 연결해 주세요.",
    SERVER_UPGRADE_REQUIRED: "이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다. 펫 연동을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요.",
    SERVER_INCOMPATIBLE: (status: number) => `서버 응답(HTTP ${status})이 이 펫의 연결 규약과 맞지 않습니다. 바라 서버 주소가 맞는지, 서버와 펫의 버전이 맞는지 확인해 주세요.`,
    CAPABILITY_MISSING: (missing: string) => `이 서버는 일부 기능(${missing})을 지원하지 않는 이전 버전입니다. 펫과 같은 기능을 지원하는 버전으로 서버를 업데이트한 뒤 다시 연결해 주세요.`,
    INSTALL_SERVER_TIMEOUT: (seconds: number, detail: string) => `메모리 서버가 제한 시간(${seconds}초) 안에 준비되지 않았습니다(${detail}). 다시 시도해 주세요.`,
    SSH_SERVER_TIMEOUT: (seconds: number, detail: string) => `SSH로 연결한 메모리 서버가 제한 시간(${seconds}초) 안에 준비되지 않았습니다(${detail}). 서버에서 메모리 서비스가 실행 중인지 확인한 뒤 다시 시도해 주세요.`,
    INSTALL_EXISTING_CONNECTION: "이미 연결된 서버가 있습니다. 기존 연결을 사용해 주세요.",
    INSTALL_EXISTING_CORE: (baseUrl: string) => `이 PC에서 이미 실행 중인 바라 서버(${baseUrl})를 찾았습니다. 새 저장소를 만들지 않았습니다. '${EXISTING_CHOICE_LABEL}'를 선택해 이 서버에 연결해 주세요.`,
    INSTALL_DATA_MISSING: "이 PC에 준비했던 메모리 데이터(DB 파일)를 찾지 못해 연결을 멈췄습니다. 빈 저장소를 새로 만들지 않았습니다. 백업에서 데이터를 복원한 뒤 다시 시도해 주세요.",
    /** Raised before anything is written (`src/service/install/disk-space.ts`); both sizes are bytes. */
    INSTALL_DISK_LOW: (missingBytes: number, freeBytes: number) => {
      const { missing, free } = shortfall(missingBytes, freeBytes);
      return `저장 공간이 부족해 이 PC에 준비를 시작하지 않았습니다. 메모리 데이터를 둘 드라이브의 여유 공간이 ${free}GB라 ` +
        `${missing}GB가 더 필요합니다. 공간을 비운 뒤 다시 시도해 주세요.`;
    },
    INSTALL_TOKENS_MISSING: "이 PC 메모리 서버의 인증 정보 파일이 없어 서버를 시작하지 않았습니다. 연결과 설정에서 '이 PC에 준비하기'를 다시 눌러 인증 정보를 준비해 주세요.",
    REMOTE_OS_UNSUPPORTED: "원격 설치는 Ubuntu Linux에서만 지원합니다.",
    REMOTE_ARCH_UNSUPPORTED: "원격 CPU는 x64 또는 ARM64여야 합니다.",
    REMOTE_TOOLS_MISSING: (commands: string) => `원격 서버에 설치에 필요한 명령이 없습니다(${commands}). 서버에 설치한 뒤 다시 시도해 주세요.`,
    REMOTE_SYSTEMD_MISSING: "원격 서버에서 systemd가 실행되고 있지 않아 메모리 서비스를 등록할 수 없습니다.",
    REMOTE_SUDO_REQUIRED: "원격 계정은 sudo -n 권한이 필요합니다.",
    REMOTE_PREFLIGHT_FAILED: (item: string | null) => `원격 서버의 설치 상태를 확인하지 못해 아무것도 바꾸지 않았습니다(${item === null ? "조사 결과 형식" : `조사 항목: ${item}`}).`,
    REMOTE_EXISTING_CORE: (unit: string, state: string | null) => `원격 서버에 기존 바라(${state === null ? unit : `${unit}, 상태: ${state}`})가 있어 새로 설치하지 않았습니다. '${EXISTING_CHOICE_LABEL}'에서 SSH 연결을 켜고 이 서버에 연결해 주세요.`,
    REMOTE_EXISTING_SERVER: "원격 설치 경로에 기존 데이터가 있습니다. 기존 연결을 사용해 주세요.",
    REMOTE_OTHER_PET_SERVER: (unit: string) => `원격 서버에 다른 경로로 설치된 바라 펫 서버(${unit})가 이미 등록되어 있어 새로 설치하지 않았습니다. '${EXISTING_CHOICE_LABEL}'에서 SSH 연결을 켜고 그 서버에 연결해 주세요.`,
    REMOTE_UNIT_FOREIGN: (unit: string) => `원격 서버의 서비스(${unit})가 펫이 설치한 서비스가 아니어서 건드리지 않았습니다. 기존 연결을 사용해 주세요.`,
    REMOTE_UNIT_UNRECOGNIZED: (unit: string) => `원격 서버의 서비스(${unit}) 설정을 펫이 해석하지 못해 건드리지 않았습니다. 서버에서 서비스 파일을 확인해 주세요.`,
    REMOTE_PORT_MISMATCH: (installed: number, requested: number) => `원격 서버에 설치된 바라 펫 서버는 포트 ${installed}번을 사용하는데 입력한 포트는 ${requested}번입니다. 바라 서버 포트를 설치된 포트와 같게 입력한 뒤 다시 시도해 주세요.`,
    REMOTE_PORT_BUSY: (port: number, owners: string) => `원격 서버의 메모리 포트(${port}번)를 다른 프로그램(PID ${owners})이 사용하고 있습니다. 그 프로그램을 종료한 뒤 다시 시도하거나, 새로 설치하는 경우 다른 포트를 입력해 주세요.`,
    REMOTE_SERVICE_FAILED: (unit: string, active: string, sub: string, enabled: string) => `원격 메모리 서비스(${unit})를 시작하지 못했습니다(상태: ${active}/${sub}, 자동 시작: ${enabled}). 서버에서 서비스 기록을 확인해 주세요.`,
    REMOTE_TOKENS_MISSING: "원격 서버의 인증 정보 파일을 읽을 수 없어 연결하지 않았습니다. 서버의 바라 펫 데이터 폴더가 온전한지 확인해 주세요.",
    SSH_TUNNEL_UNVERIFIED: "펫이 연 SSH 터널이 저장된 로컬 포트를 혼자 쓰고 있는지 확인하지 못해 서버에 인증 정보를 보내지 않았습니다. 연결과 설정에서 연결 확인을 눌러 터널을 다시 열어 주세요.",
    LOCAL_SERVER_UNVERIFIED: "펫이 시작해 확인한 이 PC 메모리 서버가 실행 중이 아니어서 서버에 인증 정보를 보내지 않았습니다. 연결과 설정에서 연결 확인을 누르고, 계속되면 '이 PC에 준비하기'를 다시 눌러 주세요.",
  },
  /** The settings screen's backup section (`src/ui/settings.ts` `renderBackup`). */
  backup: {
    heading: "백업",
    help: "백업 안내",
    description: `이 PC에 저장된 기억과 첨부를 글 형식으로 내보내요. 문서 폴더의 "${BACKUP_FOLDER}"에 저장되고, 바라를 지워도 남아요. ` +
      "설정·로그인 정보·AI 키는 들어가지 않아요. 백업에서 되살리기로 이 PC의 기억을 백업 시점으로 되돌릴 수 있어요.",
    make: "백업 만들기", stop: "중단", openFolder: "폴더 열기",
    running: "백업을 만드는 중이에요…",
    /** The user stopped the backup ("중단"); the run removed the folder it was writing. */
    cancelled: "백업 만들기를 중단했어요. 만들던 백업 폴더는 남기지 않았고, 기억은 아무것도 바뀌지 않았어요.",
    /** `memories` and `attachments` are the archive's own counts (`BackupResult`). */
    done: (folderName: string, memories: number, attachments: number) =>
      `백업을 만들었어요: ${BACKUP_FOLDER}\\${folderName} (기억 ${memories}개, 첨부 ${attachments}개)`,
    notLocal: "지금은 이 PC 밖의 바라 서버에 연결되어 있어요. 여기서 만드는 백업은 이 PC에 저장된 기억만 지원해요. 그 서버의 기억은 서버에서 백업해 주세요.",
    /** The exporter's step name, the subject of its timeout text (`installService.stepTimeout`). */
    step: "백업 내보내기",
  },
  /** Texts of the service error codes `backup.export` ends with (`src/service/backup.ts`), keyed by code. */
  backupErrors: {
    BACKUP_NOT_LOCAL: "여기서는 이 PC에 저장된 기억만 백업할 수 있어요. 지금은 이 PC 밖의 바라 서버에 연결되어 있어서 백업하지 않았어요. 그 서버의 기억은 서버에서 백업해 주세요.",
    BACKUP_NOT_READY: "이 PC에 준비를 마친 기억 저장소를 찾지 못해 백업하지 않았어요. 여기서는 이 PC에 저장된 기억만 백업할 수 있어요. 연결과 설정에서 '이 PC에 준비하기'를 마친 뒤 다시 시도해 주세요.",
    BACKUP_SETTINGS_INVALID: "이 PC 기억 저장소의 설정 파일을 읽지 못했거나 설정이 저장소 밖의 경로를 가리키고 있어 백업하지 않았어요. 기억은 아무것도 바뀌지 않았어요.",
    BACKUP_FOLDER_UNAVAILABLE: "Windows에서 문서 폴더 위치를 확인하지 못해 백업하지 않았어요. 바라를 다시 실행한 뒤 시도해 주세요.",
    BACKUP_BUSY: "백업을 이미 만들고 있어요. 지금 백업이 끝난 뒤 다시 시도해 주세요.",
    /** `backup.join` found no backup or restore of this kind in this run of the app. */
    BACKUP_JOB_NONE: "진행 중이거나 끝난 백업 작업이 없어요.",
    BACKUP_RESTORE_RUNNING: "백업에서 기억을 되살리는 중이라 백업하지 않았어요. 되살리기가 끝난 뒤 다시 시도해 주세요.",
    /** The update gate is backing the store up or the new version's preparation may be migrating it (`upgrade.ts` `busy`). */
    BACKUP_UPDATE_RUNNING: "바라 펫 업데이트를 마무리하는 중이라(업데이트 전 백업과 기억 준비) 백업하지 않았어요. 기억은 아무것도 바뀌지 않았어요. " +
      "바라 기억 서버가 시작된 뒤 다시 시도해 주세요.",
    /** Raised before anything is written; both sizes are bytes. */
    BACKUP_DISK_LOW: (missingBytes: number, freeBytes: number) => {
      const { missing, free } = shortfall(missingBytes, freeBytes);
      return `저장 공간이 부족해 백업을 시작하지 않았어요. 문서 폴더가 있는 드라이브의 여유 공간이 ${free}GB라 ${missing}GB가 더 필요해요. ` +
        "공간을 비운 뒤 다시 시도해 주세요.";
    },
    /** `cause` is the exporter's last error line (or the step's own limit text), checked by `causeOf`. */
    BACKUP_FAILED: (cause: string | undefined) =>
      withCauseThen("백업을 만들지 못했어요", cause, "기억은 아무것도 바뀌지 않았어요. 다시 시도해 주세요."),
    /** The exporter finished, so its folder is complete, but its result line could not be read. */
    BACKUP_RESULT_UNREADABLE: (folderName: string) =>
      `백업 폴더(${BACKUP_FOLDER}\\${folderName})는 만들었지만 결과를 읽지 못했어요. 기억은 아무것도 바뀌지 않았어요. 폴더 열기로 내용을 확인하거나 백업을 다시 만들어 주세요.`,
  },
  /** The settings screen's restore from a backup (`src/ui/settings.ts` `renderBackup`, `src/ui/restore-model.ts`). */
  restore: {
    open: "백업에서 되살리기", loading: "백업 목록을 읽는 중이에요…", close: "닫기",
    legend: "되살릴 백업",
    empty: `되살릴 수 있는 백업이 없어요. 문서 폴더의 "${BACKUP_FOLDER}"에 만든 백업과 업데이트 전 백업이 여기에 보여요.`,
    kind: { manual: "직접 만든 백업", "pre-update": "업데이트 전 백업" },
    /** `date` is the backup's local date and time as the screen writes it. */
    entry: (date: string, kind: string, memories: number, attachments: number) => `${date} · ${kind} · 기억 ${memories}개 · 첨부 ${attachments}개`,
    resumable: "지난번에 멈춘 되살리기를 이어서 할 수 있어요.",
    start: "되살리기", resume: "이어서 되살리기",
    confirmTitle: "이 백업으로 되살릴까요?",
    /** `entry` is the chosen backup's line (`entry` above). */
    confirmMessage: (entry: string, resume: boolean) =>
      `${entry}. 지금 이 PC의 기억과 첨부는 지우지 않고 "복원 전" 폴더(before-restore-날짜)로 옮겨 그대로 남겨 둬요. ` +
      "되살리기가 끝날 때까지 바라 기억 서버를 멈춰서, 그동안은 기억을 저장하거나 물어볼 수 없어요. " +
      (resume ? "지난번에 멈춘 곳부터 이어서 해요. " : "") +
      "검색 색인을 다시 계산하므로 기억이 많으면 오래 걸릴 수 있고, 검색 모델이 없으면 먼저 내려받아요. " +
      "설정·로그인 정보·AI 키는 그대로 남아요.",
    confirmAction: "되살리기 시작",
    running: "백업에서 되살리는 중이에요…", stop: "중단", stopping: "되살리기를 중단하는 중이에요…",
    /** `minutes` and `seconds` since the restore started. */
    elapsed: (minutes: number, seconds: number) => `지난 시간 ${minutes > 0 ? `${minutes}분 ` : ""}${seconds}초`,
    /** The counts are the restore's own, checked against the backup's manifest; `beforeFolder` keeps the previous memories. */
    done: (memories: number, attachments: number, beforeFolder: string) =>
      `되살렸어요: 기억 ${memories}개·첨부 ${attachments}개. 되살리기 전의 기억은 이 폴더에 그대로 있어요: ${beforeFolder}`,
    cancelled: "되살리기를 중단했어요. 지금 기억은 바뀌지 않았고 바라 기억 서버를 다시 시작했어요. 같은 백업을 다시 고르면 이어서 되살려요.",
    notLocal: "지금은 이 PC 밖의 바라 서버에 연결되어 있어요. 백업에서 되살리기는 이 PC에 저장된 기억만 지원해요.",
    /** How the last restore ended (`LastRestore`), shown above the list. */
    last: {
      complete: (backupName: string, memories: number | null, attachments: number | null, beforeFolder: string | null) =>
        `지난 되살리기: ${backupName}에서 기억 ${memories ?? 0}개·첨부 ${attachments ?? 0}개를 되살렸어요.` +
        (beforeFolder ? ` 되살리기 전의 기억은 이 폴더에 있어요: ${beforeFolder}` : ""),
      swapped: (backupName: string, beforeFolder: string | null) =>
        `지난 되살리기: ${backupName}의 기억으로 바꿨지만 바라 기억 서버가 아직 시작되지 않았어요. 연결 확인을 눌러 주세요.` +
        (beforeFolder ? ` 되살리기 전의 기억은 이 폴더에 있어요: ${beforeFolder}` : ""),
      "rolled-back": (backupName: string) =>
        `지난 되살리기(${backupName})는 기억을 바꾸는 도중에 끊겨서, 바라를 다시 시작할 때 원래 기억으로 되돌렸어요. 기억은 바뀌지 않았어요.`,
      interrupted: (backupName: string) =>
        `지난 되살리기(${backupName})는 끝나기 전에 바라가 종료되어 멈췄어요. 기억은 바뀌지 않았어요. 같은 백업을 고르면 이어서 되살려요.`,
    },
    /** The step names, the subject of their timeout and failure texts (`installService.stepTimeout`). */
    verifyStep: "백업 확인", modelsStep: "검색 모델 준비", restoreStep: "백업에서 되살리기",
    /** The verify step's result could not be read (written inside `restoreErrors.RESTORE_VERIFY_FAILED`, no closing period). */
    verifyUnreadable: "확인 결과를 읽지 못했어요",
    /** A save refused while the server is stopped for a restore (`memory.save` answers `rejected`; the quick input
     * keeps the text, `src/ui/quick.ts`). */
    saveRefused: "백업에서 기억을 되살리는 중이라 저장하지 않았어요. 입력한 내용은 입력창에 그대로 남아 있어요. 되살리기가 끝난 뒤 다시 보내 주세요.",
    /** `status`'s connection line while the server is stopped for a restore. */
    serverStopped: "백업에서 기억을 되살리는 중이라 바라 기억 서버를 멈춰 두었어요.",
  },
  /** Texts of the service error codes `backup.list` and `backup.restore` end with (`src/service/restore.ts`), keyed by
   * code. Up to the switch the store was not changed, so those texts say so. */
  restoreErrors: {
    RESTORE_NOT_LOCAL: "백업에서 되살리기는 이 PC에 저장된 기억만 지원해요. 지금은 이 PC 밖의 바라 서버에 연결되어 있어요.",
    RESTORE_NOT_READY: "이 PC에 준비를 마친 기억 저장소를 찾지 못했어요. 연결과 설정에서 '이 PC에 준비하기'를 마친 뒤 다시 시도해 주세요.",
    RESTORE_SETTINGS_INVALID: "이 PC 기억 저장소의 설정 파일을 읽지 못했거나 설정이 바라가 관리하는 저장소 밖을 가리키고 있어서 되살리지 않았어요. 기억은 바뀌지 않았어요.",
    RESTORE_BUSY: "이미 백업에서 되살리는 중이에요. 지금 되살리기가 끝난 뒤 다시 시도해 주세요.",
    RESTORE_UPDATE_RUNNING: "바라 펫 업데이트를 마무리하는 중이라(업데이트 전 백업과 기억 준비) 되살리지 않았어요. 기억은 바뀌지 않았어요. " +
      "바라 기억 서버가 시작된 뒤 다시 시도해 주세요.",
    RESTORE_BACKUP_RUNNING: "백업을 만드는 중이라 되살리지 않았어요. 기억은 바뀌지 않았어요. 백업이 끝난 뒤 다시 시도해 주세요.",
    RESTORE_CONNECTION_BUSY: "바라 기억 서버를 시작하거나 연결을 확인하는 중이라 되살리지 않았어요. 기억은 바뀌지 않았어요. 잠시 뒤 다시 시도해 주세요.",
    RESTORE_BACKUP_MISSING: "고른 백업을 찾지 못했어요. 그사이 백업 폴더가 옮겨졌거나 지워졌을 수 있어요. 기억은 바뀌지 않았어요. 목록을 다시 열어 골라 주세요.",
    /** `cause` is the check's last error line, its limit text or `restore.verifyUnreadable`, checked by `causeOf`. */
    RESTORE_VERIFY_FAILED: (cause: string | undefined) =>
      withCauseThen("고른 백업이 온전하지 않거나 읽을 수 없어서 되살리지 않았어요", cause, "기억은 바뀌지 않았어요. 다른 백업을 골라 주세요."),
    /** Raised before anything changes; both sizes are bytes. */
    RESTORE_DISK_LOW: (missingBytes: number, freeBytes: number) => {
      const { missing, free } = shortfall(missingBytes, freeBytes);
      return `저장 공간이 부족해 되살리기를 시작하지 않았어요. 바라 데이터가 있는 드라이브의 여유 공간이 ${free}GB라 ${missing}GB가 더 필요해요. ` +
        "기억은 바뀌지 않았어요. 공간을 비운 뒤 다시 시도해 주세요.";
    },
    RESTORE_MODELS_FAILED: (cause: string | undefined) =>
      withCauseThen("되살리기에 필요한 검색 모델을 준비하지 못했어요", cause, "기억은 바뀌지 않았어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."),
    RESTORE_STATE_UNWRITABLE: (cause: string | undefined) =>
      withCauseThen("되살리기 진행 기록을 저장하지 못해 되살리지 않았어요", cause, "기억은 바뀌지 않았어요. 바라 데이터 폴더의 권한과 여유 공간을 확인해 주세요."),
    /** `cause` is the restore's last error line or its limit text. Its checkpoints stay for the next attempt. */
    RESTORE_FAILED: (cause: string | undefined) =>
      withCauseThen("백업에서 되살리지 못했어요", cause,
        "지금 기억은 바뀌지 않았고 바라 기억 서버를 다시 시작했어요. 같은 백업을 다시 고르면 멈춘 곳부터 이어서 되살려요."),
    RESTORE_RESULT_UNREADABLE: "되살린 결과를 읽지 못해 기억을 바꾸지 않았어요. 지금 기억은 그대로이고 바라 기억 서버를 다시 시작했어요. 다시 시도해 주세요.",
    RESTORE_COUNT_MISMATCH: "되살린 기억·첨부 수가 백업과 달라서 기억을 바꾸지 않았어요. 지금 기억은 그대로이고 바라 기억 서버를 다시 시작했어요. 다른 백업을 골라 주세요.",
    /** The switch failed and was undone: the store is as before. `cause` names the move or check that failed. */
    RESTORE_SWITCH_FAILED: (cause: string | undefined) =>
      withCauseThen("되살린 기억으로 바꾸지 못해 원래 기억으로 되돌렸어요", cause,
        "기억은 바뀌지 않았고 바라 기억 서버를 다시 시작했어요. 다른 프로그램이 바라 데이터 폴더의 파일을 열고 있지 않은지 확인한 뒤 다시 시도해 주세요."),
    /** The switch failed and undoing it failed too; the next start tries again. Nothing was deleted. */
    RESTORE_ROLLBACK_FAILED: (cause: string | undefined, beforeFolder: string) =>
      withCauseThen("되살린 기억으로 바꾸다 실패했고 원래대로 되돌리는 것도 끝내지 못했어요", cause,
        `지운 파일은 없어요. 원래 기억은 이 폴더에 있을 수 있어요: ${beforeFolder} 바라를 다시 실행하면 되돌리기를 다시 시도해요. 이 폴더를 지우지 마세요.`),
    /** The restored store is in place; the server did not start on it. */
    RESTORE_START_FAILED: (cause: string | undefined, beforeFolder: string) =>
      withCauseThen("기억은 되살렸지만 바라 기억 서버를 시작하지 못했어요", cause,
        `연결 확인을 눌러 다시 시도해 주세요. 되살리기 전의 기억은 이 폴더에 그대로 있어요: ${beforeFolder}`),
    /** A question, connection check or dashboard link while the server is stopped for a restore (a save has its own
     * text, `restore.saveRefused`). */
    RESTORE_RUNNING: "백업에서 기억을 되살리는 중이라 바라 기억 서버를 멈춰 두었어요. 되살리기가 끝난 뒤 다시 시도해 주세요.",
    /** A connection change or install while a restore runs (`router.ts`). */
    RESTORE_CONNECTION_LOCKED: "백업에서 기억을 되살리는 중이라 연결을 바꾸지 않았어요. 되살리기가 끝난 뒤 다시 시도해 주세요.",
    /** A start found a switch a crash cut off and could neither finish nor undo it. */
    RESTORE_RECOVERY_FAILED: (cause: string | undefined, beforeFolder: string | null) =>
      withCauseThen("지난 백업 되살리기의 마무리를 끝내지 못해 바라 기억 서버를 시작하지 않았어요", cause,
        "지운 파일은 없어요. " + (beforeFolder ? `원래 기억은 이 폴더에 있을 수 있어요: ${beforeFolder} 이 폴더를 지우지 마세요. ` : "") +
        "다른 프로그램이 바라 데이터 폴더의 파일을 열고 있지 않은지 확인하고 바라를 다시 실행해 주세요."),
  },
  /** Texts of the service error codes the update gate ends a local server start with (`src/service/maintenance/upgrade.ts`),
   * keyed by code. Until the backup is complete the database was not opened, so those texts say nothing changed. */
  updateErrors: {
    /** Raised before anything is written; both sizes are bytes. */
    UPDATE_BACKUP_DISK_LOW: (missingBytes: number, freeBytes: number) => {
      const { missing, free } = shortfall(missingBytes, freeBytes);
      return "업데이트 전 백업에 필요한 공간이 부족해 바라 기억 서버를 시작하지 않았어요. 기억은 바뀌지 않았어요. " +
        `약 ${missing}GB를 비운 뒤 다시 시도해 주세요(지금 여유 ${free}GB).`;
    },
    /** `cause` is a backup step's last error line, its limit text or the gate's own step text, checked by `causeOf`. */
    UPDATE_BACKUP_FAILED: (cause: string | undefined) =>
      withCauseThen("업데이트 전 백업을 만들지 못해 바라 기억 서버를 시작하지 않았어요", cause, "기억은 바뀌지 않았어요. 다시 시도해 주세요."),
    /** After the backup: `cause` is the failed step's (for the data preparation, its named stop reason) and
     * `backupPath` the finished pre-update backup folder, which the settings screen's "백업에서 되살리기" lists. */
    UPDATE_START_FAILED: (cause: string | undefined, backupPath: string) =>
      withCauseThen("업데이트 뒤 바라 기억 서버를 시작하지 못했어요", cause,
        `업데이트 전까지 남긴 기억은 이 폴더에 백업해 두었어요: ${backupPath} 다시 시도해 보고, 계속 안 되면 이 백업 폴더를 지우지 말고 ` +
        "연결과 설정의 '백업에서 되살리기'에서 업데이트 전 백업을 골라 되살려 주세요."),
    /** The version record says the data may belong to a newer app, or could not be read (`maintenance/manifest.ts` run
     * kinds; a record that is not JSON at all counts as none and never comes here). A read that failed is tried again
     * on the next attempt, so that text asks for a retry first. */
    UPDATE_VERSION_UNSAFE: (run: "downgrade" | "unreadable" | "read-failed", recorded: string | null, current: string) =>
      run === "downgrade"
        ? `이 PC의 기억은 바라 펫 ${recorded ?? ""} 버전이 마지막으로 썼는데, 지금 실행한 ${current} 버전이 그보다 오래되어 바라 기억 서버를 시작하지 않았어요. ` +
          `오래된 버전이 새 버전의 기억을 바꾸지 않게 막은 것이고, 기억은 바뀌지 않았어요. 바라 펫 ${recorded ?? ""} 이상을 설치해 실행해 주세요.`
        : run === "unreadable"
          ? "이 PC의 바라 펫 버전 기록(maintenance.json)이 이 버전이 모르는 형식이라 바라 기억 서버를 시작하지 않았어요. " +
            "더 새 버전의 바라 펫이 남긴 기록일 수 있어요. 기억은 바뀌지 않았어요. 가장 최근에 쓰던 바라 펫 버전을 설치해 실행해 주세요."
          : "이 PC의 바라 펫 버전 기록(maintenance.json)을 읽다가 오류가 나서 바라 기억 서버를 시작하지 않았어요. " +
            "파일이 잠시 잠겨 있었을 수 있어요. 기억은 바뀌지 않았어요. 잠시 뒤 다시 시도하고, 계속 안 되면 바라 펫을 다시 실행해 주세요.",
  },
  /** The pre-update backup's step names (the subject of their timeout texts, `installService.stepTimeout`) and the
   * gate's own causes, written inside `updateErrors` texts (no closing period). */
  updateBackup: {
    snapshotStep: "업데이트 전 DB 스냅샷",
    exportStep: "업데이트 전 글 형식 내보내기",
    verifyStep: "업데이트 전 백업 검증",
    snapshotUnreadable: "DB 스냅샷 결과를 읽지 못했어요",
    exportUnreadable: "글 형식 내보내기 결과를 읽지 못했어요",
    verifyMismatch: "다시 읽은 백업의 기억·첨부 수가 내보낸 수와 달라요",
    stateUnwritable: "업데이트 진행 기록(update-state.json)을 저장하지 못했어요",
    noFolderName: "업데이트 전 백업 폴더 이름을 정하지 못했어요",
  },
  /** The settings screen's line about an update a previous start left unfinished (`settings-helpers.ts`
   * `updateNoticeText`). `from` is a version, or "unknown" for data from before the version record. */
  updateNotice: {
    previousVersion: "이전 버전",
    backupFailed: (from: string, to: string) =>
      `바라 펫 업데이트 ${from} → ${to}: 업데이트 전 백업을 만들지 못해 바라 기억 서버를 시작하지 않았어요. 기억은 바뀌지 않았어요. ` +
      "연결 확인을 눌러 다시 시도해 주세요.",
    startFailed: (from: string, to: string, backupPath: string) =>
      `바라 펫 업데이트 ${from} → ${to}: 업데이트 뒤 바라 기억 서버를 시작하지 못했어요. 업데이트 전까지 남긴 기억은 이 폴더에 백업해 두었어요: ${backupPath} ` +
      "연결 확인을 눌러 다시 시도해 보고, 계속 안 되면 이 백업 폴더를 지우지 마세요.",
    interrupted: (from: string, to: string, backupPath: string) =>
      `바라 펫 업데이트 ${from} → ${to}: 지난번 실행이 바라 기억 서버를 다시 시작하기 전에 끝났어요. 업데이트 전까지 남긴 기억은 이 폴더에 백업해 두었어요: ${backupPath} ` +
      "연결 확인을 누르면 이어서 진행해요.",
  },
  /** What a successful remote install run did with the server it found. */
  remoteInstall: {
    installed: "원격 메모리 서버가 준비되었습니다.",
    repaired: "원격 메모리 서비스를 다시 시작하고 자동 시작을 켠 뒤 연결했습니다.",
    connected: "이미 설치된 원격 메모리 서버에 연결했습니다.",
  },
  /** What a timed-out server wait saw last, placed inside the timeout text above. */
  connectionWait: {
    noAnswer: "응답 없음", lastStatus: (status: number) => `마지막 응답 HTTP ${status}`,
  },
  status: {
    saved: "기억해뒀어요.", draftKept: "입력한 내용은 그대로 남겨뒀어요.", noResults: "관련된 기억을 찾지 못했어요.",
  },
  quick: {
    input: "입력", question: "질문", send: "보내기", hide: "입력창 닫기",
    inputPlaceholder: "남겨둘 기억을 적어주세요", questionPlaceholder: "무엇이 궁금해요?",
    inputLabel: "바라에게 남길 내용", questionLabel: "바라에게 물어볼 내용",
    waitForReceipt: "이전 기록의 저장 여부부터 확인해 주세요.",
    answerWorking: "기억을 찾고 있어요…", saveWorking: "기억을 남기고 있어요…",
    quickHint: "Enter로 보내기 · Shift+Enter로 줄바꿈",
    inputTooLong: `기억은 ${INPUT_MAX_CHARS.toLocaleString("ko-KR")}자 이내로 줄여서 보내 주세요. 입력한 글은 그대로 남아 있어요.`,
    questionTooLong: `질문은 ${QUESTION_MAX_CHARS.toLocaleString("ko-KR")}자 이내로 줄여서 보내 주세요. 입력한 글은 그대로 남아 있어요.`,
    /** What `liveStatus` keeps when the bubble itself could not be shown: the text it should have said
     * and why it failed (`quick.ts` `publishOrRecord`). */
    bubbleUnpublished: (text: string, reason: string) => `${text} (말풍선으로 알리지 못했습니다: ${reason})`,
    /** The native window could not say which mode the quick strip was opened in, so it stays on the
     * default input mode (`quick.ts`). */
    modeLoadFailed: (reason: string) => `입력줄을 어느 방식(입력·질문)으로 열어야 하는지 확인하지 못해 "입력" 방식으로 열었어요. 원인: ${reason}`,
  },
  /** The pet window's own texts (`src/ui/squirrel/pet-view.ts`): the error card shown in place of the character, and
   * the notice line at the top of the window. */
  pet: {
    errorTitle: "캐릭터를 못 그렸어요",
    errorHint: "눌러서 입력창 열기",
    answerOutcomeMissing: "답변 결과 신호가 없는 알림을 받아 캐릭터가 반응하지 않았어요. 바라 펫을 다시 실행해도 계속되면 개발자 도구의 오류 기록을 확인해 주세요.",
    listenFailed: (reason: string) => `앱 알림을 받지 못해 캐릭터가 작업 상태에 반응하지 않아요. 바라 펫을 다시 실행해 주세요. 원인: ${causeOrEmpty(reason)}`,
    /** A command of the pet window the host refused (design decision D10). `reason` is the screen's own error text
     * (`errorText`). The host shows a window before it focuses it and tells it its mode, so a refusal can come after
     * the window already appeared: the texts say the opening did not finish, never that nothing opened. */
    quickToggleFailed: (reason: string) => `입력창 열기·닫기를 끝내지 못했어요. 원인: ${causeOrEmpty(reason)}`,
    panelOpenFailed: (reason: string) => `설정 창 열기를 끝내지 못했어요. 원인: ${causeOrEmpty(reason)}`,
    dragFailed: (reason: string) => `펫 창을 끌어 옮기지 못했어요. 원인: ${causeOrEmpty(reason)}`,
    /** One text per `SquirrelError` code (`squirrel/squirrel-errors.ts`). A function receives the error's `detail`;
     * a plain sentence is for a code that has no detail worth showing. A detail that carries an exception's sentence
     * goes through `withCauseThen`; the others are a file name with its HTTP status, a name, or a number. */
    errors: {
      WEBGL_UNAVAILABLE: "이 PC에서 캐릭터를 그리는 기능(WebGL)을 쓸 수 없어요. 그래픽 드라이버를 업데이트한 뒤 바라 펫을 다시 실행해 주세요.",
      ASSET_HTTP: (fileAndStatus: string) => `캐릭터 파일을 받지 못했어요(${fileAndStatus}). 바라 펫을 다시 설치해 주세요.`,
      ASSET_NETWORK: (detail: string) => withCauseThen("캐릭터 파일을 읽지 못했어요", detail, "바라 펫을 다시 실행해 주세요."),
      ASSET_MISSING: (file: string) => `캐릭터 파일(${file})이 앱에 없어요. 앱이 그 파일 대신 화면 문서(HTML)를 돌려줬어요. 바라 펫을 다시 설치해 주세요.`,
      IMAGE_DECODE: (file: string) => `캐릭터 그림 파일(${file})을 열지 못했어요. 바라 펫을 다시 설치해 주세요.`,
      ASSET_PARSE: (detail: string) => withCauseThen("캐릭터 파일의 내용을 해석하지 못했어요", detail, "바라 펫을 다시 설치해 주세요."),
      ANIMATION_MISSING: (name: string) => `캐릭터 파일에 설정한 동작(${name})이 없어요. 펫 개발자가 고쳐야 하는 문제예요.`,
      TRANSITION_NOT_ALLOWED: (pair: string) => `설정한 동작 순서(${pair})가 허용된 전환 목록에 없어요. 펫 개발자가 고쳐야 하는 문제예요.`,
      DARK_TINT_DISABLED: (slot: string) => `캐릭터 파츠(${slot})에 어두운 색이 있지만 그리기 설정이 그 색을 지원하지 않아요. 펫 개발자가 고쳐야 하는 문제예요.`,
      LOAD_TIMEOUT: (seconds: string) => `캐릭터 파일을 제한 시간(${seconds}초) 안에 읽지 못했어요. 바라 펫을 다시 실행해 주세요.`,
      MODULE_LOAD: (cause: string) => withCauseThen("캐릭터를 그리는 코드를 불러오지 못했어요", cause, "바라 펫을 다시 설치해 주세요."),
      CONTEXT_LOST: "그래픽 장치가 다시 시작되어 잠시 캐릭터를 그리지 못하고 있어요. 복구되면 저절로 다시 나타나요.",
      RENDER_FAILED: (cause: string) => withCauseThen("캐릭터를 그리는 중에 오류가 났어요", cause, "바라 펫을 다시 실행해 주세요."),
      CAMERA_LAYOUT: (heights: string) => `하단 여백이 부족해 캐릭터의 발아래 부분을 그리지 못해요(필요한 높이 > 여백 높이: ${heights}). 펫 개발자가 고쳐야 하는 문제예요.`,
    } satisfies Record<SquirrelErrorCode, string | ((detail: string) => string)> as Readonly<Record<SquirrelErrorCode, string | ((detail: string) => string)>>,
  },
  feedback: {
    saved: "기억해뒀어요.", entityPatched: "엔티티 항목을 갱신했어요.", error: "확인이 필요해요.", noAnswer: "답변을 확인해 주세요.",
    // Re-exported from native-host.json so the screen (feedback-model.ts safeFeedbackText) and
    // the native host (feedback/mask.rs mask_sensitive) show the exact same wording.
    omittedLink: nativeHost.text.feedbackMask.omittedLink, omittedCredential: nativeHost.text.feedbackMask.omittedCredential,
    openDetail: "자세히 보기", dismiss: "알림 닫기", dismissGlyph: "×", lastAnswer: "마지막 답변 다시 보기",
    resultHeading: "방금 받은 답", savedHeading: "저장한 기억", workingHeading: "진행 중", errorHeading: "결과 확인",
    noFeedback: NO_FEEDBACK_TEXT,
    noPending: "저장 확인이 필요한 기록이 없어요.",
    openQuickInput: "기억 남기기", openQuickQuestion: "질문하기", recovery: "저장 확인",
    settings: "연결과 설정", cleanup: "기억 정리", sourceHeading: "근거가 된 기억",
    unknownDetail: "저장 여부를 확인하지 못했어요. 보관한 내용을 먼저 확인해 주세요.",
    connectionChanged: "이 결과를 만든 서버 연결이 바뀌었어요. 원래 연결로 돌아간 뒤 다시 열어 주세요.",
    searchOnly: "AI 답변 없이 기억 검색 결과만 보여드려요.",
    classificationFailed: (reason: string) => `저장은 완료됐지만 분류에 실패했습니다: ${reason}`,
    classificationFailedGeneric: "저장은 완료됐지만 분류에 실패했습니다. 원인을 확인하지 못했습니다.",
    feedbackLoadFailed: (reason: string) => `결과를 불러오지 못했습니다: ${reason}`,
    dismissFailed: (reason: string) => `알림을 닫지 못했습니다: ${reason}`,
    openFailed: (reason: string) => `자세히 보기를 열지 못했습니다: ${reason}`,
    /** Shown in the pet's bubble when the connection check at startup fails, because the main window that
     * carries the status line is hidden then. `reason` is the service's or the host's own text. */
    startupConnectionFailed: (reason: string) => `시작할 때 바라 서버에 연결하지 못했습니다. 서버와 네트워크 상태를 확인한 뒤 바라 펫을 다시 실행해 주세요. 계속되면 펫을 오른쪽 클릭해 연결과 설정을 확인해 주세요. 원인: ${reason}`,
    /** Shown in the same bubble when the saved settings could not be read at startup, so the connection
     * was never checked: a different fault from `startupConnectionFailed`, with a different fix. */
    startupSettingsFailed: (reason: string) => `시작할 때 저장된 설정을 읽지 못해 바라 서버 연결을 확인하지 못했습니다. 바라 펫을 다시 실행해 주세요. 계속되면 펫을 오른쪽 클릭해 연결과 설정을 확인해 주세요. 원인: ${reason}`,
    answerFailed: (code?: string) => code === "AI_NOT_CONFIGURED" ? "AI 모델을 선택해 주세요. 연결과 설정에서 AI를 구성할 수 있어요."
      : code === "AUTH_REQUIRED" ? "AI 인증에 실패했습니다. API 키를 확인해 주세요."
      : "AI 답변을 만들지 못했습니다. 찾은 기억을 직접 확인해 주세요.",
  },
  /** The settings screen's license section (`licenses.ts`). The license texts themselves are not here: the UI build
   * reads them from their source files (`scripts/license-texts.ts`). */
  licenses: {
    heading: "라이선스",
    baraHeading: "바라",
    baraSummary: (license: string, source: string) =>
      `바라의 코드는 ${license} 라이선스로 공개되어 있고 소스 코드는 ${source} 에서 받을 수 있으며, 아래는 펫이 Spine 런타임과 함께 배포될 수 있도록 덧붙인 추가 허가의 전문이에요.`,
    baraTextLabel: "바라 추가 허가 전문",
    spineHeading: "Spine Runtimes License Agreement",
    spineSummary: "펫 캐릭터를 움직이는 Spine 런타임의 라이선스 전문이에요.",
    spineTextLabel: "Spine Runtimes License Agreement 전문",
    otherNotices: "그 밖의 오픈소스 라이선스 고지는 소스 저장소의 THIRD-PARTY-NOTICES.md 에 있어요.",
  },
  // The service's own public texts (`src/service`), grouped by area in their own modules.
  ...serviceCoreMessages,
  ...serviceAiMessages,
  ...serviceInstallMessages,
  ...serviceReleaseMessages,
  ...selfUpdateMessages,
  ...recentMessages,
  ...installLockMessages,
};
