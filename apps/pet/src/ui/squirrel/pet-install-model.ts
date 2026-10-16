import type { ProgressDetail, ProgressEvent, ProgressStage } from "../../shared/contracts.ts";
import { messages } from "../messages.ts";
import type { InstallProgressStage } from "../messages-install-lock.ts";

/** How often the pet asks `status` while an install runs, so its notice ends soon after the install does. Asked only
 * while installing (or after a failed ask while it was): `status` then answers at once without reaching the server. */
export const PET_INSTALL_POLL_MS = 2_000;

/** Whether `stage` is one an install reports. */
export function isInstallStage(stage: ProgressStage): stage is InstallProgressStage {
  return Object.hasOwn(messages.installLock.petStages, stage);
}

/** What one progress event asks of the screen: `ask` the service whether an install runs (an install stage came while
 * the pet did not know of one), show the new `text`, or nothing. */
export type InstallProgressStep = "ask" | "text" | "none";

/** The pet window's rules for the install lock: whether an install runs, as the service's `status` last said
 * (`AppStatus.installing`), and the line the notice shows for it, following the install's progress events.
 *
 * A failed `status` ask keeps what was last known instead of guessing: a running install's notice stays (and its click
 * stays refused) until an answer says it is over, and an install not seen yet is not assumed. The first failure of a
 * run of failed asks returns a passing notice with its cause, the same way the pet's update check reports its own. */
export class PetInstallModel {
  private known: boolean | null = null;
  private stage: InstallProgressStage | null = null;
  private detail: ProgressDetail | undefined;
  private failing = false;

  /** True only while the service last said an install runs; the screen then asks again after `PET_INSTALL_POLL_MS`. */
  get installing(): boolean {
    return this.known === true;
  }

  /** The install notice's text, or null when no install runs. */
  get text(): string | null {
    if (this.known !== true) return null;
    const text = messages.installLock;
    if (this.stage === null) return text.petInstalling;
    if (this.stage === "models" && this.detail) return text.petModels(this.detail.part, this.detail.parts, percent(this.detail));
    return text.petStage(text.petStages[this.stage]);
  }

  /** The service answered `status`. A value that is not a boolean breaks the contract and counts as a failed ask. */
  status(installing: unknown): string | null {
    if (typeof installing !== "boolean") return this.statusFailed(messages.installLock.statusFieldMissing);
    this.failing = false;
    // A new install starts without the stage of an earlier one; an install that ended forgets its stage.
    if (installing !== this.known || !installing) { this.stage = null; this.detail = undefined; }
    this.known = installing;
    return null;
  }

  /** A `status` ask failed with `reason`. Returns the passing notice for the first failure of a run, else null. */
  statusFailed(reason: string): string | null {
    if (this.failing) return null;
    this.failing = true;
    return messages.installLock.statusFailed(reason);
  }

  /** A `pet-progress` event. While an install runs its stages change the line; an install stage while none is known
   * asks the service, which is how the pet learns that an install started. Other stages change nothing. */
  progress(event: ProgressEvent): InstallProgressStep {
    if (!isInstallStage(event.stage)) return "none";
    if (this.known !== true) return "ask";
    this.stage = event.stage;
    this.detail = event.detail;
    return "text";
  }
}

/** How much of the current file arrived, in whole percent, or null when its size is unknown. */
function percent(detail: ProgressDetail): number | null {
  if (detail.total <= 0) return null;
  return Math.min(100, Math.floor((Math.min(detail.loaded, detail.total) / detail.total) * 100));
}
