import { INPUT_MAX_CHARS, QUESTION_MAX_CHARS, type AnswerOutcome, type Feedback, type SaveClassification } from "../shared/contracts.ts";
import { messages } from "./messages.ts";
import type { Draft } from "./state.ts";

export type QuickMode = "input" | "question";
export interface QuickModeState { mode: QuickMode; content: string; requestId: string }
export interface OperationState { id: string; settled: boolean }
export function reserveOperation(current: OperationState | null, id: string): OperationState | null {
  return current && !current.settled ? null : { id, settled: false };
}
export function quickLengthError(mode: QuickMode, content: string): string | null {
  return content.length > (mode === "input" ? INPUT_MAX_CHARS : QUESTION_MAX_CHARS)
    ? mode === "input" ? messages.quick.inputTooLong : messages.quick.questionTooLong : null;
}

export function switchQuickMode(state: QuickModeState, mode: QuickMode, submittedId?: string, replacementId?: string): QuickModeState {
  return { ...state, mode, requestId: state.mode !== mode && submittedId === state.requestId && replacementId ? replacementId : state.requestId };
}
export function mergeIncomingDraft(current: Draft, incoming: Draft, focused: boolean, nextId: string, settledRequestId?: string): Draft {
  if (settledRequestId && current.requestId === settledRequestId && incoming.requestId !== current.requestId) return incoming;
  if (!focused) return incoming;
  if (!incoming.content || incoming.content === current.content) return current;
  return { content: incoming.content.startsWith(current.content) ? incoming.content : `${current.content}\n\n${incoming.content}`, requestId: nextId };
}

export function canShowProgress(operation: OperationState | null, requestId: string): boolean {
  return !!operation && !operation.settled && operation.id === requestId;
}

export function acceptFeedback<T extends { sequence?: number }>(current: T | null, incoming: T): T {
  return current && (current.sequence ?? -1) > (incoming.sequence ?? -1) ? current : incoming;
}

