/**
 * dashboard/settings-restart-state.ts — "기억 서버 재시작" 버튼의 상태 전이 (순수 함수)
 *
 * 화면 배선(settings-restart-section.ts)은 서버에 묻고 결과를 이벤트로 이 reducer 에 넣을 뿐,
 * 어떤 상태로 넘어갈지·언제 포기할지는 여기서만 정한다. DOM·네트워크·시계를 모르는 순수 모듈이라
 * 시각(now)도 이벤트로 받는다.
 *
 * 상태: loading(서버에 지원 여부를 묻는 중) / unsupported(서버가 재시작 불가라고 답함) /
 *       idle(누를 수 있음) / confirming(확인창) / restarting(다시 켜지길 기다림) /
 *       reconnected(다른 bootId 로 응답함 — 버전 확인 중) / done / failed.
 */

import { RESTART_LABELS } from "./settings-restart-labels";

/** 재시작 대기 중 서버에 다시 묻는 간격(ms). */
export const RESTART_POLL_INTERVAL_MS = 2_000;

/** 이 시간 안에 새 프로세스가 응답하지 않으면 실패로 본다(ms). */
export const RESTART_GIVE_UP_MS = 120_000;

/** 재시작 대기 중 한 번의 확인 요청이 기다리는 최대 시간(ms). 멈춘 요청 하나가 제한 시간 판정을 막지 않게 한다. */
export const RESTART_POLL_REQUEST_TIMEOUT_MS = 5_000;

export type RestartState =
  | { kind: "loading" }
  | { kind: "unsupported"; reason: string }
  | { kind: "idle"; bootId: string; busyReason: string | null }
  | { kind: "confirming"; bootId: string; busyReason: string | null }
  | { kind: "restarting"; oldBootId: string; startedAt: number; lastProblem: string | null }
  | { kind: "reconnected"; bootId: string }
  | { kind: "done"; bootId: string; version: string | null; versionProblem: string | null }
  | { kind: "failed"; reason: RestartFailure };

/** 실패 원인 — 문구는 화면 쪽 라벨이 만든다. */
export type RestartFailure =
  | { type: "load"; problem: string }
  | { type: "request"; problem: string }
  | { type: "timeout"; oldBootId: string; lastProblem: string | null };

/** 대기 중 한 번 물어본 결과. unreachable 은 서버가 꺼져 있는 동안 정상으로 일어나는 일이다. */
export type PollResult =
  | { kind: "answer"; bootId: string }
  | { kind: "unreachable"; problem: string };

export type RestartEvent =
  | { type: "info-loaded"; supported: boolean; reason: string | null; busyReason: string | null; bootId: string }
  | { type: "info-failed"; problem: string }
  | { type: "request" }
  | { type: "cancel" }
  | { type: "accepted"; bootId: string; now: number }
  | { type: "request-failed"; problem: string }
  | { type: "poll"; result: PollResult; now: number }
  | { type: "version-loaded"; version: string }
  | { type: "version-failed"; problem: string };

export const INITIAL_RESTART_STATE: RestartState = { kind: "loading" };

/**
 * 허용되지 않은 (상태, 이벤트) 조합은 상태를 그대로 둔다 — 예: 이미 done 인데 늦게 도착한 poll.
 * 한 번 정해진 결과가 뒤늦은 응답으로 뒤집히지 않게 하려는 것이다.
 */
export function reduceRestart(state: RestartState, event: RestartEvent): RestartState {
  switch (event.type) {
    case "info-loaded":
      if (state.kind !== "loading") return state;
      if (!event.supported) {
        // 지원 안 함인데 이유가 없는 응답은 서버 계약 위반이다 — 빈 이유로 얼버무리지 않는다.
        if (event.reason === null || event.reason.length === 0) {
          return { kind: "failed", reason: { type: "load", problem: RESTART_LABELS.unsupportedWithoutReason } };
        }
        return { kind: "unsupported", reason: event.reason };
      }
      return { kind: "idle", bootId: event.bootId, busyReason: event.busyReason };
    case "info-failed":
      if (state.kind !== "loading") return state;
      return { kind: "failed", reason: { type: "load", problem: event.problem } };
    case "request":
      return state.kind === "idle" ? { kind: "confirming", bootId: state.bootId, busyReason: state.busyReason } : state;
    case "cancel":
      return state.kind === "confirming" ? { kind: "idle", bootId: state.bootId, busyReason: state.busyReason } : state;
    case "accepted":
      if (state.kind !== "confirming") return state;
      return { kind: "restarting", oldBootId: event.bootId, startedAt: event.now, lastProblem: null };
    case "request-failed":
      if (state.kind !== "confirming") return state;
      return { kind: "failed", reason: { type: "request", problem: event.problem } };
    case "poll":
      return reducePoll(state, event.result, event.now);
    case "version-loaded":
      if (state.kind !== "reconnected") return state;
      return { kind: "done", bootId: state.bootId, version: event.version, versionProblem: null };
    case "version-failed":
      if (state.kind !== "reconnected") return state;
      return { kind: "done", bootId: state.bootId, version: null, versionProblem: event.problem };
  }
}

function reducePoll(state: RestartState, result: PollResult, now: number): RestartState {
  if (state.kind !== "restarting") return state;
  // 다른 bootId 로 응답했으면 새 프로세스다 — 제한 시간을 막 넘겼더라도 도착한 성공은 성공으로 본다.
  if (result.kind === "answer" && result.bootId !== state.oldBootId) {
    return { kind: "reconnected", bootId: result.bootId };
  }
  const lastProblem = result.kind === "unreachable"
    ? result.problem
    : RESTART_LABELS.stillOldProcess;
  if (now - state.startedAt >= RESTART_GIVE_UP_MS) {
    return { kind: "failed", reason: { type: "timeout", oldBootId: state.oldBootId, lastProblem } };
  }
  // 서버가 내려가 있는 동안의 연결 실패·이전 프로세스의 응답은 정상 경과다 — 기다림을 이어 간다.
  return { ...state, lastProblem };
}
