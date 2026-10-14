import { expect, test } from "bun:test";
import type { UpdateBubbleEvent } from "../shared/contracts.ts";
import { downloadPercent } from "../shared/self-update.ts";
import { messages } from "./messages.ts";
import {
  INITIAL_BUBBLE_MODE, modeOnActionFailed, modeOnFeedback, modeOnInstallFailed, modeOnLaunching, modeOnProgress, modeOnUpdateEvent,
  modeOnYes, updateBubbleView, type BubbleMode, type UpdateMode,
} from "./update-bubble-model.ts";

const event = (phase: UpdateBubbleEvent["phase"], sequence: number): UpdateBubbleEvent => ({ phase, version: "0.1.9", sequence });
const asUpdate = (mode: BubbleMode): UpdateMode => { if (mode.kind !== "update") throw new Error("expected the update bubble"); return mode; };
const busy = () => modeOnUpdateEvent(modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("confirm", 3)), event("busy", 4));

test("the notice opens the question; the question answers with yes and no", () => {
  const notice = modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("notice", 1));
  expect(updateBubbleView(asUpdate(notice))).toEqual({ summary: messages.selfUpdate.notice("0.1.9"), answers: false, opensConfirm: true });
  const confirm = modeOnUpdateEvent(notice, event("confirm", 2));
  expect(updateBubbleView(asUpdate(confirm))).toEqual({ summary: messages.selfUpdate.confirm("0.1.9"), answers: true, opensConfirm: false });
});

test("a second yes does nothing", () => {
  const confirm = modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("confirm", 2));
  const starting = modeOnYes(confirm);
  expect(starting).not.toBeNull();
  expect(modeOnYes(starting!)).toBeNull();
  expect(modeOnYes(busy())).toBeNull();
  expect(modeOnYes(INITIAL_BUBBLE_MODE)).toBeNull();
});

test("a repeated confirm event while an install is starting does not allow a second yes", () => {
  const starting = modeOnYes(modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("confirm", 2)))!;
  const again = modeOnUpdateEvent(starting, event("confirm", 3));
  expect(modeOnYes(again)).toBeNull();
  // After a failure the question may be answered again by a new confirm.
  const failed = modeOnInstallFailed(starting, "0.1.9", "끊김");
  expect(modeOnYes(modeOnUpdateEvent(failed, event("confirm", 5)))).not.toBeNull();
});

test("the download shows its percent, then the check, then the start", () => {
  let mode = busy();
  expect(updateBubbleView(asUpdate(mode)).summary).toBe(messages.selfUpdate.downloading(0));
  mode = modeOnProgress(mode, "self-update-download", { part: 1, parts: 1, loaded: 50, total: 200 });
  expect(updateBubbleView(asUpdate(mode)).summary).toBe(messages.selfUpdate.downloading(25));
  mode = modeOnProgress(mode, "self-update-verify");
  expect(updateBubbleView(asUpdate(mode)).summary).toBe(messages.selfUpdate.verifying);
  mode = modeOnLaunching(mode);
  expect(updateBubbleView(asUpdate(mode))).toEqual({ summary: messages.selfUpdate.launching, answers: false, opensConfirm: false });
  expect(modeOnProgress(INITIAL_BUBBLE_MODE, "self-update-verify")).toBe(INITIAL_BUBBLE_MODE);
});

test("a result during the download does not take the bubble; at any other time a newer result does", () => {
  const downloading = busy();
  expect(modeOnFeedback(downloading, 9)).toBe(downloading);
  const confirm = modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("confirm", 5));
  expect(modeOnFeedback(confirm, 6)).toEqual({ kind: "feedback", sequence: 6 });
  expect(modeOnFeedback(confirm, 4)).toBe(confirm);
  const failed = modeOnUpdateEvent(modeOnInstallFailed(downloading, "0.1.9", "끊김"), event("failed", 7));
  expect(modeOnFeedback(failed, 8)).toEqual({ kind: "feedback", sequence: 8 });
});

test("an update event older than what the bubble shows is dropped", () => {
  const shown = modeOnFeedback(INITIAL_BUBBLE_MODE, 10);
  expect(modeOnUpdateEvent(shown, event("notice", 9))).toBe(shown);
});

test("a failure keeps its cause through the host's failed event", () => {
  const failed = modeOnInstallFailed(busy(), "0.1.9", messages.selfUpdate.failed("디스크 공간 부족"));
  const confirmed = asUpdate(modeOnUpdateEvent(failed, event("failed", 5)));
  expect(updateBubbleView(confirmed)).toEqual({ summary: messages.selfUpdate.failed("디스크 공간 부족"), answers: false, opensConfirm: false });
  expect(updateBubbleView(asUpdate(modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("failed", 1)))).summary).toBe(messages.selfUpdate.failedNoCause);
});

test("the percent is whole, bounded, and unknown without a total", () => {
  expect(downloadPercent(undefined)).toBeNull();
  expect(downloadPercent({ part: 1, parts: 1, loaded: 5, total: 0 })).toBeNull();
  expect(downloadPercent({ part: 1, parts: 1, loaded: 199, total: 200 })).toBe(99);
  expect(downloadPercent({ part: 1, parts: 1, loaded: 300, total: 200 })).toBe(100);
});

test("a result action that fails during a download is shown without stopping the download", () => {
  const downloading = asUpdate(modeOnProgress(busy(), "self-update-download", { part: 1, parts: 1, loaded: 50, total: 200 }));
  const noted = modeOnActionFailed(downloading, "결과를 닫지 못했어요");
  expect(noted.phase).toBe("busy");
  expect(noted.busy).toEqual({ step: "download", percent: 25 });
  expect(updateBubbleView(noted).summary).toBe(messages.selfUpdate.busyWithNote(messages.selfUpdate.downloading(25), "결과를 닫지 못했어요"));
  // The download goes on: its progress still reaches the bubble, the note stays with it.
  const later = asUpdate(modeOnProgress(noted, "self-update-download", { part: 1, parts: 1, loaded: 100, total: 200 }));
  expect(updateBubbleView(later).summary).toBe(messages.selfUpdate.busyWithNote(messages.selfUpdate.downloading(50), "결과를 닫지 못했어요"));
  // Outside a download the failure is the update bubble's own failure, as before.
  const notice = asUpdate(modeOnUpdateEvent(INITIAL_BUBBLE_MODE, event("notice", 1)));
  const failed = modeOnActionFailed(notice, "결과를 닫지 못했어요");
  expect(failed.phase).toBe("failed");
  expect(updateBubbleView(failed).summary).toBe("결과를 닫지 못했어요");
});
