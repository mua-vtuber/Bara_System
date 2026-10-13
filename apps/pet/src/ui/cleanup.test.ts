import { expect, test } from "bun:test";
import type { CleanupResult } from "../shared/contracts.ts";
import { messages } from "./messages.ts";
import { cleanupAvailability, cleanupFailureReason, cleanupRejectionReason, cleanupResultText, cleanupRunNotice } from "./cleanup.ts";

// WP-P2-16 (PV-9): an unconfigured cleanup provider must disable the run button and name what is
// missing, instead of the screen silently allowing a run against a provider nobody chose.
test("cleanup is disabled with a named reason when no provider is configured", () => {
  expect(cleanupAvailability("none")).toEqual({ canRun: false, notice: messages.cleanup.notConfigured });
});

test("cleanup can run once a provider is configured", () => {
  for (const provider of ["claude", "codex", "ollama", "openai-compatible"] as const) {
    expect(cleanupAvailability(provider)).toEqual({ canRun: true });
  }
});

// WP-P2-02: a run that skipped candidates with a recorded cause shows that cause, not a bare
// success banner that hides the failure.
test("a clean run with no skips shows the plain success notice", () => {
  const result: CleanupResult = { submitted: 3, noFinding: 2, skipped: 0 };
  expect(cleanupRunNotice(result)).toEqual({ text: messages.cleanup.submitted(3), kind: "success" });
});

test("a run with skipped candidates and recorded failures surfaces their causes as an error notice", () => {
  const result: CleanupResult = { submitted: 1, noFinding: 0, skipped: 3,
    failures: [{ stage: "regexStrengthen", code: "DISABLED", message: "regex cleanup is disabled" }, { stage: "personLink", code: "FORBIDDEN", message: "not allowed" },
      { stage: "lensDraft", code: "FORBIDDEN", message: "not allowed" }] };
  expect(cleanupRunNotice(result)).toEqual({ text: messages.cleanup.submittedWithFailures(1, 3), kind: "error" });
  // The causes are written once, in the result paragraph, not repeated in the notice.
  expect(cleanupRunNotice(result).text).not.toContain(messages.cleanup.failureReasons.DISABLED!);
});

// WP-PFIX-4: the notice names each cause in Korean instead of bare English codes. A code without its own
// Korean text keeps the cause sentence that came with it, so nothing is reduced to an unexplained code.
test("a known failure code reads as its Korean cause", () => {
  for (const code of ["DISABLED", "FORBIDDEN", "INVALID_INPUT", "NOT_FOUND", "STALE_CANDIDATE", "CANDIDATE_INVALID"]) {
    const text = cleanupFailureReason({ stage: "personLink", code, message: "server sentence" });
    expect({ code, text }).toEqual({ code, text: messages.cleanup.failureReasons[code] });
    expect(text).not.toContain(code);
  }
});

test("a code without Korean text is shown with the cause sentence the server or the Pet sent", () => {
  expect(cleanupFailureReason({ stage: "lensDraft", code: "INTERNAL", message: "제안 등록 실패: database is locked" }))
    .toBe(messages.cleanup.failureWithCause("INTERNAL", "제안 등록 실패: database is locked"));
  // A code named like an Object prototype member is still an unknown code, not a lookup hit.
  expect(cleanupFailureReason({ stage: "lensDraft", code: "toString", message: "odd" })).toBe(messages.cleanup.failureWithCause("toString", "odd"));
});

// The Pet's own check of the cleanup AI's answer always carries one of the Pet's Korean sentences, which already
// says what was wrong, so the screen shows that sentence without the bare AI_PROPOSAL code.
test("a rejected AI answer reads as the Pet's own sentence, without its code", () => {
  const text = cleanupFailureReason({ stage: "regexStrengthen", code: "AI_PROPOSAL", message: messages.cleanupService.regexUnconfirmed });
  expect(text).toBe(messages.cleanupService.regexUnconfirmed);
  expect(text).not.toContain("AI_PROPOSAL");
  // An empty sentence is never shown bare: the code stays with the empty-cause text.
  expect(cleanupFailureReason({ stage: "regexStrengthen", code: "AI_PROPOSAL", message: " " })).toBe(messages.cleanup.failureWithCause("AI_PROPOSAL", " "));
});

test("the result paragraph says plainly when no proposal was made", () => {
  expect(messages.cleanup.resultCounts(0, 2)).not.toContain("0건");
  expect(messages.cleanup.resultCounts(3, 0)).toContain("3건");
});

