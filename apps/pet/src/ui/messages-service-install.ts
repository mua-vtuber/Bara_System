import type { ClientTokenErrorCode } from "../../../setup/src/client-token-errors.ts";
import { EXISTING_CHOICE_LABEL } from "./messages-labels.ts";
import { withCause } from "./messages-service-core.ts";

/** The credentials step refused a value the Pet itself passed (a path, the server address or the command shape). */
const TOKEN_TOOL_MISUSE = "펫이 인증 정보 준비 프로그램에 잘못된 값을 넘겨서 멈췄습니다. 펫 자체의 문제이니 펫을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.";

/** Public texts of the local and remote install runs (`src/service/install/*`). `messages.ts` re-exports every
 * section here, so callers read `messages.<section>.<key>`. The causes that also reach the screen by code
 * (server blocks, timeouts, unverified routes) stay in `messages.connectionErrors` in `messages.ts`. */
export const serviceInstallMessages = {
  /** Names of the install steps. A step's name is the subject of its timeout or failure text
   * (`installService.stepTimeout`, `stepStalled`, `stepFailed`), so the user sees which step stopped. */
  installSteps: {
    prepareMemoryData: "메모리 데이터 준비",
    koreanDictionary: "한국어 사전 준비",
    modelDownload: "모델 내려받기",
    prepareCredentials: "인증 정보 준비",
    portOwnerLookup: "로컬 포트 소유자 확인",
    sshHostKeyDiscover: "SSH 호스트 키 확인(인증 없이)",
    sshHostKeyScan: "SSH 호스트 키 조회",
    sshFingerprint: "SSH 호스트 지문 계산",
    fileTransfer: "파일 전송",
    remoteServiceStart: "원격 서비스 시작",
    remoteTokenFileCheck: "원격 토큰 파일 확인",
    remoteCredentialsRead: "원격 인증 정보 읽기",
    remoteInstallDirPrepare: "원격 설치 폴더 준비",
    transferVerify: "전송 파일 검증",
    extract: "압축 해제",
    dependencies: "의존성 설치",
    serverDataPrepare: "서버 데이터 준비",
    remoteCredentialsPrepare: "원격 인증 정보 준비",
    releaseLink: "설치 경로 연결",
    serviceUnitRegister: "서비스 유닛 등록",
    installCompleteMark: "설치 완료 표시",
    remoteProbe: "원격 상태 조사",
  },
  /** Why the credentials step (`apps/setup/src/client-token.ts`) refused, keyed by the code its one known
   * failure line maps to (`apps/setup/src/client-token-errors.ts`); the same code is the service error code.
   * Any other output of that step stays `installService.sensitiveStepFailed`. The step runs on this PC or,
   * for a remote install, on the server, so the texts name neither. */
  clientTokenErrors: {
    CLIENT_TOKEN_FILE_EXISTS: "인증 정보를 새로 만들려는 사이에 인증 정보 파일이 먼저 생겨 있어서, 덮어쓰지 않고 멈췄습니다. 다시 시도해 주세요.",
    CLIENT_TOKEN_FILE_MISSING: "기존 인증 정보 파일을 읽으려는 사이에 파일이 없어져서 멈췄습니다. " +
      "백신이나 정리 프로그램 같은 다른 프로그램이 바라의 데이터 폴더에 있는 그 파일을 옮기거나 지우지 않았는지 확인한 뒤 다시 시도해 주세요.",
    CLIENT_TOKEN_FILE_INVALID: "기존 인증 정보 파일의 내용이 올바르지 않아 읽지 않았습니다. 파일을 고치거나 새로 만들지 않고 멈췄습니다. " +
      "다른 프로그램이 이 파일을 바꾸지 않았는지 확인해 주세요.",
    CLIENT_TOKEN_SCOPES_MISSING: "기존 인증 정보 파일에 펫용과 관리 화면용 인증 정보가 함께 들어 있지 않아 쓰지 않았습니다. " +
      "파일을 고치거나 새 인증 정보를 만들지 않고 멈췄습니다. 다른 설치에서 가져온 파일이 아닌지 확인해 주세요.",
    CLIENT_TOKEN_SERVER_RESPONDING: "메모리 서버가 쓸 포트에서 이미 다른 서버가 응답하고 있어서 새 인증 정보를 만들지 않았습니다. " +
      `그 서버를 끈 뒤 다시 시도하거나, 그 서버가 바라라면 '${EXISTING_CHOICE_LABEL}'로 연결해 주세요.`,
    CLIENT_TOKEN_STOP_UNCONFIRMED: "메모리 서버가 쓸 포트가 비어 있는지 정해진 시간 안에 확인하지 못해서, 새 인증 정보를 만들지 않고 멈췄습니다. " +
      "잠시 뒤 다시 시도해 주세요. 계속 반복되면 VPN이나 보안 프로그램이 메모리 서버를 설치하는 컴퓨터 안의 연결을 막거나 늦추고 있지 않은지 확인해 주세요.",
    CLIENT_TOKEN_PATH_NOT_ABSOLUTE: TOKEN_TOOL_MISUSE,
    CLIENT_TOKEN_URL_INVALID: TOKEN_TOOL_MISUSE,
    CLIENT_TOKEN_USAGE: TOKEN_TOOL_MISUSE,
  } satisfies Record<ClientTokenErrorCode, string>,
  /** What a finished local install run did (the remote run's are in `remoteInstall`). */
  localInstall: {
    reused: "기존 로컬 메모리 서버에 연결했습니다.",
    prepared: "로컬 메모리 서버가 준비되었습니다.",
  },
  installService: {
    // Child processes (`process.ts`).
    systemRootMissing: "Windows 환경 변수 SystemRoot가 없거나 올바르지 않아 Windows 시스템 도구를 찾을 수 없습니다.",
    outputTooLarge: "설치 명령의 출력이 너무 큽니다.",
    stepTimeout: (step: string) => `${step} 단계가 제한 시간을 넘어 중단되었습니다.`,
    stepStalled: (step: string) => `${step} 단계의 응답이 없어 중단되었습니다. 연결 상태를 확인해 주세요.`,
    sensitiveStepFailed: "비밀값을 처리하는 설치 단계가 실패했습니다. 연결과 데이터 경로를 확인해 주세요.",
    stepFailed: (step: string, exitCode: number) => `${step} 실행 실패 (exit ${exitCode}).`,
    // The bundled payload (`runtime.ts`).
    payloadListInvalid: "설치 파일 목록이 올바르지 않습니다.",
    payloadPathOutside: "설치 파일 경로가 범위를 벗어납니다.",
    payloadBunPathInvalid: "번들 Bun 실행 경로가 올바르지 않습니다.",
    payloadListMissing: "설치 파일 목록을 찾을 수 없습니다.",
    payloadCrtListInvalid: "Microsoft CRT 설치 파일 목록이 올바르지 않습니다.",
    payloadFileMissing: "필수 설치 파일이 빠졌습니다.",
    payloadCrtFileMissing: "Microsoft CRT 설치 파일이 빠졌습니다.",
    payloadIntegrityFailed: "설치 파일 무결성 확인에 실패했습니다.",
    // The local run (`index.ts`, `local-server.ts`, `net.ts`, `connection-policy.ts`).
    tokenPathMissing: "서버 토큰 경로가 없습니다.",
    tokenResultUnreadable: "인증 정보 준비 결과를 읽지 못했습니다.",
    tokenResultInvalid: "인증 정보 준비 결과가 올바르지 않습니다.",
    journalUnreadable: "이전 설치 기록을 읽지 못했습니다.",
    journalInvalid: "이전 설치 기록이 올바르지 않습니다.",
    journalPortMismatch: "로컬 서버 주소와 설치 기록의 포트가 다릅니다.",
    prepareResultUnreadable: "메모리 데이터 준비 결과를 읽지 못했습니다.",
    prepareDataPathMismatch: "메모리 데이터 경로가 일치하지 않습니다.",
    localServerExited: "메모리 서버가 시작 중 종료되었습니다.",
    /** `others` are the process ids that hold the port; none means the holder could not be named. */
    localPortTaken: (port: number, others: readonly number[]) =>
      `펫 메모리 서버의 로컬 포트 ${port}를 ${others.length > 0 ? `다른 프로그램(PID ${others.join(", ")})` : "다른 프로그램"}이 사용하고 있어 연결하지 않았습니다. ` +
      "이 포트는 설치된 메모리 서버 설정에 고정되어 있으니, 그 프로그램을 종료한 뒤 다시 시도해 주세요.",
    localPortUnavailable: "다른 서버에 예약되지 않은 로컬 포트를 찾지 못했습니다.",
    rebindTokenMissing: "연결할 서버 인증 정보가 없습니다.",
    // Who owns a local port (`port-owner.ts`).
    ownerLookupUnreadable: "로컬 포트를 쓰는 프로그램 조회 결과를 읽지 못했습니다.",
    ownerNoPermission: "로컬 포트를 쓰는 프로그램을 볼 권한이 없어 소유자를 확인할 수 없습니다.",
    powershellMissing: "Windows PowerShell을 찾지 못해 로컬 포트를 쓰는 프로그램을 확인할 수 없습니다.",
    ssCommandMissing: "ss 명령을 찾지 못해 로컬 포트를 쓰는 프로그램을 확인할 수 없습니다.",
    // The SSH tunnel (`port-owner.ts`, `remote.ts`, `index.ts`).
    /** The tunnel's local address is not `http://127.0.0.1:<port>`: raised where the address is checked
     * for the tunnel's port (`requireTunnelPort`) and where the tunnel is opened (`ensureRemoteTunnel`). */
    tunnelAddressInvalid: "SSH 연결 주소는 http://127.0.0.1:<포트> 형식이어야 합니다.",
    /** The tunnel came up on another local port than the saved one, and this connection cannot take the new address. */
    tunnelAddressKeepFailed: "기존 SSH 연결 주소를 유지할 수 없습니다.",
    tunnelExited: "SSH 터널이 시작 중 종료되었습니다.",
    /** The saved tunnel closed or did not open, and the service's own attempt to open it again failed
     * (`tunnel-keeper.ts`); it tries again on its own. Shown on the status line while the tunnel stays closed. */
    tunnelReopenFailed: (cause: string) =>
      withCause("SSH 터널이 닫혀 펫이 스스로 다시 열려고 했지만 실패했습니다. 잠시 뒤 다시 시도합니다.", cause),
    tunnelPortTaken: (port: number, others: readonly number[]) =>
      `다른 프로그램(PID ${others.join(", ")})이 SSH 터널의 로컬 포트 ${port}를 사용하고 있습니다. 그 프로그램을 종료한 뒤 다시 시도해 주세요.`,
    tunnelBindFailed: "SSH 터널이 로컬 포트를 열지 못했습니다.",
    tunnelOwnerUnknown: "SSH 터널의 로컬 포트 소유자를 확인하지 못했습니다.",
    tunnelPortLost: "SSH 터널이 로컬 포트를 소유하지 못했습니다.",
    // The SSH client and host keys (`ssh.ts`, `remote.ts`).
    remotePathInvalid: "원격 설치 경로를 확인해 주세요.",
    sshClientMissing: "Windows OpenSSH Client를 설치한 뒤 다시 시도해 주세요.",
    sshKeyMissing: "SSH 키 파일을 찾을 수 없습니다.",
    hostKeyMissing: "서버 SSH 호스트 키를 읽지 못했습니다.",
    hostFingerprintFailed: "SSH 호스트 지문을 계산하지 못했습니다.",
    hostKeyAddressMismatch: "SSH 호스트 키의 주소가 일치하지 않습니다.",
    hostKeyChanged: "저장된 SSH 서버 키가 변경되었습니다. 연결을 중단했습니다.",
    fingerprintMismatch: "확인한 서버 지문과 현재 키가 다릅니다.",
    hostUntrusted: "원격 서버 지문을 먼저 확인해 주세요.",
    // The remote run (`remote.ts`).
    remotePrepareInvalid: "서버 데이터 준비 결과가 올바르지 않습니다.",
    remotePrepareUnreadable: "서버 데이터 준비 결과를 읽지 못했습니다.",
    remoteDataPathMismatch: "서버 데이터 경로가 일치하지 않습니다.",
    remoteTokenRecoveryFailed: "원격 인증 정보 복구에 실패했습니다.",
    remoteTokenInvalid: "원격 인증 정보가 올바르지 않습니다.",
    remoteDigestMismatch: "전송한 서버 실행 파일의 SHA-256이 다릅니다.",
  },
  /** Why the remote server's SSH tunnel is not on its preferred local port (`status.tunnelPort`), shown on the
   * settings screen and once after startup. The preferred port is the address Claude Code's bara MCP uses. */
  tunnelPort: {
    inUse: (preferred: number, port: number, owners: readonly number[]) =>
      `로컬 포트 ${preferred}를 ${owners.length > 0 ? `다른 프로그램(PID ${owners.join(", ")})` : "다른 프로그램"}이 쓰고 있어 ` +
      `원격 서버 연결을 포트 ${port}에 열었습니다. 지금 Claude Code의 bara MCP(localhost:${preferred})는 펫 연결로 이어지지 않습니다. ` +
      "그 프로그램을 끈 뒤 펫을 다시 켜면 이 포트로 돌아옵니다.",
    reserved: (preferred: number, port: number) =>
      `로컬 포트 ${preferred}는 예전에 다른 서버 연결이 쓴 주소라서, 인증 정보가 섞이지 않도록 원격 서버 연결을 포트 ${port}에 열었습니다. ` +
      `지금 Claude Code의 bara MCP(localhost:${preferred})는 펫 연결로 이어지지 않습니다.`,
    bindFailed: (preferred: number, port: number) =>
      `로컬 포트 ${preferred}에 원격 서버 연결을 열지 못해 포트 ${port}에 열었습니다. ` +
      `지금 Claude Code의 bara MCP(localhost:${preferred})는 펫 연결로 이어지지 않습니다. 펫을 다시 켜면 다시 시도합니다.`,
  },
};
