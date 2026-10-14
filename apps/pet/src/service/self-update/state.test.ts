import { expect, test } from "bun:test";
import { applyOutcome, INITIAL_CHECK_STATE, publicStatus, type StatusProblems } from "./state.ts";
import type { CheckOutcome, NotifiedRead, ReleaseInfo } from "./types.ts";

const RELEASE: ReleaseInfo = { version: "0.1.9", tag: "v0.1.9", assetName: "Bara.Pet_0.1.9_x64-setup.exe",
  url: "https://github.com/mua-vtuber/Bara_System/releases/download/v0.1.9/Bara.Pet_0.1.9_x64-setup.exe", size: 1, sha256: "a".repeat(64) };
const available: CheckOutcome = { kind: "available", release: RELEASE };
const current: CheckOutcome = { kind: "current", latest: "0.1.8" };
const failed = (code = "SELF_UPDATE_HTTP"): CheckOutcome => ({ kind: "failed", code, message: `${code} 문장` });
const none: NotifiedRead = { kind: "read", version: null };
const notified = (version: string): NotifiedRead => ({ kind: "read", version });
const fine: StatusProblems = { logError: null, recordError: null };

test("before any check nothing is offered and nothing is announced", () => {
  expect(publicStatus(INITIAL_CHECK_STATE, none, fine)).toEqual({ check: "unknown", available: null, failure: null,
    failureNoticeId: null, announce: null, logError: null, recordError: null });
});

test("a failed check keeps the version found before, and a run of failures keeps one notice id", () => {
  const found = applyOutcome(INITIAL_CHECK_STATE, available);
  const first = applyOutcome(found, failed());
  expect(publicStatus(first, none, fine)).toMatchObject({ check: "failed", available: "0.1.9", failureNoticeId: 1,
    failure: { code: "SELF_UPDATE_HTTP", message: "SELF_UPDATE_HTTP 문장" } });
  const second = applyOutcome(first, failed("SELF_UPDATE_NETWORK"));
  expect(publicStatus(second, none, fine)).toMatchObject({ available: "0.1.9", failureNoticeId: 1, failure: { code: "SELF_UPDATE_NETWORK" } });
  const recovered = applyOutcome(second, available);
  expect(publicStatus(recovered, none, fine)).toMatchObject({ check: "available", failure: null, failureNoticeId: null });
  expect(publicStatus(applyOutcome(recovered, failed()), none, fine).failureNoticeId).toBe(2);
});

test("a failure before any success offers nothing; a later current check withdraws an earlier offer", () => {
  expect(publicStatus(applyOutcome(INITIAL_CHECK_STATE, failed()), none, fine)).toMatchObject({ check: "failed", available: null, failureNoticeId: 1 });
  expect(publicStatus(applyOutcome(applyOutcome(INITIAL_CHECK_STATE, available), current), none, fine))
    .toMatchObject({ check: "current", available: null, announce: null });
});

test("a version is announced until it is acknowledged, also through a failed check", () => {
  const found = applyOutcome(INITIAL_CHECK_STATE, available);
  expect(publicStatus(found, none, fine).announce).toBe("0.1.9");
  expect(publicStatus(found, notified("0.1.8"), fine).announce).toBe("0.1.9");
  expect(publicStatus(found, notified("0.1.9"), fine).announce).toBeNull();
  expect(publicStatus(applyOutcome(found, failed()), none, fine).announce).toBe("0.1.9");
  expect(publicStatus(found, none, { logError: "EACCES 문장", recordError: null }).logError).toBe("EACCES 문장");
});

test("an unreadable notice record is reported and announces nothing, while the update button stays", () => {
  const found = applyOutcome(INITIAL_CHECK_STATE, available);
  const status = publicStatus(found, { kind: "failed" }, { logError: null, recordError: "기록 파일 문장" });
  expect(status).toMatchObject({ available: "0.1.9", announce: null, recordError: "기록 파일 문장" });
});