test("a run with skipped candidates but no recorded failure detail still shows plain success", () => {
  // Defensive: skipped>0 without failures (e.g. an older service) must not crash the notice logic.
  const result: CleanupResult = { submitted: 1, noFinding: 0, skipped: 1 };
  expect(cleanupRunNotice(result)).toEqual({ text: messages.cleanup.submitted(1), kind: "success" });
});

// WP-PFIX-5: the result paragraph is written from the run's counts and failures with the Korean causes,
// not from a service sentence, so a code such as DISABLED never stands there without its explanation.
test("the result paragraph states the counts only when nothing was skipped", () => {
  expect(cleanupResultText({ submitted: 3, noFinding: 2, skipped: 0 })).toBe(messages.cleanup.resultCounts(3, 2));
});

test("the result paragraph gives each skipped cause in Korean, never as a bare code", () => {
  const text = cleanupResultText({ submitted: 1, noFinding: 0, skipped: 3,
    failures: [{ stage: "regexStrengthen", code: "DISABLED", message: "regex cleanup is disabled" }, { stage: "personLink", code: "FORBIDDEN", message: "not allowed" },
      { stage: "lensDraft", code: "FORBIDDEN", message: "not allowed" }] });
  const reasons = [messages.cleanup.failureReasons.DISABLED, messages.cleanup.failureReasons.FORBIDDEN].join(" / ");
  expect(text).toBe(`${messages.cleanup.resultCounts(1, 0)} ${messages.cleanup.resultSkipped(3, reasons)}`);
  expect(text).not.toContain("DISABLED");
  expect(text).not.toContain("FORBIDDEN");
});

test("the result paragraph keeps the code with its cause sentence when no Korean text exists for the code", () => {
  const text = cleanupResultText({ submitted: 0, noFinding: 1, skipped: 1,
    failures: [{ stage: "lensDraft", code: "INTERNAL", message: "제안 등록 실패: database is locked" }] });
  expect(text).toBe(`${messages.cleanup.resultCounts(0, 1)} ${messages.cleanup.resultSkipped(1, "INTERNAL: 제안 등록 실패: database is locked")}`);
});

test("skipped candidates without any recorded failure are still counted, without a reason", () => {
  expect(cleanupResultText({ submitted: 0, noFinding: 0, skipped: 2 }))
    .toBe(`${messages.cleanup.resultCounts(0, 0)} ${messages.cleanup.resultSkipped(2)}`);
});

// WP-PFIX-9: a request to the cleanup server that got no answer reads as its own Korean cause, not as the
// bare code. The unexpected one keeps its code together with the cause sentence the service wrote for it.
test("the result paragraph names each way a request to the cleanup server got no answer", () => {
  const unexpected = messages.cleanupService.mcp.requestUnexpected("TypeError: the cause");
  const text = cleanupResultText({ submitted: 0, noFinding: 0, skipped: 4,
    failures: [{ stage: "regexStrengthen", code: "MCP_NETWORK", message: messages.cleanupService.mcp.networkFailed },
      { stage: "personLink", code: "MCP_TIMEOUT", message: messages.cleanupService.mcp.timedOut },
      { stage: "personLink", code: "MCP_REDIRECT", message: messages.cleanupService.mcp.redirected },
      { stage: "lensDraft", code: "MCP_REQUEST_UNEXPECTED", message: unexpected }] });
  const reasons = [messages.cleanup.failureReasons.MCP_NETWORK, messages.cleanup.failureReasons.MCP_TIMEOUT,
    messages.cleanup.failureReasons.MCP_REDIRECT, `MCP_REQUEST_UNEXPECTED: ${unexpected}`].join(" / ");
  expect(text).toBe(`${messages.cleanup.resultCounts(0, 0)} ${messages.cleanup.resultSkipped(4, reasons)}`);
  for (const code of ["MCP_NETWORK", "MCP_TIMEOUT", "MCP_REDIRECT"]) expect(text).not.toContain(code);
});

