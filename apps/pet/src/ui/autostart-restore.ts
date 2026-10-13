import type { MaintenanceRun } from "../shared/contracts.ts";

/** Starts after which the login autostart (the `BaraPet` value under HKCU `...\CurrentVersion\Run`) is put back
 * when the user had it on. Installing a newer version over an older one offers "uninstall before installing" as the
 * default choice, which runs the OLD uninstaller; its pre-uninstall hook (`src-tauri/windows/installer-hooks.nsh`)
 * deletes the Run value, and an uninstaller already on a PC cannot be changed afterwards. So:
 * - `update`: a newer app than the one recorded in `maintenance.json`.
 * - `first-run`: no record yet. A saved preference that is on can only come from an earlier version that ran here
 *   (a new install starts with it off), i.e. an update from a version older than the record.
 * `same-version` is left out on purpose: it cannot be told apart from an ordinary restart, so restoring there would
 * put the value back at every start and undo a removal made outside the app (and a same-version reinstall only
 * uninstalls first when the user picks that non-default choice). A downgrade, an unreadable record and the other
 * runs are not acted on, as everywhere else in the app. */
export const AUTOSTART_RESTORE_RUNS: readonly MaintenanceRun[] = ["update", "first-run"];

/** Whether the Run value exists at all, whatever it holds (`has_autostart_entry`). */
export type AutoStartEntry = "present" | "missing";

/** Whether the run and the saved preference allow a restore, before the registry is read at all. */
export function autoStartRestoreCandidate(run: MaintenanceRun, savedPreference: boolean): boolean {
  return savedPreference && AUTOSTART_RESTORE_RUNS.includes(run);
}

/** The whole decision: restore only after an update-like start, only when the user's saved preference is on, and only
 * when the Run value is missing. A value that exists is never touched: the user may have turned it off in Task Manager,
 * which marks it in `StartupApproved` and leaves the Run value in place. A saved preference that is off never turns
 * autostart on. */
export function shouldRestoreAutoStart(run: MaintenanceRun, savedPreference: boolean, entry: AutoStartEntry): boolean {
  return autoStartRestoreCandidate(run, savedPreference) && entry === "missing";
}

export interface AutoStartRestoreDeps {
  /** This start's maintenance run (`status` → `maintenance.run`). */
  readRun(): Promise<MaintenanceRun>;
  /** The saved preference (`settings.get` → `autoStart`), which the settings toggle writes with the Run value. */
  readSavedPreference(): Promise<boolean>;
  /** `has_autostart_entry`. */
  hasEntry(): Promise<boolean>;
  /** `set_autostart` with `enabled: true`: the same registration the settings toggle makes. */
  enable(): Promise<unknown>;
}
/** `restored`: the Run value was written again. `unchanged`: nothing to do. `failed`: a read or the write failed, and
 * nothing more was tried. */
export type AutoStartRestoreResult = "restored" | "unchanged" | "failed";

/** Runs once per start, best effort: never throws, never retries. The registry is read only when the run and the
 * saved preference already allow a restore. */
export async function restoreAutoStart(deps: AutoStartRestoreDeps): Promise<AutoStartRestoreResult> {
  try {
    const [run, saved] = await Promise.all([deps.readRun(), deps.readSavedPreference()]);
    if (!autoStartRestoreCandidate(run, saved)) return "unchanged";
    const entry: AutoStartEntry = await deps.hasEntry() ? "present" : "missing";
    if (!shouldRestoreAutoStart(run, saved, entry)) return "unchanged";
    await deps.enable();
    return "restored";
  } catch { return "failed"; }
}
