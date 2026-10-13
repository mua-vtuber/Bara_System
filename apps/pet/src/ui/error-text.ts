import type { HostErrorPayload } from "../shared/contracts.ts";
import { messages } from "./messages.ts";

/** Whether a rejection is the native host's `{ code, message?, status? }` object (`src-tauri/src/host_error.rs`). */
export function isHostErrorPayload(error: unknown): error is HostErrorPayload {
  if (typeof error !== "object" || error === null || error instanceof Error) return false;
  const { code, message, status } = error as Record<string, unknown>;
  return typeof code === "string" && code !== ""
    && (message === undefined || typeof message === "string")
    && (status === undefined || Number.isInteger(status));
}

/** The code of a native rejection, or undefined when the rejection is not a host error object. */
export function hostErrorCode(error: unknown): string | undefined {
  return isHostErrorPayload(error) ? error.code : undefined;
}

function hostErrorText(code: string): string | undefined {
  return Object.hasOwn(messages.hostErrors, code) ? messages.hostErrors[code] : undefined;
}

/** The Korean text shown for a failure.
 * 1. A host code with a text in `messages.hostErrors` shows that text, with the OS error number when present.
 * 2. Any other code with the service's checked public text shows that text alone, without a code prefix.
 * 3. A code with neither shows the code itself, so the cause is never hidden.
 * 4. An `Error` made by screen code carries a `messages.*` text already and shows its message.
 * 5. Anything else (for example a Tauri permission rejection string) is logged as it is and shown as
 *    `messages.errors.unexpectedNative`, so no untranslated native text reaches the screen. */
export function errorText(error: unknown): string {
  if (isHostErrorPayload(error)) {
    const text = hostErrorText(error.code) ?? (error.message ? error.message : messages.errors.withCode(error.code));
    return error.status === undefined ? text : messages.errors.withStatus(text, error.status);
  }
  if (error instanceof Error) return error.message;
  console.error(error);
  return messages.errors.unexpectedNative;
}
