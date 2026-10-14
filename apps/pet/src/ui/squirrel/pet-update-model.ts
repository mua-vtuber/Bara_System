import type { SelfUpdateStatus } from "../../shared/contracts.ts";
import { messages } from "../messages.ts";

/** What one `selfUpdate.status` answer changes on the pet window: the version the update button offers (null hides
 * it, spec 5.3), a passing notice-line text, and the version whose notice bubble is still owed. */
export interface PetUpdateStep { buttonVersion: string | null; notice: string | null; announce: string | null }

/** The pet window's rules for its own update (spec 5.3, 5.4): the first failure of each run of failed checks shows on
 * the notice line once (the service numbers the runs), a log or a notice record that cannot be used shows once, and a failure to ask
 * the service shows once until an answer comes again. */
export class PetUpdateModel {
  private shownFailure: number | null = null;
  private shownLogError: string | null = null;
  private shownRecordError: string | null = null;
  private pollFailing = false;

  status(status: SelfUpdateStatus): PetUpdateStep {
    this.pollFailing = false;
    return { buttonVersion: status.available, notice: this.noticeFor(status), announce: status.announce };
  }

  pollFailed(reason: string): string | null {
    if (this.pollFailing) return null;
    this.pollFailing = true;
    return messages.selfUpdate.statusFailed(reason);
  }

  private noticeFor(status: SelfUpdateStatus): string | null {
    if (status.failure !== null && status.failureNoticeId !== null && status.failureNoticeId !== this.shownFailure) {
      this.shownFailure = status.failureNoticeId;
      return messages.selfUpdate.checkFailed(status.failure.message);
    }
    if (status.logError !== null && status.logError !== this.shownLogError) {
      this.shownLogError = status.logError;
      return messages.selfUpdate.logFailed(status.logError);
    }
    if (status.recordError !== null && status.recordError !== this.shownRecordError) {
      this.shownRecordError = status.recordError;
      return messages.selfUpdate.recordFailed(status.recordError);
    }
    return null;
  }
}