export function safeFeedbackText(input: string): string {
  return input
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, link => {
      try {
        const url = new URL(link);
        if (!(["http:", "https:"].includes(url.protocol))) return messages.feedback.omittedLink;
        const fragment = decodeURIComponent(url.hash).toLowerCase();
        const query = [...url.searchParams.keys()].map(key => key.toLowerCase());
        const authority = link.slice(link.indexOf("://") + 3).split(/[/?#]/, 1)[0];
        if (authority?.includes("@") || url.username || url.password || ["bara-token=", "access_token=", "api_key="].some(marker => fragment.includes(marker)) || query.some(key => ["token", "bara-token", "access_token", "api_key"].includes(key))) return messages.feedback.omittedCredential;
        return link;
      } catch { return messages.feedback.omittedLink; }
    })
    .replace(/bearer\s+\S+/gi, messages.feedback.omittedCredential)
    .replace(/bara-token\s*=\s*\S+/gi, messages.feedback.omittedCredential)
    .replace(/(?:access_token|api_key)\s*=\s*\S+/gi, messages.feedback.omittedCredential)
    .replace(/-----begin [a-z ]*private key-----[\s\S]*?-----end [a-z ]*private key-----/gi, messages.feedback.omittedCredential)
    .replace(/-----begin/gi, messages.feedback.omittedCredential)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

function limitBytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const value = safeFeedbackText(input);
  if (encoder.encode(value).length <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const width = encoder.encode(char).length;
    if (bytes + width + 3 > maxBytes) break;
    out += char;
    bytes += width;
  }
  return `${out}…`;
}

export function shortSummary(input: string): string {
  return limitBytes(input.replace(/\s+/g, " ").trim(), 210);
}

/** `outcome` is the one `assistant.ts` named for the answer. It is carried as it is, whether or not `audience` is
 * present: only the sources are dropped for a server mismatch, so an emptied `sources` never reads as "not found". */
export function answerFeedback(id: string, answer: string, sources: Array<{ id: number; content: string }>, generated: boolean, outcome: AnswerOutcome, audience?: string): Feedback {
  const unique = new Set<number>();
  const safeSources = (audience ? sources : []).filter(source => {
    if (!Number.isSafeInteger(source.id) || source.id <= 0 || unique.has(source.id)) return false;
    unique.add(source.id); return true;
  }).slice(0, 10).map(source => ({ id: source.id, content: limitBytes(source.content.slice(0, 600), 2_000) }));
  return { id, kind: "answer", mode: "question", summary: shortSummary(answer) || messages.feedback.noAnswer,
    detail: limitBytes(answer.slice(0, 20_000), 28_000), sources: safeSources, generated, answerOutcome: outcome, ...(audience ? { audience } : {}) };
}

export function workingFeedback(id: string, mode: QuickMode, summary: string, requestId?: string, audience?: string): Feedback {
  return { id, kind: "working", mode, summary: shortSummary(summary), detail: limitBytes(summary, 28_000), ...(requestId ? { requestId } : {}), ...(audience ? { audience } : {}) };
}

/** The reason to show for a classification that failed, or undefined when it did not fail. A blank reason (a `ServiceError`
 * can carry any `publicMessage`) becomes the generic text: `savedFeedback` reads an empty reason as "no failure", so a blank
 * one would show a failed classification as a plain successful save. */
export function failedClassificationReason(classification: SaveClassification | undefined): string | undefined {
  if (classification?.outcome !== "failed") return undefined;
  return classification.reason?.trim() ? classification.reason : messages.feedback.classificationFailedGeneric;
}

export function savedFeedback(id: string, detail: string, requestId: string, memoryId?: number, audience?: string, captureLabel?: string, failureReason?: string, resultType?: "memory" | "entity_patch"): Feedback {
  // A classification failure must be visible in the bubble's summary itself, not only in `detail`,
  // because the bubble (bubble.ts) renders only `summary` and the opened view replaces `detail` with a fresh server read.
  // The reason is service text of any length, so it is cut like every other summary: the host rejects a summary (and a
  // `classificationFailureReason`) over 240 bytes, which would turn this confirmed save into an error bubble. The whole
  // message stays in `detail`.
  const summary = failureReason ? shortSummary(messages.feedback.classificationFailed(failureReason))
    : captureLabel ? messages.composer.savedAs(captureLabel)
    : resultType === "entity_patch" ? messages.feedback.entityPatched
    : messages.feedback.saved;
  return { id, kind: "saved", mode: "input", summary,
    detail: limitBytes(detail.slice(0, 500), 2_000), ...(memoryId && memoryId > 0 && audience ? { memoryId } : {}), requestId, ...(audience ? { audience } : {}),
    // Carried separately from `detail` so a view that re-fetches the memory can still show why classification failed.
    ...(failureReason ? { classificationFailureReason: summary } : {}) };
}

/** The opened memory dialog re-fetches its content from the server, discarding `feedback.detail`.
 * This is the one piece of state that must survive that transition; kept pure so the "open on save" wiring is testable. */
export function openedMemoryInitialStatus(feedback: Feedback): string | undefined {
  return feedback.kind === "saved" ? feedback.classificationFailureReason : undefined;
}

export function errorFeedback(id: string, mode: QuickMode, detail: string, requestId?: string, audience?: string): Feedback {
  return { id, kind: "error", mode, summary: messages.feedback.error,
    detail: limitBytes(detail, 28_000), ...(requestId ? { requestId } : {}), ...(audience ? { audience } : {}) };
}

/** The quick strip's warning text for a draft-store failure (readDraft/readSubmissions/writeDraft
 * throwing). `errorMessage` on a broken `localStorage` value already carries the specific cause
 * (`messages.drafts.unreadableDraft`/`unreadableOutbox`); this only supplies a fallback for the rare
 * case where the thrown error has no message at all, so the warning is never left blank (PW-0). */
export function storageWarningText(rawMessage: string): string {
  return rawMessage || messages.composer.storageFailure;
}

/** The draft-store accesses whose failure the quick strip reports to the bubble. */
export type StorageAccess = "readDraft" | "readSubmissions" | "writeDraft" | "finishSubmission";
/** The cause text the bubble shows for each access that is failing right now. */
export type StorageNotices = Readonly<Partial<Record<StorageAccess, string>>>;

/** A draft-store access failed. Returns the cause text and whether to publish it: a cause the bubble
 * already shows for a failing access is not published again, so a store that keeps failing on every
 * keystroke publishes one bubble per distinct cause (WP-PFIX-4). */
export function storageAccessFailed(notices: StorageNotices, access: StorageAccess, rawMessage: string): { notices: StorageNotices; text: string; publish: boolean } {
  const text = storageWarningText(rawMessage);
  return { notices: { ...notices, [access]: text }, text, publish: !Object.values(notices).includes(text) };
}

/** A draft-store access worked again. The failure it had is over, so the same cause is published again
 * if it returns (WP-PFIX-5). Only that access is cleared: a read that works says nothing about a write
 * that still fails, and clearing on any success would publish a bubble per keystroke for a failing write. */
export function storageAccessSucceeded(notices: StorageNotices, access: StorageAccess): StorageNotices {
  if (!Object.hasOwn(notices, access)) return notices;
  const remaining: Partial<Record<StorageAccess, string>> = { ...notices };
  delete remaining[access];
  return remaining;
}

/** The quick strip blocks sending input while any draft-store access still fails. Derived from the
 * per-access failure state instead of a separate flag, so the block lifts by itself once every failing
 * access has worked again (WP-PFIX-6); a flag only ever set to true stayed on until the app restarted. */
export function isStorageBlocked(notices: StorageNotices): boolean {
  return Object.keys(notices).length > 0;
}

/** The submission outbox was read and `unsettledCount` entries still wait for a receipt. A failed
 * `finishSubmission` leaves its entry in the outbox, and nothing retries it while sending is blocked, so
 * an outbox that has since been emptied (on the recovery screen) also ends that failure. */
export function storageOutboxRead(notices: StorageNotices, unsettledCount: number): StorageNotices {
  const read = storageAccessSucceeded(notices, "readSubmissions");
  return unsettledCount === 0 ? storageAccessSucceeded(read, "finishSubmission") : read;
}

/** What the feedback bubble shows when its initial `get_feedback` read fails. Distinct from the
 * ordinary empty state (`messages.feedback.noFeedback`) so "nothing to show yet" and "the lookup
 * itself failed" are never displayed as the same text (PW-6). */
export function bubbleLoadFailureSummary(reason: string): string {
  return messages.feedback.feedbackLoadFailed(reason);
}

/** What the feedback bubble's dismiss/open action warning shows when the native command it fired
 * (dismiss_feedback / open_feedback) rejects instead of silently doing nothing (PW-6). */
export function bubbleActionFailureText(action: "dismiss" | "open", reason: string): string {
  return action === "dismiss" ? messages.feedback.dismissFailed(reason) : messages.feedback.openFailed(reason);
}