// WP-PFIX-11: a failure of the request to the cleanup AI's server reads as the cleanup AI's, never as the
// memory server's "AUTH_REQUIRED: server authentication needed". A fixed cause has Korean text of its own; the
// two that carry the request layer's sentence show their code with that sentence.
test("a failure of the cleanup AI's server reads as its own Korean cause, or as its code with the sentence that came with it", () => {
  for (const code of ["CLEANUP_AI_AUTH_REQUIRED", "CLEANUP_AI_FORBIDDEN", "CLEANUP_AI_HTTP_FAILED"]) {
    const text = cleanupFailureReason({ stage: "personLink", code, message: "service sentence" });
    expect({ code, text }).toEqual({ code, text: messages.cleanup.failureReasons[code] });
    expect(text).toContain("정리 AI 서버");
    expect(text).not.toContain(code);
  }
  const sentence = messages.cleanupService.aiServer.failedWith(messages.serverClient.responseMalformed);
  for (const code of ["CLEANUP_AI_RESPONSE", "CLEANUP_AI_REQUEST_UNEXPECTED"]) {
    expect(Object.hasOwn(messages.cleanup.failureReasons, code)).toBe(false);
    expect(cleanupFailureReason({ stage: "personLink", code, message: sentence })).toBe(messages.cleanup.failureWithCause(code, sentence));
  }
  const text = cleanupResultText({ submitted: 0, noFinding: 0, skipped: 2,
    failures: [{ stage: "personLink", code: "CLEANUP_AI_AUTH_REQUIRED", message: messages.cleanupService.aiServer.authRejected },
      { stage: "lensDraft", code: "CLEANUP_AI_AUTH_REQUIRED", message: messages.cleanupService.aiServer.authRejected }] });
  expect(text).toBe(`${messages.cleanup.resultCounts(0, 0)} ${messages.cleanup.resultSkipped(2, messages.cleanup.failureReasons.CLEANUP_AI_AUTH_REQUIRED)}`);
  expect(text).not.toContain("AUTH_REQUIRED");
});

// 2026-10-11 regex alignment D4: a rule the cleanup server's quality checks turned down is counted on its own,
// neither as a made proposal nor as a skip, and its reason is said once, in Korean, in the result paragraph.
test("rejected rules get their own count in the notice and their Korean reasons once in the result paragraph", () => {
  const result: CleanupResult = { submitted: 1, noFinding: 0, skipped: 0, rejected: 2,
    rejections: [{ stage: "regexStrengthen", reason: "overmatch", detail: "과매치율 0.5 — 임계 0.3 초과" }, { stage: "regexStrengthen", reason: "overmatch", detail: "과매치율 0.9 — 임계 0.3 초과" }] };
  expect(cleanupRunNotice(result)).toEqual({ text: messages.cleanup.submittedWithRejections(1, 2), kind: "success" });
  expect(cleanupRunNotice(result).text).not.toContain(messages.cleanup.rejectionReasons.overmatch!);
  const text = cleanupResultText(result);
  expect(text).toBe(`${messages.cleanup.resultCounts(1, 0)} ${messages.cleanup.resultRejected(2, messages.cleanup.rejectionReasons.overmatch)}`);
  expect(text).not.toContain("overmatch");
});

test("every check the server runs has its own Korean reason; an unknown one keeps the server's sentence", () => {
  for (const reason of ["compile", "self_match", "overmatch", "redundant", "validity"]) {
    const text = cleanupRejectionReason({ stage: "regexStrengthen", reason, detail: "server sentence" });
    expect({ reason, text }).toEqual({ reason, text: messages.cleanup.rejectionReasons[reason] });
  }
  expect(cleanupRejectionReason({ stage: "regexStrengthen", reason: "future_check", detail: "새 검사에서 떨어짐" }))
    .toBe(messages.cleanup.failureWithCause("future_check", "새 검사에서 떨어짐"));
});

test("rejections and skips together: an error notice with both counts, the paragraph names both reasons", () => {
  const result: CleanupResult = { submitted: 0, noFinding: 1, skipped: 1, rejected: 1,
    failures: [{ stage: "personLink", code: "FORBIDDEN", message: "not allowed" }],
    rejections: [{ stage: "regexStrengthen", reason: "self_match", detail: "예문 매치 0" }] };
  expect(cleanupRunNotice(result)).toEqual({ text: messages.cleanup.submittedWithFailuresAndRejections(0, 1, 1), kind: "error" });
  // Counts only: the reasons stand once, in the paragraph.
  expect(cleanupRunNotice(result).text).not.toContain(messages.cleanup.rejectionReasons.self_match!);
  expect(cleanupResultText(result)).toBe([
    messages.cleanup.resultCounts(0, 1),
    messages.cleanup.resultRejected(1, messages.cleanup.rejectionReasons.self_match),
    messages.cleanup.resultSkipped(1, messages.cleanup.failureReasons.FORBIDDEN),
  ].join(" "));
});
