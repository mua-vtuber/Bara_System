import type { SaveResult } from "../shared/contracts.ts";
import { messages } from "./messages.ts";

/** What the recovery screen does with a `memory.status` answer: how the outbox entry settles
 * (`finishSubmission`) and the notice it shows. A saved entity-only input (`entity_patch`) updated an
 * existing entity instead of creating a memory, so it gets its own text rather than "saved a memory". */
export interface SaveCheckOutcome { settled: true | "rejected" | false; text: string; tone: "success" | "error" }

export function saveCheckOutcome(result: SaveResult): SaveCheckOutcome {
  if (result.state === "saved")
    return { settled: true, tone: "success", text: result.resultType === "entity_patch" ? messages.composer.entityPatchSaved : messages.composer.saved };
  return { settled: result.state === "rejected" ? "rejected" : false, tone: "error", text: result.message ?? messages.errors.unknown };
}

/** What the recovery screen's `<summary>` shows for one pending entry. A failed `status` lookup
 * (the control process being unreachable) still keeps `busy` true -- it cannot prove the write
 * stopped -- but must say so instead of silently reusing the ordinary "saving" text (PW-1): the two
 * reasons `busy` can be true (actually in flight vs. status lookup failed) must read differently. */
export function pendingEntryStatusText(busy: boolean, unknownDueToStatusFailure: boolean, statusError: string | undefined): string {
  if (unknownDueToStatusFailure && statusError) return messages.composer.statusUnknown(statusError);
  return busy ? messages.composer.saving : messages.composer.pendingCheck;
}
