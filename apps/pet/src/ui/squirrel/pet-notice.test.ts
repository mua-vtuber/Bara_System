import { expect, test } from "bun:test";
import { messages } from "../messages.ts";
import { NoticeState } from "./pet-notice.ts";

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
