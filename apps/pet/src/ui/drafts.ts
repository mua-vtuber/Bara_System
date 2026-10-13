import { messages } from "./messages.ts";
import { restoreSubmission, settleSubmission, type Draft, type Submission } from "./state.ts";
const DRAFT_KEY = "bara.pet.draft.v1";
const OUTBOX_KEY = "bara.pet.outbox.v1";
interface StoredDraft extends Draft { settledRequestId?: string }
export const activeSaves = new Map<string, string>();
export const DRAFT_EVENT = "bara-draft-updated";
function valid(value: unknown): value is Draft {
  return !!value && typeof value === "object" && "content" in value && typeof value.content === "string" &&
    "requestId" in value && typeof value.requestId === "string";
}
export function readDraft(): StoredDraft {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (raw === null) return { content: "", requestId: "" };
  const value: unknown = JSON.parse(raw);
  if (!valid(value)) throw new Error(messages.drafts.unreadableDraft);
  if ("settledRequestId" in value && (typeof value.settledRequestId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.settledRequestId))) {
    throw new Error(messages.drafts.unreadableDraft);
  }
  return value as StoredDraft;
}
export function writeDraft(draft: Draft, settledRequestId?: string): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ content: draft.content, requestId: draft.requestId,
    ...(settledRequestId ? { settledRequestId } : {}) }));
}
export function readSubmissions(): Submission[] {
  const raw = localStorage.getItem(OUTBOX_KEY);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(item => !valid(item) || !("state" in item) || !["pending", "unknown"].includes(String(item.state)))) {
    throw new Error(messages.drafts.unreadableOutbox);
  }
  if (value.some(item => "operationId" in item && (typeof item.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.operationId)))) throw new Error(messages.drafts.unreadableOutbox);
  if (value.some(item => "audience" in item && (typeof item.audience !== "string" || item.audience.length < 1 || item.audience.length > 4_096))) throw new Error(messages.drafts.unreadableOutbox);
  return value as Submission[];
}
export function beginSubmission(draft: Draft, operation: string, audience: string): void {
  if (!audience || audience.length > 4_096) throw new Error(messages.feedback.connectionChanged);
  const submissions = readSubmissions();
  if (activeSaves.size || submissions.some(item => item.requestId === draft.requestId)) throw new Error(messages.drafts.confirmPrevious);
  if (submissions.length >= 20) throw new Error(messages.drafts.tooManyPending);
  localStorage.setItem(OUTBOX_KEY, JSON.stringify([...submissions, { ...draft, state: "pending", operationId: operation, audience }]));
  activeSaves.set(draft.requestId, operation); document.dispatchEvent(new Event(DRAFT_EVENT));
}
export function finishSubmission(requestId: string, saved: boolean | "rejected"): void {
  activeSaves.delete(requestId);
  const state = settleSubmission(readDraft(), readSubmissions(), requestId, saved);
  writeDraft(state.draft, saved === true ? requestId : undefined);
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(state.submissions));
  document.dispatchEvent(new Event(DRAFT_EVENT));
}
export function returnToDraft(requestId: string): void {
  if (activeSaves.has(requestId)) throw new Error(messages.drafts.activeSending);
  const state = restoreSubmission(readDraft(), readSubmissions(), requestId, crypto.randomUUID());
  // Preserve content in the draft before removing its recovery entry.
  writeDraft(state.draft); localStorage.setItem(OUTBOX_KEY, JSON.stringify(state.submissions));
  document.dispatchEvent(new Event(DRAFT_EVENT));
}
