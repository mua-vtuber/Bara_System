/**
 * 기억 서버 재시작 한국어 라벨 — 연결·진단 화면의 재시작 절과 설정 저장 안내가 쓰는 사용자 문자열.
 *
 * i18n-ready 로 한 곳에 모은다. 화면 코드에는 사용자 문자열 리터럴을 직접 쓰지 않는다.
 */

/** journalctl 로 확인할 서비스 이름(펫이 설치하는 서버 유닛). */
const SERVER_UNIT_NAME = "bara-pet-memory.service";

export const RESTART_LABELS = {
  /** 설정 저장 직후 상태 줄 — 재시작이 필요하다는 안내(settings.ts 가 쓴다). */
  savedNeedsRestart:
    "저장했어요. 재시작해야 적용돼요. 모든 설정을 마친 뒤 연결·진단 화면의 재시작 버튼을 눌러 주세요.",
  title: "기억 서버 재시작",
  desc: "설정을 저장한 뒤 새 값을 적용하려면 서버를 한 번 다시 켜야 해요.",
  button: "기억 서버 재시작",
  loading: "재시작 가능 여부를 확인하는 중...",
  confirm: "5~15초 동안 서버가 멈추고, Claude Code·디스코드 봇 연결이 잠깐 끊겨요. 재시작할까요?",
  restarting: "다시 켜지는 중…",
  done: "재시작 완료",
  doneVersion: (version: string) => `재시작 완료 (서버 버전 ${version})`,
  doneVersionProblem: (problem: string) => `재시작 완료. 다만 서버 버전은 확인하지 못했어요: ${problem}`,
  loadFailed: (problem: string) => `재시작 가능 여부를 확인하지 못했어요: ${problem}`,
  requestFailed: (problem: string) => `재시작을 시작하지 못했어요: ${problem}`,
  timeout: (seconds: number, lastProblem: string | null) =>
    `${seconds}초가 지나도 서버가 새로 켜진 것을 확인하지 못했어요.` +
    (lastProblem === null ? "" : ` 마지막으로 확인된 상태: ${lastProblem}`) +
    ` 서버에서 journalctl -u ${SERVER_UNIT_NAME} 로 기록을 확인해 주세요.`,
  invalidInfoResponse: "서버 응답 형식을 확인할 수 없어요.",
  missingBootId: "서버 응답에 bootId 가 없어요.",
  missingVersion: "응답에 version 이 없어요.",
  unsupportedWithoutReason: "서버가 재시작 불가라고 답했지만 이유를 알려 주지 않았어요.",
  stillOldProcess: "서버가 아직 이전 프로세스(같은 bootId)로 응답하고 있어요.",
  pollTimedOut: (seconds: number) => `서버가 ${seconds}초 안에 응답하지 않았어요.`,
  versionRequestFailed: (status: number) => `HTTP ${status}`,
  infoRequestFailed: (status: number) => `HTTP ${status}`,
} as const;
