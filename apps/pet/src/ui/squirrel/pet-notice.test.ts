import { expect, test } from "bun:test";
import { messages } from "../messages.ts";
import { NoticeState, noticeLook } from "./pet-notice.ts";

// The rules of the pet window's notice line (design section 8, decision D10), with the real notice texts.
const commandFailure = messages.pet.quickToggleFailed("창이 응답하지 않아요.");
const contractBreak = messages.pet.answerOutcomeMissing;
const deaf = messages.pet.listenFailed("권한이 없어요.");

test("the line is hidden until a notice comes, and a command failure shows with its timer", () => {
  const line = new NoticeState();
  expect(line.text).toBeNull();
  expect(line.show("command", commandFailure)).toBe(true);
  expect(line.text).toBe(commandFailure);
});

test("a later successful command ends a command failure, but not a notice of another kind", () => {
  const line = new NoticeState();
  line.show("command", commandFailure);
  expect(line.clear("command")).toBe(true);
  expect(line.text).toBeNull();
  line.show("contract", contractBreak);
  expect(line.clear("command")).toBe(false);
  expect(line.text).toBe(contractBreak);
});

test("a passing notice covers a lasting one, which shows again when the passing one ends or expires", () => {
  const line = new NoticeState();
  expect(line.show("listen", deaf)).toBe(false);
  expect(line.text).toBe(deaf);
  line.show("command", commandFailure);
  expect(line.text).toBe(commandFailure);
  line.clear("command");
  expect(line.text).toBe(deaf);
  line.show("contract", contractBreak);
  line.expire();
  expect(line.text).toBe(deaf);
  // What stays broken is never cleared by a success.
  expect(line.clear("listen")).toBe(false);
  expect(line.text).toBe(deaf);
});

test("a newer passing notice replaces the older one", () => {
  const line = new NoticeState();
  line.show("contract", contractBreak);
  line.show("command", commandFailure);
  expect(line.text).toBe(commandFailure);
  expect(line.clear("contract")).toBe(false);
  expect(line.clear("command")).toBe(true);
  expect(line.text).toBeNull();
});

test("an update notice passes like a command failure and leaves a lasting notice in place", () => {
  const line = new NoticeState();
  line.show("listen", deaf);
  const failure = messages.selfUpdate.checkFailed("연결 실패");
  expect(line.show("update", failure)).toBe(true);
  expect(line.text).toBe(failure);
  line.expire();
  expect(line.text).toBe(deaf);
});

test("a running install lasts above the deaf notice, passing notices cover it, and it ends only by its clear", () => {
  const line = new NoticeState();
  const installing = messages.installLock.petInstalling;
  line.show("listen", deaf);
  expect(line.show("install", installing)).toBe(false);
  expect(line.text).toBe(installing);
  // The stage changes the same lasting line.
  const stage = messages.installLock.petStage(messages.installLock.petStages.server);
  line.show("install", stage);
  expect(line.text).toBe(stage);
  // The pet's click refused while installing passes over it, then the install shows again.
  expect(line.show("installNote", messages.installLock.petClickRefused)).toBe(true);
  expect(line.text).toBe(messages.installLock.petClickRefused);
  line.expire();
  expect(line.text).toBe(stage);
  // A successful command does not end it; its own clear does, and the deaf notice shows again.
  expect(line.clear("command")).toBe(false);
  expect(line.text).toBe(stage);
  expect(line.clear("install")).toBe(false);
  expect(line.text).toBe(deaf);
});

test("ending the install leaves a passing notice and its time alone", () => {
  const line = new NoticeState();
  line.show("install", messages.installLock.petInstalling);
  line.show("command", commandFailure);
  // No passing notice ended, so the screen keeps its timer.
  expect(line.clear("install")).toBe(false);
  expect(line.text).toBe(commandFailure);
  line.expire();
  expect(line.text).toBeNull();
});

test("the line reports the kind it shows, and only an install told is looked at as information", () => {
  const line = new NoticeState();
  expect(line.kind).toBeNull();
  line.show("listen", deaf);
  expect(line.kind).toBe("listen");
  line.show("install", messages.installLock.petClickRefused);
  expect(line.kind).toBe("install");
  line.show("command", commandFailure);
  expect(line.kind).toBe("command");
  line.expire();
  expect(line.kind).toBe("install");
  line.clear("install");
  expect(line.kind).toBe("listen");
  expect(noticeLook("install")).toBe("info");
  expect(noticeLook("installNote")).toBe("info");
  for (const kind of ["command", "contract", "listen", "update"] as const) expect(noticeLook(kind)).toBe("error");
});
