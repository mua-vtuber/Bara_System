import { expect, test } from "bun:test";
import { nextDraft, shouldSend, completeDraft, settleSubmission, restoreSubmission, submissionIsActive } from "./state.ts";
test("typing after submit preserves the new draft and request identity", () => {
  const prior = { content: "첫 기록", requestId: "one" };
  const next = nextDraft(prior, "다음 기록", "two");
  expect(completeDraft(next, "one")).toEqual(next);
  expect(completeDraft(prior, "one")).toEqual({ content: "", requestId: "" });
});
test("unchanged text retains request identity for reconciliation", () => {
  expect(nextDraft({ content: "기록", requestId: "one" }, "기록", "two").requestId).toBe("one");
});
test("IME composition and busy state prevent accidental send", () => {
  expect(shouldSend({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
  expect(shouldSend({ key: "Enter", shiftKey: false, isComposing: false }, true)).toBe(false);
  expect(shouldSend({ key: "Enter", shiftKey: true, isComposing: false }, false)).toBe(false);
  expect(shouldSend({ key: "Enter", shiftKey: false, isComposing: false }, false)).toBe(true);
});
test("late save settles only its own outbox entry and preserves a newer draft", () => {
  expect(settleSubmission({ content: "새 메모", requestId: "two" }, [
    { content: "이전 메모", requestId: "one", state: "pending" },
    { content: "별도 미확인", requestId: "three", state: "unknown" },
  ], "one", true)).toEqual({ draft: { content: "새 메모", requestId: "two" }, submissions: [
    { content: "별도 미확인", requestId: "three", state: "unknown" },
  ] });
});
test("uncertain response keeps the original submitted text even after editing", () => {
  expect(settleSubmission({ content: "수정한 메모", requestId: "two" }, [
    { content: "전송한 메모", requestId: "one", state: "pending" },
  ], "one", false)).toEqual({ draft: { content: "수정한 메모", requestId: "two" }, submissions: [
    { content: "전송한 메모", requestId: "one", state: "unknown" },
  ] });
});
test("a definitive rejection releases its receipt while keeping the unchanged draft", () => {
  const draft = { content: "로그인 전 입력", requestId: "one" };
  expect(settleSubmission(draft, [{ ...draft, state: "pending" }], "one", "rejected")).toEqual({ draft, submissions: [] });
});
test("explicit recovery preserves a newer draft and never sends a request", () => {
  expect(restoreSubmission({ content: "새 내용", requestId: "two" }, [{ content: "확인할 내용", requestId: "one", state: "unknown" }], "one", "three")).toEqual({
    draft: { content: "새 내용\n\n확인할 내용", requestId: "three" }, submissions: [],
  });
});
test("recovery cannot resolve an operation still active in the quick window", () => {
  const item = { content: "기록", requestId: "draft", state: "pending" as const, operationId: "quick-op" };
  expect(submissionIsActive(item, ["quick-op"])).toBe(true);
  expect(submissionIsActive(item, [])).toBe(false);
});
