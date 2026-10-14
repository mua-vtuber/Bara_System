import { fitted } from "../errors.ts";
import { causeOf } from "../fetch-failure.ts";

/** `text` written with the cause sentence of `error` (`causeOf`: addresses stripped of credentials, one line, cut),
 * shortened so the whole text stays within what the native host passes on to the screen (`fitted`). */
export function failureText(text: (cause: string) => string, error: unknown): string {
  return fitted((cause) => text(cause ?? ""), causeOf(error));
}
