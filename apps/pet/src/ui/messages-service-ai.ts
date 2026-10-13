import { serviceCoreMessages, withCause } from "./messages-service-core.ts";

/** Public texts of the service's AI calls and of the memory cleanup run (`src/service`: `ai.ts`, `cleanup.ts`,
 * `cli.ts`, `mcp.ts`). `messages.ts` re-exports every section here, so callers read `messages.<section>.<key>`.
 * The prompts sent to the models are not here: they are instructions to a model, not text shown to the user. */
export const serviceAiMessages = {
  /** The answer and classification model (`ai.ts`). */
  aiService: {
    responseFormat: "AI 응답 형식을 확인하지 못했습니다.",
    classificationInvalid: "AI 분류 응답이 올바르지 않습니다.",
    answerSourcesUnconfirmed: "AI 답변의 근거를 확인하지 못했습니다.",
    modelListUnreadable: "AI 모델 목록을 읽을 수 없습니다.",
    sameKindServerNeeded: "정리 AI와 같은 종류의 AI 서버 주소를 설정해 주세요.",
    modelNeeded: "AI 모델을 선택해 주세요.",
    /** What the settings screen shows after "check the AI" (`AiClient.probe`). */
    probe: {
      searchOnly: "AI 없이 검색만 사용합니다.",
      pickCleanupAi: "정리에 사용할 AI를 선택해 주세요.",
      connected: "AI 서버와 연결되었습니다.",
      modelNotFound: "선택한 모델을 AI 서버에서 찾지 못했습니다.",
      /** The model-list request never got an answer. */
      networkFailed: "AI 서버에 연결하지 못했습니다. 주소와 AI 서버 실행 상태를 확인해 주세요.",
      /** The model-list request connected but got no answer within its time limit. */
      timedOut: "AI 서버가 제한 시간 안에 응답하지 않았습니다. AI 서버가 실행 중인지, 모델을 불러오는 중은 아닌지 확인해 주세요.",
      /** The server refused the credential; `cause` is the server's own text. */
      authRejected: (cause: string) => withCause("AI 서버가 인증을 받아들이지 않았습니다. 인증키를 확인해 주세요.", cause),
      /** The server answered with something that is not a model list (an address that reaches another web server). */
      notModelList: (cause: string) => withCause("AI 서버의 답을 모델 목록으로 읽지 못했습니다. 주소가 AI 서버를 가리키는지 확인해 주세요.", cause),
    },
  },
  /** One cleanup run: the AI's proposals, the server's candidates, the `claude`/`codex` CLI and the MCP tools. */
  cleanupService: {
    limitRange: "정리 건수는 1~100으로 설정해 주세요.",
    pickCleanupAi: "정리에 사용할 AI를 먼저 선택해 주세요.",
    serverAndModelNeeded: "정리 AI 서버와 모델을 설정해 주세요.",
    proposalListUnreadable: "정리 제안 목록을 읽을 수 없습니다.",
    candidateListUnreadable: "정리 후보 목록을 읽을 수 없습니다.",
    candidateUnreadable: "정리 후보를 읽을 수 없습니다.",
    toolInputMismatch: "정리 도구 입력 형식이 맞지 않습니다.",
    cancelled: "정리 작업을 취소했습니다.",
    /** The cleanup model's output is not JSON: raised by `AiClient.cleanupDecision` and by the CLI alike. */
    modelJsonUnreadable: "정리 AI JSON을 읽을 수 없습니다.",
    /** The AI_PROPOSAL texts: the Pet checked the cleanup AI's answer and threw it away, so each says what was wrong with it. */
    proposalFormat: "정리 AI의 답이 정해진 형식과 달라 쓰지 않았습니다.",
    proposalTooLarge: "정리 AI의 답이 너무 길어 쓰지 않았습니다.",
    proposalJsonUnreadable: "정리 AI의 답을 읽을 수 없어 쓰지 않았습니다.",
    noFindingHasProposal: "정리 AI가 고칠 곳이 없다고 하면서 제안을 함께 보내 쓰지 않았습니다.",
    personLinkUnconfirmed: "정리 AI가 고른 사람이 후보 명단에 없거나 답의 형식이 달라 사람 연결 제안을 쓰지 않았습니다.",
    regexUnconfirmed: "정리 AI가 낸 메모 자동 분류 규칙(정규식) 제안이 정해진 형식과 달라 쓰지 않았습니다.",
    entityEnrichUnconfirmed: "정리 AI가 낸 항목 빈칸 채우기 제안이 정해진 형식과 달라 쓰지 않았습니다.",
    proposalKindMismatch: "정리 AI가 요청과 다른 종류의 제안을 보내 쓰지 않았습니다.",
    entityRegisterUnconfirmed: "정리 AI가 낸 항목·일정 답의 형식이 올바르지 않습니다.",
    /** The server sent the candidates of a stage whose instruction it owns without that instruction (an older server). */
    instructionMissing: {
      entityRegister: "서버가 항목·일정 등록 지시문을 보내지 않았습니다. 서버를 업데이트해 주세요.",
      regexStrengthen: "서버가 메모 자동 분류 규칙(정규식) 제안 지시문을 보내지 않았습니다. 서버를 업데이트해 주세요.",
    },
    /** The cleanup server answered a submitted proposal with neither a proposal id nor a quality-check rejection. */
    submitResponseUnreadable: "정리 서버가 제안 등록 결과를 알 수 없는 모양으로 보내 이 제안이 등록됐는지 확인하지 못했습니다.",
    stageUnsupported: "연결된 기억 서버가 항목·일정 등록 단계를 모르는 이전 버전이라 이 단계는 건너뛰었습니다.",
    /** A request to the cleanup AI's own server (Ollama or an OpenAI-compatible one) that got no HTTP answer
     * (`cleanupAiFailure`, `cleanup.ts`): said apart from the cleanup server's own failures (`mcp`). */
    aiServer: {
      networkFailed: "정리 AI 서버에 연결하지 못했습니다. 주소와 AI 서버 실행 상태를 확인해 주세요.",
      timedOut: "정리 AI 서버가 제한 시간 안에 응답하지 않았습니다. AI 서버가 실행 중인지, 모델을 불러오는 중은 아닌지 확인해 주세요.",
      redirected: "정리 AI 서버가 다른 주소로 이동하라고 응답했습니다. 펫은 이동 안내를 따라가지 않으니 AI 서버 주소를 확인해 주세요.",
      /** The cleanup AI's server answered 401: its key is missing, wrong or expired. Not the memory server's `serverClient.http.authRequired`. */
      authRejected: "정리 AI 서버가 인증을 거부했습니다. AI 서버의 인증키가 맞는지 확인해 주세요.",
      /** The cleanup AI's server answered 403. */
      forbidden: "정리 AI 서버가 이 요청을 허용하지 않았습니다. 인증키에 이 모델을 쓸 권한이 있는지 확인해 주세요.",
      /** The cleanup AI's server answered with another HTTP error status (400, 404, 409, 5xx), or the Pet refused to send the request to the saved AI address. */
      httpFailed: "정리 AI 서버가 요청을 처리하지 못했습니다. AI 서버 주소와 모델 이름을 확인해 주세요.",
      /** An answer from the cleanup AI's server that is not HTTP or whose body cannot be read, and an exception no code names while sending
       * the request; `sentence` is the request layer's own sentence for it (`serverClient.responseMalformed`, `requestUnexpected(cause)`, ...). */
      failedWith: (sentence: string) => `정리 AI 서버와 주고받는 중 문제가 생겼습니다. ${sentence}`,
    },
    /** The `claude` or `codex` command line the cleanup runs through. */
    cli: {
      responseUnreadable: "정리 AI 응답을 읽을 수 없습니다.",
      claudeResponseUnconfirmed: "Claude 응답을 확인하지 못했습니다.",
      claudeStructuredMissing: "Claude 구조화 응답이 없습니다.",
      outputTooLarge: "정리 AI 응답이 너무 큽니다.",
      timeout: "정리 AI 응답 시간이 초과되었습니다.",
      failed: "정리 AI 실행에 실패했습니다. 로그인과 모델 설정을 확인해 주세요.",
      tempDirFailed: "임시 작업 폴더를 만들지 못했습니다.",
      launchFailed: "정리 AI CLI를 실행하지 못했습니다. 설치와 로그인을 확인해 주세요.",
      probeTempDirFailed: "CLI 임시 폴더를 만들지 못했습니다.",
      probeUnsafeVersion: "현재 CLI 버전은 안전한 도구 제한 기능을 지원하지 않습니다.",
      probeCodexRestrictionUnconfirmed: "Codex 도구 제한 기능을 확인하지 못했습니다.",
      probeClaudeLogin: "Claude CLI에 로그인해 주세요.",
      /** The Codex CLI is installed but `codex login status` failed: the user is not logged in. */
      probeCodexLogin: "Codex CLI에 로그인되어 있지 않습니다. 터미널에서 codex login을 실행해 로그인한 뒤 다시 시도해 주세요.",
      /** The `claude` or `codex` command is not on this PC's PATH; nothing was run. */
      probeNotInstalled: {
        claude: "이 PC에서 Claude Code를 찾지 못했습니다. Claude Code를 설치하고 터미널에서 claude가 실행되는지 확인한 뒤 다시 시도해 주세요.",
        codex: "이 PC에서 Codex CLI를 찾지 못했습니다. Codex CLI를 설치하고 터미널에서 codex가 실행되는지 확인한 뒤 다시 시도해 주세요.",
      } as Readonly<Record<"claude" | "codex", string>>,
      probeAvailable: { claude: "Claude CLI를 사용할 수 있습니다.", codex: "Codex CLI를 사용할 수 있습니다." } as Readonly<Record<"claude" | "codex", string>>,
      probeUnavailable: "CLI 설치 또는 로그인을 확인해 주세요.",
    },
    /** The server's MCP cleanup tools. */
    mcp: {
      responseUnreadable: "정리 서버 응답을 읽을 수 없습니다.",
      responseUnconfirmed: "정리 서버 응답을 확인하지 못했습니다.",
      responseTooLarge: "정리 서버 응답이 너무 큽니다.",
      /** The same answer as `serverClient.responseMalformed`, at the cleanup server's address (`McpClient`). */
      responseMalformed: "정리 서버 주소에서 HTTP 응답으로 읽을 수 없는 답이 왔습니다. 주소와 포트가 맞는지 확인해 주세요.",
      /** Reading the body failed after the answer began; `cause` is that exception's own sentence (`causeOf`). */
      responseReadFailed: (cause: string) => withCause("정리 서버 응답을 끝까지 읽지 못했습니다.", cause),
      networkFailed: "정리 서버에 연결하지 못했습니다.",
      /** The cleanup server did not answer within the request's time limit (`McpClient`). */
      timedOut: "정리 서버가 제한 시간 안에 응답하지 않았습니다. 서버가 실행 중인지, 연결이 막히거나 느리지 않은지 확인해 주세요.",
      /** The cleanup server answered with a redirect; the Pet never follows one, so the bearer never leaves for another address. */
      redirected: "정리 서버가 다른 주소로 이동하라고 응답했습니다. 펫은 이동 안내를 따라가지 않으니 서버 주소를 확인해 주세요.",
      /** `McpClient` met an exception no service code names while sending a request; `cause` is that exception's own sentence (`causeOf`). */
      requestUnexpected: (cause: string) => withCause("정리 서버로 요청을 보내는 중 예상하지 못한 오류가 났습니다.", cause),
      authRequired: serviceCoreMessages.serverClient.http.authRequired,
      forbidden: "정리 도구 권한이 없습니다.",
      requestFailed: (status: number) => `정리 서버 요청에 실패했습니다 (${status}).`,
      versionMismatch: "정리 서버 버전이 맞지 않습니다.",
      toolListUnreadable: "정리 도구 목록을 읽을 수 없습니다.",
      toolMissing: "서버에 필요한 정리 도구가 없습니다.",
      toolError: "정리 도구가 요청을 처리하지 못했습니다. 서버 설정과 후보 상태를 확인해 주세요.",
      toolResponseEmpty: "정리 도구 응답이 비어 있습니다.",
      toolResponseUnreadable: "정리 도구 응답을 읽을 수 없습니다.",
      toolJsonUnreadable: "정리 도구 JSON을 읽을 수 없습니다.",
    },
  },
};
