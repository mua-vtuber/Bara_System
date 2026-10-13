import { messages } from "../ui/messages.ts";
import { isShowableText } from "./protocol.ts";

/** The error codes `fetchGuarded` gives a request that produced no HTTP answer. A request the server did
 * answer keeps the status-based codes of `requestJson`. `describeProbeFailure` (`ai.ts`) reads these too. */
export const FETCH_FAILURE_CODES = {
  network: "NETWORK", timeout: "TIMEOUT", redirect: "REDIRECT", unexpected: "REQUEST_UNEXPECTED",
} as const;

/** What stopped a request. `malformed` is an answer that is not HTTP or whose body cannot be decoded: a
 * server-response fault, reported without a cause sentence. `unexpected` is every exception no rule below
 * names: it is never reported as a connection fault, because a Pet defect (an unusable header, a body that
 * cannot be serialized) is not one. */
export type FetchFailureKind = "cancelled" | "timeout" | "redirect" | "network" | "malformed" | "unexpected";

/** `AbortSignal.timeout` rejects the request with an error of this name. */
const TIMEOUT_ERROR_NAME = "TimeoutError";
/** Bun's code for a 3xx answer to a request made with `redirect: "error"`. */
const REDIRECT_REFUSED_CODES: ReadonlySet<string> = new Set(["UnexpectedRedirect"]);
/** Codes of a request that never reached the server or lost its connection before an answer arrived.
 * Reproduced on Bun: `ConnectionRefused` (closed port, unknown host) and `ECONNRESET` (socket closed by the
 * server); the others are the standard names other runtimes use for the same situations. */
const NO_ANSWER_CODES: ReadonlySet<string> = new Set([
  "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
]);
/** Codes of an answer that came back but cannot be read as HTTP, each reproduced on Bun 1.3.6:
 * `Malformed_HTTP_Response` (bytes that are not an HTTP status line or header, such as an SSH banner on the
 * port), `InvalidHTTPResponse` (broken chunk framing, before or while the body streams in), and the three
 * decoders' codes for a body its own `content-encoding` (gzip/deflate, br, zstd) cannot decode. Bun's
 * sentence for each holds the whole request address, so none of them may become a cause sentence. */
const MALFORMED_ANSWER_CODES: ReadonlySet<string> = new Set([
  "Malformed_HTTP_Response", "InvalidHTTPResponse", "ZlibError", "BrotliDecompressionError", "ZstdDecompressionError",
]);

