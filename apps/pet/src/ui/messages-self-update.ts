import { SELF_UPDATE } from "../shared/self-update.ts";
import { causeOrEmpty } from "./messages-service-core.ts";

/** Last digits read with a final consonant (영, 일, 삼, 육, 칠, 팔): they take 이 rather than 가. */
const SUBJECT_AFTER_CONSONANT = new Set(["0", "1", "3", "6", "7", "8"]);
/** Last digits read with a final consonant other than ㄹ (영, 삼, 육): they take 으로 rather than 로. */
const DIRECTION_AFTER_CONSONANT = new Set(["0", "3", "6"]);

/** `version` with the subject particle its last digit takes ("0.1.9가", "0.2.0이"). */
export function withSubject(version: string): string {
  return `${version}${SUBJECT_AFTER_CONSONANT.has(version.slice(-1)) ? "이" : "가"}`;
}
/** `version` with the direction particle its last digit takes ("0.1.9로", "0.2.0으로"). */
export function withDirection(version: string): string {
  return `${version}${DIRECTION_AFTER_CONSONANT.has(version.slice(-1)) ? "으로" : "로"}`;
}

/** Texts of the pet's own update (docs/decisions/2026-10-14-pet-self-update-spec.md): the pet window's update button
 * and notice line, the update bubble, and the service's failures (`src/service/self-update`, keyed by code).
 * `messages.ts` re-exports both sections, so callers read `messages.selfUpdate.<key>` and `messages.selfUpdateErrors.<CODE>`. */
