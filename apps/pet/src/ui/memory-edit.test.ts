import { expect, test } from "bun:test";
import type { Memory } from "../shared/contracts.ts";
import { normalizeMemory } from "../service/client.ts";
import { validateCapture } from "../service/validation.ts";
import { errorText } from "./error-text.ts";
import { labels, messages } from "./messages.ts";
import { categoryLabel, editReloadKind, loadEditable, memoryEditRequest, reloadCategory, seedCategory, unknownCategoryNotice } from "./memory-edit.ts";

test("information read from the server displays its label and survives an edit roundtrip", () => {
  const wire = { id: 41, content: "GPU는 4080S #컴퓨터사양", editableContent: "GPU는 4080S", metadata: { sharedMemory: { revision: 1 }, capture: { kind: "information", source: "ai" } } };
  const memory = normalizeMemory(wire, "server-A");
  expect(categoryLabel(memory)).toBe("정보·경험");
  expect(unknownCategoryNotice(memory)).toBeUndefined();
  expect(seedCategory(memory)).toEqual({ seeded: "information", selected: "information" });
  expect(memoryEditRequest(memory, "GPU는 4080S, RAM은 96GB", seedCategory(memory))).not.toHaveProperty("capture");

  const previous = normalizeMemory({ ...wire, metadata: { ...wire.metadata, capture: { kind: "preference", source: "ai" } } }, "server-A");
  const request = memoryEditRequest(previous, "GPU는 4080S", { ...seedCategory(previous), selected: "information" });
  expect(request).toEqual({ id: 41, audience: "server-A", expectedRevision: 1, capture: { kind: "information", source: "user" } });
  const reread = normalizeMemory({ ...wire, metadata: { sharedMemory: { revision: 2 }, capture: validateCapture(request.capture) } }, "server-A");
  expect(categoryLabel(reread)).toBe("정보·경험");
  expect(seedCategory(reread)).toEqual({ seeded: "information", selected: "information" });
});
test("classification-only edits omit raw hashtag content and preserve revision zero", () => {
  const memory: Memory = { id: 4, audience: "server-A", content: "기록 #독서", editableContent: "기록", revision: 0 };
  expect(memoryEditRequest(memory, "기록", { ...seedCategory(memory), selected: "idea" })).toEqual({
    id: 4, audience: "server-A", expectedRevision: 0, capture: { kind: "idea", source: "user" },
  });
});
test("body editing sends only the edited body for server-owned tag preservation", () => {
  const memory: Memory = { id: 4, audience: "server-A", content: "기록 #독서", editableContent: "기록", revision: 1 };
  expect(memoryEditRequest(memory, "새 기록", seedCategory(memory))).toEqual({
    id: 4, audience: "server-A", expectedRevision: 1, content: "새 기록",
  });
});
test("a legacy memory without an audience cannot issue an edit", () => {
  expect(() => memoryEditRequest({ id: 4, content: "기록" }, "새 기록", { seeded: "", selected: "" })).toThrow(messages.memory.audienceMissing);
});

// Data-loss regression: the select cannot represent an unknownCapture kind, so it starts at "" for such
// a memory. A body-only edit left at that default "" must not send `capture: null` -- that would erase
// the server's classification even though the user never touched the category field.
test("a memory with unknownCapture, body-edited and left at the default select, omits capture entirely", () => {
  const memory: Memory = { id: 9, audience: "server-A", content: "본문", editableContent: "본문", revision: 2, metadata: { unknownCapture: { kind: "habit", source: "ai" } } };
  expect(seedCategory(memory)).toEqual({ seeded: "", selected: "" });
  const request = memoryEditRequest(memory, "고친 본문", seedCategory(memory));
  expect(request).toEqual({ id: 9, audience: "server-A", expectedRevision: 2, content: "고친 본문" });
  expect(request).not.toHaveProperty("capture");
});

// WP-PFIX-2: the category is sent only when the user changed it in this edit session. An untouched
// known category is not re-sent, so a stale select value can never overwrite the server.
test("a known category left unchanged is not re-sent with a body edit", () => {
  const memory: Memory = { id: 10, audience: "server-A", content: "기록", editableContent: "기록", revision: 0, metadata: { capture: { kind: "idea", source: "user" } } };
  const request = memoryEditRequest(memory, "고친 기록", seedCategory(memory));
  expect(request).toEqual({ id: 10, audience: "server-A", expectedRevision: 0, content: "고친 기록" });
  expect(request).not.toHaveProperty("capture");
});

// WP-P2-08: an AI-classified memory's body-only edit must not promote the AI's classification to a
// user-confirmed one. Changing the select to a different kind is still a deliberate user choice.
test("an AI-classified memory's body-only edit omits capture, and changing the select sends a user capture", () => {
  const memory: Memory = { id: 30, audience: "server-A", content: "기록", editableContent: "기록", revision: 0, metadata: { capture: { kind: "decision", source: "ai" } } };
  expect(memoryEditRequest(memory, "고친 기록", seedCategory(memory))).not.toHaveProperty("capture");
  expect(memoryEditRequest(memory, "기록", { ...seedCategory(memory), selected: "task" }))
    .toEqual({ id: 30, audience: "server-A", expectedRevision: 0, capture: { kind: "task", source: "user" } });
});

