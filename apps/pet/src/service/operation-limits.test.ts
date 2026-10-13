import { expect, test } from "bun:test";
import { RPC_METHODS } from "../shared/contracts.ts";
import { ceilingFor, OPERATION_CEILINGS, OPERATION_SAFETY_CEILING_MS, runWithCeiling } from "./operation-limits.ts";

test("every RPC method and dashboard.link has a registered ceiling policy", () => {
  const expected: Array<(typeof RPC_METHODS)[number] | "dashboard.link"> = [...RPC_METHODS, "dashboard.link"];
  expect(new Set(OPERATION_CEILINGS.keys())).toEqual(new Set(expected));
  for (const method of expected) expect(() => ceilingFor(method)).not.toThrow();
});

test("operations with their own cancel button and step limits carry no total ceiling", () => {
  for (const method of ["install.local", "install.remote", "cleanup.run", "backup.export", "backup.restore", "backup.join"] as const)
    expect(ceilingFor(method)).toBeNull();
});

test("joining the startup check carries no ceiling of its own: the check's connection part has connection.test's", () => {
  expect(ceilingFor("startup.check")).toBeNull();
  expect(ceilingFor("connection.test")).toBe(OPERATION_SAFETY_CEILING_MS);
});

test("every other operation is bounded by the shared safety ceiling", () => {
  for (const method of RPC_METHODS)
    if (!["install.local", "install.remote", "cleanup.run", "backup.export", "backup.restore", "backup.join", "startup.check"].includes(method))
      expect(ceilingFor(method)).toBe(OPERATION_SAFETY_CEILING_MS);
  expect(ceilingFor("dashboard.link")).toBe(OPERATION_SAFETY_CEILING_MS);
});

test("work that ignores its abort signal is stopped and reported as OPERATION_TIMEOUT once the ceiling elapses", async () => {
  const parent = new AbortController();
  const work = () => new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("should have been abandoned by the ceiling, not finished")), 5_000);
  });
  await expect(runWithCeiling(work, 50, parent.signal)).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
});

test("work that finishes well within the ceiling returns its own result untouched", async () => {
  const parent = new AbortController();
  const result = await runWithCeiling(async (signal) => { signal.throwIfAborted(); return "ok"; }, 5_000, parent.signal);
  expect(result).toBe("ok");
});

test("a null ceiling never stops the work regardless of how long it runs", async () => {
  const parent = new AbortController();
  const result = await runWithCeiling(async () => { await Bun.sleep(30); return "unbounded"; }, null, parent.signal);
  expect(result).toBe("unbounded");
});

test("a parent cancellation is left to the caller, not rewritten into OPERATION_TIMEOUT", async () => {
  const parent = new AbortController();
  const work = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "PARENT_ABORT" })), { once: true });
  });
  const pending = runWithCeiling(work, 5_000, parent.signal);
  parent.abort();
  await expect(pending).rejects.toMatchObject({ code: "PARENT_ABORT" });
});
