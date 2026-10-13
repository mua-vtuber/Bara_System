/**
 * dashboard/settings-restart-section.ts — 연결·진단 화면의 "기억 서버 재시작" 절
 *
 * 설정 대부분은 서버를 다시 켜야 적용된다. 이 절의 버튼이 그 재시작을 맡는다.
 * 어떤 상태로 넘어가는지는 settings-restart-state.ts(순수 reducer)가 정하고, 이 파일은
 * 서버에 묻고(GET/POST /server/restart, GET /health) 결과를 이벤트로 넣은 뒤 상태를 화면에 그린다.
 *
 * 주입형 설계 — deps 의 default 가 apiFetch 실구현을 감싼다. 테스트는 함수에 데이터를 주입한다
 * (인터페이스 Mock 클래스가 아니다).
 */

import { apiFetch } from "./api-fetch";
import { RESTART_LABELS } from "./settings-restart-labels";
import {
  INITIAL_RESTART_STATE,
  reduceRestart,
  RESTART_GIVE_UP_MS,
  RESTART_POLL_INTERVAL_MS,
  RESTART_POLL_REQUEST_TIMEOUT_MS,
  type RestartEvent,
  type RestartState,
} from "./settings-restart-state";

/** GET /server/restart 응답 계약 (src/server-internal/routes/server-restart.ts). */
export interface RestartInfo {
  supported: boolean;
  reason: string | null;
  /** 정리·추출 같은 백그라운드 쓰기 작업이 도는 중이면 true (이때 POST 는 409). */
  busy: boolean;
  busyReason: string | null;
  bootId: string;
}

export interface RestartSectionDeps {
  /** GET /server/restart. 실패 시 원인을 담아 throw. signal 은 대기 중 확인 요청의 제한 시간. */
  fetchInfo: (signal?: AbortSignal) => Promise<RestartInfo>;
  /** POST /server/restart (202 면 성공). 실패 시 원인을 담아 throw. */
  postRestart: () => Promise<{ bootId: string }>;
  /** GET /health 의 version. 실패 시 원인을 담아 throw. */
  fetchVersion: () => Promise<string>;
  /** 확인창. 운영은 window.confirm. */
  confirm: (message: string) => boolean;
  now: () => number;
  /** 재시작 대기 중 다시 묻는 간격(ms). */
  pollIntervalMs: number;
}

async function failureText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : RESTART_LABELS.infoRequestFailed(res.status);
}

function isRestartInfo(value: unknown): value is RestartInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as Record<string, unknown>;
  return typeof info.supported === "boolean" && typeof info.bootId === "string" && info.bootId.length > 0
    && typeof info.busy === "boolean"
    && (info.reason === null || typeof info.reason === "string")
    && (info.busyReason === null || typeof info.busyReason === "string");
}

const defaultDeps: RestartSectionDeps = {
  fetchInfo: async (signal) => {
    const res = await apiFetch("/server/restart", signal ? { signal } : {});
    if (!res.ok) throw new Error(await failureText(res));
    const body: unknown = await res.json();
    if (!isRestartInfo(body)) throw new Error(RESTART_LABELS.invalidInfoResponse);
    return body;
  },
  postRestart: async () => {
    const res = await apiFetch("/server/restart", { method: "POST" });
    if (res.status !== 202) throw new Error(await failureText(res));
    const body = (await res.json()) as { bootId?: unknown };
    if (typeof body.bootId !== "string" || body.bootId.length === 0) throw new Error(RESTART_LABELS.missingBootId);
    return { bootId: body.bootId };
  },
  fetchVersion: async () => {
    const res = await apiFetch("/health");
    if (!res.ok) throw new Error(RESTART_LABELS.versionRequestFailed(res.status));
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.length === 0) throw new Error(RESTART_LABELS.missingVersion);
    return body.version;
  },
  confirm: (message) => window.confirm(message),
  now: () => Date.now(),
  pollIntervalMs: RESTART_POLL_INTERVAL_MS,
};

