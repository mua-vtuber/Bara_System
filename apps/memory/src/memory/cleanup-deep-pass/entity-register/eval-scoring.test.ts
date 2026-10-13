import { expect, test } from "bun:test";
import { collectBatchAnswers, scoreCase, scoreMissing, summarize, type EvalCase } from "./eval-scoring.ts";

const c: EvalCase = {
  id: 28, src: "synthetic", createdAt: "2026-10-10 09:00:00", text: "지은이랑 12월 24일 강남역에서 만나기로 함",
  expect: { entities: [{ types: ["person"], names: ["지은"] }, { types: ["place"], names: ["강남역"] }], acceptable: [], forbidden: ["지은이"], schedule: { dateTexts: ["12월 24일"], date: "2026-12-24", required: true } },
  note: "",
};

test("hits, extras, forbidden names and the schedule are scored separately", () => {
  const s = scoreCase(c, { nodeId: 28, entities: [{ type: "person", name: "지은" }, { type: "place", name: "강남" }, { type: "person", name: "지은이" }], eventDateText: "12월 24일", eventDate: "2026-12-24", scheduleTitle: "지은 만남" });
  expect(s).toEqual({ id: 28, hits: 1, required: 2, extra: ["강남", "지은이"], forbiddenHit: ["지은이"], scheduleOk: true });
});

test("a wrong date fails the schedule, an optional schedule is not scored", () => {
  expect(scoreCase(c, { nodeId: 28, entities: [], eventDateText: "12월 24일", eventDate: "2026-12-25", scheduleTitle: "x" }).scheduleOk).toBe(false);
  const optional = { ...c, expect: { ...c.expect, schedule: { dateTexts: ["어제"], date: "2026-10-09", required: false } } };
  expect(scoreCase(optional, { nodeId: 28, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null }).scheduleOk).toBeNull();
});

test("a memo the model left unanswered is an error, never a correct-looking empty answer", () => {
  expect(scoreMissing(c)).toEqual({ id: 28, hits: 0, required: 2, extra: [], forbiddenHit: [], scheduleOk: false });
  const none = { ...c, expect: { ...c.expect, entities: [], schedule: null } };
  expect(scoreMissing(none)).toEqual({ id: 28, hits: 0, required: 0, extra: [], forbiddenHit: [], scheduleOk: null });
});

test("summary counts judge decisions", () => {
  const sum = summarize([], [{ nodeId: 1, entities: [{ action: "auto_create", type: "person", name: "a" }, { action: "discard", type: "person", name: "b", reason: "not_in_text" }], schedule: { action: "auto", title: "t", date: "2026-01-01", dateText: "1월 1일" } }]);
  expect(sum.decisions).toEqual({ auto: 2, propose: 0, discard: 1 });
});

test("answers for memos outside the batch and repeated answers for one memo are dropped and counted", () => {
  const answer = (nodeId: number) => ({ nodeId, entities: [], eventDateText: null, eventDate: null, scheduleTitle: null });
  const out = collectBatchAnswers([1, 2, 3], [answer(1), answer(9), answer(2), answer(2), answer(8)]);
  expect([...out.accepted.keys()]).toEqual([1]);
  expect(out.strayAnswers).toBe(2);
  expect(out.duplicateAnswers).toBe(2);
});

