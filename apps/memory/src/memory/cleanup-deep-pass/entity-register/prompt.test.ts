import { expect, test } from "bun:test";
import type { LlmChatResult, ObservableLlmClient } from "../../../llm/types.ts";
import { CircuitBreaker, CleanupLlmExecutor, createUsageAccumulator } from "../cleanup-llm-executor.ts";
import {
  buildEntityRegisterInstruction, createEntityRegisterInferFn, parseEntityRegisterResponse, parseEntityRegisterSingle,
  renderEntityRegisterMemoLine,
} from "./prompt.ts";
import { splitHonorific } from "./name-match.ts";
import { ENTITY_REGISTER_LIMITS } from "./constants.ts";

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

// ── 2026-10-20 instruction review ─────────────────────────────────────────────

/** Same shape as lang/ko.yaml entity_register (data fixture, as in name-match.test.ts). */
const KO_SUFFIX_PROFILE = {
  honorificSuffixes: ["오빠", "누나", "언니", "선배", "형", "씨", "님", "쌤", "이"],
  finalConsonantSuffixes: ["이"],
};

test("one honorific rule: every suffix stays attached, and the example names are the ones the judge splits", () => {
  const text = buildEntityRegisterInstruction(["person"]);
  expect(text).toContain("이름 끝 호칭(형·씨·님·선배 같은 것)은 떼지 않고 본문에 붙은 그대로 쓴다");
  expect(text).not.toContain('"~님", "~씨" 같은 존칭은 떼고');
  for (const [memo, name] of [["민수가", "민수"], ["지은이랑", "지은이"], ["민수형한테", "민수형"], ["김철수님께", "김철수님"]] as const) {
    expect(text).toContain(`"${memo}" -> "${name}"`);
  }
  // The kept-suffix examples are exactly what splitHonorific turns into a "base + suffix" proposal.
  for (const name of ["지은이", "민수형", "김철수님"]) {
    expect(splitHonorific(name, KO_SUFFIX_PROFILE, ENTITY_REGISTER_LIMITS.minSimilarNameChars)).not.toBeNull();
  }
  expect(splitHonorific("민수", KO_SUFFIX_PROFILE, ENTITY_REGISTER_LIMITS.minSimilarNameChars)).toBeNull();
});

test("several dates in one memo: pick the one main event so date text, date and title point at the same thing", () => {
  const text = buildEntityRegisterInstruction(["person"]);
  expect(text).toContain("10. 날짜가 여러 개면 메모가 가장 중심으로 말하는 일 하나의 날짜만 고른다.");
  expect(text).toContain("11. JSON 배열 하나만 출력한다.");
  expect(buildEntityRegisterInstruction(["person"], "single")).toContain("11. JSON 객체 하나만 출력한다");
});

test("intake and creature hints draw the line against the rule-3 generic words, only when the type is offered", () => {
  const text = buildEntityRegisterInstruction(["intake", "creature"]);
  expect(text).toContain("- intake: 먹거나 마시는 것 중 상품·메뉴처럼 하나를 콕 집는 이름. 우유·보리밥 같은 음식 일반 이름은 3번대로 뽑지 않는다");
  expect(text).toContain("- creature: 이름이 있는 동물·식물");
  // 식물 품종(몬스테라)은 creature 로 뽑고, 동물 종류 이름(고양이)만 3번대로 제외한다.
  expect(text).toContain("키우는 식물 이름이나 품종 예: 몬스테라");
  expect(text).toContain("고양이·강아지 같은 동물 종류 이름은 3번대로 뽑지 않는다");
  expect(buildEntityRegisterInstruction(["person"])).not.toContain("음식 일반 이름");
});

test("a batch answer wrapped in a code fence with bracketed chatter outside is still read", () => {
  const arr = '[{"nodeId":4,"entities":[],"eventDateText":null,"eventDate":null,"scheduleTitle":null}]';
  const raw = ["결과 [요약]:", "```json", arr, "```", "참고 [끝]"].join("\n");
  expect(parseEntityRegisterResponse(raw).map((r) => r.nodeId)).toEqual([4]);
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
