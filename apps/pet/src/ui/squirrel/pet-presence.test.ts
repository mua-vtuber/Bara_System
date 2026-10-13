import { expect, test } from "bun:test";
import type { MotionFeedback } from "./motion-types.ts";
import { HostVisibility, PendingInputs, petDrawable, RendererPresence } from "./pet-presence.ts";

// Plan 1C: the character is created on the first show, pauses while hidden and resumes when shown, driven by the
// host's visibility signal; the page asks for the state at load without losing to a newer event.

test("a tray-only start creates nothing until the pet is first shown", () => {
  const presence = new RendererPresence();
  expect(presence.visibility(false)).toBeNull();
  expect(presence.phase).toBe("waiting");
  expect(presence.visibility(true)).toBe("load");
  expect(presence.phase).toBe("loading");
  expect(presence.loaded()).toBe("resume");
  expect(presence.phase).toBe("running");
});

test("a shown start loads at once and the running character pauses and resumes with the pet", () => {
  const presence = new RendererPresence();
  expect(presence.visibility(true)).toBe("load");
  expect(presence.loaded()).toBe("resume");
  expect(presence.visibility(true)).toBeNull();
  expect(presence.visibility(false)).toBe("pause");
  expect(presence.visibility(false)).toBeNull();
  expect(presence.visibility(true)).toBe("resume");
});

test("a hide while the files load is answered when loading ends, and loads only once", () => {
  const presence = new RendererPresence();
  expect(presence.visibility(true)).toBe("load");
  expect(presence.visibility(false)).toBeNull();
  expect(presence.visibility(true)).toBeNull();
  expect(presence.visibility(false)).toBeNull();
  expect(presence.loaded()).toBe("pause");
  expect(presence.visible).toBe(false);
  expect(presence.visibility(true)).toBe("resume");
});

test("after a failed start nothing is loaded or resumed again", () => {
  const presence = new RendererPresence();
  presence.visibility(true);
  presence.failed();
  expect(presence.visibility(false)).toBeNull();
  expect(presence.visibility(true)).toBeNull();
  expect(presence.phase).toBe("stopped");
  expect(() => presence.loaded()).toThrow();
});

test("the pet draws only when the host shows it and the page is visible", () => {
  expect(petDrawable(true, true)).toBe(true);
  expect(petDrawable(true, false)).toBe(false);
  expect(petDrawable(false, true)).toBe(false);
  expect(petDrawable(null, true)).toBe(false);
});

test("the host state is unknown until the answer or an event comes", () => {
  const host = new HostVisibility();
  expect(host.visible).toBeNull();
  const token = host.asked();
  expect(host.answered(token, false)).toBe(true);
  expect(host.visible).toBe(false);
  expect(host.event(true)).toBe(true);
  expect(host.event(true)).toBe(false);
  expect(host.visible).toBe(true);
});

test("an event during the question wins over the older answer", () => {
  const host = new HostVisibility();
  const token = host.asked();
  expect(host.event(true)).toBe(true);
  expect(host.answered(token, false)).toBe(false);
  expect(host.visible).toBe(true);
  expect(host.failed(token)).toBe(false);
  expect(host.visible).toBe(true);
});

test("a failed question counts as shown only when nothing is known", () => {
  const unknown = new HostVisibility();
  expect(unknown.failed(unknown.asked())).toBe(true);
  expect(unknown.visible).toBe(true);
  const hidden = new HostVisibility();
  hidden.event(false);
  expect(hidden.failed(hidden.asked())).toBe(false);
  expect(hidden.visible).toBe(false);
});

const working = (id: string, sequence: number): MotionFeedback => ({ id, kind: "working", sequence });
const saved = (id: string, sequence: number): MotionFeedback => ({ id, kind: "saved", sequence });

test("waiting inputs come out in arrival order with the last quick input state, then the store is empty", () => {
  const pending = new PendingInputs(8);
  pending.feedback(working("a", 1));
  pending.quickVisibility(true);
  pending.feedback(saved("a", 2));
  pending.quickVisibility(false);
  expect(pending.take()).toEqual({ feedback: [working("a", 1), saved("a", 2)], quickVisible: false });
  expect(pending.take()).toEqual({ feedback: [], quickVisible: null });
});

test("a long hidden time keeps at most the limit, dropping finished work first and keeping work still running", () => {
  const pending = new PendingInputs(4);
  pending.feedback(working("long", 1));
  let sequence = 2;
  for (let index = 0; index < 50; index++) {
    pending.feedback(working(`r${index}`, sequence++));
    pending.feedback(saved(`r${index}`, sequence++));
    expect(pending.size).toBeLessThanOrEqual(4);
  }
  const { feedback } = pending.take();
  expect(feedback[0]).toEqual(working("long", 1));
  // The newest results stay, in order, so the last sequence is the newest one.
  expect(feedback.at(-1)).toEqual(saved("r49", sequence - 1));
  for (let index = 1; index < feedback.length; index++) expect(feedback[index]!.sequence!).toBeGreaterThan(feedback[index - 1]!.sequence!);
});

test("a working feedback with a later feedback for its id goes before a newer result", () => {
  const pending = new PendingInputs(3);
  pending.feedback(saved("old", 1));
  pending.feedback(working("job", 2));
  pending.feedback(saved("job", 3));
  pending.feedback(working("next", 4));
  pending.feedback(working("other", 5));
  // First the oldest result, then `job`'s working (its result is kept).
  expect(pending.take().feedback).toEqual([saved("job", 3), working("next", 4), working("other", 5)]);
});

test("the limit must be a positive integer, and a failed start clears what waited", () => {
  expect(() => new PendingInputs(0)).toThrow(RangeError);
  expect(() => new PendingInputs(1.5)).toThrow(RangeError);
  const pending = new PendingInputs(2);
  pending.feedback(working("a", 1));
  pending.quickVisibility(true);
  pending.clear();
  expect(pending.take()).toEqual({ feedback: [], quickVisible: null });
});
