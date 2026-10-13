import type { Feedback } from "../shared/contracts.ts";
import { command } from "./bridge.ts";
import { button, element, type Notice } from "./dom.ts";
import { openedMemoryInitialStatus } from "./feedback-model.ts";
import { memoryCard, openMemory } from "./memory-view.ts";
import { messages } from "./messages.ts";
import { renderRecovery } from "./recovery.ts";

export function renderResult(host: HTMLElement, feedback: Feedback | null, notice: Notice, openSettings: () => void): () => void {
  host.replaceChildren();
  let live = true;
  if (!feedback) {
    host.append(element("h1", "result-title", messages.feedback.resultHeading), element("p", "hint", messages.feedback.noFeedback));
    const actions = element("div", "stack-actions");
    actions.append(button(messages.feedback.openQuickInput, () => command("open_quick", { mode: "input" })),
      button(messages.feedback.openQuickQuestion, () => command("open_quick", { mode: "question" })));
    host.append(actions);
    return () => { live = false; };
  }
  const title = feedback.kind === "answer" ? messages.feedback.resultHeading : feedback.kind === "saved" ? messages.feedback.savedHeading
    : feedback.kind === "working" ? messages.feedback.workingHeading : messages.feedback.errorHeading;
  host.append(element("h1", "result-title", title), element("p", "result-summary", feedback.summary));
  if (feedback.kind === "answer" && feedback.generated === false) host.append(element("p", "hint", messages.feedback.searchOnly));
  if (feedback.detail.trim() && feedback.detail.trim() !== feedback.summary.trim()) host.append(element("p", "answer", feedback.detail));
  if (feedback.kind === "answer" && feedback.sources?.length && feedback.audience) {
    host.append(element("h2", "sources-heading", messages.feedback.sourceHeading));
    const sources = element("div", "results");
    for (const source of feedback.sources) sources.append(memoryCard({ ...source, audience: feedback.audience }, memory => { void openMemory(memory, notice); }));
    host.append(sources);
  } else if (feedback.kind === "answer" && feedback.sources?.length) {
    host.append(element("p", "hint", messages.feedback.connectionChanged));
  }
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
  return () => { live = false; stopRecovery(); };
}
