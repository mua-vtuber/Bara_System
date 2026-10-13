import { expect, test } from "bun:test";
import { ANSWER_OUTCOMES } from "../shared/contracts.ts";
import { answerFeedback, acceptFeedback, canShowProgress, errorFeedback, failedClassificationReason, isStorageBlocked, mergeIncomingDraft, openedMemoryInitialStatus, quickLengthError, reserveOperation, safeFeedbackText, savedFeedback, shortSummary, storageAccessFailed, storageAccessSucceeded, storageOutboxRead, storageWarningText, switchQuickMode, workingFeedback, type StorageNotices } from "./feedback-model.ts";
import { messages } from "./messages.ts";
import { settleSubmission } from "./state.ts";

test("mode switch keeps the typed text and request identity", () => {
  expect(switchQuickMode({ mode: "input", content: "아직 쓰는 문장", requestId: "draft-1" }, "question"))
    .toEqual({ mode: "question", content: "아직 쓰는 문장", requestId: "draft-1" });
});
test("switching modes during a save gives the retained text a new draft identity", () => {
  expect(switchQuickMode({ mode: "input", content: "새 질문으로 쓸 내용", requestId: "submitted" }, "question", "submitted", "next"))
    .toEqual({ mode: "question", content: "새 질문으로 쓸 내용", requestId: "next" });
});

test("a settled operation ignores late progress", () => {
  expect(canShowProgress({ id: "op-1", settled: false }, "op-1")).toBe(true);
  expect(canShowProgress({ id: "op-1", settled: true }, "op-1")).toBe(false);
  expect(canShowProgress({ id: "op-2", settled: false }, "op-1")).toBe(false);
});
test("a second send cannot reserve the quick strip while connection preflight is pending", () => {
  const first = reserveOperation(null, "first");
  expect(first).toEqual({ id: "first", settled: false });
  expect(reserveOperation(first, "second")).toBeNull();
});

