import { SELF_UPDATE, selfUpdateHeaders, type ReleaseSource } from "../../shared/self-update.ts";
import { messages } from "../../ui/messages.ts";
import { classifyFetchFailure } from "../fetch-failure.ts";
import { publicError } from "../protocol.ts";
import { failureText } from "./failure.ts";
import { classifyRelease, parseRelease } from "./release.ts";
import type { CheckOutcome } from "./types.ts";

const failed = (code: string, message: string): CheckOutcome => ({ kind: "failed", code, message });

/** Why a request that produced no usable answer stopped, as a failed outcome with its own code (spec 5.2). */
function requestFailed(error: unknown, signal: AbortSignal, timeoutMs: number): CheckOutcome {
  const text = messages.selfUpdateErrors;
  switch (classifyFetchFailure(error, signal)) {
    case "cancelled": return failed("CANCELLED", messages.rpc.cancelled);
    case "timeout": return failed("SELF_UPDATE_TIMEOUT", text.SELF_UPDATE_TIMEOUT(Math.ceil(timeoutMs / 1000)));
    case "redirect": return failed("SELF_UPDATE_REDIRECT", text.SELF_UPDATE_REDIRECT);
    case "network": return failed("SELF_UPDATE_NETWORK", failureText(text.SELF_UPDATE_NETWORK, error));
    case "malformed": return failed("SELF_UPDATE_RESPONSE_INVALID", text.SELF_UPDATE_RESPONSE_INVALID);
    case "unexpected": return failed("SELF_UPDATE_UNEXPECTED", failureText(text.SELF_UPDATE_UNEXPECTED, error));
  }
}

/** The one request of a check (spec 5.2): `GET source.latestUrl` with only `selfUpdateHeaders()`, no redirect followed,
 * at most `timeoutMs`. Every failure comes back as a `failed` outcome naming its cause; this never rejects. A
 * cancelled check (`signal`) comes back as `CANCELLED`, which the caller drops. */
export async function fetchLatestRelease(source: ReleaseSource, currentVersion: string, signal: AbortSignal,
  timeoutMs: number = SELF_UPDATE.checkTimeoutMs): Promise<CheckOutcome> {
  const limited = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try { response = await fetch(source.latestUrl, { signal: limited, redirect: "error", headers: selfUpdateHeaders() }); }
  catch (error) { return requestFailed(error, signal, timeoutMs); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {}); // the status is the answer; its body is not read
    return failed("SELF_UPDATE_HTTP", messages.selfUpdateErrors.SELF_UPDATE_HTTP(response.status));
  }
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    const kind = classifyFetchFailure(error, signal);
    return kind === "unexpected" || kind === "malformed"
      ? failed("SELF_UPDATE_RESPONSE_INVALID", messages.selfUpdateErrors.SELF_UPDATE_RESPONSE_INVALID)
      : requestFailed(error, signal, timeoutMs);
  }
  try { return classifyRelease(parseRelease(body, source), currentVersion); }
  catch (error) { const reply = publicError(error); return failed(reply.code, reply.message); }
}
