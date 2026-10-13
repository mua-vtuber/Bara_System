import { errorText } from "./error-text.ts";
import { isStorageBlocked, type QuickMode, type StorageNotices } from "./feedback-model.ts";
import { messages } from "./messages.ts";

/** What the quick strip's send button depends on. `notices` is the draft-store accesses that fail right now
 * (`StorageNotices`), `activeSaves` the saves of this window still running, and `unresolved` whether the
 * submission outbox still holds an entry that has no receipt. */
export interface QuickSendInputs {
  mode: QuickMode; busy: boolean; hasText: boolean; notices: StorageNotices; activeSaves: number; unresolved: boolean;
}
export interface QuickSendState { disabled: boolean; title: string }

/** Whether the send button is off, and the tooltip it carries. Sending an input waits for every failing
 * draft-store access to work again (the block is derived from `notices`, so it lifts by itself), for the
 * saves under way, and for the receipts of earlier saves; a question touches none of the draft store, so
 * only an empty field or a running send holds it. The tooltip names the storage fault whenever one is
 * failing, because that is the cause the user can act on. */
export function quickSendState(input: QuickSendInputs): QuickSendState {
  const storageBlocked = isStorageBlocked(input.notices);
  const sendingInput = input.mode === "input";
  return {
    disabled: input.busy || !input.hasText || (sendingInput && (storageBlocked || input.activeSaves > 0 || input.unresolved)),
    title: storageBlocked ? messages.composer.storageFailure
      : input.unresolved && sendingInput ? messages.quick.waitForReceipt : messages.quick.send,
  };
}

/** What asking the native window which mode it was opened in came to. */
export type QuickModeLoad =
  | { kind: "skipped" }
  | { kind: "loaded"; mode: QuickMode }
  | { kind: "failed"; text: string };

/** Asks the native window (`ask`) for the mode the quick strip was opened in. The browser preview has no
 * native window, so it is never asked and keeps the default input mode. A native window that fails to answer
 * also leaves the default mode, but says so with its cause (`text`) instead of passing as a normal start. */
export async function loadQuickMode(native: boolean, ask: () => Promise<QuickMode>): Promise<QuickModeLoad> {
  if (!native) return { kind: "skipped" };
  try { return { kind: "loaded", mode: await ask() }; }
  catch (error) { return { kind: "failed", text: messages.quick.modeLoadFailed(errorText(error)) }; }
}
