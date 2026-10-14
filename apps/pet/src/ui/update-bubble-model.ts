import type { ProgressDetail, ProgressStage, UpdateBubbleEvent, UpdateBubblePhase } from "../shared/contracts.ts";
import { downloadPercent } from "../shared/self-update.ts";
import { messages } from "./messages.ts";

/** Where a running update is: downloading (with its percent), checking the file, or starting the installer. */
export type BusyStep = { step: "download"; percent: number } | { step: "verify" } | { step: "launch" };
/** The update bubble (spec 6.1). `starting` is set by the first "yes" and stops a second one. `note` is a result
 * action's failure that came during a download: it shows next to the progress and does not stop the download. */
export interface UpdateMode {
  kind: "update"; phase: UpdateBubblePhase; version: string; sequence: number;
  busy: BusyStep | null; failure: string | null; starting: boolean; note: string | null;
}
/** What the bubble shows: results, or the update bubble. `sequence` is the host's number of the last event shown. */
export type BubbleMode = { kind: "feedback"; sequence: number } | UpdateMode;

export const INITIAL_BUBBLE_MODE: BubbleMode = { kind: "feedback", sequence: -1 };

/** A result arrived (spec 6.1 and the plan's "말풍선 우선순위 규칙"): a running download keeps the bubble, and a result
 * older than what the bubble shows is dropped; otherwise the result takes the bubble. The same object comes back when
 * nothing changes. */
export function modeOnFeedback(mode: BubbleMode, sequence: number | undefined): BubbleMode {
  if (mode.kind === "update" && mode.phase === "busy") return mode;
  const at = sequence ?? -1;
  return at < mode.sequence ? mode : { kind: "feedback", sequence: at };
}

/** The host changed the update phase. The download's step and a failure's cause, which only this bubble knows,
 * are kept for the same version; so is a started install, so a repeated `confirm` event cannot allow a second one. */
export function modeOnUpdateEvent(mode: BubbleMode, event: UpdateBubbleEvent): BubbleMode {
  if (event.sequence < mode.sequence) return mode;
  const same = mode.kind === "update" && mode.version === event.version ? mode : null;
  return { kind: "update", phase: event.phase, version: event.version, sequence: event.sequence,
    busy: event.phase === "busy" ? same?.busy ?? { step: "download", percent: 0 } : null,
    failure: event.phase === "failed" ? same?.failure ?? null : null,
    starting: event.phase === "confirm" && same?.starting === true,
    note: event.phase === "busy" ? same?.note ?? null : null };
}

/** "Yes" on the question: the next mode, or null when the click must do nothing (not the question, or already started). */
export function modeOnYes(mode: BubbleMode): UpdateMode | null {
  return mode.kind === "update" && mode.phase === "confirm" && !mode.starting ? { ...mode, starting: true } : null;
}

export function modeOnProgress(mode: BubbleMode, stage: ProgressStage, detail?: ProgressDetail): BubbleMode {
  if (mode.kind !== "update" || mode.phase !== "busy") return mode;
  if (stage === "self-update-download") {
    const previous = mode.busy?.step === "download" ? mode.busy.percent : 0;
    return { ...mode, busy: { step: "download", percent: downloadPercent(detail) ?? previous } };
  }
  return stage === "self-update-verify" ? { ...mode, busy: { step: "verify" } } : mode;
}

export function modeOnLaunching(mode: BubbleMode): BubbleMode {
  return mode.kind === "update" && mode.phase === "busy" ? { ...mode, busy: { step: "launch" } } : mode;
}

/** The download, the launch or a bubble step failed: the failure with its cause shows at once; the host's own
 * `failed` event that follows keeps it. */
export function modeOnInstallFailed(mode: BubbleMode, version: string, text: string): UpdateMode {
  return { kind: "update", phase: "failed", version, sequence: mode.sequence, busy: null, failure: text, starting: false, note: null };
}

/** A result action (load, open, dismiss) failed while the update bubble shows (`bubble.ts`). During a download the
 * download is not this failure's to stop: the text shows next to the progress and the phase stays. Otherwise it shows
 * as the update bubble's failure. */
export function modeOnActionFailed(mode: UpdateMode, text: string): UpdateMode {
  return mode.phase === "busy" ? { ...mode, note: text } : modeOnInstallFailed(mode, mode.version, text);
}

/** What the update bubble shows: its one line, whether the yes/no buttons show, and whether a click opens the question. */
export interface UpdateBubbleView { summary: string; answers: boolean; opensConfirm: boolean }

export function updateBubbleView(mode: UpdateMode): UpdateBubbleView {
  const text = messages.selfUpdate;
  switch (mode.phase) {
    case "notice": return { summary: text.notice(mode.version), answers: false, opensConfirm: true };
    case "confirm": return { summary: text.confirm(mode.version), answers: true, opensConfirm: false };
    case "busy": {
      const step = mode.busy ?? { step: "download", percent: 0 };
      const progress = step.step === "download" ? text.downloading(step.percent) : step.step === "verify" ? text.verifying : text.launching;
      return { summary: mode.note === null ? progress : text.busyWithNote(progress, mode.note), answers: false, opensConfirm: false };
    }
    case "failed": return { summary: mode.failure ?? text.failedNoCause, answers: false, opensConfirm: false };
  }
}
