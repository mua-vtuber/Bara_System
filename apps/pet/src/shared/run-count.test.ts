import { expect, test } from "bun:test";
import { RunCount } from "./run-count.ts";

test("a run counts from the call until it succeeds", async () => {
  const runs = new RunCount();
  let finish!: (value: string) => void;
  const run = runs.track(() => new Promise<string>((resolve) => { finish = resolve; }));
  expect(runs.running).toBe(true);
  finish("done");
  expect(await run).toBe("done");
  expect(runs.running).toBe(false);
});

test("a failed run stops counting and hands its error on unchanged", async () => {
  const runs = new RunCount();
  const failure = new Error("work failed");
  let fail!: (error: Error) => void;
  const run = runs.track(() => new Promise<never>((_, reject) => { fail = reject; }));
  expect(runs.running).toBe(true);
  fail(failure);
  await expect(run).rejects.toBe(failure);
  expect(runs.running).toBe(false);
});

test("a cancelled run stops counting when its signal aborts the work", async () => {
  const runs = new RunCount();
  const controller = new AbortController();
  const run = runs.track(() => new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
  }));
  expect(runs.running).toBe(true);
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(runs.running).toBe(false);
});

test("two runs overlapping keep it running until both ended", async () => {
  const runs = new RunCount();
  let first!: () => void;
  let second!: () => void;
  const a = runs.track(() => new Promise<void>((resolve) => { first = resolve; }));
  const b = runs.track(() => new Promise<void>((resolve) => { second = resolve; }));
  first();
  await a;
  expect(runs.running).toBe(true);
  second();
  await b;
  expect(runs.running).toBe(false);
});

test("work that throws before its first await still ends the count", async () => {
  const runs = new RunCount();
  await expect(runs.track(() => { throw new Error("at once"); })).rejects.toThrow("at once");
  expect(runs.running).toBe(false);
});
