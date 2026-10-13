import type { LastRestore, RestoreEntry, RestoreResult } from "../shared/contracts.ts";
import { messages } from "./messages.ts";

// The texts of the settings screen's restore from a backup (`settings.ts` `renderBackup`), apart from the DOM so
// they can be tested.

const two = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DD HH:mm` in the PC's local time, or the text as it came when it is not a date. */
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** One backup's line in the list: when it was made, which kind, and how much it holds. */
export function entryLine(entry: Pick<RestoreEntry, "createdAt" | "kind" | "memories" | "attachments">): string {
  return messages.restore.entry(localDateTime(entry.createdAt), messages.restore.kind[entry.kind], entry.memories, entry.attachments);
}

/** Whole minutes and seconds since `startedAt`, never negative. */
export function elapsedText(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return messages.restore.elapsed(Math.floor(seconds / 60), seconds % 60);
}

/** The line about how the last restore ended, or null when there is none to show. */
export function lastRestoreText(last: LastRestore | null): string | null {
  if (!last) return null;
  switch (last.outcome) {
    case "complete": return messages.restore.last.complete(last.backupName, last.memories, last.attachments, last.beforeFolder);
    case "swapped": return messages.restore.last.swapped(last.backupName, last.beforeFolder);
    case "rolled-back": return messages.restore.last["rolled-back"](last.backupName);
    case "interrupted": return messages.restore.last.interrupted(last.backupName);
  }
}

export function restoreDoneText(result: Pick<RestoreResult, "memories" | "attachments" | "beforeFolder">): string {
  return messages.restore.done(result.memories, result.attachments, result.beforeFolder);
}

/** The stages after which the restore can no longer be stopped: the switch is renames recorded step by step and
 * the server start that follows must not be left half done. */
export const RESTORE_UNSTOPPABLE_STAGES = new Set(["restore-switch", "server", "prepare"]);
