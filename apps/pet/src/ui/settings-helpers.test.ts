import { expect, test } from "bun:test";
import type { ConnectionStatus, UpdateStatus } from "../shared/contracts.ts";
import { messages } from "./messages.ts";
import { aiUrlForProvider, confirmConnection, connectionCredential, enrollmentConnected, leaveSetup, readServerUpdate, serverUpdateNotice, serverUpdateReadNotice,
  serverUpdateText, startupServerUpdateNotice, stopSetup, tunnelPortText, updateNoticeText,
  type SetupCancellers } from "./settings-helpers.ts";

test("choosing a compatible provider after saved no-AI settings supplies a usable default address", () => {
  expect(aiUrlForProvider("openai-compatible", "")).toBe("http://127.0.0.1:1234");
  expect(aiUrlForProvider("openai-compatible", "   ")).toBe("http://127.0.0.1:1234");
  expect(aiUrlForProvider("openai-compatible", "https://authored-ai.example.org")).toBe("https://authored-ai.example.org");
});
test("dashboard capability links are passed as owner credentials, never daily bearer", () => {
  expect(connectionCredential("http://127.0.0.1:3001/#bara-token=owner-value")).toEqual({ ownerToken: "http://127.0.0.1:3001/#bara-token=owner-value" });
  expect(connectionCredential(" daily-value ")).toEqual({ token: "daily-value" });
  expect(connectionCredential(" ")).toEqual({});
});
test("a URL without a capability is not silently treated as a bearer token", () => {
  expect(() => connectionCredential("https://memory.example/")).toThrow();
});

// WP-PFIX-2: an approved enrollment is reported as connected only after connection.test passes, so an
// outdated server that still approves shows its version message instead of "connected".
function connectionTest(answer: ConnectionStatus) {
  const calls: number[] = [];
  return { calls, test: async () => { calls.push(1); return answer; } };
}
const outdated: ConnectionStatus = { connected: false, message: "이 바라 서버는 펫 연동을 지원하지 않는 이전 버전입니다." };
test("an approved enrollment on a server that fails connection.test throws the test's message", async () => {
  const check = connectionTest(outdated);
  await expect(enrollmentConnected({ state: "approved", message: "승인되었습니다." }, check.test)).rejects.toThrow(outdated.message);
  expect(check.calls).toHaveLength(1);
});
test("an approved enrollment counts as connected only after connection.test passes", async () => {
  const check = connectionTest({ connected: true, message: messages.serverClient.connected });
  expect(await enrollmentConnected({ state: "approved", message: "승인되었습니다." }, check.test)).toBe(true);
  expect(check.calls).toHaveLength(1);
});
test("a pending or rejected enrollment is not finished and does not run connection.test", async () => {
  const check = connectionTest({ connected: true, message: messages.serverClient.connected });
  expect(await enrollmentConnected({ state: "pending", message: "승인을 기다리고 있어요." }, check.test)).toBe(false);
  expect(await enrollmentConnected({ state: "rejected", message: "거절되었습니다." }, check.test)).toBe(false);
  expect(check.calls).toHaveLength(0);
});
test("a manually entered token is confirmed by the same connection.test check", async () => {
  await expect(confirmConnection(connectionTest(outdated).test)).rejects.toThrow(outdated.message);
  await expect(confirmConnection(connectionTest({ connected: true, message: messages.serverClient.connected }).test)).resolves.toBeUndefined();
});

