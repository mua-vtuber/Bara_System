import { errorMessage } from "./bridge.ts";
import { button, element, type Notice } from "./dom.ts";
import { memoryCard, openMemory } from "./memory-view.ts";
import { labels, messages } from "./messages.ts";
import { parseAnswers, parseSaves, pushRecent, saveOutcomeText, type RecentAnswer, type RecentSave } from "./recent-history-model.ts";

/** The recent questions and saves of this PC's Pet. They live in the windows' shared storage like the draft and the
 * outbox (`drafts.ts`), so the quick strip writes them and the large window reads them. */
const ANSWERS_KEY = "bara.pet.recent-answers.v1";
const SAVES_KEY = "bara.pet.recent-saves.v1";
/** Sent in the window that wrote a list; the other windows hear the write through the `storage` event. */
const RECENT_EVENT = "bara-recent-updated";

export const readRecentAnswers = () => parseAnswers(localStorage.getItem(ANSWERS_KEY), ANSWERS_KEY);
export const readRecentSaves = () => parseSaves(localStorage.getItem(SAVES_KEY), SAVES_KEY);

export function recordAnswer(entry: RecentAnswer): void {
  localStorage.setItem(ANSWERS_KEY, JSON.stringify(pushRecent(readRecentAnswers(), entry)));
  document.dispatchEvent(new Event(RECENT_EVENT));
}
export function recordSave(entry: RecentSave): void {
  localStorage.setItem(SAVES_KEY, JSON.stringify(pushRecent(readRecentSaves(), entry)));
  document.dispatchEvent(new Event(RECENT_EVENT));
}

const timeFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const labelOf = (kind: string) => (labels as Record<string, string>)[kind] ?? messages.memory.unknownCategory(kind);

/** Draws `draw` into `host` now and again whenever a list changes in any window; returns the cleanup. */
function live(host: HTMLElement, key: string, draw: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) draw(); };
  window.addEventListener("storage", onStorage);
  document.addEventListener(RECENT_EVENT, draw);
  draw();
  return () => { window.removeEventListener("storage", onStorage); document.removeEventListener(RECENT_EVENT, draw); host.replaceChildren(); };
}

/** The last answers, newest first and open; the older ones show their question until opened. */
export function renderRecentAnswers(host: HTMLElement, notice: Notice): () => void {
  return live(host, ANSWERS_KEY, () => {
    host.replaceChildren(element("h2", "recent-heading", messages.recent.answersHeading));
    let entries: RecentAnswer[];
    try { entries = readRecentAnswers(); }
    catch (error) { host.append(element("p", "hint recent-error", errorMessage(error))); return; }
    if (!entries.length) { host.append(element("p", "hint", messages.recent.answersEmpty)); return; }
    entries.forEach((entry, index) => {
      const record = element("details", "recent-entry"); record.open = index === 0;
      const summary = element("summary", "recent-summary");
      summary.append(element("span", "recent-question", entry.question), element("span", "recent-time", timeFormat.format(new Date(entry.at))));
      record.append(summary, element("p", "answer", entry.answer));
      // "search results only" is true only when there are results to show; a not-found answer has none.
      if (!entry.generated && entry.sources.length) record.append(element("p", "hint", messages.feedback.searchOnly));
      if (entry.sources.length && entry.audience) {
        record.append(element("h3", "sources-heading", messages.feedback.sourceHeading));
        const sources = element("div", "results");
        for (const source of entry.sources) sources.append(memoryCard({ ...source, audience: entry.audience }, memory => { void openMemory(memory, notice); }));
        record.append(sources);
      } else if (entry.sources.length) record.append(element("p", "hint", messages.feedback.connectionChanged));
      host.append(record);
    });
  });
}

/** The last saves that ended, newest first, each with how it was handled. */
export function renderRecentSaves(host: HTMLElement, notice: Notice): () => void {
  return live(host, SAVES_KEY, () => {
    host.replaceChildren(element("h2", "recent-heading", messages.recent.savesHeading));
    let entries: RecentSave[];
    try { entries = readRecentSaves(); }
    catch (error) { host.append(element("p", "hint recent-error", errorMessage(error))); return; }
    if (!entries.length) { host.append(element("p", "hint", messages.recent.savesEmpty)); return; }
    for (const entry of entries) {
      const record = element("div", "recent-save");
      record.dataset.outcome = entry.outcome.kind;
      const top = element("div", "recent-save-top");
      top.append(element("span", "recent-outcome", saveOutcomeText(entry.outcome, labelOf)), element("span", "recent-time", timeFormat.format(new Date(entry.at))));
      record.append(top, element("p", "recent-content", entry.content));
      const { memoryId, audience } = entry;
      if (memoryId && audience) record.append(button(messages.recent.openMemory, () => openMemory({ id: memoryId, content: entry.content, audience }, notice), "text-button"));
      host.append(record);
    }
  });
}
