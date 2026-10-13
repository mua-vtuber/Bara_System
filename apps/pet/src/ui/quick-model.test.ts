import { expect, test } from "bun:test";
import { storageAccessFailed, storageAccessSucceeded, storageOutboxRead, type StorageNotices } from "./feedback-model.ts";
import { messages } from "./messages.ts";
import { loadQuickMode, quickSendState, type QuickSendInputs } from "./quick-model.ts";

// WP-PFIX-8: the send button's decision and the quick-mode lookup used to live inside the DOM code of
// `quick.ts`, where no test reached them. These tests drive the same primitives `quick.ts` calls
// (`storageAccessFailed`, `storageAccessSucceeded`, `storageOutboxRead`), in the order it calls them.

const ready: QuickSendInputs = { mode: "input", busy: false, hasText: true, notices: {}, activeSaves: 0, unresolved: false };
const failing = (notices: StorageNotices, access: Parameters<typeof storageAccessFailed>[1], cause = "저장소 오류"): StorageNotices =>
  storageAccessFailed(notices, access, cause).notices;

test("a ready input strip can send and carries the plain tooltip", () => {
  expect(quickSendState(ready)).toEqual({ disabled: false, title: messages.quick.send });
});

test("an empty field or a send under way holds the button in both modes", () => {
  for (const mode of ["input", "question"] as const) {
    expect(quickSendState({ ...ready, mode, hasText: false }).disabled).toBe(true);
    expect(quickSendState({ ...ready, mode, busy: true }).disabled).toBe(true);
  }
});

test("a failing draft-store access blocks sending an input and names the storage fault, until the access works again", () => {
  let notices = failing({}, "writeDraft");
  expect(quickSendState({ ...ready, notices })).toEqual({ disabled: true, title: messages.composer.storageFailure });
  notices = storageAccessSucceeded(notices, "writeDraft");
  expect(quickSendState({ ...ready, notices })).toEqual({ disabled: false, title: messages.quick.send });
});

test("the block lifts only when every failing access has worked again", () => {
  let notices = failing(failing({}, "readDraft", "읽기 오류"), "writeDraft", "쓰기 오류");
  notices = storageAccessSucceeded(notices, "readDraft");
  expect(quickSendState({ ...ready, notices }).disabled).toBe(true);
  notices = storageAccessSucceeded(notices, "writeDraft");
  expect(quickSendState({ ...ready, notices }).disabled).toBe(false);
});

test("a draft-store failure that happened and was recovered earlier does not hold the button for the rest of the session", () => {
  let notices: StorageNotices = {};
  for (const access of ["readDraft", "readSubmissions", "writeDraft", "finishSubmission"] as const) {
    notices = failing(notices, access);
    expect(quickSendState({ ...ready, notices }).disabled).toBe(true);
    notices = storageAccessSucceeded(notices, access);
    expect(quickSendState({ ...ready, notices }).disabled).toBe(false);
  }
});

test("a failed outbox read ends when the outbox reads again, and a failed finishSubmission when the outbox is empty", () => {
  let notices = failing(failing({}, "readSubmissions"), "finishSubmission");
  notices = storageOutboxRead(notices, 1);
  expect(quickSendState({ ...ready, notices, unresolved: true })).toEqual({ disabled: true, title: messages.composer.storageFailure });
  notices = storageOutboxRead(notices, 0);
  expect(quickSendState({ ...ready, notices, unresolved: false })).toEqual({ disabled: false, title: messages.quick.send });
});

test("a question is not held by the draft store, by saves under way or by an unresolved receipt", () => {
  const blocked = { ...ready, mode: "question" as const, notices: failing({}, "writeDraft"), activeSaves: 2, unresolved: true };
  expect(quickSendState(blocked).disabled).toBe(false);
  expect(quickSendState({ ...blocked, hasText: false }).disabled).toBe(true);
});

test("an input waits for the saves under way and for an earlier receipt, and says which", () => {
  expect(quickSendState({ ...ready, activeSaves: 1 }).disabled).toBe(true);
  expect(quickSendState({ ...ready, unresolved: true })).toEqual({ disabled: true, title: messages.quick.waitForReceipt });
});

test("the storage fault outranks the wait for a receipt in the tooltip", () => {
  expect(quickSendState({ ...ready, notices: failing({}, "readSubmissions"), unresolved: true }).title).toBe(messages.composer.storageFailure);
});

// The browser preview has no native window; a native window that cannot say which mode it was opened in
// keeps the default and reports why.
test("the browser preview never asks the native window which mode it was opened in", async () => {
  let asked = 0;
  const result = await loadQuickMode(false, async () => { asked++; return "question"; });
  expect(result).toEqual({ kind: "skipped" });
  expect(asked).toBe(0);
});

test("a native window's answer is the mode the strip opens in", async () => {
  expect(await loadQuickMode(true, async () => "question")).toEqual({ kind: "loaded", mode: "question" });
  expect(await loadQuickMode(true, async () => "input")).toEqual({ kind: "loaded", mode: "input" });
});

test("a native window that fails to answer is reported with its cause, not passed off as a normal start", async () => {
  const thrown = new Error("the quick window was closed before it answered");
  const failed = await loadQuickMode(true, async () => { throw thrown; });
  expect(failed).toEqual({ kind: "failed", text: messages.quick.modeLoadFailed(thrown.message) });
  expect(failed.kind === "failed" && failed.text).toContain(thrown.message);
});

test("a native rejection object keeps its own text in the report", async () => {
  const failed = await loadQuickMode(true, async () => { throw { code: "HOST_WINDOW_STATE", message: "창 상태를 읽을 수 없습니다." }; });
  expect(failed).toEqual({ kind: "failed", text: messages.quick.modeLoadFailed("창 상태를 읽을 수 없습니다.") });
});
