import { errorMessage, native, request } from "./bridge.ts";
import { activeSaves, DRAFT_EVENT, finishSubmission, readSubmissions, returnToDraft } from "./drafts.ts";
import { button, confirmAction, element, type Notice } from "./dom.ts";
import { messages } from "./messages.ts";
import { openMemory } from "./memory-view.ts";
import { recordSave, renderRecentSaves } from "./recent-history.ts";
import { confirmedEntry, saveEntry } from "./recent-history-model.ts";
import { pendingEntryStatusText, saveCheckOutcome } from "./recovery-model.ts";
import { submissionIsActive } from "./state.ts";

export function renderRecovery(host: HTMLElement, notice: Notice): () => void {
  host.replaceChildren();
  let live = true, generation = 0;
  const title = element("h1", "result-title", messages.feedback.recovery);
  const intro = element("p", "muted", messages.composer.pendingCheck);
  const list = element("div", "outbox");
  const recent = element("section", "recent-list");
  host.append(title, intro, list, recent);
  const stopRecent = renderRecentSaves(recent, notice);
  /** Adds a handled save to the recent list; a failure is told on the status line, the save itself already ended. */
  const remember = (write: () => void) => {
    try { write(); } catch (error) { notice(messages.recent.recordFailed(errorMessage(error)), "error"); }
  };

  async function refresh() {
    const revision = ++generation;
    let submissions;
    try { submissions = readSubmissions(); }
    catch (error) { notice(errorMessage(error), "error"); return; }
    let active: string[] = [], statusKnown = !native;
    let statusError: string | undefined;
    if (native && submissions.length) {
      // An unreachable sidecar cannot prove that a write has stopped, so `busy` still defaults to
      // true below (safe assumption) -- but the cause must stay visible instead of silently
      // reusing the ordinary "saving" text (PW-1).
      try { active = (await request("status", {})).activeOperations; statusKnown = true; }
      catch (error) { statusError = errorMessage(error); }
    }
    if (!live || revision !== generation) return;
    list.replaceChildren();
    if (!submissions.length) { list.append(element("p", "hint", messages.feedback.noPending)); return; }
    for (const item of submissions) {
      const unknownDueToStatusFailure = !statusKnown && !!item.operationId;
      const busy = activeSaves.has(item.requestId) || submissionIsActive(item, active) || unknownDueToStatusFailure;
      const record = element("details", "settings-details");
      const statusText = pendingEntryStatusText(busy, unknownDueToStatusFailure, statusError);
      record.append(element("summary", "", statusText), element("p", "answer", item.content));
      if (busy) {
        record.append(button(messages.composer.stopSending, async () => {
          const id = item.operationId ?? activeSaves.get(item.requestId);
          if (id) await request("operation.cancel", { requestId: id }).catch(error => notice(messages.composer.cancelNotDelivered(errorMessage(error)), "error"));
        }));
      } else {
        if (item.audience) record.append(button(messages.composer.checkSave, async () => {
          try {
            const result = await request("memory.status", { requestId: item.requestId, audience: item.audience! });
            const outcome = saveCheckOutcome(result);
            finishSubmission(item.requestId, outcome.settled);
            notice(outcome.text, outcome.tone);
            const entry = saveEntry(item.content, result, item.audience!, new Date().toISOString());
            if (entry) remember(() => recordSave(entry));
            if (result.memory && live) void openMemory(result.memory, notice);
            void refresh();
          } catch (error) { notice(errorMessage(error), "error"); }
        }));
        else record.append(element("p", "hint", messages.feedback.connectionChanged));
        record.append(button(messages.composer.confirmSaved, async () => {
          if (await confirmAction(messages.composer.confirmSavedTitle, messages.composer.confirmSavedBody, messages.composer.confirmSavedAction)) {
            try {
              finishSubmission(item.requestId, true); notice(messages.composer.cleanConfirmed);
              remember(() => recordSave(confirmedEntry(item.content, new Date().toISOString()))); void refresh();
            }
            catch (error) { notice(errorMessage(error), "error"); }
          }
        }));
        record.append(button(messages.composer.restoreDraft, async () => {
          if (await confirmAction(messages.composer.restoreDraftTitle, messages.composer.restoreDraftBody, messages.composer.restoreDraftAction)) {
            try { returnToDraft(item.requestId); notice(messages.composer.draftRestored); void refresh(); }
            catch (error) { notice(errorMessage(error), "error"); }
          }
        }));
      }
      list.append(record);
    }
  }
  const refreshOnStorage = (event: StorageEvent) => { if (event.key?.startsWith("bara.pet.")) void refresh(); };
  const refreshOnLocal = () => { void refresh(); };
  window.addEventListener("storage", refreshOnStorage);
  document.addEventListener(DRAFT_EVENT, refreshOnLocal);
  void refresh();
  return () => { live = false; generation++; stopRecent(); window.removeEventListener("storage", refreshOnStorage); document.removeEventListener(DRAFT_EVENT, refreshOnLocal); };
}