// WP-PFIX-3: a cancel that fails is shown, not swallowed, and leaving the screen ends the OpenSSH wait.
function cancellers(failure?: Error) {
  const calls: string[] = [];
  const cancel: SetupCancellers = {
    ssh: async () => { calls.push("ssh"); if (failure) throw failure; },
    operation: async requestId => { calls.push(`operation:${requestId}`); if (failure) throw failure; },
  };
  const reported: unknown[] = [];
  return { calls, cancel, reported, report: (error: unknown) => { reported.push(error); } };
}
test("the stop button cancels the OpenSSH wait while it runs, otherwise the running request", async () => {
  const waiting = cancellers();
  await stopSetup(true, "op-1", waiting.cancel, waiting.report);
  expect(waiting.calls).toEqual(["ssh"]);
  const requesting = cancellers();
  await stopSetup(false, "op-1", requesting.cancel, requesting.report);
  expect(requesting.calls).toEqual(["operation:op-1"]);
  const idle = cancellers();
  await stopSetup(false, "", idle.cancel, idle.report);
  expect(idle.calls).toEqual([]);
  expect([...waiting.reported, ...requesting.reported, ...idle.reported]).toEqual([]);
});
test("a cancel that fails reaches the screen with its cause", async () => {
  const failure = new Error("cancel failed");
  for (const [awaitingSsh, operation] of [[true, ""], [false, "op-2"]] as const) {
    const run = cancellers(failure);
    await stopSetup(awaitingSsh, operation, run.cancel, run.report);
    expect(run.reported).toEqual([failure]);
  }
  const leaving = cancellers(failure);
  await leaveSetup(true, leaving.cancel, leaving.report);
  expect(leaving.reported).toEqual([failure]);
});
test("leaving the settings screen cancels only an OpenSSH wait still in progress", async () => {
  const waiting = cancellers();
  await leaveSetup(true, waiting.cancel, waiting.report);
  expect(waiting.calls).toEqual(["ssh"]);
  const idle = cancellers();
  await leaveSetup(false, idle.cancel, idle.report);
  expect(idle.calls).toEqual([]);
});

test("the settings line names an update a previous start left unfinished, with its backup folder when there is one", () => {
  const path = "C:\\Users\\me\\AppData\\Local\\com.bara.pet\\memory\\backups\\pre-update\\0.1.0-to-0.2.0-20261007-090503";
  const update = { from: "0.1.0", to: "0.2.0", backupPath: path, failedStage: null, errorCode: null };
  const text = (value: UpdateStatus | null | undefined) => updateNoticeText(value, "local");
  expect(text(null)).toBeNull();
  expect(text(undefined)).toBeNull();
  for (const stage of ["backup", "backed-up", "complete"] as const) expect(text({ ...update, stage })).toBeNull();
  expect(text({ ...update, stage: "migrating" })).toBe(messages.updateNotice.interrupted("0.1.0", "0.2.0", path));
  expect(text({ ...update, stage: "failed", failedStage: "migrating", errorCode: "INSTALL_PORT_TAKEN" }))
    .toBe(messages.updateNotice.startFailed("0.1.0", "0.2.0", path));
  const backupFailed: UpdateStatus = { ...update, stage: "failed", backupPath: null, failedStage: "backup", errorCode: "UPDATE_BACKUP_FAILED" };
  expect(text(backupFailed)).toBe(messages.updateNotice.backupFailed("0.1.0", "0.2.0"));
  expect(text({ ...update, from: "unknown", stage: "migrating" })).toContain("바라 펫 업데이트 이전 버전 → 0.2.0");
  // Each line asks for a retry of this PC's server; on another connection (or before the settings arrived) none shows.
  for (const mode of ["remote", "existing", null] as const) {
    expect(updateNoticeText(backupFailed, mode)).toBeNull();
    expect(updateNoticeText({ ...update, stage: "migrating" }, mode)).toBeNull();
  }
  expect(messages.updateNotice.startFailed("0.1.0", "0.2.0", path)).toContain(`이 폴더에 백업해 두었어요: ${path} `);
});

test("the server line shows an update, its failure, or a dev build, and nothing for a Pet build", () => {
  const current = (origin: "pet" | "dev", commit: string | null) =>
    ({ state: "current" as const, installed: { appVersion: "0.2.0", origin, commit }, leftoverLock: null, cancelledAfterCheck: false });
  expect(serverUpdateText(null)).toBeNull();
  expect(serverUpdateText({ state: "updating", from: "0.1.0", to: "0.2.0" })).toEqual({ text: messages.serverUpdate.updating("0.1.0", "0.2.0"), error: false });
  expect(serverUpdateText({ state: "failed", from: "0.1.0", to: "0.2.0", code: "RELEASE_ROLLED_BACK", message: "원인", stopped: false }))
    .toEqual({ text: messages.serverUpdate.failed("원인"), error: true });
  expect(serverUpdateText(current("dev", "abc1234def".padEnd(40, "0")))).toEqual({ text: "서버는 개발 빌드(커밋 abc1234)", error: false });
  expect(serverUpdateText(current("pet", null))).toBeNull();
});

test("an update that finished but left its lock folder, or finished past a cancel, says so", () => {
  const done = { state: "current" as const, installed: { appVersion: "0.2.0", origin: "pet" as const, commit: null } };
  expect(serverUpdateText({ ...done, leftoverLock: "/srv/bara/.bara-release-lock", cancelledAfterCheck: false }))
    .toEqual({ text: messages.serverUpdate.leftoverLock("/srv/bara/.bara-release-lock"), error: true });
  expect(serverUpdateText({ ...done, leftoverLock: null, cancelledAfterCheck: true }))
    .toEqual({ text: messages.serverUpdate.cancelledAfterCheck, error: false });
});

