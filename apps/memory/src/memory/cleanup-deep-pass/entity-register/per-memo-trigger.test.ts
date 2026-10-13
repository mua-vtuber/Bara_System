import { expect, test } from "bun:test";
import { createMemoSavedCleanupTrigger } from "./per-memo-trigger.ts";

function harness(
  busy: () => boolean,
  result: () => "started" | "already_running" = () => "started",
  maxPerRun?: number,
) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const started: number[][] = [];
  const trigger = createMemoSavedCleanupTrigger({
    isBusy: busy,
    start: (ids) => { started.push(ids); return result(); },
    debounceMs: 3000, busyRetryMs: 60000,
    ...(maxPerRun !== undefined ? { maxPerRun } : {}),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
  });
  const fire = () => timers.shift()!.fn();
  return { trigger, timers, started, fire };
}

test("saves within the wait are sent together once", () => {
  const h = harness(() => false);
  h.trigger.enqueue(1);
  h.trigger.enqueue(2);
  expect(h.timers).toHaveLength(1);
  h.fire();
  expect(h.started).toEqual([[1, 2]]);
  expect(h.trigger.pendingCount()).toBe(0);
});

test("a busy scheduler keeps the queue and retries", () => {
  let busy = true;
  const h = harness(() => busy);
  h.trigger.enqueue(7);
  h.fire();
  expect(h.started).toEqual([]);
  expect(h.timers[0]!.ms).toBe(60000);
  busy = false;
  h.fire();
  expect(h.started).toEqual([[7]]);
});

test("a race lost to another cycle keeps the ids for the next try", () => {
  const h = harness(() => false, () => "already_running");
  h.trigger.enqueue(3);
  h.fire();
  expect(h.trigger.pendingCount()).toBe(1);
  expect(h.timers[0]!.ms).toBe(60000);
});

test("stop drops the timer and ignores later saves", () => {
  const h = harness(() => false);
  h.trigger.stop();
  h.trigger.enqueue(1);
  expect(h.timers).toHaveLength(0);
});

test("the same memo saved twice is queued once", () => {
  const h = harness(() => false);
  h.trigger.enqueue(4);
  h.trigger.enqueue(4);
  expect(h.trigger.pendingCount()).toBe(1);
  h.fire();
  expect(h.started).toEqual([[4]]);
});

test("a memo saved while its run is going waits for a later run", () => {
  let busy = false;
  const h = harness(() => busy);
  h.trigger.enqueue(1);
  h.fire();
  busy = true;
  h.trigger.enqueue(2);
  h.fire();
  expect(h.started).toEqual([[1]]);
  expect(h.timers[0]!.ms).toBe(60000);
  busy = false;
  h.fire();
  expect(h.started).toEqual([[1], [2]]);
});

test("a run takes at most maxPerRun memos and the rest stay queued", () => {
  let busy = false;
  const h = harness(() => busy, () => "started", 2);
  for (const id of [1, 2, 3, 4, 5]) h.trigger.enqueue(id);
  h.fire();
  expect(h.started).toEqual([[1, 2]]);
  expect(h.trigger.pendingCount()).toBe(3);
  expect(h.timers).toHaveLength(1);
  busy = true;
  h.fire();
  expect(h.timers[0]!.ms).toBe(60000);
  busy = false;
  h.fire();
  h.fire();
  expect(h.started).toEqual([[1, 2], [3, 4], [5]]);
  expect(h.trigger.pendingCount()).toBe(0);
});

test("a start that throws keeps the memos queued and retries instead of escaping the timer", () => {
  let fail = true;
  const h = harness(() => false, () => {
    if (fail) throw new Error("database is locked");
    return "started";
  });
  h.trigger.enqueue(9);
  expect(() => h.fire()).not.toThrow();
  expect(h.trigger.pendingCount()).toBe(1);
  expect(h.timers).toHaveLength(1);
  expect(h.timers[0]!.ms).toBe(60000);
  fail = false;
  h.fire();
  expect(h.started).toEqual([[9], [9]]);
  expect(h.trigger.pendingCount()).toBe(0);
});
