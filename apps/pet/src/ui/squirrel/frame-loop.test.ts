import { afterEach, beforeEach, expect, test } from "bun:test";
import { FrameLoop, frameDelta } from "./frame-loop.ts";
import { SQUIRREL_MOTION } from "./motion-config.ts";

// Plan 1C and design section 6.8: hidden means no frame is requested at all, and the first frame after showing again
// gets no elapsed time, so the motion clock never counts the time hidden. `requestAnimationFrame` is replaced by a
// queue the test runs by hand, with the frame times it chooses.

const frame = SQUIRREL_MOTION.frame;
const intervalMs = 1_000 / frame.maxFps;

let queued = new Map<number, FrameRequestCallback>();
let nextId = 1;
const saved = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };

beforeEach(() => {
  queued = new Map();
  nextId = 1;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextId++;
    queued.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number): void => { queued.delete(id); };
});

afterEach(() => {
  globalThis.requestAnimationFrame = saved.request;
  globalThis.cancelAnimationFrame = saved.cancel;
});

/** Runs the frame requested now at `time`, as the browser would. */
function tick(time: number): void {
  const callbacks = [...queued.values()];
  queued.clear();
  for (const callback of callbacks) callback(time);
}

function recordingLoop(): { loop: FrameLoop; deltas: number[] } {
  const deltas: number[] = [];
  const loop = new FrameLoop(frame, deltaSeconds => { deltas.push(deltaSeconds); });
  return { loop, deltas };
}

test("a hidden pet requests no frame and draws nothing, however long it stays hidden", () => {
  const { loop, deltas } = recordingLoop();
  loop.run();
  tick(0);
  tick(intervalMs);
  expect(deltas.length).toBe(2);
  loop.setVisible(false);
  expect(loop.pending).toBe(false);
  expect(queued.size).toBe(0);
  tick(60_000);
  expect(deltas.length).toBe(2);
  // A restart while hidden (a restored GPU context) still requests nothing.
  loop.halt();
  loop.run();
  expect(queued.size).toBe(0);
});

test("showing again resumes with a first frame of no elapsed time, so the clock skips the time hidden", () => {
  const { loop, deltas } = recordingLoop();
  loop.run();
  tick(0);
  tick(intervalMs);
  const clockBefore = loop.clock;
  loop.setVisible(false);
  loop.setVisible(true);
  expect(loop.pending).toBe(true);
  tick(intervalMs + 600_000);
  expect(deltas.at(-1)).toBe(0);
  expect(loop.clock).toBe(clockBefore);
  tick(intervalMs * 2 + 600_000);
  expect(deltas.at(-1)).toBeCloseTo(intervalMs / 1_000, 6);
});

test("a frame requested before hiding never runs after it", () => {
  const { loop, deltas } = recordingLoop();
  loop.run();
  const stale = [...queued.values()];
  loop.setVisible(false);
  for (const callback of stale) callback(0);
  expect(deltas.length).toBe(0);
});

test("the same visibility twice changes nothing", () => {
  const { loop } = recordingLoop();
  loop.run();
  const first = [...queued.keys()];
  loop.setVisible(true);
  expect([...queued.keys()]).toEqual(first);
});

test("a frame's elapsed time: none first, skipped under the cap, clamped above, never negative or backwards", () => {
  const max = frame.maxDeltaSeconds;
  expect(frameDelta(null, 5_000, intervalMs, max)).toBe(0);
  expect(frameDelta(1_000, 1_000 + intervalMs / 2, intervalMs, max)).toBeNull();
  // A frame just under the interval of a 60 Hz display still counts (the 1 ms slack).
  expect(frameDelta(1_000, 1_000 + intervalMs - 0.5, intervalMs, max)).toBeCloseTo((intervalMs - 0.5) / 1_000, 6);
  expect(frameDelta(1_000, 1_000 + 60_000, intervalMs, max)).toBe(max);
  // A time before the last frame is skipped, and one within the slack before it gets nothing.
  expect(frameDelta(1_000, 900, 0, max)).toBeNull();
  expect(frameDelta(1_000, 999.5, 0, max)).toBe(0);
});
