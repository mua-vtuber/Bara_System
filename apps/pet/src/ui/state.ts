export interface Draft { content: string; requestId: string }
export interface Submission extends Draft { state: "pending" | "unknown"; operationId?: string; audience?: string }
export function submissionIsActive(item: Submission, activeOperationIds: readonly string[]): boolean {
  return !!item.operationId && activeOperationIds.includes(item.operationId);
}
export function nextDraft(previous: Draft, content: string, nextId: string): Draft {
  return content === previous.content ? previous : { content, requestId: nextId };
}
export function completeDraft(current: Draft, submittedId: string): Draft {
  return current.requestId === submittedId ? { content: "", requestId: "" } : current;
}
export function shouldSend(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">, busy: boolean): boolean {
  return !busy && event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
export function settleSubmission(draft: Draft, submissions: Submission[], requestId: string, saved: boolean | "rejected"): { draft: Draft; submissions: Submission[] } {
  return {
    draft: saved === true ? completeDraft(draft, requestId) : draft,
    submissions: saved === true || saved === "rejected" ? submissions.filter(item => item.requestId !== requestId)
      : submissions.map(item => item.requestId === requestId ? { ...item, state: "unknown" } : item),
  };
}
export function restoreSubmission(draft: Draft, submissions: Submission[], requestId: string, nextId: string): { draft: Draft; submissions: Submission[] } {
  const submitted = submissions.find(item => item.requestId === requestId);
  if (!submitted) return { draft, submissions };
  const content = !draft.content || draft.requestId === requestId || draft.content === submitted.content
    ? submitted.content : `${draft.content}\n\n${submitted.content}`;
  return { draft: { content, requestId: nextId }, submissions: submissions.filter(item => item.requestId !== requestId) };
}
