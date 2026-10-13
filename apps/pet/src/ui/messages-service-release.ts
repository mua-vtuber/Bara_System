import { withCause, withCauseThen } from "./messages-service-core.ts";

/** Where the manual recovery steps of a stopped server are written. */
const RECOVERY_GUIDE = `되돌리는 방법은 apps/memory/README.md 의 "업데이트 실패 후 되돌리기" 절에 있어요.`;

/** Public texts of replacing a component's release on a host (`src/service/install/release-*.ts`, `server-component.ts`,
 * `adapter-component.ts`, `remote-update.ts`, `remote-restore.ts`) and of `scripts/deploy-a1.ts`. `messages.ts`
 * re-exports every section here, so callers read `messages.<section>.<key>`. */
export const serviceReleaseMessages = {
  /** Step names: the subject of a step's timeout and failure text (`installService.stepTimeout`, `stepFailed`). */
  releaseSteps: {
    inspect: "서버 파일 확인", writeFile: "서버 파일 기록", makeDir: "서버 폴더 준비", removeDir: "서버 폴더 정리",
    listDirs: "버전 폴더 목록 읽기", digest: "올린 파일 검증", extract: "묶음 풀기", runtime: "실행 파일 설치",
    dependencies: "의존성 설치", link: "버전 연결 바꾸기", lock: "업데이트 잠금", serviceStop: "서비스 멈추기",
    serviceStart: "서비스 켜기", serviceState: "서비스 상태 확인", unitInstall: "서비스 파일 등록", unitRemove: "서비스 파일 삭제",
    schemaRead: "DB 구조 버전 읽기", health: "서버 응답 확인", installFile: "설정 파일 올리기",
    restorePack: "백업 묶기", restoreInspect: "설치 대상 데이터 확인", restoreRun: "백업에서 되살리기", restoreSwap: "되살린 기억 바꿔 끼우기",
  },
  /** The remote install's "백업에서 시작" (`remote-restore.ts`, spec 4). Every failure leaves the server's service off. */
  remoteRestore: {
    RESTORE_TARGET_NOT_EMPTY: "설치할 서버의 데이터 폴더에 이미 기억(보관된 기억 포함)이나 첨부가 있어 '백업에서 시작'을 하지 않았어요. 서버의 기억은 바뀌지 않았어요.",
    RESTORE_TARGET_INSTALLED: "이 서버 경로에는 설치가 끝난 펫 서버가 있어 '백업에서 시작'을 할 수 없어요. 서버의 기억은 바뀌지 않았어요.",
    RESTORE_WORK_OTHER_BACKUP: (path: string) => `서버에 다른 백업으로 시작했던 되살리기 작업 폴더 ${path} 이 남아 있어 멈췄어요. 처음 고른 백업으로 다시 시도하거나, 그 폴더를 지운 뒤 다시 시도해 주세요.`,
    RESTORE_UPLOAD_MISMATCH: "올린 백업의 해시가 맞지 않아 멈췄어요. 서버의 기억은 바뀌지 않았어요. 다시 시도해 주세요.",
    RESTORE_PACK_FAILED: (cause: string | undefined) => withCauseThen("고른 백업을 올릴 파일로 묶지 못했어요", cause, "서버에는 아무것도 올리지 않았어요."),
    RESTORE_REMOTE_FAILED: (cause: string | undefined) =>
      withCauseThen("서버에서 백업을 되살리지 못했어요", cause, "서비스는 켜지 않았어요. 같은 백업으로 다시 설치하면 멈춘 곳부터 이어서 되살려요."),
    /** The counts compared are the backup's own manifest, so running the same backup again gives the same result. */
    RESTORE_REMOTE_COUNT_MISMATCH: (workPath: string) =>
      "서버에서 되살린 기억 수가 백업의 목록 파일(manifest.json)에 적힌 수와 달라 바꿔 끼우지 않았어요. 서비스는 켜지 않았어요. " +
      "같은 백업으로 다시 설치해도 결과는 같아요. 다른 백업을 고르려면 서버의 되살리기 작업 폴더 " +
      `${workPath} 를 지운 뒤 다시 설치해 주세요. 이 백업을 꼭 써야 한다면 PC의 백업 폴더가 손상되지 않았는지 먼저 확인해 주세요.`,
    RESTORE_SWAP_FAILED: (cause: string | undefined) => withCauseThen("되살린 기억을 바꿔 끼우지 못했어요", cause, "서비스는 켜지 않았어요. 다시 설치하면 이어서 진행해요."),
    /** Added to the install's result after a swap: where this install's empty database and attachment folder were moved. */
    restored: (backupName: string, replaced: string) =>
      `백업 ${backupName} 의 기억으로 시작했어요. 이번 설치가 처음 만든 빈 DB와 빈 첨부 폴더는 지우지 않고 서버의 ${replaced} 폴더로 옮겨 두었어요.`,
  },
  releaseErrors: {
    /** S-14: plain about the stale lock a cut-off update leaves behind; never removed automatically. */
    RELEASE_BUSY: (lock: string) => `다른 업데이트가 진행 중이라 멈췄어요. 지금 진행 중인 업데이트가 없다면 서버의 잠금 폴더 ${lock} 를 지워도 돼요. 지운 뒤 다시 실행해 주세요.`,
    RELEASE_MODELS_FAILED: (cause: string | undefined) =>
      withCauseThen("새 버전에 필요한 한국어 사전과 검색 모델을 준비하지 못했어요", cause, "실행 중인 버전은 그대로 두었어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."),
    RELEASE_DIGEST_MISMATCH: "올린 묶음의 해시가 맞지 않아 업데이트하지 않았어요. 다시 시도해 주세요.",
    RELEASE_DIGEST_INVALID: "묶음 해시 값의 형식이 올바르지 않아요.",
    RELEASE_RECORD_INVALID: (path: string) => `버전 기록 파일 ${path} 을 읽지 못했어요.`,
    RELEASE_VERSION_INVALID: (version: string) => `버전 번호 '${version}' 의 형식이 올바르지 않아요. 숫자 세 개를 점으로 이은 형식이어야 해요.`,
    RELEASE_CONNECTION_INCOMPLETE: (key: string) => `저장된 원격 연결 설정에 ${key} 값이 없어 멈췄어요. 펫에서 원격 설치를 다시 해 주세요.`,
    RELEASE_STEP_OUTPUT_INVALID: (step: string) => `${step} 단계의 결과를 읽지 못했어요.`,
    RELEASE_ENV_INCOMPLETE: (key: string) => `서버 서비스 설정에 ${key} 값이 없어 새 버전의 모델을 준비하지 못하고 멈췄어요. 실행 중인 버전은 그대로 두었어요.`,
    RELEASE_UNIT_INVALID: (unit: string) => `서비스 이름 '${unit}' 은 쓸 수 없어요. 영문·숫자·@._- 만 쓰고 .service 로 끝나야 해요.`,
    RELEASE_NOT_DIRECTORY: (path: string) => `${path} 이 폴더가 아니라서 버전 폴더 목록을 읽지 못했어요.`,
    RELEASE_START_FAILED: (cause: string) => withCause("새 버전이 시작하지 못했고 되돌릴 이전 버전이 없어 서비스를 멈춰 두었어요.", cause),
    RELEASE_ROLLED_BACK: (cause: string) => withCause("새 버전이 시작하지 못해 이전 버전으로 되돌렸어요.", cause),
    RELEASE_ROLLBACK_FAILED: (cause: string, rollback: string) =>
      `${withCause("새 버전이 시작하지 못했어요.", cause)} ${withCause("이전 버전으로 되돌린 뒤에도 시작하지 못해 서비스를 멈춰 두었어요.", rollback)}`,
    RELEASE_SCHEMA_CHANGED: (cause: string, snapshotDir: string, previous: string | null) =>
      `${withCause("새 버전이 DB 구조를 바꾼 뒤 시작하지 못했어요.", cause)} 이전 버전은 바뀐 구조의 DB를 열지 못해 자동으로 되돌리지 않고 서비스를 멈춰 두었어요. 구조 변경 전 사본은 ${snapshotDir} 에 있어요. ${previous === null ? "되돌릴 직전 버전 폴더는 없어요." : `되돌릴 직전 버전 폴더는 ${previous} 예요.`} ${RECOVERY_GUIDE}`,
    /** Recovery itself hit an error (`release-swap.ts` `recover`): what state the service was left in and where `current` points. */
    RELEASE_RECOVERY_FAILED: (cause: string, recovery: string, stopped: boolean, link: string) =>
      `${withCause("새 버전이 시작하지 못했어요.", cause)} ${withCause("이전 상태로 되돌리는 중에 오류가 났어요.", recovery)} ` +
      `${stopped ? "서비스를 멈춰 두었어요." : "서비스를 멈추지도 못했어요. 서버에서 서비스 상태를 직접 확인해 주세요."} 지금 current 링크는 ${link} 를 가리켜요.`,
    /** R3a: the bundle asked for is already `current`, but the service is not running it (an earlier update stopped it). */
    RELEASE_NOT_RUNNING: (release: string, cause: string) =>
      `${withCause(`설치하려는 버전 폴더 ${release} 는 이미 연결돼 있지만 서비스가 정상 실행 중이 아니에요.`, cause)} 이전 업데이트가 실패한 채 멈춰 있을 수 있어 자동으로 켜지 않았어요.`,
    /** Also the keep path when nothing was updated: the server may simply have been stopped or not come back after a
     * reboot, so the text does not assume a failed update. */
    RELEASE_NOT_RUNNING_SERVER: (release: string, cause: string, snapshotDir: string) =>
      `${withCause(`서버가 정상 실행 중이 아니에요. 지금 연결된 버전 폴더는 ${release} 예요.`, cause)} ` +
      "업데이트가 실패한 뒤일 수도 있고, 서버를 다시 시작했거나 서비스를 직접 멈춘 뒤일 수도 있어요. 업데이트 실패 뒤라면 켜는 것이 위험할 수 있어 자동으로 켜지 않았어요. " +
      `업데이트로 DB 구조가 바뀐 뒤 멈춘 것이라면 구조 변경 전 사본은 ${snapshotDir} 에 있어요. ${RECOVERY_GUIDE}`,
    /** R3a: the lock directory could not be removed at the end of a replace; appended to the replace's own result or error. */
    lockLeft: (lock: string, cause: string) =>
      `${withCause(`업데이트 잠금 폴더 ${lock} 를 지우지 못했어요.`, cause)} 진행 중인 업데이트가 없다면 이 폴더를 지운 뒤 다시 실행해 주세요.`,
    RELEASE_LOCK_LEFT: (cause: string, lockLeft: string) => `${withCause("업데이트가 중간에 멈췄어요.", cause)} ${lockLeft}`,
    /** Cause sentence when the replace was cancelled after the switch: recovery ran first. */
    cancelled: "업데이트가 취소됐어요",
    /** A step error that came in while the replace was being cancelled: the step's own cause first, then the cancellation. */
    causeThenCancelled: (cause: string) => `${cause}. 그 사이에 업데이트도 취소됐어요`,
    /** `RELEASE_RECOVERY_FAILED`'s link when it could not be read. */
    linkUnknown: "확인할 수 없는 곳",
    linkMissing: "아무 곳도 아닌 상태",
    /** Cause sentences of a start check (`release-swap.ts` `started`). */
    notActive: (active: string) => `서비스 상태가 ${active} 예요`,
    wrongVersion: (reported: string, expected: string) => `서버가 ${reported} 버전이라고 답했어요. 기대한 버전은 ${expected} 예요`,
    noVersion: "버전 없음",
    noAnswer: "서버가 정해진 시간 안에 응답하지 않았어요",
    restarted: (count: number) => `서비스가 시작 뒤 ${count}번 다시 시작됐어요`,
  },
  /** The Pet's update of its remote server (`remote-update.ts`), on the settings screen and in the pet's bubble. */
  serverUpdate: {
    updating: (from: string | null, to: string) => from === null ? `서버 업데이트 중이에요. 새 버전: ${to}` : `서버 업데이트 중이에요: ${from} → ${to}`,
    failed: (message: string) => `서버 업데이트에 실패했어요. ${message}`,
    /** The status holding the update's outcome could not be read, so whether the update worked is unknown. */
    statusUnreadable: (cause: string) => withCause("서버 업데이트 결과를 읽지 못했어요.", cause),
    devBuild: (commit: string) => `서버는 개발 빌드(커밋 ${commit})`,
    /** The update finished but its lock folder could not be removed; the next update stops until it is deleted. */
    leftoverLock: (lock: string) => `서버 업데이트는 마쳤지만 업데이트 잠금 폴더 ${lock} 를 지우지 못했어요. 진행 중인 업데이트가 없다면 이 폴더를 지워야 다음 업데이트가 시작돼요.`,
    /** A cancel arrived after the new version had passed its start check. */
    cancelledAfterCheck: "취소 요청이 있었지만 새 서버 버전이 이미 시작 확인을 통과해서 업데이트를 끝까지 마쳤어요.",
  },
  adapterErrors: {
    ADAPTER_UNKNOWN: (name: string, known: string) => `알 수 없는 어댑터 이름 '${name}' 이에요. 쓸 수 있는 이름: ${known}`,
    ADAPTER_START_SCRIPT_INVALID: (name: string) => `${name} 어댑터의 package.json scripts.start 가 'bun run <어댑터 폴더 안 파일>' 형식이 아니에요.`,
    ADAPTER_SETTINGS_REQUIRED: (name: string) => `${name} 어댑터를 처음 설치할 때는 --settings <설정 파일> 이 필요해요. 아무것도 바꾸지 않았어요.`,
    ADAPTER_SETTINGS_MISSING: (path: string) => `설정 파일 ${path} 을 찾지 못했어요.`,
    ADAPTER_SETTINGS_NOT_FILE: (path: string) => `설정 파일 ${path} 이 일반 파일이 아니에요. 설정 내용이 든 파일을 지정해 주세요.`,
    ADAPTER_SERVER_ENV_MISSING: (key: string) => `서버 서비스 설정에 ${key} 값이 없어 어댑터 서비스를 만들지 못하고 멈췄어요.`,
    ADAPTER_NOT_INSTALLED: (name: string) => `${name} 어댑터는 이 서버에 설치되어 있지 않아요.`,
  },
  deployCli: {
    DEPLOY_PET_DATA_DIR_MISSING: "펫 데이터 폴더를 찾지 못했어요. LOCALAPPDATA 또는 BARA_PET_DATA_DIR 환경변수가 필요해요.",
    DEPLOY_NO_SETTINGS: (path: string) => `펫 설정 파일 ${path} 이 없어 멈췄어요. 펫에서 원격 설치를 먼저 해 주세요.`,
    DEPLOY_NOT_REMOTE: (mode: string) =>
      `펫 연결이 원격(펫이 설치한 서버)이 아니라 멈췄어요. 지금 연결 방식: ${mode}. ` +
      "deploy:a1 은 펫이 SSH 로 설치해 관리하는 서버(remote)에만 반영할 수 있어요. 이미 있는 서버에 붙은 연결(existing)이나 이 PC의 서버(local)에는 쓸 수 없어요.",
    DEPLOY_SETTINGS_UNREADABLE: (path: string, cause: string) => withCause(`펫 설정 파일 ${path} 을 읽지 못했어요.`, cause),
    DEPLOY_SETTINGS_BUSY: "펫이 설정을 저장하던 중이라 멈췄어요. 펫을 한 번 켰다가 다시 실행해 주세요.",
    DEPLOY_DIRTY_TREE: (count: number, shown: string) => `커밋하지 않은 변경이 ${count}개 있어 멈췄어요: ${shown}. 커밋하거나 되돌린 뒤 다시 실행해 주세요.`,
    DEPLOY_SERVER_NOT_READY: "서버 설치가 끝나지 않았어요. 펫에서 원격 설치를 마친 뒤 다시 실행해 주세요.",
    DEPLOY_BUN_VERSION: (expected: string, actual: string) => `deploy:a1 은 Bun ${expected} 로 실행해야 해요. 지금 Bun: ${actual}`,
    DEPLOY_ARGS_INVALID: (detail: string) => `명령 선택지가 올바르지 않아요: ${detail}`,
    adapterOnlyOptions: "--settings 와 --remove 는 --adapter <이름> 과 함께만 쓸 수 있어요",
    removeWithSettings: "--remove 와 --settings 는 함께 쓸 수 없어요",
    adapterRemoved: (name: string, dataDir: string) => `${name} 어댑터를 멈추고 등록을 지웠어요. 데이터 폴더는 남겨 두었어요: ${dataDir}`,
    /** After an adapter install, update or removal: the memory server reads adapters' dashboard manifests only at start. */
    adapterDashboardAfterRestart: (restartCommand: string) =>
      `대시보드의 어댑터 화면은 기억 서버를 다시 시작해야 바뀐 내용으로 보여요. 서버에서 이 명령을 실행해 주세요: ${restartCommand}`,
    /** The server's unit predates BARA_ADAPTERS_DIR, so its dashboard cannot find any adapter until the server is updated. */
    adapterServerNeedsUpdate: (variable: string) =>
      `주의: 이 서버의 서비스 파일에 ${variable} 가 없어 대시보드가 어댑터를 찾지 못해요. 먼저 서버를 업데이트해 주세요 (bun run deploy:a1).`,
    unexpected: (cause: string) => withCause("배포를 끝내지 못했어요.", cause),
    done: (component: string, version: string, release: string) => `${component} ${version} 배포를 마쳤어요. 실행 중인 버전 폴더: ${release}`,
    unchanged: (component: string, release: string) => `${component}: 같은 묶음이 이미 실행 중이라 바꾸지 않았어요. 버전 폴더: ${release}`,
    /** The replace finished but its lock folder could not be removed; a later replace stops until it is deleted. */
    leftoverLock: (lock: string) => `주의: 업데이트 잠금 폴더 ${lock} 를 지우지 못했어요. 진행 중인 업데이트가 없다면 이 폴더를 지워야 다음 배포가 시작돼요.`,
    /** A cancel arrived after the new version had passed its start check. */
    cancelledAfterCheck: "취소 요청이 있었지만 새 버전이 이미 시작 확인을 통과해서 업데이트를 끝까지 마쳤어요.",
    /** Ctrl+C (`scripts/deploy-a1.ts` `interruptGuard`): before the service is stopped, the deploy is cancelled. */
    cancelling: "취소하는 중이에요. 지금 단계가 끝나는 대로 실행 중인 서버는 바꾸지 않고 멈춰요.",
    DEPLOY_CANCELLED: "Ctrl+C 로 배포를 취소했어요. 실행 중인 서버는 바꾸지 않았어요.",
    /** Ctrl+C after the switch began: it is not stopped halfway. */
    finishingSwitch: "서버 전환이 이미 시작돼서 지금 멈추면 서버가 알 수 없는 상태로 남아요. 전환이나 되돌리기를 끝까지 마치는 중이니 기다려 주세요. Ctrl+C 를 다시 눌러도 기다려요.",
    /** The deploy finished after a Ctrl+C it could not act on (the switch, or an adapter removal); it still ends with a failure code. */
    interruptedButFinished: "Ctrl+C 를 받았지만 중간에 멈출 수 없는 단계여서 끝까지 마쳤어요. 위의 결과를 확인해 주세요. 중단 요청이 있었으므로 실패 코드로 끝내요.",
  },
  /** The remote install's "백업에서 시작" option (`remote-restore-pick.ts`). */
  remoteRestorePick: {
    option: "백업에서 시작",
    hint: "이 PC에 있는 백업으로 새 서버의 기억을 채워요. 기억이 이미 있는 서버에는 쓸 수 없어요. 검색 색인을 다시 계산해서 오래 걸릴 수 있어요.",
    loading: "백업 목록을 읽고 있어요.",
    empty: "고를 수 있는 백업이 없어요. 설정의 '백업 만들기'로 만든 백업이나 업데이트 전 백업이 여기에 보여요.",
    pickRequired: "되살릴 백업을 골라 주세요.",
  },
};
