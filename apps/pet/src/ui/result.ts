import type { Feedback } from "../shared/contracts.ts";
import { command } from "./bridge.ts";
import { button, element, type Notice } from "./dom.ts";
import { openedMemoryInitialStatus } from "./feedback-model.ts";
import { openMemory } from "./memory-view.ts";
import { messages } from "./messages.ts";
import { renderRecentAnswers } from "./recent-history.ts";
import { renderRecovery } from "./recovery.ts";

/** With no result, or an answer, the screen is the recent questions and answers (the answer is the newest of them).
 * Any other result (a save, work in progress, a failure) is shown first, with the recent answers under it. */
export function renderResult(host: HTMLElement, feedback: Feedback | null, notice: Notice, openSettings: () => void): () => void {
  host.replaceChildren();
  let live = true;
  if (!feedback || feedback.kind === "answer") {
    host.append(element("h1", "result-title", messages.feedback.resultHeading));
    const recent = element("section", "recent-answers");
    host.append(recent);
    const stopRecent = renderRecentAnswers(recent, notice);
    const actions = element("div", "stack-actions");
    actions.append(button(messages.feedback.openQuickInput, () => command("open_quick", { mode: "input" })),
      button(messages.feedback.openQuickQuestion, () => command("open_quick", { mode: "question" })));
    host.append(actions);
    return () => { live = false; stopRecent(); };
  }
  const title = feedback.kind === "saved" ? messages.feedback.savedHeading
    : feedback.kind === "working" ? messages.feedback.workingHeading : messages.feedback.errorHeading;
  host.append(element("h1", "result-title", title), element("p", "result-summary", feedback.summary));
  if (feedback.detail.trim() && feedback.detail.trim() !== feedback.summary.trim()) host.append(element("p", "answer", feedback.detail));
  let stopRecovery = () => {};
  if (feedback.kind === "error") {
    const actions = element("div", "stack-actions");
    actions.append(button(messages.feedback.settings, openSettings));
    host.append(actions);
    const recovery = element("section", "result-recovery"); host.append(recovery);
    stopRecovery = renderRecovery(recovery, notice);
  }
  if (feedback.kind === "saved" && feedback.memoryId && feedback.audience) {
    // One bubble click opens the original record; the large window is only its host.
    // openMemory re-fetches the memory from the server, which would otherwise silently drop
    // `feedback.detail` (the classification-failure text) — so pass it through as the dialog's initial status.
    queueMicrotask(() => { if (live) void openMemory({ id: feedback.memoryId!, content: feedback.detail, audience: feedback.audience }, notice, openedMemoryInitialStatus(feedback)); });
  } else if (feedback.kind === "saved" && feedback.memoryId) {
    host.append(element("p", "hint", messages.feedback.connectionChanged));
  }
  const recent = element("section", "recent-list"); host.append(recent);
  const stopRecent = renderRecentAnswers(recent, notice);
  return () => { live = false; stopRecovery(); stopRecent(); };
}
