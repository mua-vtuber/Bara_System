import type { SelfUpdateStatus } from "../../shared/contracts.ts";
import type { CheckOutcome, NotifiedRead, ReleaseInfo } from "./types.ts";

/** What the service keeps of its checks (spec 5.3). `available` survives a failed check, so a failure never turns an
 * offered version back into "current" and an install can go on with it. `failureNoticeId` is the number of the run of
 * failed checks the last check belongs to; `failureRuns` counts the runs so far. */
export interface CheckState {
  readonly check: SelfUpdateStatus["check"];
  readonly available: ReleaseInfo | null;
  readonly failure: { code: string; message: string } | null;
  readonly failureNoticeId: number | null;
  readonly failureRuns: number;
}

export const INITIAL_CHECK_STATE: CheckState = { check: "unknown", available: null, failure: null, failureNoticeId: null, failureRuns: 0 };

export function applyOutcome(previous: CheckState, outcome: CheckOutcome): CheckState {
  switch (outcome.kind) {
    case "current":
      return { check: "current", available: null, failure: null, failureNoticeId: null, failureRuns: previous.failureRuns };
    case "available":
      return { check: "available", available: outcome.release, failure: null, failureNoticeId: null, failureRuns: previous.failureRuns };
    case "failed": {
      // A failure after a success (or after no check) starts a new run, whose first failure the pet window shows (spec 5.4).
      const failureRuns = previous.check === "failed" ? previous.failureRuns : previous.failureRuns + 1;
      return { check: "failed", available: previous.available, failure: { code: outcome.code, message: outcome.message },
        failureNoticeId: failureRuns, failureRuns };
    }
  }
}

/** What the service could not write or read about the update, reported in `selfUpdate.status` (never hidden). */
export interface StatusProblems { logError: string | null; recordError: string | null }

/** `selfUpdate.status`. `notified` is the notice record (`self-update.json`) as read: while it could not be read, no
 * notice bubble is owed (it is not shown on a guess) and `problems.recordError` says why. */
export function publicStatus(state: CheckState, notified: NotifiedRead, problems: StatusProblems): SelfUpdateStatus {
  const available = state.available?.version ?? null;
  const owed = available !== null && notified.kind === "read" && available !== notified.version;
  return { check: state.check, available, failure: state.failure, failureNoticeId: state.failureNoticeId,
    announce: owed ? available : null, logError: problems.logError, recordError: problems.recordError };
}