test("clearing a known category is a deliberate change and sends capture null", () => {
  const memory: Memory = { id: 10, audience: "server-A", content: "기록", editableContent: "기록", revision: 0, metadata: { capture: { kind: "idea", source: "user" } } };
  expect(memoryEditRequest(memory, "기록", { ...seedCategory(memory), selected: "" }))
    .toEqual({ id: 10, audience: "server-A", expectedRevision: 0, capture: null });
});

test("a save that changes neither body nor category is refused instead of sending an empty edit", () => {
  const known: Memory = { id: 11, audience: "server-A", content: "기록", editableContent: "기록", revision: 0, metadata: { capture: { kind: "idea", source: "user" } } };
  const none: Memory = { id: 11, audience: "server-A", content: "기록", editableContent: "기록", revision: 0 };
  expect(() => memoryEditRequest(known, "기록", seedCategory(known))).toThrow(messages.memory.nothingToSave);
  expect(() => memoryEditRequest(none, "기록", seedCategory(none))).toThrow(messages.memory.nothingToSave);
  // Choosing another category and then going back to the original is no change either.
  expect(() => memoryEditRequest(known, "기록", { seeded: "idea", selected: "idea" })).toThrow(messages.memory.nothingToSave);
});

// WP-PFIX-2 (High): the QA scenario. The dialog read "idea"; someone else changed the category to "task"
// (new revision); the user's body save hit 409; "reload the latest" re-read the server. The next save
// must never send the stale "idea" back.
test("after a conflict reload an untouched category follows the server and the next save never sends the stale one", () => {
  const opened: Memory = { id: 20, audience: "server-A", content: "원문", editableContent: "원문", revision: 1, metadata: { capture: { kind: "idea", source: "user" } } };
  const beforeConflict = seedCategory(opened);
  expect(memoryEditRequest(opened, "고친 원문", beforeConflict)).not.toHaveProperty("capture");
  const latest: Memory = { id: 20, audience: "server-A", content: "원문", editableContent: "원문", revision: 2, metadata: { capture: { kind: "task", source: "user" } } };
  const synced = reloadCategory(beforeConflict, latest);
  expect(synced).toEqual({ choice: { seeded: "task", selected: "task" } });
  const request = memoryEditRequest(latest, "고친 원문", synced.choice);
  expect(request).toEqual({ id: 20, audience: "server-A", expectedRevision: 2, content: "고친 원문" });
  expect(request).not.toHaveProperty("capture");
});

test("a category the user changed before the conflict is still sent, with the latest server category shown beside it", () => {
  const opened: Memory = { id: 21, audience: "server-A", content: "원문", editableContent: "원문", revision: 1, metadata: { capture: { kind: "idea", source: "user" } } };
  const chosen = { ...seedCategory(opened), selected: "decision" as const };
  const latest: Memory = { id: 21, audience: "server-A", content: "원문", editableContent: "원문", revision: 2, metadata: { capture: { kind: "task", source: "ai" } } };
  const synced = reloadCategory(chosen, latest);
  expect(synced).toEqual({ choice: { seeded: "task", selected: "decision" }, latestLabel: labels.task });
  expect(memoryEditRequest(latest, "고친 원문", synced.choice)).toEqual({
    id: 21, audience: "server-A", expectedRevision: 2, content: "고친 원문", capture: { kind: "decision", source: "user" },
  });
});

test("a user's choice that already equals the latest server category needs no note and is not re-sent", () => {
  const opened: Memory = { id: 22, audience: "server-A", content: "원문", editableContent: "원문", revision: 1, metadata: { capture: { kind: "idea", source: "user" } } };
  const latest: Memory = { id: 22, audience: "server-A", content: "원문", editableContent: "원문", revision: 2, metadata: { capture: { kind: "task", source: "user" } } };
  const synced = reloadCategory({ ...seedCategory(opened), selected: "task" }, latest);
  expect(synced).toEqual({ choice: { seeded: "task", selected: "task" } });
  expect(memoryEditRequest(latest, "고친 원문", synced.choice)).not.toHaveProperty("capture");
});

test("after a conflict reload an untouched select keeps an unknown server category untouched", () => {
  const opened: Memory = { id: 23, audience: "server-A", content: "원문", editableContent: "원문", revision: 1, metadata: { capture: { kind: "idea", source: "user" } } };
  const latest: Memory = { id: 23, audience: "server-A", content: "원문", editableContent: "원문", revision: 2, metadata: { unknownCapture: { kind: "habit", source: "ai" } } };
  const synced = reloadCategory(seedCategory(opened), latest);
  expect(synced).toEqual({ choice: { seeded: "", selected: "" } });
  expect(memoryEditRequest(latest, "고친 원문", synced.choice)).not.toHaveProperty("capture");
  // A choice made before the conflict replaces the unknown category, and the note names what it replaces.
  const chosen = reloadCategory({ ...seedCategory(opened), selected: "decision" }, latest);
  expect(chosen).toEqual({ choice: { seeded: "", selected: "decision" }, latestLabel: messages.memory.unknownCategory("habit") });
});

