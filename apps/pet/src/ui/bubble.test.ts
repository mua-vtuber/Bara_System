import { expect, test } from "bun:test";
import { bubbleActionFailureText, bubbleLoadFailureSummary } from "./feedback-model.ts";
import { messages } from "./messages.ts";

// WP-P2-15: get_feedback/dismiss_feedback/open_feedback failures must reach the bubble with their
// cause instead of being swallowed by `.catch(() => {})`, and must never read like the ordinary
// "nothing to show" empty state (PW-6).
test("a failed get_feedback read shows a load-failure summary distinct from the empty state", () => {
  const text = bubbleLoadFailureSummary("제어 프로세스에 연결할 수 없습니다.");
  expect(text).toBe(messages.feedback.feedbackLoadFailed("제어 프로세스에 연결할 수 없습니다."));
  expect(text).not.toBe(messages.feedback.noFeedback);
  expect(text).toContain("제어 프로세스에 연결할 수 없습니다.");
});

test("a failed dismiss_feedback call names the failure, not a silent no-op", () => {
  const text = bubbleActionFailureText("dismiss", "요청이 거부되었습니다.");
  expect(text).toBe(messages.feedback.dismissFailed("요청이 거부되었습니다."));
  expect(text).toContain("요청이 거부되었습니다.");
});

test("a failed open_feedback call names the failure, not a silent no-op", () => {
  const text = bubbleActionFailureText("open", "창을 열지 못했습니다.");
  expect(text).toBe(messages.feedback.openFailed("창을 열지 못했습니다."));
  expect(text).toContain("창을 열지 못했습니다.");
});

test("dismiss and open failures use distinct wording so the cause of each action is clear", () => {
  const reason = "네트워크 오류";
  expect(bubbleActionFailureText("dismiss", reason)).not.toBe(bubbleActionFailureText("open", reason));
});
