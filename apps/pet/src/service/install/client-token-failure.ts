import { clientTokenErrorCode } from "../../../../setup/src/client-token-errors.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError, type ServiceError } from "../errors.ts";

/** The cause of a failed credentials step (`apps/setup/src/client-token.ts`, run on this PC or over SSH), read from
 * its error output only when that output is exactly one of the step's known, secret-free lines. The error carries
 * the line's code and its fixed Korean text, never the output itself; any other output gives undefined, and the
 * caller keeps the generic `installService.sensitiveStepFailed`. Passed to `runCaptured` as its `sensitive` option. */
export function clientTokenFailure(stderr: string): ServiceError | undefined {
  const code = clientTokenErrorCode(stderr);
  return code === undefined ? undefined : serviceError(code, messages.clientTokenErrors[code]);
}
