import { ANSWER_OUTCOMES, INPUT_MAX_CHARS, QUESTION_MAX_CHARS, type AnswerOutcome, type Feedback, type SaveResult } from "../shared/contracts.ts";
import { failedClassificationReason, safeFeedbackText } from "./feedback-model.ts";
import { messages } from "./messages.ts";

/** How many recent answers and recent saves the Pet keeps; older ones drop off the end. */
export const RECENT_LIMIT = 5;

/** A question asked from the Pet and the answer it got. `answer` and `sources` are the answer bubble's own
 * (`answerFeedback`, already masked and cut); `audience` is set only when the sources belong to the connected server. */
export interface RecentAnswer {
  at: string; question: string; answer: string; generated: boolean; outcome: AnswerOutcome;
  sources: Array<{ id: number; content: string }>; audience?: string;
}

/** How a save from the Pet ended. `saved` carries the capture kind the AI applied, if any; a kind this Pet does not
 * know is kept as it came so the list can name it as unknown. `confirmedByUser` is an entry the user settled on the
 * "저장 확인" screen without a server answer. */
export type SaveOutcome =
  | { kind: "saved"; captureKind?: string }
  | { kind: "entityPatch" }
  | { kind: "classificationFailed"; reason: string }
  | { kind: "rejected"; reason?: string }
  | { kind: "confirmedByUser" };

export interface RecentSave { at: string; content: string; outcome: SaveOutcome; memoryId?: number; audience?: string }

export function pushRecent<T>(list: readonly T[], item: T): T[] {
  return [item, ...list].slice(0, RECENT_LIMIT);
}

/** `generated` and `outcome` are the answer's own (`assistant.ask`), passed as they came. */
export function answerEntry(question: string, feedback: Feedback, generated: boolean, outcome: AnswerOutcome, at: string): RecentAnswer {
  return {
    at, question: safeFeedbackText(question.slice(0, QUESTION_MAX_CHARS)), answer: feedback.detail,
    generated, outcome, sources: feedback.sources ?? [],
    ...(feedback.audience ? { audience: feedback.audience } : {}),
  };
}

/** The outcome of a `memory.save` / `memory.status` answer, in the order the saved bubble names it
 * (`savedFeedback`): a failed classification first, then the applied category, then an entity update.
 * `null` for a save that has not ended (`pending`, `unknown`): it stays in the outbox instead. */
export function saveOutcome(result: SaveResult): SaveOutcome | null {
  if (result.state === "rejected") return { kind: "rejected", ...(result.message?.trim() ? { reason: result.message } : {}) };
  if (result.state !== "saved") return null;
  const failure = failedClassificationReason(result.classification);
  if (failure) return { kind: "classificationFailed", reason: failure };
  const capture = result.classification?.outcome === "applied" ? result.classification.capture : undefined;
  if (capture) return { kind: "saved", captureKind: capture.kind };
  if (result.resultType === "entity_patch") return { kind: "entityPatch" };
  return { kind: "saved" };
}

/** `audience` is the connection the save was sent to; the memory link is kept only when the server answered for it. */
export function saveEntry(content: string, result: SaveResult, audience: string, at: string): RecentSave | null {
  const outcome = saveOutcome(result);
  if (!outcome) return null;
  const memoryId = result.memory?.id;
  const linked = outcome.kind !== "rejected" && !!memoryId && memoryId > 0 && result.audience === audience;
  return { at, content: safeFeedbackText(content.slice(0, INPUT_MAX_CHARS)), outcome, ...(linked ? { memoryId, audience } : {}) };
}

export function confirmedEntry(content: string, at: string): RecentSave {
  return { at, content: safeFeedbackText(content.slice(0, INPUT_MAX_CHARS)), outcome: { kind: "confirmedByUser" } };
}

/** The sentence the list shows for a save's outcome. `label` names a capture kind (`messages.labels`). */
export function saveOutcomeText(outcome: SaveOutcome, label: (kind: string) => string): string {
  switch (outcome.kind) {
    case "saved": return outcome.captureKind ? messages.recent.savedAs(label(outcome.captureKind)) : messages.recent.savedPlain;
    case "entityPatch": return messages.recent.entityPatched;
    case "classificationFailed": return messages.recent.classificationFailed(outcome.reason);
    case "rejected": return outcome.reason ? messages.recent.rejected(outcome.reason) : messages.recent.rejectedNoReason;
    case "confirmedByUser": return messages.recent.confirmedByUser;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isOptionalText = (value: unknown) => value === undefined || isText(value);
const isId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isTime = (value: unknown) => isText(value) && !Number.isNaN(Date.parse(value));

function isAnswer(value: unknown): value is RecentAnswer {
  return isRecord(value) && isTime(value.at) && isText(value.question) && isText(value.answer) && typeof value.generated === "boolean"
    && (ANSWER_OUTCOMES as readonly unknown[]).includes(value.outcome) && isOptionalText(value.audience)
    && Array.isArray(value.sources) && value.sources.every(source => isRecord(source) && isId(source.id) && isText(source.content));
}

function isOutcome(value: unknown): value is SaveOutcome {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "saved": return isOptionalText(value.captureKind);
    case "classificationFailed": return isText(value.reason);
    case "rejected": return isOptionalText(value.reason);
    case "entityPatch": case "confirmedByUser": return true;
    default: return false;
  }
}

function isSave(value: unknown): value is RecentSave {
  return isRecord(value) && isTime(value.at) && isText(value.content) && isOutcome(value.outcome)
    && (value.memoryId === undefined || isId(value.memoryId)) && isOptionalText(value.audience);
}

/** Reads a stored list: nothing stored is an empty list; a value of the wrong shape throws with the storage key
 * (`messages.recent.unreadable`) instead of being dropped, so a broken store is never shown as "no history yet". */
function parseList<T>(raw: string | null, key: string, isItem: (value: unknown) => value is T): T[] {
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(messages.recent.unreadable(key)); }
  if (!Array.isArray(value) || !value.every(isItem)) throw new Error(messages.recent.unreadable(key));
  return value.slice(0, RECENT_LIMIT);
}

export const parseAnswers = (raw: string | null, key: string) => parseList(raw, key, isAnswer);
export const parseSaves = (raw: string | null, key: string) => parseList(raw, key, isSave);
