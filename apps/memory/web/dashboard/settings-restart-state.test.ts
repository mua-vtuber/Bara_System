import { expect, test } from "bun:test";
import {
  INITIAL_RESTART_STATE,
  reduceRestart,
  RESTART_GIVE_UP_MS,
  type RestartEvent,
  type RestartState,
} from "./settings-restart-state";

const run = (events: RestartEvent[], from: RestartState = INITIAL_RESTART_STATE): RestartState =>
  events.reduce(reduceRestart, from);

const supported: RestartEvent = { type: "info-loaded", supported: true, reason: null, busyReason: null, bootId: "old" };
const started = (at: number): RestartEvent[] => [supported, { type: "request" }, { type: "accepted", bootId: "old", now: at }];

test("loading -> idle when the server says it can restart", () => {
  expect(run([supported])).toEqual({ kind: "idle", bootId: "old", busyReason: null });
});

test("loading -> unsupported keeps the server's reason", () => {
  expect(run([{ type: "info-loaded", supported: false, reason: "systemd 없음", busyReason: null, bootId: "old" }]))
    .toEqual({ kind: "unsupported", reason: "systemd 없음" });
});

test("unsupported answer without a reason is a failure, not a silent disabled state", () => {
  const state = run([{ type: "info-loaded", supported: false, reason: null, busyReason: null, bootId: "old" }]);
  expect(state.kind).toBe("failed");
});

test("a failed support check is a failure with its cause, never 'supported'", () => {
  expect(run([{ type: "info-failed", problem: "HTTP 500" }]))
    .toEqual({ kind: "failed", reason: { type: "load", problem: "HTTP 500" } });
});

test("request needs idle, cancel returns to idle", () => {
  expect(run([{ type: "request" }]).kind).toBe("loading");
  expect(run([supported, { type: "request" }]).kind).toBe("confirming");
  expect(run([supported, { type: "request" }, { type: "cancel" }])).toEqual({ kind: "idle", bootId: "old", busyReason: null });
});

test("accepted starts the wait with the bootId the server reported", () => {
  expect(run(started(1000))).toEqual({ kind: "restarting", oldBootId: "old", startedAt: 1000, lastProblem: null });
});

test("a refused request fails with its cause", () => {
  expect(run([supported, { type: "request" }, { type: "request-failed", problem: "HTTP 409" }]))
    .toEqual({ kind: "failed", reason: { type: "request", problem: "HTTP 409" } });
});

test("network errors while the server is down do not end the wait", () => {
  const state = run([...started(0), { type: "poll", result: { kind: "unreachable", problem: "fetch failed" }, now: 2000 },
    { type: "poll", result: { kind: "unreachable", problem: "fetch failed" }, now: 4000 }]);
  expect(state).toMatchObject({ kind: "restarting", lastProblem: "fetch failed" });
});

test("the old process answering with the same bootId does not count as restarted", () => {
  const state = run([...started(0), { type: "poll", result: { kind: "answer", bootId: "old" }, now: 2000 }]);
  expect(state.kind).toBe("restarting");
});

test("a different bootId means the server restarted", () => {
  const state = run([...started(0), { type: "poll", result: { kind: "answer", bootId: "new" }, now: 6000 }]);
  expect(state).toEqual({ kind: "reconnected", bootId: "new" });
});

test("a different bootId arriving exactly at the limit still counts as success", () => {
  const state = run([...started(0), { type: "poll", result: { kind: "answer", bootId: "new" }, now: RESTART_GIVE_UP_MS }]);
  expect(state.kind).toBe("reconnected");
});

test("no new process by the limit fails with the old bootId and the last problem", () => {
  const before = run([...started(0), { type: "poll", result: { kind: "unreachable", problem: "x" }, now: RESTART_GIVE_UP_MS - 1 }]);
  expect(before.kind).toBe("restarting");
  const after = run([...started(0), { type: "poll", result: { kind: "unreachable", problem: "connection refused" }, now: RESTART_GIVE_UP_MS }]);
  expect(after).toEqual({ kind: "failed", reason: { type: "timeout", oldBootId: "old", lastProblem: "connection refused" } });
});

test("still the old process at the limit also fails", () => {
  const after = run([...started(0), { type: "poll", result: { kind: "answer", bootId: "old" }, now: RESTART_GIVE_UP_MS }]);
  expect(after.kind).toBe("failed");
});

test("version arrives after reconnect -> done with it; a failed version lookup is reported, not hidden", () => {
  const reconnected = run([...started(0), { type: "poll", result: { kind: "answer", bootId: "new" }, now: 4000 }]);
  expect(run([{ type: "version-loaded", version: "0.1.3" }], reconnected))
    .toEqual({ kind: "done", bootId: "new", version: "0.1.3", versionProblem: null });
  expect(run([{ type: "version-failed", problem: "HTTP 502" }], reconnected))
    .toEqual({ kind: "done", bootId: "new", version: null, versionProblem: "HTTP 502" });
});

test("late events do not overturn a finished result", () => {
  const done = run([...started(0), { type: "poll", result: { kind: "answer", bootId: "new" }, now: 4000 }, { type: "version-loaded", version: "0.1.3" }]);
  expect(run([{ type: "poll", result: { kind: "unreachable", problem: "late" }, now: 999999 }], done)).toBe(done);
  const failed = run([{ type: "info-failed", problem: "x" }]);
  expect(run([{ type: "request" }], failed)).toBe(failed);
});

test("a busy reason rides along: idle and confirming keep it, cancel restores it", () => {
  const busy: RestartEvent = { type: "info-loaded", supported: true, reason: null, busyReason: "작업 중", bootId: "old" };
  expect(run([busy])).toEqual({ kind: "idle", bootId: "old", busyReason: "작업 중" });
  expect(run([busy, { type: "request" }, { type: "cancel" }])).toEqual({ kind: "idle", bootId: "old", busyReason: "작업 중" });
});