test("native feedback stays within size, source, and ID bounds", () => {
  const result = answerFeedback("answer-1", "긴 답변 ".repeat(7_000), Array.from({ length: 12 }, (_, index) => ({ id: index + 1, content: "자료 ".repeat(2_000) })), true, "found", "server-A");
  expect(new TextEncoder().encode(result.summary).length).toBeLessThanOrEqual(240);
  expect(new TextEncoder().encode(result.detail).length).toBeLessThanOrEqual(30_000);
  expect(result.sources?.length).toBe(10);
  expect(result.sources?.every(source => source.id > 0 && new TextEncoder().encode(source.content).length <= 4_000)).toBe(true);
  expect(result.sequence).toBeUndefined();
  expect(result.audience).toBe("server-A");
});
test("native feedback never carries an ID reference without its server audience", () => {
  expect(savedFeedback("op", "본문", "receipt", 4).memoryId).toBeUndefined();
  expect(answerFeedback("op", "답", [{ id: 4, content: "근거" }], true, "found").sources).toEqual([]);
});
test("an answer feedback carries the outcome it was given, also when the sources are emptied for another server", () => {
  const sources = [{ id: 4, content: "근거" }];
  for (const outcome of ANSWER_OUTCOMES) {
    const sameServer = answerFeedback("op", "답", sources, false, outcome, "server-A");
    expect(sameServer.answerOutcome).toBe(outcome);
    expect(sameServer.sources?.length).toBe(1);
    // A different server drops the sources but never the outcome: an empty `sources` does not mean "not found".
    const otherServer = answerFeedback("op", "답", sources, false, outcome);
    expect(otherServer.sources).toEqual([]);
    expect(otherServer.answerOutcome).toBe(outcome);
  }
});
test("only an answer feedback carries an outcome", () => {
  expect(savedFeedback("op", "본문", "receipt", 4, "server-A").answerOutcome).toBeUndefined();
  expect(workingFeedback("op", "question", "찾는 중").answerOutcome).toBeUndefined();
  expect(errorFeedback("op", "question", "실패").answerOutcome).toBeUndefined();
});
test("a save with an AI-applied capture label shows the classification result, not the generic saved summary", () => {
  expect(savedFeedback("op", "본문", "receipt", 4, "server-A", "아이디어").summary).toBe("아이디어로 분류했어요.");
});
test("an entity_patch save shows a dedicated update summary instead of the generic saved summary", () => {
  expect(savedFeedback("op", "본문", "receipt", undefined, "server-A", undefined, undefined, "entity_patch").summary).toBe(messages.feedback.entityPatched);
});
test("a save whose classification step failed announces the failure in the bubble's summary, not only in detail", () => {
  const failed = savedFeedback("op", "저장된 원문", "receipt", 4, "server-A", undefined, "AI 서버에 연결할 수 없습니다.");
  const expectedSummary = messages.feedback.classificationFailed("AI 서버에 연결할 수 없습니다.");
  expect(failed.summary).toBe(expectedSummary);
  expect(failed.summary).not.toBe(messages.feedback.saved);
  // The opened memory view re-fetches content from the server and drops `detail`; the reason must survive that.
  expect(failed.classificationFailureReason).toBe(expectedSummary);
});
test("a failed classification is always shown as a failure, also when the service gave a blank reason", () => {
  const generic = messages.feedback.classificationFailedGeneric;
  const genericSummary = shortSummary(messages.feedback.classificationFailed(generic));
  for (const reason of ["", "   ", "\n\t "]) {
    const shown = failedClassificationReason({ outcome: "failed", reason });
    expect(shown).toBe(generic);
    const feedback = savedFeedback("op", "저장된 원문", "receipt", 4, "server-A", undefined, shown);
    expect(feedback.summary).toBe(genericSummary);
    expect(feedback.summary).not.toBe(messages.feedback.saved);
    expect(feedback.classificationFailureReason).toBe(genericSummary);
  }
  expect(failedClassificationReason({ outcome: "failed" })).toBe(generic);
  expect(failedClassificationReason({ outcome: "failed", reason: "AI 서버에 연결할 수 없습니다." })).toBe("AI 서버에 연결할 수 없습니다.");
  // Only a failed classification has a reason to show.
  expect(failedClassificationReason(undefined)).toBeUndefined();
  expect(failedClassificationReason({ outcome: "undecided" })).toBeUndefined();
  expect(failedClassificationReason({ outcome: "applied", capture: { kind: "idea", source: "ai" } })).toBeUndefined();
});
test("a long classification failure reason is cut to the host's summary limit while detail keeps the whole message", () => {
  const HOST_SUMMARY_MAX_BYTES = 240; // src-tauri/src/feedback.rs SUMMARY_MAX_BYTES, which also bounds classificationFailureReason
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const reason = "가".repeat(200);
  const prefix = messages.feedback.classificationFailed("");
  const whole = messages.feedback.classificationFailed(reason);
  const failed = savedFeedback("op", whole, "receipt", 4, "server-A", undefined, reason);
  expect(bytes(failed.summary)).toBeLessThanOrEqual(HOST_SUMMARY_MAX_BYTES);
  expect(bytes(failed.classificationFailureReason ?? "")).toBeLessThanOrEqual(HOST_SUMMARY_MAX_BYTES);
  expect(failed.summary.startsWith(prefix)).toBe(true);
  expect(failed.classificationFailureReason?.startsWith(prefix)).toBe(true);
  // The bubble shows the cut summary; the full message is still available in `detail`, within its own bound.
  expect(failed.detail).toBe(whole);
  expect(bytes(failed.detail)).toBeLessThanOrEqual(2_000);
});
test("the memory dialog opened after a save only carries an initial status when classification actually failed", () => {
  const failed = savedFeedback("op", "저장된 원문", "receipt", 4, "server-A", undefined, "AI 서버에 연결할 수 없습니다.");
  expect(openedMemoryInitialStatus(failed)).toBe(messages.feedback.classificationFailed("AI 서버에 연결할 수 없습니다."));
  const succeeded = savedFeedback("op", "저장된 원문", "receipt", 4, "server-A", "아이디어");
  expect(openedMemoryInitialStatus(succeeded)).toBeUndefined();
  const plain = savedFeedback("op", "저장된 원문", "receipt", 4, "server-A");
  expect(openedMemoryInitialStatus(plain)).toBeUndefined();
  expect(openedMemoryInitialStatus(answerFeedback("a", "답", [], true, "found"))).toBeUndefined();
});

test("older native reads cannot overwrite newer feedback", () => {
  const newer = { id: "new", sequence: 4 };
  expect(acceptFeedback(newer, { id: "old", sequence: 3 })).toBe(newer);
  expect(acceptFeedback(newer, { id: "latest", sequence: 5 })).toEqual({ id: "latest", sequence: 5 });
});

