import { expect, test } from "bun:test";
import type { LlmChatResult, ObservableLlmClient } from "../../../llm/types.ts";
import { CircuitBreaker, CleanupLlmExecutor, createUsageAccumulator } from "../cleanup-llm-executor.ts";
import {
  buildEntityRegisterInstruction, createEntityRegisterInferFn, parseEntityRegisterResponse, parseEntityRegisterSingle,
  renderEntityRegisterMemoLine,
} from "./prompt.ts";

test("the single-memo instruction asks for one object without nodeId", () => {
  const text = buildEntityRegisterInstruction(["person"], "single");
  expect(text).toContain("JSON 객체 하나만");
  expect(text).not.toContain("JSON 배열 하나만");
});

test("the instruction lists every allowed type and asks for the memo-date based date", () => {
  const text = buildEntityRegisterInstruction(["person", "place", "work"]);
  for (const t of ["person", "place", "work"]) expect(text).toContain(`- ${t}:`);
  expect(text).toContain("eventDate");
  expect(text).toContain("createdAt");
  expect(text).not.toContain("- creature:");
});

test("a memo line carries its id, creation date, already-linked names and text", () => {
  const line = renderEntityRegisterMemoLine({ nodeId: 7, content: "민수가 왔다", createdAt: "2026-10-10 09:00:00", alreadyLinked: ["민수"] });
  expect(line).toContain('"nodeId":7');
  expect(line).toContain('"createdAt":"2026-10-10"');
  expect(line).toContain('"alreadyLinked":["민수"]');
});

test("a batch answer is read memo by memo", () => {
  const raw = 'note\n[{"nodeId":1,"entities":[{"type":"person","name":"민수"}],"eventDateText":"11월 3일","eventDate":"2026-11-03","scheduleTitle":"민수 결혼"},{"nodeId":2,"entities":[],"eventDateText":null,"eventDate":null,"scheduleTitle":null}]';
  const parsed = parseEntityRegisterResponse(raw);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toEqual({ nodeId: 1, entities: [{ type: "person", name: "민수" }], eventDateText: "11월 3일", eventDate: "2026-11-03", scheduleTitle: "민수 결혼" });
});

test("a broken answer is a loud parse error, never an empty result", () => {
  expect(() => parseEntityRegisterResponse("no json here")).toThrow("JSON 배열");
  expect(() => parseEntityRegisterResponse('[{"nodeId":1,"entities":"x"}]')).toThrow("entities");
  expect(() => parseEntityRegisterResponse('[{"nodeId":1,"entities":[],"eventDateText":5}]')).toThrow("eventDateText");
});

test("too many entities for one memo is a format error", () => {
  const many = Array.from({ length: 31 }, (_, i) => ({ type: "thing", name: `물건${i}` }));
  expect(() => parseEntityRegisterSingle({ entities: many, eventDateText: null, eventDate: null, scheduleTitle: null }, 1)).toThrow("30");
});

test("an inherited object key is not mistaken for a static type", () => {
  expect(() => buildEntityRegisterInstruction(["constructor"])).toThrow("constructor");
});

test("a missing date/title key is a loud format error, null is allowed", () => {
  expect(() => parseEntityRegisterSingle({ entities: [], eventDateText: null, eventDate: null }, 3)).toThrow("scheduleTitle");
  expect(() => parseEntityRegisterSingle({ entities: [] }, 3)).toThrow("node 3");
});

test("the title length in the instruction comes from the limits constant", () => {
  expect(buildEntityRegisterInstruction(["person"])).toContain("15자 이내");
});

test("an unparsable model answer becomes a deterministic failure with the reason", async () => {
  const stop: LlmChatResult = {
    text: "JSON 없음",
    stopReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  const client: ObservableLlmClient = { name: "fixture", chat: async () => "unused", chatDetailed: async () => stop };
  const executor = new CleanupLlmExecutor({ client, usage: createUsageAccumulator(), breaker: new CircuitBreaker(5) });
  const infer = createEntityRegisterInferFn(executor);
  const out = await infer({
    memos: [{ nodeId: 1, content: "민수가 왔다", createdAt: "2026-10-10 09:00:00", alreadyLinked: [] }],
    allowedTypes: ["person"],
  });
  expect(out.kind).toBe("deterministic");
  if (out.kind === "deterministic") expect(out.reason).toContain("JSON 배열");
});
