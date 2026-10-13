import { expect, test } from "bun:test";
import { messages } from "./messages.ts";
import { pendingEntryStatusText, saveCheckOutcome } from "./recovery-model.ts";

// WP-PFIX-2: the recovery screen's "check save" must not call an entity-only update a saved memory.
test("a saved entity_patch answer settles the entry with the entity text, not the memory text", () => {
  expect(saveCheckOutcome({ state: "saved", requestId: "r1", resultType: "entity_patch" }))
    .toEqual({ settled: true, tone: "success", text: messages.composer.entityPatchSaved });
  expect(messages.composer.entityPatchSaved).not.toBe(messages.composer.saved);
});

test("a saved memory answer, with or without a result type, uses the memory text", () => {
  expect(saveCheckOutcome({ state: "saved", requestId: "r2", resultType: "memory" }))
    .toEqual({ settled: true, tone: "success", text: messages.composer.saved });
  expect(saveCheckOutcome({ state: "saved", requestId: "r3" }))
    .toEqual({ settled: true, tone: "success", text: messages.composer.saved });
});

test("a rejected answer drops the entry and an unconfirmed one keeps it, both with the server's reason", () => {
  expect(saveCheckOutcome({ state: "rejected", requestId: "r4", message: messages.serverClient.requestInvalid }))
    .toEqual({ settled: "rejected", tone: "error", text: messages.serverClient.requestInvalid });
  expect(saveCheckOutcome({ state: "unknown", requestId: "r5", message: "저장 여부를 확인하지 못했습니다." }))
    .toEqual({ settled: false, tone: "error", text: "저장 여부를 확인하지 못했습니다." });
  expect(saveCheckOutcome({ state: "pending", requestId: "r6" }))
    .toEqual({ settled: false, tone: "error", text: messages.errors.unknown });
});

// WP-P2-07: a failed `status` lookup must not be shown as the ordinary "saving" text -- the two
// reasons `busy` can be true (actually sending vs. status lookup failed) must read differently.
test("a pending entry that is actually in flight shows the ordinary saving text", () => {
  expect(pendingEntryStatusText(true, false, undefined)).toBe(messages.composer.saving);
});
test("a pending entry whose status lookup failed shows the specific cause, not the saving text", () => {
  const text = pendingEntryStatusText(true, true, "제어 프로세스에 연결할 수 없습니다.");
  expect(text).toBe(messages.composer.statusUnknown("제어 프로세스에 연결할 수 없습니다."));
  expect(text).not.toBe(messages.composer.saving);
});
test("a pending entry with a known, non-busy status still shows the plain pending-check text", () => {
  expect(pendingEntryStatusText(false, false, undefined)).toBe(messages.composer.pendingCheck);
});
test("busy from status failure with no captured reason falls back to the ordinary saving text", () => {
  // unknownDueToStatusFailure without statusError should not happen in practice (the catch always sets
  // one), but the function must not throw or show an empty message if it ever does.
  expect(pendingEntryStatusText(true, true, undefined)).toBe(messages.composer.saving);
});

// WP-P2-07: a failed "stop sending" (operation.cancel) must reach the screen with its cause instead
// of being swallowed by a bare `.catch(() => {})`.
test("the cancel-not-delivered notice names the actual failure reason", () => {
  const text = messages.composer.cancelNotDelivered("서버에 연결할 수 없습니다.");
  expect(text).toContain("서버에 연결할 수 없습니다.");
  expect(text).not.toBe("");
});