test("ordinary saved HTTPS links remain readable plain text", () => {
  const note = "Stored link: https://example.test/guide?q=2";
  expect(safeFeedbackText(note)).toBe(note);
  expect(safeFeedbackText("로컬 자료 http://127.0.0.1:3001/guide")).toBe("로컬 자료 http://127.0.0.1:3001/guide");
});
test("credential-bearing links and auth markers are redacted", () => {
  const result = safeFeedbackText("https://user:pass@example.test/#bara-token=abc Authorization: Bearer SECRET -----BEGIN PRIVATE KEY----- https://example.test/?access_token=hidden");
  expect(result).not.toMatch(/user:pass|bara-token=|Bearer |SECRET|-----BEGIN|access_token=/i);
  expect(result).toContain("[인증정보 생략]");
});
test("oversized pasted text remains intact and is rejected on send", () => {
  const pasted = "가".repeat(30_001);
  expect(quickLengthError("input", pasted)).toBeTruthy();
  expect(pasted.length).toBe(30_001);
  expect(quickLengthError("input", "정상 입력")).toBeNull();
});
test("cross-window recovery merges into focused newer input without erasing it", () => {
  expect(mergeIncomingDraft({ content: "새로 쓰는 내용", requestId: "local" }, { content: "복구한 이전 내용", requestId: "external" }, true, "merged"))
    .toEqual({ content: "새로 쓰는 내용\n\n복구한 이전 내용", requestId: "merged" });
  expect(mergeIncomingDraft({ content: "새로 쓰는 내용", requestId: "local" }, { content: "", requestId: "" }, true, "merged"))
    .toEqual({ content: "새로 쓰는 내용", requestId: "local" });
});
// WP-P2-06: the quick strip's visible storage warning must show the actual cause, not a blank message.
test("a draft-store failure's visible warning carries the real cause from the thrown error", () => {
  expect(storageWarningText(messages.drafts.unreadableDraft)).toBe(messages.drafts.unreadableDraft);
  expect(storageWarningText(messages.drafts.unreadableOutbox)).toBe(messages.drafts.unreadableOutbox);
});
test("a draft-store failure with no message at all still shows a visible warning, not a blank one", () => {
  expect(storageWarningText("")).toBe(messages.composer.storageFailure);
});
// WP-PFIX-4: the quick strip reports a storage failure through the feedback bubble. A store that keeps
// failing on every keystroke publishes one bubble per distinct cause, and a new cause is published again.
test("a storage failure is published to the bubble once per distinct cause", () => {
  const first = storageAccessFailed({}, "readDraft", messages.drafts.unreadableDraft);
  expect(first).toMatchObject({ text: messages.drafts.unreadableDraft, publish: true });
  const again = storageAccessFailed(first.notices, "readDraft", messages.drafts.unreadableDraft);
  expect(again).toMatchObject({ text: messages.drafts.unreadableDraft, publish: false });
  expect(storageAccessFailed(again.notices, "readDraft", messages.drafts.unreadableOutbox)).toMatchObject({ text: messages.drafts.unreadableOutbox, publish: true });
  expect(storageAccessFailed({}, "writeDraft", "")).toMatchObject({ text: messages.composer.storageFailure, publish: true });
});

// WP-PFIX-5: once the store works again, the same cause must be able to reach the bubble again. A fixed
// "already published" text would keep the bubble silent after a recovery.
test("the same cause is published again after the failing access worked in between", () => {
  const cause = messages.drafts.unreadableOutbox;
  const first = storageAccessFailed({}, "readSubmissions", cause);
  expect(first.publish).toBe(true);
  expect(storageAccessFailed(first.notices, "readSubmissions", cause).publish).toBe(false);
  const recovered = storageAccessSucceeded(first.notices, "readSubmissions");
  expect(recovered).toEqual({});
  expect(storageAccessFailed(recovered, "readSubmissions", cause)).toMatchObject({ text: cause, publish: true });
});

