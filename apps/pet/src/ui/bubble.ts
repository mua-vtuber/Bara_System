import type { Feedback } from "../shared/contracts.ts";
import { command, errorMessage, native, onFeedback } from "./bridge.ts";
import { button, element } from "./dom.ts";
import { acceptFeedback, bubbleActionFailureText, bubbleLoadFailureSummary } from "./feedback-model.ts";
import { messages } from "./messages.ts";

export function renderBubble(host: HTMLElement): () => void {
  host.replaceChildren();
  let live = true, current: Feedback | null = null, unlisten: (() => void) | undefined;
  const card = element("div", "feedback-card"); card.setAttribute("role", "button"); card.tabIndex = 0;
  card.setAttribute("aria-label", messages.feedback.openDetail);
  const summary = element("p", "feedback-summary", messages.feedback.noFeedback);
  // get_feedback/dismiss_feedback/open_feedback failures replace the summary text, the one line the
  // 170 px bubble always shows (PW-6); a separate warning paragraph ran past the card out of the window.
  // The next feedback that arrives replaces the failure text again.
  function showFailure(text: string) { if (!live) return; host.dataset.kind = "error"; summary.textContent = text; }
  const dismiss = button(messages.feedback.dismissGlyph, async () => {
    await command("dismiss_feedback").catch(error => showFailure(bubbleActionFailureText("dismiss", errorMessage(error))));
  }, "feedback-dismiss");
  dismiss.setAttribute("aria-label", messages.feedback.dismiss);
  card.append(summary); host.append(card, dismiss);
  async function open() {
    if (!current) return;
    await command("open_feedback", { id: current.id }).catch(error => showFailure(bubbleActionFailureText("open", errorMessage(error))));
  }
  card.addEventListener("click", () => { void open(); });
  card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void open(); } });
  function display(incoming: Feedback) {
    if (!live) return;
    current = acceptFeedback(current, incoming);
    host.dataset.kind = current.kind;
    summary.textContent = current.summary;
  }
  void onFeedback(display).then(async stop => {
    if (!live) { stop(); return; }
    unlisten = stop;
    if (native) {
      try { const latest = await command<Feedback | null>("get_feedback"); if (latest) display(latest); }
      catch (error) { showFailure(bubbleLoadFailureSummary(errorMessage(error))); }
    }
  });
  return () => { live = false; unlisten?.(); };
}