function stringField(error: unknown, field: "name" | "code"): string {
  if (typeof error !== "object" || error === null) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

/** Why a request or the read of its body threw. `signal` is the caller's own: when it is aborted the caller
 * cancelled, whatever the exception looked like. */
export function classifyFetchFailure(error: unknown, signal: AbortSignal): FetchFailureKind {
  if (signal.aborted) return "cancelled";
  if (stringField(error, "name") === TIMEOUT_ERROR_NAME) return "timeout";
  const code = stringField(error, "code");
  if (REDIRECT_REFUSED_CODES.has(code)) return "redirect";
  if (MALFORMED_ANSWER_CODES.has(code)) return "malformed";
  return NO_ANSWER_CODES.has(code) ? "network" : "unexpected";
}

/** The longest a cause sentence shown to the user may be, in characters (code points: an emoji counts once
 * and is never cut in half). */
export const CAUSE_MAX_CHARS = 300;
/** How much of a sentence is read before its addresses are stripped, in UTF-16 code units: well over
 * `CAUSE_MAX_CHARS`, because stripping an address's query string and user information shortens the sentence,
 * but still a bound. The cleanup server's own sentence is as long as a response may be (2 MB); only the
 * removal of characters that show nothing runs over all of it, and that removal is one linear pass. */
export const CAUSE_SCAN_MAX_CHARS = 4_000;
/** An address written in a sentence: a scheme and `//`, then every character up to one that a serialized
 * URL never holds unescaped (whitespace, `"`, `<`, `>`, a backtick). Stopping only there means a query
 * string or fragment is never cut short and left half in the sentence. The scheme is the whole run of scheme
 * characters before `://`, whatever it starts with, so `_http://` and `1http://` are addresses too. The
 * lookbehind makes a match start only where such a run starts: a bare word boundary (`\b`) is also a start
 * inside a long run like `a.a.a.a`, and trying every one of them made the search quadratic in the length. */
const ADDRESS_IN_TEXT = /(?<![a-z0-9+.-])[a-z0-9+.-]+:\/\/[^\s"<>`]*/gi;
/** The characters that end an address in a sentence (the complement of its tail above). */
const ADDRESS_END = /[\s"<>`]/;
/** Whitespace that is also a control character (tab, line feed, carriage return, vertical tab, form feed,
 * next line): a break between words, so it becomes a space before the control characters are removed. The
 * lookahead intersects the two classes (the `v` flag that writes an intersection directly needs ES2024). */
const CONTROL_WHITESPACE = /(?=\p{Cc})\p{White_Space}/gu;
/** Characters that show nothing: control, format (zero-width space, soft hyphen, byte order mark, word joiner,
 * bidirectional marks, tags), private-use and lone-surrogate characters, and the other default-ignorable ones
 * (combining grapheme joiner, variation selectors, Hangul fillers). Nothing of a sentence shows through them,
 * but inside `://`, a credential or an address they split what the checks below look for, and a control
 * character can restyle or overwrite what is around it on the screen. */
const NON_PRINTING = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
/** The first half of a surrogate pair (a character outside the basic plane, such as an emoji). */
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

/** The address without its user information (`user:pass@`), query string and fragment: the parts that carry
 * credentials such as the enrollment's `pickupSecret`. Scheme, host, port and path stay, so the sentence
 * still says where the request went. */
function addressWithoutSecrets(address: string): string {
  const afterScheme = address.indexOf("//") + 2;
  const rest = address.slice(afterScheme);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  const pathEnd = tail.search(/[?#]/);
  return `${address.slice(0, afterScheme)}${authority.slice(authority.lastIndexOf("@") + 1)}${pathEnd === -1 ? tail : tail.slice(0, pathEnd)}`;
}

/** `text` with every address in it stripped of user information, query string and fragment. */
export function stripAddressSecrets(text: string): string {
  return text.replace(ADDRESS_IN_TEXT, addressWithoutSecrets);
}

/** The part of a sentence that is read: all of it when it fits `CAUSE_SCAN_MAX_CHARS`, otherwise its start,
 * without a last token that the cut left half an address. Half an address is not safe to keep: cut inside
 * `user:pa|ss@host` there is no `@` left to tell the user information from the host, so `user:pa` would
 * stay. A last token the cut broke is dropped when it holds `://` (an address begun and not finished), and
 * kept otherwise, since a word cut short has nothing to hide. `null` when that token is the whole start (one
 * unbroken address longer than the bound), where nothing is left to show. `text` holds no character that
 * shows nothing: one inside `://` would hide the address from that check. */
function readableStart(text: string): string | null {
  if (text.length <= CAUSE_SCAN_MAX_CHARS) return text;
  // Never between the two halves of a surrogate pair: the lone half left would reach the screen, since lone
  // surrogates were removed before the cut.
  const cut = HIGH_SURROGATE.test(text.charAt(CAUSE_SCAN_MAX_CHARS - 1)) ? CAUSE_SCAN_MAX_CHARS - 1 : CAUSE_SCAN_MAX_CHARS;
  const start = text.slice(0, cut);
  // A break right at the cut ends the last token whole.
  if (ADDRESS_END.test(text.charAt(cut))) return start;
  let tokenStart = start.length;
  while (tokenStart > 0 && !ADDRESS_END.test(start.charAt(tokenStart - 1))) tokenStart--;
  if (!start.slice(tokenStart).includes("://")) return start;
  return tokenStart === 0 ? null : start.slice(0, tokenStart);
}

/** The first `max` characters of `text`, counted in code points, so the cut never leaves half an emoji. */
function codePointPrefix(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) break;
    end += char.length;
    count++;
  }
  return text.slice(0, end);
}

/** The cause sentence of a failure that no service code names, and the one place such a sentence is built
 * for the screen: the exception's own `name: message` (or the server's own text) with its line breaks and
 * tabs turned into spaces and every character that shows nothing removed, then read up to
 * `CAUSE_SCAN_MAX_CHARS`, with every address in it stripped of user information, query string and fragment,
 * on one line and cut to a length a bubble can show. The removal comes first because the cut and the address
 * search both stop at whitespace: a byte order mark (whitespace to `\s`) before an address's `@`, or a
 * zero-width space inside its `://`, otherwise split the address so that its user information or query string
 * stayed. A sentence still holding something shaped like a credential is replaced by a line saying it was
 * withheld, so the user still learns that a cause exists. That check reads the sentence the removal left, in
 * which `Bearer` and its token may now touch (`Bearer<BOM>TOKEN`), so it knows that shape too
 * (`isShowableText`); it reads only the sentence shown, never the rest of a long one. An empty result (the
 * sentence held only spaces or characters that show nothing) is named by the messages layer (`withCause`). */
export function causeOf(error: unknown): string {
  const visible = String(error).replace(CONTROL_WHITESPACE, " ").replace(NON_PRINTING, "");
  const start = readableStart(visible);
  if (start === null) return messages.serverClient.causeTooLong;
  const sentence = codePointPrefix(stripAddressSecrets(start).replace(/\s+/g, " ").trim(), CAUSE_MAX_CHARS);
  return isShowableText(sentence) ? sentence : messages.serverClient.causeWithheld;
}