/** 멈춘 요청이 제한 시간에 끊긴 경우(TimeoutError)는 브라우저의 영문 문구 대신 우리 문구로 바꾼다. */
function pollErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return RESTART_LABELS.pollTimedOut(RESTART_POLL_REQUEST_TIMEOUT_MS / 1000);
  }
  return errorText(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderRestartSection(overrides: Partial<RestartSectionDeps> = {}): HTMLElement {
  const deps: RestartSectionDeps = { ...defaultDeps, ...overrides };
  const root = document.createElement("section");
  root.className = "memory-info-note server-restart-section";

  const title = document.createElement("h3");
  title.textContent = RESTART_LABELS.title;
  const desc = document.createElement("p");
  desc.className = "document-processing-meta";
  desc.textContent = RESTART_LABELS.desc;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "server-restart-button document-processing-submit";
  button.textContent = RESTART_LABELS.button;
  const status = document.createElement("p");
  status.className = "document-processing-status server-restart-status";
  status.setAttribute("role", "status");
  root.append(title, desc, button, status);

  // 선언 형식을 넓혀 둔다: 초기값으로 좁혀지면 TS 가 비동기 콜백 안의 상태 비교를 never 로 본다.
  let state = INITIAL_RESTART_STATE as RestartState;

  function render(): void {
    button.disabled = state.kind !== "idle";
    status.classList.toggle("error", state.kind === "failed");
    status.textContent = statusText(state);
  }

  function dispatch(event: RestartEvent): RestartState {
    state = reduceRestart(state, event);
    render();
    return state;
  }

  async function loadInfo(): Promise<void> {
    try {
      const info = await deps.fetchInfo();
      dispatch({ type: "info-loaded", supported: info.supported, reason: info.reason, busyReason: info.busy ? info.busyReason : null, bootId: info.bootId });
    } catch (error) {
      dispatch({ type: "info-failed", problem: errorText(error) });
    }
  }

  async function loadVersion(): Promise<void> {
    try {
      dispatch({ type: "version-loaded", version: await deps.fetchVersion() });
    } catch (error) {
      dispatch({ type: "version-failed", problem: errorText(error) });
    }
  }

  async function pollOnce(): Promise<void> {
    if (state.kind !== "restarting") return;
    let after: RestartState;
    try {
      const info = await deps.fetchInfo(AbortSignal.timeout(RESTART_POLL_REQUEST_TIMEOUT_MS));
      after = dispatch({ type: "poll", result: { kind: "answer", bootId: info.bootId }, now: deps.now() });
    } catch (error) {
      // 서버가 꺼져 있는 동안의 연결 실패는 정상이다 — reducer 가 제한 시간 전까지는 기다림을 이어 간다.
      after = dispatch({ type: "poll", result: { kind: "unreachable", problem: pollErrorText(error) }, now: deps.now() });
    }
    if (after.kind === "restarting") setTimeout(() => void pollOnce(), deps.pollIntervalMs);
    else if (after.kind === "reconnected") void loadVersion();
  }

  async function startRestart(): Promise<void> {
    try {
      const accepted = await deps.postRestart();
      dispatch({ type: "accepted", bootId: accepted.bootId, now: deps.now() });
    } catch (error) {
      dispatch({ type: "request-failed", problem: errorText(error) });
      return;
    }
    setTimeout(() => void pollOnce(), deps.pollIntervalMs);
  }

  button.addEventListener("click", () => {
    dispatch({ type: "request" });
    if (state.kind !== "confirming") return;
    if (!deps.confirm(RESTART_LABELS.confirm)) {
      dispatch({ type: "cancel" });
      return;
    }
    void startRestart();
  });

  render();
  void loadInfo();
  return root;
}

function statusText(state: RestartState): string {
  switch (state.kind) {
    case "loading": return RESTART_LABELS.loading;
    case "unsupported": return state.reason;
    case "idle": return state.busyReason ?? "";
    case "confirming": return state.busyReason ?? "";
    case "restarting": return RESTART_LABELS.restarting;
    case "reconnected": return RESTART_LABELS.restarting;
    case "done":
      if (state.version !== null) return RESTART_LABELS.doneVersion(state.version);
      return state.versionProblem !== null ? RESTART_LABELS.doneVersionProblem(state.versionProblem) : RESTART_LABELS.done;
    case "failed":
      switch (state.reason.type) {
        case "load": return RESTART_LABELS.loadFailed(state.reason.problem);
        case "request": return RESTART_LABELS.requestFailed(state.reason.problem);
        case "timeout": return RESTART_LABELS.timeout(RESTART_GIVE_UP_MS / 1000, state.reason.lastProblem);
      }
  }
}
