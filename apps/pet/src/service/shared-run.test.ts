import { expect, test } from "bun:test";
import type { ProgressDetail, ProgressStage, RequestContext } from "../shared/contracts.ts";
import { SharedRun } from "./shared-run.ts";

type Frame = [ProgressStage, ProgressDetail | undefined];
function caller(signal: AbortSignal = new AbortController().signal): RequestContext & { frames: Frame[] } {
  const frames: Frame[] = [];
  return { signal, frames, progress: (stage, detail) => { frames.push([stage, detail]); } };
}
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("the host's request starts the work once and the window's later request joins it", async () => {
  const gate = held<string>();
  let runs = 0;
  const run = new SharedRun(async () => { runs++; return gate.promise; });
  expect(run.started).toBe(false);
  const host = run.join(caller());
  const screen = run.join(caller());
  expect(runs).toBe(1);
  gate.resolve("connected");
  expect(await host).toBe("connected");
  expect(await screen).toBe("connected");
  // A caller after the end gets the same outcome without a new run.
  expect(await run.join(caller())).toBe("connected");
  expect(runs).toBe(1);
});

test("every waiting caller receives the progress, and one that joins late first gets the latest stage again", async () => {
  const gate = held<void>();
  let report!: RequestContext["progress"];
  const run = new SharedRun(async (ctx) => { report = ctx.progress; ctx.progress("update-backup"); await gate.promise; ctx.progress("server"); return "done"; });
  const host = caller();
  const hostWait = run.join(host);
  // The work reported before the first caller was listening; that caller gets it too.
  expect(host.frames).toEqual([["update-backup", undefined]]);
  const screen = caller();
  const screenWait = run.join(screen);
  expect(screen.frames).toEqual([["update-backup", undefined]]);
  report("models", { part: 1, parts: 2, loaded: 5, total: 10 });
  gate.resolve();
  await Promise.all([hostWait, screenWait]);
  expect(host.frames).toEqual([["update-backup", undefined], ["models", { part: 1, parts: 2, loaded: 5, total: 10 }], ["server", undefined]]);
  expect(screen.frames).toEqual([["update-backup", undefined], ["models", { part: 1, parts: 2, loaded: 5, total: 10 }], ["server", undefined]]);
  // After the end nothing is replayed: a finished backup must not show up again on a late screen.
  const late = caller();
  await run.join(late);
  expect(late.frames).toEqual([]);
});

test("a caller's cancel ends only its own wait; the work goes on for the others on its own signal", async () => {
  const gate = held<string>();
  let workSignal: AbortSignal | undefined;
  const run = new SharedRun(async (ctx) => { workSignal = ctx.signal; return gate.promise; });
  const cancelled = new AbortController();
  const leaving = caller(cancelled.signal);
  const leavingWait = run.join(leaving);
  const staying = caller();
  const stayingWait = run.join(staying);
  cancelled.abort(new Error("ceiling"));
  await expect(leavingWait).rejects.toThrow("ceiling");
  expect(workSignal?.aborted).toBe(false);
  gate.resolve("connected");
  expect(await stayingWait).toBe("connected");
  // A caller already cancelled is turned away before anything starts.
  const fresh = new SharedRun(async () => "never");
  expect(() => fresh.join(caller(AbortSignal.abort()))).toThrow();
  expect(fresh.started).toBe(false);
});

test("closing stops the running work, and the callers still waiting get what it ends with", async () => {
  const run = new SharedRun(async (ctx) => {
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    return ctx.signal.aborted ? "stopped" : "finished";
  });
  const wait = run.join(caller());
  run.close();
  expect(await wait).toBe("stopped");
});

test("a failing work fails every caller the same way and is not run again", async () => {
  let runs = 0;
  const run = new SharedRun<string>(async () => { runs++; throw new Error("broken"); });
  await expect(run.join(caller())).rejects.toThrow("broken");
  await expect(run.join(caller())).rejects.toThrow("broken");
  expect(runs).toBe(1);
});
