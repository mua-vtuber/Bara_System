import { expect, test } from "bun:test";
import { ANSWER_OUTCOMES, INSTALL_RUNNING_CODE, PROGRESS_STAGES } from "../shared/contracts.ts";
import nativeHost from "../shared/native-host.json";
import { errorText, hostErrorCode, isHostErrorPayload, isInstallRunning } from "./error-text.ts";
import { messages } from "./messages.ts";

test("every native host error code has a Korean text and no text is left without a code", () => {
  const codes = nativeHost.contract.hostErrorCodes;
  expect(new Set(codes).size).toBe(codes.length);
  expect(Object.keys(messages.hostErrors).sort()).toEqual([...codes].sort());
  for (const code of codes) expect(messages.hostErrors[code]).toMatch(/[가-힣]/);
});

test("the progress stage contract, the shared type and the screen's own text all agree", () => {
  const jsonStages = nativeHost.contract.progressStages;
  expect(new Set(jsonStages).size).toBe(jsonStages.length);
  expect([...jsonStages].sort()).toEqual([...PROGRESS_STAGES].sort());
  expect(Object.keys(messages.progress).sort()).toEqual([...PROGRESS_STAGES].sort());
  for (const stage of PROGRESS_STAGES) expect(messages.progress[stage]).toMatch(/[가-힣]/);
});

test("the answer outcome contract the host checks and the shared type list the same values", () => {
  const jsonOutcomes = nativeHost.contract.answerOutcomes;
  expect(jsonOutcomes.length).toBeGreaterThan(0);
  expect(new Set(jsonOutcomes).size).toBe(jsonOutcomes.length);
  expect([...jsonOutcomes].sort()).toEqual([...ANSWER_OUTCOMES].sort());
});

test("a host error shows its Korean text, with the OS error number when the host sent one", () => {
  expect(errorText({ code: "HOST_SERVICE_MISSING" })).toBe(messages.hostErrors.HOST_SERVICE_MISSING);
  expect(errorText({ code: "HOST_DATA_DIR_FAILED", status: 5 }))
    .toBe(messages.errors.withStatus(messages.hostErrors.HOST_DATA_DIR_FAILED, 5));
  expect(errorText({ code: "HOST_DATA_DIR_FAILED", status: 5 })).toContain("5");
});

test("a service error shows only the service's public text, without a code prefix", () => {
  expect(errorText({ code: "INVALID_INPUT", message: "검색어를 확인해 주세요." })).toBe("검색어를 확인해 주세요.");
  // Codes the screen treats specially keep showing the service's own text.
  expect(errorText({ code: "SERVER_UPGRADE_REQUIRED", message: messages.connectionErrors.SERVER_UPGRADE_REQUIRED }))
    .toBe(messages.connectionErrors.SERVER_UPGRADE_REQUIRED);
  const missing = messages.connectionErrors.CAPABILITY_MISSING("memory-deeplink");
  expect(errorText({ code: "CAPABILITY_MISSING", message: missing })).toBe(missing);
  expect(errorText({ code: "EDIT_CONFLICT", message: messages.memory.editConflict })).toBe(messages.memory.editConflict);
});

test("a code without any text is shown with the code, so the cause is not hidden", () => {
  expect(errorText({ code: "EDIT_CONFLICT" })).toBe(messages.errors.withCode("EDIT_CONFLICT"));
  expect(errorText({ code: "EDIT_CONFLICT", message: "" })).toBe(messages.errors.withCode("EDIT_CONFLICT"));
  expect(errorText({ code: "SOME_NEW_CODE", status: 3 }))
    .toBe(messages.errors.withStatus(messages.errors.withCode("SOME_NEW_CODE"), 3));
});

test("a raw native string is never shown as it is", () => {
  const raw = "Command request not allowed by ACL: C:\\Users\\someone\\AppData";
  expect(errorText(raw)).toBe(messages.errors.unexpectedNative);
  expect(errorText(raw)).not.toContain("ACL");
  expect(errorText("EDIT_CONFLICT: 다른 곳에서 먼저 수정되었습니다.")).toBe(messages.errors.unexpectedNative);
  for (const value of [undefined, null, 42, {}, { code: 7 }, { code: "" }, { code: "X", status: "5" }, { code: "X", message: 1 }]) {
    expect(errorText(value)).toBe(messages.errors.unexpectedNative);
  }
});

test("an Error made by screen code shows its message", () => {
  expect(errorText(new Error(messages.errors.desktopOnly))).toBe(messages.errors.desktopOnly);
});

test("only a well-formed host error object counts as one", () => {
  expect(isHostErrorPayload({ code: "HOST_TASK_FAILED" })).toBe(true);
  expect(isHostErrorPayload({ code: "HOST_JOB_FAILED", status: 5 })).toBe(true);
  expect(isHostErrorPayload({ code: "X", status: 1.5 })).toBe(false);
  expect(isHostErrorPayload(Object.assign(new Error("x"), { code: "X" }))).toBe(false);
  expect(hostErrorCode({ code: "EDIT_CONFLICT", message: "x" })).toBe("EDIT_CONFLICT");
  expect(hostErrorCode("EDIT_CONFLICT: x")).toBeUndefined();
});

test("only the install refusal counts as an install still running", () => {
  expect(isInstallRunning({ code: INSTALL_RUNNING_CODE, message: "x" })).toBe(true);
  expect(isInstallRunning({ code: "EDIT_CONFLICT" })).toBe(false);
  expect(isInstallRunning(new Error(INSTALL_RUNNING_CODE))).toBe(false);
});
