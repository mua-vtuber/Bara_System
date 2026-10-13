import { expect, test } from "bun:test";
import { startupFailureFeedback } from "./startup-failure.ts";
import { errorFeedback } from "./feedback-model.ts";
import { messages } from "./messages.ts";

test("the startup failure text names the cause and how to try again, in Korean", () => {
  const reason = messages.serverClient.networkFailed;
  const text = messages.feedback.startupConnectionFailed(reason);
  expect(text).toContain(reason);
  expect(text).toMatch(/[가-힣]/);
  expect(text).toContain("다시 실행");
  expect(text).toContain("연결과 설정");
});

test("an empty cause still produces the guidance text, so the bubble is never blank", () => {
  expect(messages.feedback.startupConnectionFailed("").trim()).not.toBe("");
  expect(messages.feedback.startupSettingsFailed("").trim()).not.toBe("");
});

test("the startup connection failure becomes an error bubble carrying the cause in its detail", () => {
  const reason = "서버에 닿지 않습니다.";
  const feedback = startupFailureFeedback("startup-check-1", "connection", reason);
  expect(feedback.id).toBe("startup-check-1");
  expect(feedback.kind).toBe("error");
  expect(feedback.summary).toBe(messages.feedback.error);
  expect(feedback.detail).toBe(messages.feedback.startupConnectionFailed(reason));
  expect(feedback.detail).toContain(reason);
  expect(feedback.requestId).toBeUndefined();
  expect(feedback.audience).toBeUndefined();
});

// WP-PFIX-6: reading the saved settings and checking the server connection are separate steps. A settings
// read failure must not be reported as "could not connect to the server".
test("a settings read failure gets its own text, not the connection failure text", () => {
  const reason = "설정 파일을 읽을 수 없습니다.";
  const feedback = startupFailureFeedback("startup-settings-1", "settings", reason);
  expect(feedback.kind).toBe("error");
  expect(feedback.summary).toBe(messages.feedback.error);
  expect(feedback.detail).toBe(messages.feedback.startupSettingsFailed(reason));
  expect(feedback.detail).toContain(reason);
  expect(feedback.detail).toContain("설정을 읽지 못해");
  expect(feedback.detail).not.toBe(messages.feedback.startupConnectionFailed(reason));
  expect(feedback.detail).not.toContain("서버에 연결하지 못했습니다");
  expect(startupFailureFeedback("startup-check-2", "connection", reason).detail).not.toContain("설정을 읽지 못해");
});

test("a credential-shaped fragment in the cause is masked before it reaches the bubble", () => {
  for (const stage of ["connection", "settings"] as const) {
    const feedback = startupFailureFeedback(crypto.randomUUID(), stage, "응답: Bearer secret-value-123");
    expect(feedback.detail).not.toContain("secret-value-123");
    expect(feedback.detail).toContain(messages.feedback.omittedCredential);
  }
});

// The app runs the startup check by itself: with the pet hidden its failure must wait in the tray's
// "최근 결과" instead of popping up, while a result the user asked for keeps no origin (the user's).
test("a startup failure is a background result; other error bubbles stay the user's", () => {
  expect(startupFailureFeedback("startup-check-2", "connection", "x").origin).toBe("background");
  expect(startupFailureFeedback("startup-settings-2", "settings", "x").origin).toBe("background");
  expect(errorFeedback("tray-1", "input", "x").origin).toBeUndefined();
});
