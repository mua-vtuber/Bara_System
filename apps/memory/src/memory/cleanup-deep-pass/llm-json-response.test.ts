/**
 * llm-json-response.test.ts — 정리 AI 응답 글에서 JSON 을 꺼내는 공용 함수(순수 함수, 데이터 입력만).
 */

import { expect, test } from "bun:test";
import { extractLlmJson } from "./llm-json-response.ts";

test("글 전체가 JSON 이면 그대로 읽는다(문자열 안 괄호도 그대로)", () => {
  expect(extractLlmJson(' [{"a":"[x] {y}"}] ', "array")).toEqual([{ a: "[x] {y}" }]);
  expect(extractLlmJson('{"k":[1,2]}', "object")).toEqual({ k: [1, 2] });
});

test("글 전체를 감싼 코드 울타리 하나는 벗긴다", () => {
  expect(extractLlmJson("```json\n[1,2]\n```", "array")).toEqual([1, 2]);
  expect(extractLlmJson("```\n{\"k\":1}\n```", "object")).toEqual({ k: 1 });
});

test("울타리 밖 설명 글에 괄호가 섞여도 울타리 안 값을 읽는다(옛 첫~끝 괄호 구간은 여기서 깨졌다)", () => {
  const raw = ["참고 [1] 결과입니다:", "```json", '[{"n":1}]', "```", "주의 [2]"].join("\n");
  expect(extractLlmJson(raw, "array")).toEqual([{ n: 1 }]);
  const obj = ["양식 {예시}:", "```", '{"chunkSummaries":[]}', "```", "끝 {완료}"].join("\n");
  expect(extractLlmJson(obj, "object")).toEqual({ chunkSummaries: [] });
});

test("울타리 없이 앞뒤 잡담만 있으면 옛 방식(첫 여는 괄호 ~ 마지막 닫는 괄호)으로 읽는다", () => {
  expect(extractLlmJson('결과: [1, 2] 입니다', "array")).toEqual([1, 2]);
  expect(extractLlmJson('note {"k":1} done', "object")).toEqual({ k: 1 });
});

test("울타리 없이 잡담에 [12] 같은 괄호가 앞서면 객체만 담긴 첫 배열을 읽는다(문자열 안 괄호는 건너뜀)", () => {
  expect(extractLlmJson('참고 [12] 결과: [{"a":"[x]"}] 끝', "array")).toEqual([{ a: "[x]" }]);
  // 객체 아닌 원소 배열뿐이면 옛 방식으로 넘어가 파싱 실패.
  expect(() => extractLlmJson("앞 [1] 뒤 [2, 3]", "array")).toThrow("LLM 응답 JSON 파싱 실패");
});

test("rejectWholeOtherShape 면 글 전체가 다른 모양 JSON 일 때 속을 뒤지지 않고 던진다", () => {
  expect(() =>
    extractLlmJson('{"results":[{"a":1}]}', "array", { rejectWholeOtherShape: true }),
  ).toThrow("LLM 응답이 배열이 아님");
  expect(extractLlmJson('잡담 {"a":1} [{"b":2}]', "array", { rejectWholeOtherShape: true })).toEqual([{ b: 2 }]);
});

test("기대 모양이 아닌 글 전체 JSON 은 받지 않고 괄호 구간으로 넘어간다", () => {
  // 배열을 기대했는데 객체 — 옛 동작대로 안쪽 배열 구간을 읽는다.
  expect(extractLlmJson('{"items":[1,2]}', "array")).toEqual([1, 2]);
});

test("못 찾거나 문법이 깨지면 옛 오류 문장 그대로 던진다", () => {
  expect(() => extractLlmJson("JSON 없음", "array")).toThrow("LLM 응답에서 JSON 배열을 못 찾음");
  expect(() => extractLlmJson("JSON 없음", "object")).toThrow("LLM 응답에서 JSON 객체를 못 찾음");
  expect(() => extractLlmJson("[1, 2,, 깨짐]", "array")).toThrow("LLM 응답 JSON 파싱 실패");
});