test("after the install wizard connects, a failed server update or a leftover lock is told as an error, anything else is not", () => {
  const rolledBack = { state: "failed" as const, from: "0.1.0", to: "0.2.0", code: "RELEASE_ROLLED_BACK", message: "원인", stopped: false };
  expect(serverUpdateNotice(rolledBack)).toBe(messages.serverUpdate.failed("원인"));
  expect(serverUpdateNotice({ ...rolledBack, code: "RELEASE_BUSY" })).toBe(messages.serverUpdate.failed("원인"));
  const done = { state: "current" as const, installed: { appVersion: "0.2.0", origin: "pet" as const, commit: null }, cancelledAfterCheck: false };
  expect(serverUpdateNotice({ ...done, leftoverLock: "/srv/bara/.bara-release-lock" })).toBe(messages.serverUpdate.leftoverLock("/srv/bara/.bara-release-lock"));
  expect(serverUpdateNotice({ ...done, leftoverLock: null })).toBeNull();
  expect(serverUpdateNotice({ state: "updating", from: null, to: "0.2.0" })).toBeNull();
  expect(serverUpdateNotice(null)).toBeNull();
});

test("a server-update status that could not be read is told as an error with its cause, never as no news", async () => {
  const failedRead = await readServerUpdate(() => Promise.reject(new Error("연결 끊김")), (error) => (error as Error).message);
  expect(failedRead).toEqual({ ok: false, cause: "연결 끊김" });
  expect(serverUpdateReadNotice(failedRead)).toBe(messages.serverUpdate.statusUnreadable("연결 끊김"));
  expect(startupServerUpdateNotice(failedRead)).toBe(messages.serverUpdate.statusUnreadable("연결 끊김"));
  expect(messages.serverUpdate.statusUnreadable("연결 끊김")).toContain("서버 업데이트 결과를 읽지 못했어요");
});

test("a server-update status that was read keeps the existing notices", async () => {
  const rolledBack = { state: "failed" as const, from: "0.1.0", to: "0.2.0", code: "RELEASE_ROLLED_BACK", message: "원인", stopped: false };
  const read = await readServerUpdate(() => Promise.resolve({ serverUpdate: rolledBack }), String);
  expect(read).toEqual({ ok: true, update: rolledBack });
  expect(serverUpdateReadNotice(read)).toBe(messages.serverUpdate.failed("원인"));
  expect(startupServerUpdateNotice(read)).toBe(messages.serverUpdate.failed("원인"));
  const none = await readServerUpdate(() => Promise.resolve({}), String);
  expect(none).toEqual({ ok: true, update: null });
  expect(serverUpdateReadNotice(none)).toBeNull();
  expect(startupServerUpdateNotice(none)).toBeNull();
  // At startup a lock folder an update left behind is shown on the settings screen, not as a startup error (as before).
  const done = { state: "current" as const, installed: { appVersion: "0.2.0", origin: "pet" as const, commit: null }, cancelledAfterCheck: false,
    leftoverLock: "/srv/bara/.bara-release-lock" };
  expect(startupServerUpdateNotice({ ok: true, update: done })).toBeNull();
});

test("a remote tunnel off its preferred port is told with the reason, the ports and any holding process", () => {
  expect(tunnelPortText(null)).toBeNull();
  expect(tunnelPortText(undefined)).toBeNull();
  const inUse = tunnelPortText({ preferredPort: 3001, port: 59785, reason: "in-use", owners: [4242] });
  expect(inUse).toBe(messages.tunnelPort.inUse(3001, 59785, [4242]));
  expect(inUse).toContain("PID 4242");
  expect(inUse).toContain("59785");
  expect(tunnelPortText({ preferredPort: 3001, port: 59785, reason: "in-use", owners: [] })).not.toContain("PID");
  expect(tunnelPortText({ preferredPort: 3001, port: 59785, reason: "reserved", owners: [] }))
    .toBe(messages.tunnelPort.reserved(3001, 59785));
  expect(tunnelPortText({ preferredPort: 3001, port: 59785, reason: "bind-failed", owners: [] }))
    .toBe(messages.tunnelPort.bindFailed(3001, 59785));
});