test("a different access working does not free the cause of one that still fails", () => {
  // The quick strip reads the outbox on every keystroke while a write keeps failing: the working read
  // must not make the failing write publish a bubble for every keystroke.
  const cause = "QuotaExceededError";
  const failing = storageAccessFailed({}, "writeDraft", cause);
  expect(failing.publish).toBe(true);
  let notices: StorageNotices = failing.notices;
  for (let keystroke = 0; keystroke < 3; keystroke++) {
    notices = storageAccessSucceeded(notices, "readSubmissions");
    const next = storageAccessFailed(notices, "writeDraft", cause);
    expect(next.publish).toBe(false);
    notices = next.notices;
  }
});

test("one cause that two accesses share is published once, and is freed only when both have recovered", () => {
  const cause = "SecurityError";
  const read = storageAccessFailed({}, "readDraft", cause);
  const write = storageAccessFailed(read.notices, "writeDraft", cause);
  expect([read.publish, write.publish]).toEqual([true, false]);
  const readRecovered = storageAccessSucceeded(write.notices, "readDraft");
  expect(storageAccessFailed(readRecovered, "readDraft", cause).publish).toBe(false);
  const allRecovered = storageAccessSucceeded(storageAccessSucceeded(write.notices, "readDraft"), "writeDraft");
  expect(storageAccessFailed(allRecovered, "readDraft", cause).publish).toBe(true);
});

test("an access that had no failure leaves the notices as they were", () => {
  const notices: StorageNotices = { writeDraft: "cause" };
  expect(storageAccessSucceeded(notices, "readDraft")).toBe(notices);
});

// WP-PFIX-6: sending input is blocked exactly while some draft-store access still fails. A flag that is
// only ever set would keep the button off after the store works again, until the app restarts.
test("storage is blocked while any access fails and free once every failing access has worked again", () => {
  expect(isStorageBlocked({})).toBe(false);
  const read = storageAccessFailed({}, "readDraft", "SecurityError");
  expect(isStorageBlocked(read.notices)).toBe(true);
  const both = storageAccessFailed(read.notices, "writeDraft", "QuotaExceededError");
  const readRecovered = storageAccessSucceeded(both.notices, "readDraft");
  expect(isStorageBlocked(readRecovered)).toBe(true); // the write still fails
  expect(isStorageBlocked(storageAccessSucceeded(readRecovered, "writeDraft"))).toBe(false);
});

test("an access that never failed neither blocks nor frees storage", () => {
  const failing = storageAccessFailed({}, "writeDraft", "QuotaExceededError").notices;
  expect(isStorageBlocked(storageAccessSucceeded(failing, "readSubmissions"))).toBe(true);
  expect(isStorageBlocked(storageAccessSucceeded({}, "readSubmissions"))).toBe(false);
});

test("a readable outbox frees a failed outbox read but not a write that still fails", () => {
  const readFailed = storageAccessFailed({}, "readSubmissions", messages.drafts.unreadableOutbox).notices;
  expect(isStorageBlocked(readFailed)).toBe(true);
  expect(isStorageBlocked(storageOutboxRead(readFailed, 2))).toBe(false);
  const both = storageAccessFailed(readFailed, "writeDraft", "QuotaExceededError").notices;
  expect(isStorageBlocked(storageOutboxRead(both, 0))).toBe(true);
});

test("an emptied outbox ends a failed finishSubmission, an outbox that still holds entries does not", () => {
  const failed = storageAccessFailed({}, "finishSubmission", "QuotaExceededError").notices;
  expect(isStorageBlocked(storageOutboxRead(failed, 1))).toBe(true);
  expect(isStorageBlocked(storageOutboxRead(failed, 0))).toBe(false);
});

test("confirmed save clears only the matching focused draft across quick refresh", () => {
  const submitted = { content: "저장한 내용", requestId: "submitted" };
  const cleared = settleSubmission(submitted, [{ ...submitted, state: "pending" }], "submitted", true).draft;
  expect(mergeIncomingDraft({ content: "저장한 내용", requestId: "submitted" }, cleared, true, "unused", "submitted"))
    .toEqual(cleared);
  expect(mergeIncomingDraft({ content: "새 메모", requestId: "newer" }, cleared, true, "unused", "submitted"))
    .toEqual({ content: "새 메모", requestId: "newer" });
  expect(mergeIncomingDraft({ content: "새 질문", requestId: "question-draft" }, cleared, true, "unused", "submitted"))
    .toEqual({ content: "새 질문", requestId: "question-draft" });
});