export const selfUpdateMessages = {
  selfUpdate: {
    buttonGlyph: "↑",
    buttonLabel: "지금 업데이트하기",
    cardLabel: "새 버전 설치 확인 열기",
    versionField: "업데이트 버전",
    notice: (version: string) => `새 버전 ${withSubject(version)} 있어요`,
    confirm: (version: string) => `${withDirection(version)} 지금 설치하시겠습니까?`,
    yes: "네",
    no: "아니오",
    downloading: (percent: number) => `받는 중 ${percent}%`,
    verifying: "파일 확인 중",
    /** The progress line with a result action's failure that came during the download (the download goes on). */
    busyWithNote: (progress: string, note: string) => `${progress}. ${note}`,
    launching: "설치를 시작합니다",
    failed: (cause: string) => `업데이트를 끝내지 못했어요. 펫은 그대로 쓸 수 있고, 펫 오른쪽 아래 화살표 버튼으로 다시 시도할 수 있어요. 원인: ${causeOrEmpty(cause)}`,
    failedNoCause: "업데이트를 끝내지 못했어요. 원인이 이 말풍선에 전달되지 않았어요. 펫 오른쪽 아래 화살표 버튼으로 다시 시도해 주세요.",
    stateFailed: (text: string, cause: string) => `${text} 말풍선 상태도 바꾸지 못했어요. 원인: ${causeOrEmpty(cause)}`,
    openFailed: (cause: string) => `업데이트 말풍선을 열지 못했어요. 원인: ${causeOrEmpty(cause)}`,
    closeFailed: (cause: string) => `업데이트 말풍선을 닫지 못했어요. 원인: ${causeOrEmpty(cause)}`,
    announceFailed: (cause: string) => `새 버전 알림을 끝내지 못했어요. 화살표 버튼으로 설치할 수 있어요. 원인: ${causeOrEmpty(cause)}`,
    listenFailed: (cause: string) => `업데이트 알림을 받지 못해 말풍선에 업데이트가 보이지 않을 수 있어요. 바라 펫을 다시 실행해 주세요. 원인: ${causeOrEmpty(cause)}`,
    checkFailed: (cause: string) => `업데이트 확인 실패: ${causeOrEmpty(cause)}`,
    statusFailed: (cause: string) => `업데이트 확인 상태를 읽지 못했어요. 원인: ${causeOrEmpty(cause)}`,
    logFailed: (cause: string) => `업데이트 실패 기록 파일 ${SELF_UPDATE.logFileName} 을 쓰지 못했어요. 원인: ${causeOrEmpty(cause)}`,
    /** `cause` is the service's whole sentence (`selfUpdateErrors.SELF_UPDATE_RECORD_*`), which names the file. */
    /** Added to every download failure once the half-received file is gone (`src/service/self-update/download.ts`). */
    partialRemoved: "받던 파일은 지웠어요.",
    /** Added instead when that file could not be removed; the cause is in the log as SELF_UPDATE_PARTIAL_CLEANUP_FAILED. */
    partialKept: `받던 파일은 지우지 못했어요. 다음 시작 때 다시 지워요. 원인은 ${SELF_UPDATE.logFileName} 에 적었어요.`,
    recordFailed: (cause: string) => `새 버전 알림 기록에 문제가 있어요. 화살표 버튼은 그대로 쓸 수 있어요. ${causeOrEmpty(cause)}`,
  },
  selfUpdateErrors: {
    SELF_UPDATE_HTTP: (status: number) => `GitHub가 새 버전 확인 요청을 받아 주지 않았어요. 응답 코드: HTTP ${status}. 다음 확인 때 다시 시도해요.`,
    SELF_UPDATE_NETWORK: (cause: string) => `GitHub에 연결하지 못해 새 버전을 확인하지 못했어요. 인터넷 연결을 확인해 주세요. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_TIMEOUT: (seconds: number) => `GitHub가 ${seconds}초 안에 답하지 않아 새 버전을 확인하지 못했어요.`,
    SELF_UPDATE_REDIRECT: "GitHub가 릴리스 정보 대신 다른 주소로 안내해 따라가지 않았어요. 저장소 이름이나 위치가 바뀌었는지 확인해 주세요.",
    SELF_UPDATE_RESPONSE_INVALID: "GitHub 응답을 릴리스 정보로 읽지 못했어요.",
    SELF_UPDATE_UNEXPECTED: (cause: string) => `새 버전을 확인하다 예상하지 못한 오류가 났어요. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_TAG_INVALID: (tag: string) => `릴리스 형식 오류: 버전 태그가 v와 버전 번호 형식이 아니에요. 받은 태그: ${tag}`,
    SELF_UPDATE_INSTALLER_MISSING: `릴리스 형식 오류: 이름이 ${SELF_UPDATE.installerSuffix} 로 끝나는 설치 파일이 없어요.`,
    SELF_UPDATE_INSTALLER_AMBIGUOUS: (count: number) =>
      `릴리스 형식 오류: 이름이 ${SELF_UPDATE.installerSuffix} 로 끝나는 설치 파일이 ${count}개라 어느 것을 받을지 정하지 않았어요.`,
    SELF_UPDATE_ASSET_INVALID: (name: string) => `릴리스 형식 오류: 설치 파일의 이름, 주소, 크기 가운데 올바르지 않은 값이 있어요. 파일: ${name}`,
    SELF_UPDATE_DIGEST_INVALID: (name: string) => `릴리스 형식 오류: 설치 파일에 sha256 지문이 없거나 형식이 달라 받지 않아요. 파일: ${name}`,
    SELF_UPDATE_NOT_AVAILABLE: (version: string) =>
      `지금 설치할 수 있는 새 버전이 아니에요: ${version}. 펫이 새 버전을 다시 확인한 뒤 화살표 버튼으로 다시 시도해 주세요.`,
    SELF_UPDATE_BUSY: (version: string) => `다른 버전의 설치 파일을 받고 있어요: ${version}. 끝난 뒤 다시 시도해 주세요.`,
    SELF_UPDATE_VERSION_INVALID: "업데이트 버전 형식이 올바르지 않아요.",
    SELF_UPDATE_DIR_LINK: (path: string) => `업데이트 폴더가 다른 곳으로 연결된 링크 폴더라 그 안에 쓰거나 지우지 않았어요. 이 폴더를 지운 뒤 다시 시도해 주세요: ${path}`,
    SELF_UPDATE_CLEANUP_FAILED: (path: string, cause: string) =>
      `지난 업데이트에서 남은 파일을 지우지 못했어요. 다음 시작 때 다시 지워요. 파일: ${path}. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_PARTIAL_CLEANUP_FAILED: (path: string, cause: string) =>
      `받다 만 설치 파일을 정리하지 못했어요. 다음 시작 때 다시 지워요. 파일: ${path}. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_DOWNLOAD_HTTP: (status: number) => `설치 파일을 받지 못했어요. 응답 코드: HTTP ${status}.`,
    SELF_UPDATE_DOWNLOAD_NETWORK: (cause: string) => `설치 파일을 받다가 연결이 끊겼어요. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_DOWNLOAD_STALLED: (seconds: number) => `설치 파일이 ${seconds}초 동안 더 오지 않아 받기를 멈췄어요.`,
    SELF_UPDATE_DOWNLOAD_UNEXPECTED: (cause: string) => `설치 파일을 받다 예상하지 못한 오류가 났어요. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_DISK_FULL: (path: string) => `디스크 공간이 부족해 설치 파일을 다 쓰지 못했어요. 공간을 비운 뒤 다시 시도해 주세요. 위치: ${path}`,
    SELF_UPDATE_WRITE_FAILED: (path: string, cause: string) => `설치 파일을 쓰지 못했어요. 위치: ${path}. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_SIZE_MISMATCH: (expected: number, actual: number) =>
      `파일이 손상됐거나 바뀌었습니다. 기대한 크기: ${expected}바이트, 받은 크기: ${actual}바이트.`,
    SELF_UPDATE_DIGEST_MISMATCH: (expected: string, actual: string) =>
      `파일이 손상됐거나 바뀌었습니다. 기대한 sha256: ${expected}, 실제 sha256: ${actual}.`,
    SELF_UPDATE_CANCELLED: "설치 파일 받기를 멈췄어요.",
    SELF_UPDATE_RECORD_UNREADABLE: (path: string, cause: string) =>
      `새 버전 알림 기록 파일을 읽지 못해 이번 실행 동안 새 버전 알림 말풍선을 띄우지 않아요. 파일: ${path}. 원인: ${causeOrEmpty(cause)}`,
    SELF_UPDATE_RECORD_INVALID: (path: string) =>
      `새 버전 알림 기록 파일의 내용이 이 펫이 아는 형식이 아니라 이번 실행 동안 새 버전 알림 말풍선을 띄우지 않아요. 이 파일을 지우면 다음 시작부터 새로 기록해요. 파일: ${path}`,
    SELF_UPDATE_RECORD_SAVE_FAILED: (path: string, cause: string) =>
      `새 버전 알림을 보여 준 기록을 저장하지 못했어요. 다음에 펫을 켜면 같은 알림이 한 번 더 보일 수 있어요. 파일: ${path}. 원인: ${causeOrEmpty(cause)}`,
  },
};
