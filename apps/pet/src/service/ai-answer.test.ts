import { expect, test } from "bun:test";
import { messages } from "../ui/messages.ts";
import type { Memory } from "../shared/contracts.ts";
import { parseGroundedAnswer } from "./ai.ts";
import { groundedAnswerResult } from "./assistant.ts";

const known = [1, 2, 3];
const memory = (id: number) => ({ id, content: `기억 ${id}` }) as Memory;

test("a reply with supporting ids is returned with those ids once each", () => {
  expect(parseGroundedAnswer('{"answer":" 답 ","sourceIds":[2,2,3]}', known)).toEqual({ text: "답", sourceIds: [2, 3] });
});

test("empty sourceIds is the no-grounded-answer case: accepted, and the model's text is dropped", () => {
  expect(parseGroundedAnswer('{"answer":"저는 모르겠어요 하지만 아마도...","sourceIds":[]}', known)).toEqual({ text: "", sourceIds: [] });
  expect(parseGroundedAnswer('{"answer":"","sourceIds":[]}', known)).toEqual({ text: "", sourceIds: [] });
});

test("unknown ids, extra keys, a missing array, and an empty answer with ids are still refused", () => {
  for (const bad of ['{"answer":"x","sourceIds":[9]}', '{"answer":"x","sourceIds":[1.5]}', '{"answer":"x","sourceIds":[1],"extra":1}', '{"answer":"x"}', '{"answer":"  ","sourceIds":[1]}', '{"answer":1,"sourceIds":[]}'])
    expect(() => parseGroundedAnswer(bad, known)).toThrow(messages.aiService.answerSourcesUnconfirmed);
});

test("a grounded reply becomes a found answer with only its sources", () => {
  expect(groundedAnswerResult({ text: "답", sourceIds: [3] }, [memory(1), memory(3)], "A")).toEqual({ text: "답", sources: [memory(3)], generated: true, outcome: "found", audience: "A" });
});

test("a reply with no sources becomes a fixed not-found message with no sources, not an error and not a grounded answer", () => {
  const answer = groundedAnswerResult({ text: "", sourceIds: [] }, [memory(1)]);
  expect(answer).toEqual({ text: messages.assistant.noGroundedAnswer, sources: [], generated: false, outcome: "notFound" });
});
