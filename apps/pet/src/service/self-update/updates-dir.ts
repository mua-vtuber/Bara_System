import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { failureText } from "./failure.ts";

/** `<data folder>/updates`: the only folder the update writes to or removes from (spec 6.2). */
export function updatesDir(dataDir: string): string {
  return join(dataDir, SELF_UPDATE.updatesDirName);
}

/** Creates the updates folder and refuses one that is a link (junction or symbolic link): what is written there must
 * stay inside the data folder, where the host also looks for it (`src-tauri/src/self_update.rs`). */
export async function prepareUpdatesDir(dir: string): Promise<void> {
  const writeFailed = (error: unknown) =>
    serviceError("SELF_UPDATE_WRITE_FAILED", failureText((cause) => messages.selfUpdateErrors.SELF_UPDATE_WRITE_FAILED(dir, cause), error));
  try { await mkdir(dir, { recursive: true }); } catch (error) { throw writeFailed(error); }
  let info: Stats;
  try { info = await lstat(dir); } catch (error) { throw writeFailed(error); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw serviceError("SELF_UPDATE_DIR_LINK", messages.selfUpdateErrors.SELF_UPDATE_DIR_LINK(dir));
}

export interface CleanupFailure { code: string; message: string }

/** Removes everything a previous update left in the updates folder (spec 6.2-1), and nothing outside it. A folder
 * that is a link is not entered; a link inside it is removed itself, never what it points to. Each entry that could not
 * be removed comes back as a failure for the log; the next start tries again. */
export async function clearUpdates(dir: string): Promise<CleanupFailure[]> {
  const cleanupFailed = (path: string, error: unknown): CleanupFailure => ({ code: "SELF_UPDATE_CLEANUP_FAILED",
    message: failureText((cause) => messages.selfUpdateErrors.SELF_UPDATE_CLEANUP_FAILED(path, cause), error) });
  let names: string[];
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      return [{ code: "SELF_UPDATE_DIR_LINK", message: messages.selfUpdateErrors.SELF_UPDATE_DIR_LINK(dir) }];
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [cleanupFailed(dir, error)];
  }
  const failures: CleanupFailure[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const entry = await lstat(path);
      // A directory link (a junction) goes with rmdir, a file link with unlink; neither enters the target.
      if (entry.isSymbolicLink()) await rmdir(path).catch(() => unlink(path));
      else await rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push(cleanupFailed(path, error));
    }
  }
  return failures;
}
