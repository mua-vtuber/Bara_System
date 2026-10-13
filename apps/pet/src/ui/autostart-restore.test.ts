import { expect, test } from "bun:test";
import type { MaintenanceRun } from "../shared/contracts.ts";
import { AUTOSTART_RESTORE_RUNS, restoreAutoStart, shouldRestoreAutoStart, type AutoStartRestoreDeps } from "./autostart-restore.ts";

const RUNS: MaintenanceRun[] = ["first-run", "same-version", "update", "downgrade", "unreadable", "read-failed", "unversioned"];

test("the Run value is put back only after an update-like start, with the preference on and the value missing", () => {
  for (const run of RUNS) {
    for (const saved of [true, false]) {
      for (const entry of ["present", "missing"] as const) {
        const expected = (run === "update" || run === "first-run") && saved && entry === "missing";
        expect({ run, saved, entry, restore: shouldRestoreAutoStart(run, saved, entry) }).toEqual({ run, saved, entry, restore: expected });
      }
    }
  }
  expect([...AUTOSTART_RESTORE_RUNS].sort()).toEqual(["first-run", "update"]);
});

test("a same-version start never restores: it cannot be told apart from an ordinary restart", () => {
  expect(shouldRestoreAutoStart("same-version", true, "missing")).toBe(false);
});

/** Real async functions resolving or rejecting the way the native bridge does, recording what was called. */
function deps(run: MaintenanceRun, saved: boolean, present: boolean, overrides: Partial<AutoStartRestoreDeps> = {}) {
  const calls: string[] = [];
  const value: AutoStartRestoreDeps = {
    readRun: async () => { calls.push("status"); return run; },
    readSavedPreference: async () => { calls.push("settings.get"); return saved; },
    hasEntry: async () => { calls.push("has_autostart_entry"); return present; },
    enable: async () => { calls.push("set_autostart"); return true; },
    ...overrides,
  };
  return { calls, value };
}

test("after an update with the preference on and the value deleted, it registers once", async () => {
  const { calls, value } = deps("update", true, false);
  expect(await restoreAutoStart(value)).toBe("restored");
  expect(calls.filter(call => call === "set_autostart")).toHaveLength(1);
});

test("an existing value is never rewritten (it may be turned off in Task Manager, which keeps it)", async () => {
  const { calls, value } = deps("update", true, true);
  expect(await restoreAutoStart(value)).toBe("unchanged");
  expect(calls).not.toContain("set_autostart");
});

test("a preference that is off never turns autostart on, and the registry is not even read", async () => {
  const { calls, value } = deps("update", false, false);
  expect(await restoreAutoStart(value)).toBe("unchanged");
  expect(calls).not.toContain("has_autostart_entry");
  expect(calls).not.toContain("set_autostart");
});

test("an ordinary restart does nothing even when the value is missing", async () => {
  const { calls, value } = deps("same-version", true, false);
  expect(await restoreAutoStart(value)).toBe("unchanged");
  expect(calls).not.toContain("has_autostart_entry");
});

test("a failed read or write ends as failed without throwing, and nothing more is tried", async () => {
  const boom = async (): Promise<never> => { throw new Error("HOST_AUTOSTART_READ_FAILED"); };
  const failedStatus = deps("update", true, false, { readRun: boom });
  expect(await restoreAutoStart(failedStatus.value)).toBe("failed");
  expect(failedStatus.calls).not.toContain("set_autostart");

  const failedEntry = deps("update", true, false, { hasEntry: boom });
  expect(await restoreAutoStart(failedEntry.value)).toBe("failed");
  expect(failedEntry.calls).not.toContain("set_autostart");

  let writes = 0;
  const failedWrite = deps("first-run", true, false, { enable: async () => { writes++; throw new Error("HOST_AUTOSTART_REGISTRY_FAILED"); } });
  expect(await restoreAutoStart(failedWrite.value)).toBe("failed");
  expect(writes).toBe(1);
});
