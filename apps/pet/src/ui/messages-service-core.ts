/** Public texts of the service's own requests, input checks, settings store and memory-server client
 * (`src/service`: `router.ts`, `main.ts`, `protocol.ts`, `operation-limits.ts`, `validation.ts`, `config.ts`,
 * `client.ts`). `messages.ts` re-exports every section here, so callers read `messages.<section>.<key>`.
 * Keys name the situation, not the error code: one code can carry several situations, and one situation
 * is written once. The AI and cleanup texts are in `messages-service-ai.ts`, the install texts in
 * `messages-service-install.ts`. */

/** Says that a failure's cause sentence came out empty: it held nothing but spaces or characters that show
 * nothing (`causeOf`). It is not a cause, so it is never written inside the parentheses a cause goes in. */
const CAUSE_EMPTY = "원인 문장이 비어 있습니다";
const isEmptyCause = (cause: string): boolean => cause.trim() === "";

/** A failure's sentence followed by the cause sentence that came with it, in parentheses; when that cause came
 * out empty, followed instead by `CAUSE_EMPTY` as a sentence of its own. `()` would show nothing, and a
 * stand-in inside the parentheses would read as the cause. Every text that writes a cause in parentheses
 * is built here or in `withCauseThen`, so this choice is made in those two functions only; the source scan
 * in `messages-cause-guard.test.ts` keeps it that way. */
export function withCause(sentence: string, cause: string): string {
  return isEmptyCause(cause) ? `${sentence} ${CAUSE_EMPTY}.` : `${sentence} (${cause})`;
}

/** `withCause` for a text that goes on after its cause: `lead` is the failure's sentence without its closing
 * period and `follow` the sentences after it. The cause sits against `lead` and closes the sentence
 * (`lead(cause). follow`); an empty cause becomes `CAUSE_EMPTY` as a sentence of its own (`lead. CAUSE_EMPTY.
 * follow`). `undefined` means no cause sentence was available at all, and the text reads without one. */
export function withCauseThen(lead: string, cause: string | undefined, follow: string): string {
  if (cause === undefined) return `${lead}. ${follow}`;
  return isEmptyCause(cause) ? `${lead}. ${CAUSE_EMPTY}. ${follow}` : `${lead}(${cause}). ${follow}`;
}

/** The cause sentence for a text that writes it after a label (`code: cause`) rather than in parentheses:
 * the cause itself, or `CAUSE_EMPTY` when it came out empty, so the label is never followed by nothing. */
export function causeOrEmpty(cause: string): string {
  return isEmptyCause(cause) ? CAUSE_EMPTY : cause;
}

