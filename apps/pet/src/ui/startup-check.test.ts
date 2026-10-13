import { expect, test } from "bun:test";
import { messages } from "./messages.ts";
import { checkStartup, observeStartupCheck } from "./startup-check.ts";
import { startupFailureFeedback } from "./startup-failure.ts";

// WP-PFIX-8: the startup check's branches used to be written inside `main.ts`, where no test reached them,
// so a change that reported a settings-read failure as "could not connect to the server" (the state before
// WP-PFIX-6) failed no test. Each branch below runs the real `checkStartup` with real functions that resolve
// or reject the way the native bridge does.

const connectedAnswer = { connected: true, message: "연결되었습니다." };
const unreachable = async (): Promise<never> => { throw new Error("connection.test must not run here"); };

test("a saved token and a reachable server end as connected, with the server's own message", async () => {
  expect(await checkStartup(async () => ({ hasToken: true }), async () => connectedAnswer))
    .toEqual({ kind: "connected", message: connectedAnswer.message });
});

test("a first run, with no token saved, checks no connection", async () => {
  let asked = 0;
  const check = await checkStartup(async () => ({ hasToken: false }), async () => { asked++; return connectedAnswer; });
  expect(check).toEqual({ kind: "firstRun" });
  expect(asked).toBe(0);
});

test("a settings read that fails is a settings failure, and no connection is checked", async () => {
  const check = await checkStartup(async () => { throw new Error("설정 파일을 읽을 수 없습니다."); }, unreachable);
  expect(check).toEqual({ kind: "failed", stage: "settings", reason: "설정 파일을 읽을 수 없습니다.",
    text: messages.feedback.startupSettingsFailed("설정 파일을 읽을 수 없습니다.") });
});

test("a connection check the server answers as not connected is a connection failure carrying the server's message", async () => {
  const answer = { connected: false, message: messages.serverClient.networkFailed };
  expect(await checkStartup(async () => ({ hasToken: true }), async () => answer))
    .toEqual({ kind: "failed", stage: "connection", reason: answer.message, text: answer.message });
});

test("a connection check that throws is a connection failure, not a settings failure", async () => {
  const check = await checkStartup(async () => ({ hasToken: true }), async () => { throw { code: "HOST_SERVICE_STOPPED" }; });
  const reason = messages.hostErrors.HOST_SERVICE_STOPPED;
  expect(check).toEqual({ kind: "failed", stage: "connection", reason, text: reason });
});

test("each failure becomes the bubble text of its own step", async () => {
  const settings = await checkStartup(async () => { throw new Error("읽기 실패"); }, unreachable);
  const connection = await checkStartup(async () => ({ hasToken: true }), async () => { throw new Error("닿지 않음"); });
  if (settings.kind !== "failed" || connection.kind !== "failed") throw new Error("both checks must fail");
  expect(startupFailureFeedback("a", settings.stage, settings.reason).detail).toBe(messages.feedback.startupSettingsFailed("읽기 실패"));
  expect(startupFailureFeedback("b", connection.stage, connection.reason).detail).toBe(messages.feedback.startupConnectionFailed("닿지 않음"));
  expect(startupFailureFeedback("a", settings.stage, settings.reason).detail).not.toBe(messages.feedback.startupConnectionFailed("읽기 실패"));
});

// Plan 1C②: the native host starts the check; the main window only joins it (`startup.check`).

test("the window takes the outcome of the check the host started, without the host's bubble", async () => {
  const feedback = startupFailureFeedback("host-made", "connection", "닿지 않음");
  const failed = { kind: "failed" as const, stage: "connection" as const, reason: "닿지 않음", text: "닿지 않음", feedback };
  expect(await observeStartupCheck(async () => failed)).toEqual({ kind: "failed", stage: "connection", reason: "닿지 않음", text: "닿지 않음" });
  expect(await observeStartupCheck(async () => ({ kind: "connected", message: "연결되었습니다." })))
    .toEqual({ kind: "connected", message: "연결되었습니다." });
  expect(await observeStartupCheck(async () => ({ kind: "firstRun" }))).toEqual({ kind: "firstRun" });
});

test("a join the host cannot carry (no service, quitting) is a connection failure with that cause", async () => {
  const reason = messages.hostErrors.HOST_SERVICE_START_FAILED;
  expect(await observeStartupCheck(async () => { throw { code: "HOST_SERVICE_START_FAILED" }; }))
    .toEqual({ kind: "failed", stage: "connection", reason, text: reason });
  expect(await observeStartupCheck(async () => { throw { code: "SHUTTING_DOWN", message: messages.rpc.shuttingDown }; }))
    .toEqual({ kind: "failed", stage: "connection", reason: messages.rpc.shuttingDown, text: messages.rpc.shuttingDown });
});

test("the host's notice for a check it could not follow has its own text", () => {
  expect(messages.hostErrors.HOST_STARTUP_CHECK_FAILED).toContain("바라 서버 연결을 확인하지 못했어요");
});
