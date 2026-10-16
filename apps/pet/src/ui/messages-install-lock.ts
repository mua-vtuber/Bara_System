import { causeOrEmpty } from "./messages-service-core.ts";

/** Stages an install reports (`src/service/install/*`): this PC's install, then a remote server's. */
export type InstallProgressStage = "prepare" | "models" | "server" | "host-key" | "preflight" | "transfer" | "dependencies" | "service" | "server-update";

/** The pet's lasting install notice, also the start of its longer forms. */
const INSTALLING = "설치 중";
/** The model download stage's short name, alone and with its file count. */
const MODELS = "모델 받는 중";

/** Texts of the install lock: while "이 PC에 준비하기" or a remote install runs, the pet says "설치 중", and what cannot
 * work before the install is done is refused with these sentences (`INSTALL_RUNNING`). `messages.ts` re-exports the
 * section, so callers read `messages.installLock.<key>`. */
export const installLockMessages = {
  installLock: {
    /** The service's refusal of a request that needs the finished install (`INSTALL_RUNNING`), by method. */
    refused: {
      "dashboard.link": "설치가 끝나면 대시보드를 열 수 있어요.",
      "assistant.ask": "설치가 끝나면 물어볼 수 있어요. 설치가 끝난 뒤 다시 물어봐 주세요.",
    },
    /** A save refused while installing; the input stays in the box (`quick.ts` keeps a rejected input). */
    saveRefused: "설치가 끝나면 저장할 수 있어요. 입력한 내용은 입력창에 그대로 남아 있어요. 설치가 끝난 뒤 다시 보내 주세요.",
    /** The pet's lasting notice; `petStage` adds what the install does now. */
    petInstalling: INSTALLING,
    petStage: (stage: string) => `${INSTALLING} · ${stage}`,
    /** Short stage names for the pet's notice line, which has room for one short line. */
    petStages: {
      prepare: "준비", models: MODELS, server: "서버 시작", "host-key": "서버 확인", preflight: "서버 환경 확인",
      transfer: "파일 보내는 중", dependencies: "필요한 프로그램 설치", service: "서비스 시작", "server-update": "서버 업데이트",
    } satisfies Record<InstallProgressStage, string> as Readonly<Record<InstallProgressStage, string>>,
    /** The model download: file `part` of `parts`, and how much of that file arrived when its size is known. */
    petModels: (part: number, parts: number, percent: number | null) =>
      `${INSTALLING} · ${MODELS} ${part}/${parts}${percent === null ? "" : ` · ${percent}%`}`,
    /** The pet's click while installing: the input strip does not open. */
    petClickRefused: "설치가 끝나면 쓸 수 있어요.",
    /** The pet could not ask whether an install runs; it keeps what it last knew. */
    statusFailed: (cause: string) => `설치 진행 상태를 읽지 못했어요. 원인: ${causeOrEmpty(cause)}`,
    /** The service's `status` answer had no install flag (the screen and the service do not match). */
    statusFieldMissing: "상태 응답에 설치 여부(installing)가 없어요. 바라 펫을 다시 설치해 주세요.",
    /** The main window keeps the running install's screen instead of switching to another view. */
    viewKept: (stopButton: string) => `설치가 끝날 때까지 이 화면을 그대로 둬요. 진행 상황과 '${stopButton}' 버튼이 여기 있어요.`,
    /** The main window's input and question buttons while installing. */
    quickRefused: "설치가 끝나면 입력하고 물어볼 수 있어요.",
  },
};

