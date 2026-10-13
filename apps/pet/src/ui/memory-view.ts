import type { CaptureKind, Memory } from "../shared/contracts.ts";
import { CAPTURE_KINDS } from "../shared/contracts.ts";
import { command, errorMessage, request } from "./bridge.ts";
import { button, element, field, select, type Notice } from "./dom.ts";
import { labels, messages } from "./messages.ts";
import { editReloadKind, loadEditable, memoryEditRequest, reloadCategory, seedCategory, unknownCategoryNotice, type CategoryChoice } from "./memory-edit.ts";

export function memoryCard(memory: Memory, open: (memory: Memory) => void): HTMLElement {
  const card = element("button", "memory-card"); card.type = "button";
  const capture = memory.metadata?.capture;
  const unknownCapture = memory.metadata?.unknownCapture;
  const headingText = capture ? labels[capture.kind] : unknownCapture ? messages.memory.unknownCategory(unknownCapture.kind) : messages.memory.genericLabel;
  const heading = element("span", "memory-card-heading", headingText);
  const text = element("span", "memory-preview", memory.content);
  const footer = element("span", "memory-card-footer", messages.memory.sourceLabel(memory.id));
  card.append(heading, text, footer); card.addEventListener("click", () => open(memory)); return card;
}

export async function openMemory(memory: Memory, notice: Notice, initialStatus?: string): Promise<void> {
  if (!memory.audience) { notice(messages.feedback.connectionChanged, "error"); return; }
  let current: Memory;
  try { current = await request("memory.get", { id: memory.id, audience: memory.audience }); }
  catch (error) { notice(errorMessage(error), "error"); return; }
  const dialog = element("dialog", "memory-dialog");
  const top = element("div", "dialog-top");
  top.append(element("h2", "", messages.memory.originalHeading), button(messages.common.close, () => dialog.close(), "text-button"));
  const reading = element("article", "memory-reading", current.content);
  const editing = element("div", "memory-editing"); editing.hidden = true;
  // Seeded only when editing opens, from the server's tag-free `editableContent` (never the tagged original).
  const content = element("textarea", "memory-editor"); content.setAttribute("aria-label", messages.common.contentLabel);
  const category = select([["", messages.common.noCategory], ...CAPTURE_KINDS.map(kind => [kind, labels[kind]] as [string, string])], "");
  // The server category the select was last synced to; `memoryEditRequest` sends `capture` only when the
  // select differs from it (see `CategoryChoice`).
  let seededCategory: CategoryChoice["seeded"] = "";
  const categoryChoice = (): CategoryChoice => ({ seeded: seededCategory, selected: category.value as CaptureKind | "" });
  // Names the latest server category next to a choice the user made before a conflict reload.
  const latestCategory = element("p", "hint"); latestCategory.hidden = true;
  const applyCategory = (choice: CategoryChoice, latestLabel?: string) => {
    seededCategory = choice.seeded; category.value = choice.selected;
    latestCategory.textContent = latestLabel ? messages.memory.latestServerCategory(latestLabel) : ""; latestCategory.hidden = !latestLabel;
  };
  // The dialog re-fetches `current` from the server, which discards any caller-supplied detail (e.g. a
  // classification-failure reason from the save that opened this dialog). Surface it here instead, up front.
  const status = element("p", "hint", initialStatus ?? ""); status.setAttribute("role", "status");
  // A capture kind this Pet does not recognize (a newer server feature) is honest information, not a
  // user input error: the category select stays at "분류 없음" only because it cannot represent an
  // unknown kind, not because the user cleared it. The select is seeded at that same "", so a save that
  // leaves it alone omits `capture` and the server's unknown classification survives unless the user
  // actively picks a different category. This note names what is actually going on instead of leaving it
  // silently untouched, and follows `current` whenever the dialog re-reads the server.
  const unknownNotice = element("p", "hint");
  const showUnknownNotice = (latest: Memory) => {
    const text = unknownCategoryNotice(latest); unknownNotice.textContent = text ?? ""; unknownNotice.hidden = text === undefined;
  };
  showUnknownNotice(current); applyCategory(seedCategory(current));
  const actions = element("div", "dialog-actions");
  const loadLatest = () => loadEditable(() => request("memory.get", { id: current.id, audience: memory.audience! }), errorMessage);
  // What the last failed save calls for (`editReloadKind`); the reload button is shown only while this is set.
  let pendingReload: "saved" | "conflict" | undefined;
  const showSaved = () => {
    reading.textContent = current.content;
    editing.hidden = true; reading.hidden = false; save.hidden = true; reload.hidden = true; edit.hidden = false;
    status.textContent = messages.memory.edited; notice(messages.memory.updated, "success");
  };
  // `memory.update` answers with the memory re-read after the PATCH (or fails), so no second read is needed here.
  const save = button(messages.memory.saveEdit, async () => {
    if (!content.value.trim()) { status.textContent = messages.memory.emptyContent; return; }
    save.disabled = true; status.textContent = messages.memory.savingEdit;
    try {
      current = await request("memory.update", memoryEditRequest(current, content.value, categoryChoice()));
      pendingReload = undefined; showSaved();
    } catch (error) {
      status.textContent = errorMessage(error);
      pendingReload = editReloadKind(error); reload.hidden = pendingReload === undefined;
    }
    finally { save.disabled = false; }
  }, "button primary");
  save.hidden = true;
  // After a conflict the user's draft stays in the editor and the latest server text is shown above it, so
  // the next save is checked against the latest revision with the user having seen what changed.
  const reload = button(messages.memory.reloadLatest, async () => {
    reload.disabled = true; status.textContent = messages.memory.reloadingLatest;
    try { current = await loadLatest(); }
    catch (error) { status.textContent = errorMessage(error); return; }
    finally { reload.disabled = false; }
    const kind = pendingReload; pendingReload = undefined;
    if (kind === "saved") { showSaved(); return; }
    reading.textContent = current.content; reading.hidden = false; reload.hidden = true;
    const synced = reloadCategory(categoryChoice(), current);
    applyCategory(synced.choice, synced.latestLabel); showUnknownNotice(current);
    status.textContent = messages.memory.reloadedLatest;
  });
  reload.hidden = true;
  const edit = button(messages.memory.edit, async () => {
    edit.disabled = true;
    try {
      let editableBody = current.editableContent;
      if (editableBody === undefined) {
        const shownStatus = status.textContent; status.textContent = messages.memory.reloadingLatest;
        const latest = await loadLatest();
        current = latest; editableBody = latest.editableContent;
        reading.textContent = latest.content; status.textContent = shownStatus;
      }
      content.value = editableBody; applyCategory(seedCategory(current)); showUnknownNotice(current);
      editing.hidden = false; reading.hidden = true; edit.hidden = true; save.hidden = false; content.focus();
    } catch (error) { status.textContent = errorMessage(error); }
    finally { edit.disabled = false; }
  }, "button primary");
  actions.append(button(messages.memory.dashboard, async () => {
    try { await command("open_dashboard", { memoryId: current.id, audience: memory.audience, review: false }); }
    catch (error) { status.textContent = errorMessage(error); }
  }), edit, reload, save);
  editing.append(field(messages.memory.content, content));
  editing.append(unknownNotice, field(messages.memory.category, category), latestCategory);
  if (current.editableContent !== undefined && current.editableContent !== current.content) editing.append(element("p", "hint", messages.memory.preserveTags));
  dialog.append(top, reading, editing, status, actions);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}
