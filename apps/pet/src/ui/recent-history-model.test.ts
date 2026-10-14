import { expect, test } from "bun:test";
import { answerFeedback } from "./feedback-model.ts";
import { messages } from "./messages.ts";
import { answerEntry, confirmedEntry, parseAnswers, parseSaves, pushRecent, RECENT_LIMIT, saveEntry, saveOutcome, saveOutcomeText } from "./recent-history-model.ts";

const AT = "2026-10-14T09:30:00.000Z";
const label = (kind: string) => `[${kind}]`;

test("a new entry goes first and the list keeps only the newest five", () => {
  let list: number[] = [];
  for (let i = 1; i <= 7; i++) list = pushRecent(list, i);
  expect(list).toEqual([7, 6, 5, 4, 3]);
  expect(list.length).toBe(RECENT_LIMIT);
});

test("an answer entry keeps the question with the answer bubble's text, sources and server", () => {
  const feedback = answerFeedback("op", "답변 본문", [{ id: 3, content: "근거" }], true, "found", "server-A");
  const entry = answerEntry("지난주에 뭐 했지?", feedback, true, "found", AT);
  expect(entry).toEqual({ at: AT, question: "지난주에 뭐 했지?", answer: "답변 본문", generated: true, outcome: "found",
    sources: [{ id: 3, content: "근거" }], audience: "server-A" });
});

test("an answer entry masks a credential written in the question", () => {
  const feedback = answerFeedback("op", "답", [], false, "notFound");
  const entry = answerEntry("토큰 bearer abc.def 맞아?", feedback, false, "notFound", AT);
  expect(entry.question).not.toContain("abc.def");
  expect(entry.audience).toBeUndefined();
});

test("each save result maps to the outcome the saved bubble names, in the same order", () => {
  expect(saveOutcome({ state: "saved", requestId: "r", classification: { outcome: "failed", reason: "AI 서버 없음" },
    resultType: "entity_patch" })).toEqual({ kind: "classificationFailed", reason: "AI 서버 없음" });
  expect(saveOutcome({ state: "saved", requestId: "r", classification: { outcome: "applied", capture: { kind: "idea", source: "ai" } } }))
    .toEqual({ kind: "saved", captureKind: "idea" });
  expect(saveOutcome({ state: "saved", requestId: "r", resultType: "entity_patch" })).toEqual({ kind: "entityPatch" });
  expect(saveOutcome({ state: "saved", requestId: "r", classification: { outcome: "undecided" } })).toEqual({ kind: "saved" });
  expect(saveOutcome({ state: "rejected", requestId: "r", message: "너무 길어요" })).toEqual({ kind: "rejected", reason: "너무 길어요" });
  expect(saveOutcome({ state: "rejected", requestId: "r" })).toEqual({ kind: "rejected" });
});

test("a save that has not ended is not a recent save: it stays in the outbox", () => {
  expect(saveEntry("본문", { state: "pending", requestId: "r" }, "server-A", AT)).toBeNull();
  expect(saveEntry("본문", { state: "unknown", requestId: "r" }, "server-A", AT)).toBeNull();
});

test("a saved entry links its memory only when the server answered for the connection it was sent to", () => {
  const memory = { id: 9, content: "본문" };
  expect(saveEntry("본문", { state: "saved", requestId: "r", memory, audience: "server-A" }, "server-A", AT))
    .toEqual({ at: AT, content: "본문", outcome: { kind: "saved" }, memoryId: 9, audience: "server-A" });
  const other = saveEntry("본문", { state: "saved", requestId: "r", memory, audience: "server-B" }, "server-A", AT);
  expect(other?.memoryId).toBeUndefined();
  expect(other?.audience).toBeUndefined();
});

test("a save the user settled by hand says so", () => {
  expect(confirmedEntry("본문", AT)).toEqual({ at: AT, content: "본문", outcome: { kind: "confirmedByUser" } });
  expect(saveOutcomeText({ kind: "confirmedByUser" }, label)).toBe(messages.recent.confirmedByUser);
});

test("each outcome has its own sentence, and a rejection without a reason says the server gave none", () => {
  expect(saveOutcomeText({ kind: "saved", captureKind: "idea" }, label)).toBe(messages.recent.savedAs("[idea]"));
  expect(saveOutcomeText({ kind: "saved" }, label)).toBe(messages.recent.savedPlain);
  expect(saveOutcomeText({ kind: "entityPatch" }, label)).toBe(messages.recent.entityPatched);
  expect(saveOutcomeText({ kind: "classificationFailed", reason: "원인" }, label)).toContain("원인");
  expect(saveOutcomeText({ kind: "rejected", reason: "너무 길어요" }, label)).toBe(messages.recent.rejected("너무 길어요"));
  expect(saveOutcomeText({ kind: "rejected" }, label)).toBe(messages.recent.rejectedNoReason);
});

test("stored lists read back as written; nothing stored is an empty list", () => {
  const answer = answerEntry("질문", answerFeedback("op", "답", [], true, "found"), true, "found", AT);
  expect(parseAnswers(JSON.stringify([answer]), "k")).toEqual([answer]);
  const save = confirmedEntry("본문", AT);
  expect(parseSaves(JSON.stringify([save]), "k")).toEqual([save]);
  expect(parseAnswers(null, "k")).toEqual([]);
  expect(parseSaves(null, "k")).toEqual([]);
});

test("a broken stored list fails with its storage key instead of reading as empty", () => {
  for (const raw of ["{", "{}", JSON.stringify([{ at: AT }]), JSON.stringify([{ at: "아님", content: "x", outcome: { kind: "saved" } }]),
    JSON.stringify([{ at: AT, content: "x", outcome: { kind: "모름" } }])]) {
    expect(() => parseSaves(raw, "bara.pet.recent-saves.v1")).toThrow(messages.recent.unreadable("bara.pet.recent-saves.v1"));
  }
  expect(() => parseAnswers(JSON.stringify([{ at: AT, question: "q", answer: "a", generated: true, outcome: "found", sources: [{ id: 0, content: "" }] }]), "k"))
    .toThrow(messages.recent.unreadable("k"));
});