export const serviceCoreMessages = {
  /** What a failed input check points at; `validation.checkValue` and `rpc.checkField` put one in front of their sentence. */
  fieldLabels: {
    serverAddress: "서버 주소", adminLink: "관리자 링크", sshConnection: "SSH 연결", sshPort: "SSH 포트",
    sshKeyPath: "SSH 키 경로", sshFingerprint: "SSH 지문", serverPath: "서버 경로", serverPort: "서버 포트",
    sshTunnelAddress: "SSH 터널 주소", connectionMode: "연결 방식", settings: "설정", aiSettings: "AI 설정",
    cleanupAiSettings: "정리 AI 설정", autoStart: "자동 시작", cleanupOnSave: "입력한 메모 바로 정리", credentials: "인증 정보", category: "분류",
    input: "입력", serverConnection: "서버 연결", autoClassify: "자동 분류", requestNumber: "요청 번호",
    memoryNumber: "기억 번호", question: "질문", memoryContent: "기억 내용", recordNumber: "기록 번호",
    searchQuery: "검색어", content: "내용",
  },
  validation: {
    checkValue: (field: string) => `${field} 값을 확인해 주세요.`,
  },
  /** The service process answering the native host: frame checks, request routing and its safety limits. */
  rpc: {
    shuttingDown: "바라를 종료하고 있어 새 요청을 받지 않았어요. 바라를 다시 실행한 뒤 시도해 주세요.",
    checkField: (field: string) => `${field}을 확인해 주세요.`,
    memoryNumber: "기억 번호를 확인해 주세요.",
    memoryRevision: "기억의 수정 버전을 확인해 주세요.",
    unsupportedRequest: "지원하지 않는 요청이에요.",
    pickAiTarget: "확인할 AI를 선택해 주세요.",
    otherOperationRunning: "다른 작업을 진행하고 있습니다.",
    settingsSaveBusy: "진행 중인 작업이 끝난 뒤 설정을 다시 저장해 주세요.",
    invalidFrame: "요청 형식을 확인하지 못했습니다.",
    duplicateRequest: "같은 요청이 이미 진행 중이에요.",
    tooManyOperations: "진행 중인 작업이 많아요. 잠시 후 다시 시도해 주세요.",
    cancelled: "작업을 중단했어요. 전송한 기록은 저장 여부를 확인해 주세요.",
    /** `publicError` for an error that carries no checked public text. */
    internal: "작업을 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
    operationTimeout: "요청이 제한 시간을 넘어 중단되었습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
    vaultTimeout: "Windows의 인증정보 보관 기능이 응답하지 않습니다. 앱을 다시 열어 주세요.",
    vaultRejected: "저장한 인증정보를 열지 못했습니다. 연결 설정에서 다시 등록해 주세요.",
  },
  /** The saved settings file, the port ledger and the credential vault (`config.ts`). */
  settingsStore: {
    portLedgerUnreadable: "저장된 서버 포트 기록을 읽을 수 없습니다.",
    portLedgerTooLarge: "저장된 서버 포트 기록이 너무 많습니다.",
    portOwnerMismatch: "현재 서버 포트의 소유 기록이 맞지 않습니다.",
    originReserved: "이 로컬 주소는 다른 서버에 사용했습니다. 새 로컬 포트를 선택해 주세요.",
    portLedgerSaveFailed: "서버 포트 기록을 저장하지 못했습니다.",
    settingsUnreadable: "저장된 설정을 읽을 수 없습니다.",
    settingsVersionMismatch: "설정 파일 버전이 맞지 않습니다.",
    settingsSaveFailed: "설정을 저장하지 못했습니다. 다시 시작한 뒤 연결을 확인해 주세요.",
    saveRecoveryFailed: "설정 저장을 복구하지 못했습니다. 앱을 다시 시작해 주세요.",
    recoveryStateUnknown: "설정 복구 상태를 확인하지 못했습니다.",
    recoveryFailed: "설정 복구에 실패했습니다. 앱을 다시 시작해 주세요.",
    anotherWindowSaving: "다른 펫 창이 설정을 저장하고 있습니다. 잠시 후 다시 시도해 주세요.",
    capabilitiesUnknown: "서버 지원 기능을 확인하지 못해 딥링크를 만들 수 없습니다.",
    ownerTokenRequired: "관리자 인증 링크를 먼저 연결해 주세요.",
  },
  /** A saved connection that no longer matches the one a request or a record was made for. */
  connectionChange: {
    /** The record or request names a server other than the connected one. */
    serverSwitched: "연결한 서버가 바뀌었습니다. 원래 연결에서 기록을 확인해 주세요.",
    /** The saved connection (address or SSH route) changed while an operation was under way. */
    routeChanged: "서버 주소가 변경되었습니다. 연결을 다시 시작해 주세요.",
  },
  /** The memory-server HTTP client, its receipts and the connection approval flow (`client.ts`). */
  serverClient: {
    tokenMissing: "서버 토큰을 연결해 주세요.",
    requestInvalid: "요청을 확인해 주세요.",
    serverAddressInvalid: "서버 주소를 확인해 주세요.",
    requestCancelled: "요청을 취소했습니다.",
    networkFailed: "서버에 연결하지 못했습니다. 주소와 연결 상태를 확인해 주세요.",
    /** The server did not answer within the request's time limit (`fetchGuarded`). */
    timedOut: "서버가 제한 시간 안에 응답하지 않았습니다. 서버가 실행 중인지, 연결이 막히거나 느리지 않은지 확인해 주세요.",
    /** The server answered with a redirect; the Pet never follows one, so no credential leaves for another address. */
    redirected: "서버가 다른 주소로 이동하라고 응답했습니다. 펫은 이동 안내를 따라가지 않으니 서버 주소를 확인해 주세요.",
    /** `fetchGuarded` met an exception no service code names while building or sending a request; `cause` is that exception's own sentence (`causeOf`). */
    requestUnexpected: (cause: string) => withCause("서버로 요청을 보내는 중 예상하지 못한 오류가 났습니다.", cause),
    responseTooLarge: "서버 응답이 너무 큽니다.",
    responseUnreadable: "서버 응답을 읽을 수 없습니다.",
    /** Something answered at the address, but not as an HTTP server (another program holds the port) or with
     * a body its own declared encoding cannot decode (`fetchGuarded`). No cause sentence: the runtime's own
     * sentence holds the whole request address, query string included. */
    responseMalformed: "서버 주소에서 HTTP 응답으로 읽을 수 없는 답이 왔습니다. 주소와 포트가 맞는지 확인해 주세요.",
    /** Reading the body failed after the answer began, for a reason other than the time limit or a cancellation;
     * `cause` is that exception's own sentence (`causeOf`). */
    responseReadFailed: (cause: string) => withCause("서버 응답을 끝까지 읽지 못했습니다.", cause),
    memoryUnreadable: "서버의 기억 응답을 읽을 수 없습니다.",
    captureUnreadable: "서버의 기억 분류 응답을 읽을 수 없습니다.",
    searchUnreadable: "검색 응답을 읽을 수 없습니다.",
    saveResultUnconfirmed: "저장 결과를 확인하지 못했습니다.",
    /** The HTTP status of a refused request, as the text for its code (`requestJson`). */
    http: {
      rejectedInput: "서버가 입력을 거부했습니다. 내용과 크기를 확인해 주세요.",
      authRequired: "서버 인증이 필요합니다.",
      forbidden: "이 작업에 필요한 권한이 없습니다.",
      conflict: "이미 저장된 내용과 충돌했습니다. 서버에서 확인해 주세요.",
      notFound: "대상을 찾지 못했습니다.",
      failed: (status: number) => `서버 요청이 실패했습니다 (${status}).`,
    },
    connected: "연결되었습니다.",
    /** `MemoryClient.info` caught an exception no service code names; `cause` is that exception's own sentence (`causeOf`). */
    connectionCheckFailed: (cause: string) => withCause("서버 연결을 확인하는 중 예상하지 못한 오류가 났습니다.", cause),
    receiptPending: "저장 처리 중입니다. 잠시 후 결과를 확인해 주세요.",
    saveUnconfirmed: "저장 여부를 확인하지 못했습니다. 초안을 보존하고 서버에서 확인해 주세요.",
    /** `MemoryClient.save` caught an unexpected exception while checking the input, before anything was sent. */
    saveInputCheckFailed: (cause: string) => withCause("저장할 내용을 검사하는 중 예상하지 못한 오류가 나서 서버로 보내지 않았습니다.", cause),
    /** `MemoryClient.save` caught an unexpected exception while reading the saved connection, before anything was sent. */
    saveConnectionCheckFailed: (cause: string) => withCause("서버 연결을 확인하는 중 예상하지 못한 오류가 나서 서버로 보내지 않았습니다.", cause),
    /** Stands in for a cause sentence that holds something shaped like a credential. */
    causeWithheld: "인증정보처럼 보이는 내용이 있어 원인 문장을 표시하지 않았습니다",
    /** Stands in for a cause sentence that is one unbroken address longer than `causeOf` reads. */
    causeTooLong: "원인 문장이 너무 길어 표시하지 않았습니다",
    /** Follows a failure's sentence in place of a cause sentence that came out empty (`withCause`, `causeOrEmpty`). */
    causeEmpty: CAUSE_EMPTY,
    editRevisionInvalid: "수정 버전을 확인해 주세요.",
    editNothing: "수정할 내용이나 분류를 선택해 주세요.",
    captureKindsUnknown: "서버 분류 계약을 확인하지 못했습니다.",
    informationCategoryUnsupported: "이 서버는 정보·경험 분류를 지원하지 않습니다. 바라 서버를 업데이트해 주세요.",
    enrollmentRequestUnconfirmed: "연결 요청을 확인하지 못했습니다.",
    enrollmentApprovePending: "서버 대시보드에서 연결 요청을 승인해 주세요.",
    enrollmentMissing: "먼저 연결 요청을 시작해 주세요.",
    enrollmentRestart: "연결 요청을 다시 시작해 주세요.",
    enrollmentAddressChanged: "서버 주소가 바뀌었습니다. 연결 요청을 다시 시작해 주세요.",
    enrollmentApproved: "서버와 연결되었습니다.",
    enrollmentRejected: "연결 요청이 거절되었습니다.",
    enrollmentWaiting: "서버 승인을 기다리고 있습니다.",
    enrollmentResultUnreadable: "승인 결과를 읽을 수 없습니다.",
    enrollmentPendingExists: "서버에 이 펫 이름으로 된 연결 요청이 이미 승인을 기다리고 있는데, 이 펫에는 그 요청 정보가 없습니다. 서버 대시보드의 어댑터 관리에서 그 요청의 접속 주소와 요청 시각을 보고 본인 요청인지 확인해 주세요. 본인 요청이 아니면 거절한 뒤 다시 시도해 주세요.",
    enrollmentAddressQueueFull: "이 기기 주소에서 보낸 연결 요청이 너무 많이 승인을 기다리고 있습니다. 서버 대시보드의 어댑터 관리에서 대기 요청을 승인하거나 거절한 뒤 다시 시도해 주세요.",
    enrollmentQueueFull: "서버에 승인을 기다리는 연결 요청이 너무 많습니다. 서버 대시보드의 어댑터 관리에서 대기 요청을 정리한 뒤 다시 시도해 주세요.",
    enrollmentRateLimited: "연결 요청을 너무 자주 보냈습니다. 몇 분 뒤에 다시 시도해 주세요.",
    enrollmentExpired: "연결 요청이 만료되었거나 서버에서 찾을 수 없습니다. 연결 요청을 다시 시작해 주세요.",
  },
  /** What `assistant.ts` answers when no AI wrote the answer. */
  assistant: {
    foundMemories: "관련 기억을 찾았습니다. 내용을 확인해 주세요.",
    noMemories: "관련 기억을 찾지 못했습니다.",
  },
};
