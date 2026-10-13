import { MEMORY_EDIT_ERROR_CODES, type CaptureKind, type Memory, type RpcOperations } from "../shared/contracts.ts";
import { hostErrorCode } from "./error-text.ts";
import { labels, messages } from "./messages.ts";

/** The category select in one edit session. `seeded` is the server category the select was last synced
 * to (when editing opened, or when a reload after a conflict re-read the server); `selected` is its value
 * now. The select cannot represent an `unknownCapture` kind (it is not one of `CAPTURE_KINDS`), so such a
 * memory seeds "" -- the same value as "분류 없음". */
export interface CategoryChoice { seeded: CaptureKind | ""; selected: CaptureKind | "" }

export function seedCategory(memory: Memory): CategoryChoice {
  const kind = memory.metadata?.capture?.kind ?? "";
  return { seeded: kind, selected: kind };
}

/** Whether the user moved the select away from the server category it was last synced to. */
export function categoryChanged(choice: CategoryChoice): boolean {
  return choice.selected !== choice.seeded;
}

/** A memory's server category as the editor names it: a known kind's label, an unknown kind named as
 * such, or "분류 없음". */
export function categoryLabel(memory: Memory): string {
  const capture = memory.metadata?.capture;
  const unknownCapture = memory.metadata?.unknownCapture;
  return capture ? labels[capture.kind] : unknownCapture ? messages.memory.unknownCategory(unknownCapture.kind) : messages.common.noCategory;
}

/** The note shown beside the category select for a server kind this Pet does not recognize, or none. */
export function unknownCategoryNotice(memory: Memory): string | undefined {
  const unknownCapture = memory.metadata?.unknownCapture;
  return unknownCapture ? `${messages.memory.unknownCategory(unknownCapture.kind)} · ${messages.memory.unknownCategoryHint}` : undefined;
}

/** The category select after "reload the latest" following a refused (stale) save. The select's baseline
 * always becomes the latest server category, because that is what the next save is checked against:
 * - a select the user left alone follows the latest server category, so the next save omits `capture`
 *   and never puts back the value this dialog read before someone else changed it;
 * - a select the user changed keeps the user's choice, which is still sent on the next save, and
 *   `latestLabel` names the latest server category so the user sees what that choice will replace.
 *   When the user's choice already equals the latest server category there is nothing to replace and
 *   no note. */
export function reloadCategory(choice: CategoryChoice, latest: Memory): { choice: CategoryChoice; latestLabel?: string } {
  const synced = seedCategory(latest);
  if (!categoryChanged(choice)) return { choice: synced };
  const next: CategoryChoice = { seeded: synced.seeded, selected: choice.selected };
  return categoryChanged(next) ? { choice: next, latestLabel: categoryLabel(latest) } : { choice: next };
}

/** `capture` is sent only when the user changed the category select in this edit session
 * (`categoryChanged`); a select left at its synced value omits `capture`, leaving the server's value
 * untouched. That one rule covers both ways an unchanged select could otherwise overwrite the server:
 * - an `unknownCapture` kind seeds the select at "", and sending that "" as `capture: null` on a
 *   body-only edit would erase the server's classification;
 * - a category changed elsewhere after this dialog read it would be silently reverted by re-sending the
 *   stale select value on the save that follows a conflict reload (`reloadCategory` re-syncs it).
 * A deliberate change sends `{ kind, source: "user" }`, or `null` when a known category is cleared to "".
 * There is currently no UI path to deliberately clear an unknown classification. A save that changes
 * neither body nor category is refused here instead of sending an empty edit.
 *
 * The edited body is compared only against the server's tag-free `editableContent`. Falling back to the
 * tagged `content` would send the raw original, tags included, as the new body, so a memory without
 * `editableContent` cannot produce a request at all; neither can one without a revision, since the
 * server's stale-edit check needs the revision the user actually edited. */
export function memoryEditRequest(memory: Memory, editedBody: string, category: CategoryChoice): RpcOperations["memory.update"]["params"] {
  if (!memory.audience) throw new Error(messages.memory.audienceMissing);
  if (memory.editableContent === undefined) throw new Error(messages.memory.editableBodyMissing);
  if (memory.revision === undefined) throw new Error(messages.memory.editRevisionMissing);
  const bodyChanged = editedBody !== memory.editableContent;
  const sendCapture = categoryChanged(category);
  if (!bodyChanged && !sendCapture) throw new Error(messages.memory.nothingToSave);
  return { id: memory.id, audience: memory.audience, expectedRevision: memory.revision,
    ...(bodyChanged ? { content: editedBody } : {}),
    ...(sendCapture ? { capture: category.selected ? { kind: category.selected, source: "user" } : null } : {}) };
}

export type EditableMemory = Memory & { editableContent: string };

/** Reads the latest memory for the editor. A read that fails, or that answers without the server's
 * tag-free `editableContent`, blocks the edit with its cause instead of letting the tagged original stand
 * in for the editable body (user decision on WP-P2-09: never PATCH the tagged original). */
export async function loadEditable(reload: () => Promise<Memory>, describe: (error: unknown) => string): Promise<EditableMemory> {
  let latest: Memory;
  try { latest = await reload(); }
  catch (error) { throw new Error(messages.memory.editReloadFailed(describe(error)), { cause: error }); }
  const { editableContent } = latest;
  if (editableContent === undefined) throw new Error(messages.memory.editableBodyMissing);
  return { ...latest, editableContent };
}

/** Which "reload the latest" the edit dialog offers after a failed save: `saved` when the edit reached the
 * server but its read-back failed, `conflict` when the server refused a stale edit; otherwise none. The
 * service's code arrives in the native host's rejection object (`HostErrorPayload`). */
export function editReloadKind(error: unknown): "saved" | "conflict" | undefined {
  const code = hostErrorCode(error);
  if (code === MEMORY_EDIT_ERROR_CODES.rereadFailed) return "saved";
  if (code === MEMORY_EDIT_ERROR_CODES.conflict || code === MEMORY_EDIT_ERROR_CODES.captureConflict) return "conflict";
  return undefined;
}
