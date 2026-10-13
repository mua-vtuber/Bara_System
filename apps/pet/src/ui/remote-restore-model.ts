import type { RestoreListing } from "../shared/contracts.ts";
import { messages } from "./messages.ts";
import { entryLine } from "./restore-model.ts";

// The remote install's "백업에서 시작" choice (`remote-restore-pick.ts`), apart from the DOM so it can be tested.
export interface PickRow { id: string; line: string }
export function remoteRestoreRows(listing: RestoreListing): PickRow[] {
  return listing.entries.map((entry) => ({ id: entry.id, line: entryLine(entry) }));
}

export type RestoreChoice = { restoreFrom?: string } | { error: string };
/** What `install.remote` adds to its input: nothing with the option off, the chosen id with it on. */
export function restoreChoice(enabled: boolean, selected: string | null): RestoreChoice {
  if (!enabled) return {};
  return selected ? { restoreFrom: selected } : { error: messages.remoteRestorePick.pickRequired };
}
