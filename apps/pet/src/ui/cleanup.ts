import { messages } from "./messages.ts";
import { connectionAudience, type CleanupFailure, type CleanupProvider, type CleanupRejection, type CleanupResult } from "../shared/contracts.ts";
import { command, errorMessage, onProgress, request } from "./bridge.ts";
import { button, element, type Notice } from "./dom.ts";

/** Whether the "정리 제안 만들기" button may run, and the notice to show for the unconfigured state
 * (PV-9/WP-P2-16): a cleanup provider of `"none"` -- never chosen yet -- must disable the run button
 * and name what is missing, instead of silently defaulting to a specific AI. */
export function cleanupAvailability(provider: CleanupProvider): { canRun: boolean; notice?: string } {
  return provider === "none" ? { canRun: false, notice: messages.cleanup.notConfigured } : { canRun: true };
}

/** Codes whose sentence is always one of the Pet's own Korean texts (`messages.cleanupService`), which
 * already says what was wrong, so the code is left off the screen. */
const PET_SENTENCE_CODES: ReadonlySet<string> = new Set(["AI_PROPOSAL"]);

/** One failure's cause in Korean: the fixed text for a known code, the Pet's own sentence for a code that
 * always carries one, otherwise the code with the cause sentence that came with it (the server's tool
 * message or the Pet's own error text). */
export function cleanupFailureReason(failure: CleanupFailure): string {
  if (Object.hasOwn(messages.cleanup.failureReasons, failure.code)) return messages.cleanup.failureReasons[failure.code]!;
  if (PET_SENTENCE_CODES.has(failure.code) && failure.message.trim()) return failure.message;
  return messages.cleanup.failureWithCause(failure.code, failure.message);
}

/** Each distinct failure cause in Korean, joined for one sentence. */
function failureReasons(failures: readonly CleanupFailure[]): string {
  return [...new Set(failures.map(cleanupFailureReason))].join(" / ");
}

/** One quality-check rejection in Korean: the fixed text for a known check, otherwise the check name with the
 * server's own sentence. */
export function cleanupRejectionReason(rejection: CleanupRejection): string {
  if (Object.hasOwn(messages.cleanup.rejectionReasons, rejection.reason)) return messages.cleanup.rejectionReasons[rejection.reason]!;
  return messages.cleanup.failureWithCause(rejection.reason, rejection.detail);
}

/** The notice text and severity for a finished cleanup.run() result (WP-P2-02): a run that skipped
 * candidates with a known cause shows an error notice instead of a bare success banner. The causes
 * themselves stand once, in the result paragraph (`cleanupResultText`), so the screen does not say them twice. */
export function cleanupRunNotice(result: CleanupResult): { text: string; kind: "success" | "error" } {
  if (result.skipped > 0 && result.failures?.length)
    return { text: result.rejected
      ? messages.cleanup.submittedWithFailuresAndRejections(result.submitted, result.skipped, result.rejected)
      : messages.cleanup.submittedWithFailures(result.submitted, result.skipped), kind: "error" };
  // A proposal the server's quality checks turned down is an honest outcome of the run, not a failure.
  if (result.rejected)
    return { text: messages.cleanup.submittedWithRejections(result.submitted, result.rejected), kind: "success" };
  return { text: messages.cleanup.submitted(result.submitted), kind: "success" };
}

/** The result paragraph under the buttons (WP-PFIX-5), written from the run's counts and failures with
 * the same Korean causes as the notice. The service's own sentence is not used, so no failure code
 * reaches the screen without its Korean text or the cause sentence that came with it. */
export function cleanupResultText(result: CleanupResult): string {
  const parts = [messages.cleanup.resultCounts(result.submitted, result.noFinding)];
  if (result.rejected) {
    // Each distinct reason once; the notice only gives the count.
    const reasons = result.rejections?.length ? [...new Set(result.rejections.map(cleanupRejectionReason))].join(" / ") : undefined;
    parts.push(messages.cleanup.resultRejected(result.rejected, reasons));
  }
  if (result.skipped > 0) parts.push(messages.cleanup.resultSkipped(result.skipped, result.failures?.length ? failureReasons(result.failures) : undefined));
  return parts.join(" ");
}

export function renderCleanup(host: HTMLElement, notice: Notice): () => void {
  host.replaceChildren(); let active = ""; let live = true; let runAudience: string | undefined; let configured = false;
  const intro = element("div", "composer-intro");
  intro.append(element("h1", "", messages.cleanup.heading), element("p", "muted", messages.cleanup.intro));
  const result = element("div", "results"); result.setAttribute("aria-live", "polite");
  const run = button(messages.cleanup.create, async () => {
    if (active || !configured) return; active = crypto.randomUUID(); run.disabled = true; cancel.hidden = false;
    notice(messages.cleanup.progress);
    try {
      const response = await request("cleanup.run", { limit: 5 }, active);
      if (live) {
        runAudience = response.audience; result.replaceChildren(element("p", "answer", cleanupResultText(response)));
        const outcome = cleanupRunNotice(response);
        notice(outcome.text, outcome.kind);
      }
    } catch (error) { if (live) notice(errorMessage(error), "error"); }
    finally { active = ""; if (live) { run.disabled = !configured; cancel.hidden = true; } }
  }, "button primary");
  run.disabled = true;
  const cancel = button(messages.cleanup.cancel, async () => {
    if (active) await request("operation.cancel", { requestId: active }).catch((error) => { if (live) notice(messages.cleanup.cancelFailed(errorMessage(error)), "error"); });
  }); cancel.hidden = true;
  const review = button(messages.cleanup.review, async () => { try {
    const audience = runAudience ?? connectionAudience((await request("settings.get", {})).connection);
    await command("open_dashboard", { review: true, audience });
  } catch (error) { notice(errorMessage(error), "error"); } });
  const actions = element("div", "stack-actions"); actions.append(run, cancel, review);
  const notConfigured = element("p", "hint", messages.cleanup.notConfigured); notConfigured.hidden = true;
  host.append(intro, actions, element("p", "hint", messages.cleanup.settingsHint), notConfigured, result);
  let stop: (() => void) | undefined;
  void onProgress(event => { if (live && event.requestId === active) notice(messages.progress[event.stage]); }).then(fn => { if (live) stop = fn; else fn(); });
  void request("settings.get", {}).then((settings) => {
    if (!live) return;
    const availability = cleanupAvailability(settings.cleanup.provider);
    configured = availability.canRun;
    notConfigured.hidden = availability.canRun;
    if (!active) run.disabled = !configured;
  }).catch((error) => { if (live) notice(errorMessage(error), "error"); });
  return () => { live = false; stop?.(); };
}