test("the editor names a memory's server category and explains only an unknown one", () => {
  const base: Memory = { id: 24, content: "원문" };
  expect(categoryLabel({ ...base, metadata: { capture: { kind: "task", source: "user" } } })).toBe(labels.task);
  expect(categoryLabel({ ...base, metadata: { unknownCapture: { kind: "habit", source: "ai" } } })).toBe(messages.memory.unknownCategory("habit"));
  expect(categoryLabel(base)).toBe(messages.common.noCategory);
  expect(unknownCategoryNotice({ ...base, metadata: { unknownCapture: { kind: "habit", source: "ai" } } }))
    .toBe(`${messages.memory.unknownCategory("habit")} · ${messages.memory.unknownCategoryHint}`);
  expect(unknownCategoryNotice({ ...base, metadata: { capture: { kind: "task", source: "user" } } })).toBeUndefined();
});

// WP-P2-09 (CC-3): a memory read without the server's tag-free body must never turn into a PATCH whose
// body is the tagged original. The request builder refuses it instead of comparing against `content`.
test("a memory without editableContent cannot produce an edit request, so the tagged original is never sent", () => {
  const tagged: Memory = { id: 12, audience: "server-A", content: "기록 #독서", revision: 3 };
  expect(() => memoryEditRequest(tagged, "기록 #독서", seedCategory(tagged))).toThrow(messages.memory.editableBodyMissing);
  expect(() => memoryEditRequest(tagged, "고친 기록", { ...seedCategory(tagged), selected: "idea" })).toThrow(messages.memory.editableBodyMissing);
});

test("a memory without a revision cannot produce an edit request, so the stale-edit check is never skipped", () => {
  expect(() => memoryEditRequest({ id: 13, audience: "server-A", content: "기록", editableContent: "기록" }, "고친 기록", { seeded: "", selected: "" }))
    .toThrow(messages.memory.editRevisionMissing);
});

test("loadEditable returns the re-read memory when the server sends its tag-free body", async () => {
  const latest: Memory = { id: 14, audience: "server-A", content: "기록 #독서", editableContent: "기록", revision: 4 };
  expect(await loadEditable(async () => latest, String)).toEqual({ ...latest, editableContent: "기록" });
});

test("loadEditable blocks the edit with the read failure's cause when the re-read fails", async () => {
  const failure = { code: "NETWORK", message: messages.serverClient.networkFailed };
  const blocked = loadEditable(async () => { throw failure; }, errorText);
  await expect(blocked).rejects.toThrow(messages.memory.editReloadFailed(failure.message));
  await expect(blocked).rejects.toMatchObject({ cause: failure });
});

test("loadEditable blocks the edit when the re-read still has no tag-free body", async () => {
  await expect(loadEditable(async () => ({ id: 15, audience: "server-A", content: "기록 #독서", revision: 0 }), String))
    .rejects.toThrow(messages.memory.editableBodyMissing);
});

// The native bridge rejects with `{ code, message }` objects (src-tauri/src/bridge/protocol.rs `service_error`).
test("editReloadKind offers a reload only for the edit conflicts and the saved-but-unread edit", () => {
  expect(editReloadKind({ code: "EDIT_REREAD_FAILED", message: messages.memory.editRereadFailed() })).toBe("saved");
  expect(editReloadKind({ code: "EDIT_CONFLICT", message: messages.memory.editConflict })).toBe("conflict");
  expect(editReloadKind({ code: "CAPTURE_CONFLICT", message: messages.memory.captureConflict })).toBe("conflict");
  expect(editReloadKind({ code: "EDIT_CONFLICT" })).toBe("conflict");
  expect(editReloadKind({ code: "CONFLICT", message: messages.serverClient.http.conflict })).toBeUndefined();
  expect(editReloadKind({ code: "NETWORK", message: "서버에 연결하지 못했습니다." })).toBeUndefined();
  expect(editReloadKind({ code: "HOST_SERVICE_STOPPED" })).toBeUndefined();
  expect(editReloadKind(new Error(messages.memory.editConflict))).toBeUndefined();
  // The old joined "CODE: message" string is no longer a bridge format and is not parsed.
  expect(editReloadKind(`EDIT_CONFLICT: ${messages.memory.editConflict}`)).toBeUndefined();
});

test("the edit dialog shows the service's own conflict text for an edit conflict", () => {
  expect(errorText({ code: "EDIT_CONFLICT", message: messages.memory.editConflict })).toBe(messages.memory.editConflict);
  expect(errorText({ code: "EDIT_REREAD_FAILED", message: messages.memory.editRereadFailed() })).toBe(messages.memory.editRereadFailed());
});
