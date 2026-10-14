import type { Feedback } from "../shared/contracts.ts";
import { command, errorMessage, native, onFeedback, onUpdateBubble } from "./bridge.ts";
import { button, element } from "./dom.ts";
import { acceptFeedback, bubbleActionFailureText, bubbleLoadFailureSummary } from "./feedback-model.ts";
import { messages } from "./messages.ts";
import { mountUpdateCard } from "./update-bubble.ts";
import { INITIAL_BUBBLE_MODE, modeOnActionFailed, modeOnFeedback, modeOnUpdateEvent, type BubbleMode } from "./update-bubble-model.ts";

/** The bubble window: a result (`Feedback`) or the update bubble (spec 6.1), whichever `update-bubble-model.ts` says
 * holds it. Results and update events carry one host sequence, so the newer one wins, and a running download keeps
 * the bubble while results wait in "최근 결과". */
export function renderBubble(host: HTMLElement): () => void {
  host.replaceChildren();
  let live = true, current: Feedback | null = null, mode: BubbleMode = INITIAL_BUBBLE_MODE;
  const stops: Array<() => void> = [];
  const card = element("div", "feedback-card"); card.setAttribute("role", "button"); card.tabIndex = 0;
  card.setAttribute("aria-label", messages.feedback.openDetail);
  const summary = element("p", "feedback-summary", messages.feedback.noFeedback);
  const update = mountUpdateCard({ mode: () => mode, apply });
  // get_feedback/dismiss_feedback/open_feedback failures replace the summary text, the one line the
  // 170 px bubble always shows (PW-6); a separate warning paragraph ran past the card out of the window.
  // The next feedback that arrives replaces the failure text again. On the update bubble they show as its failure,
  // except during a download, which they do not stop: there they show next to the progress (`modeOnActionFailed`).
  function showFailure(text: string) {
    if (!live) return;
    if (mode.kind === "update") { apply(modeOnActionFailed(mode, text)); return; }
    host.dataset.kind = "error"; summary.textContent = text;
  }
  const dismiss = button(messages.feedback.dismissGlyph, async () => {
    await command("dismiss_feedback").catch(error => showFailure(bubbleActionFailureText("dismiss", errorMessage(error))));
  }, "feedback-dismiss");
  dismiss.setAttribute("aria-label", messages.feedback.dismiss);
  card.append(summary); host.append(card, update.element, dismiss);
  async function open() {
    if (!current) return;
    await command("open_feedback", { id: current.id }).catch(error => showFailure(bubbleActionFailureText("open", errorMessage(error))));
  }
  card.addEventListener("click", () => { void open(); });
  card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void open(); } });
  function apply(next: BubbleMode) {
    if (!live) return;
    mode = next;
    card.hidden = mode.kind === "update";
    update.element.hidden = mode.kind !== "update";
    if (mode.kind === "update") { host.dataset.kind = mode.phase === "failed" ? "error" : "update"; update.render(mode); }
    else if (current) { host.dataset.kind = current.kind; summary.textContent = current.summary; }
  }
  function display(incoming: Feedback) {
    if (!live) return;
    const next = modeOnFeedback(mode, incoming.sequence);
    if (next === mode) return;
    current = acceptFeedback(current, incoming);
    apply(next);
  }
  void onFeedback(display).then(async stop => {
    if (!live) { stop(); return; }
    stops.push(stop);
    if (native) {
      try { const latest = await command<Feedback | null>("get_feedback"); if (latest) display(latest); }
      catch (error) { showFailure(bubbleLoadFailureSummary(errorMessage(error))); }
    }
  });
  void onUpdateBubble(event => apply(modeOnUpdateEvent(mode, event)))
    .then(stop => { if (!live) stop(); else stops.push(stop); })
    .catch(error => showFailure(messages.selfUpdate.listenFailed(errorMessage(error))));
  return () => { live = false; for (const stop of stops.splice(0)) stop(); };
}
