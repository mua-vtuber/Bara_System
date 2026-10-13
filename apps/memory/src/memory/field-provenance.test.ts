import { test, expect } from "bun:test";
import {
  canWriteField,
  readFieldSource,
  withFieldSource,
} from "./field-provenance.ts";

test("canWriteField: 빈 칸엔 누구든 쓴다", () => {
  expect(canWriteField(undefined, "inferred")).toBe(true);
  expect(canWriteField(undefined, "system")).toBe(true);
  expect(canWriteField(undefined, "direct")).toBe(true);
});

test("canWriteField: 직접 입력값은 시스템·추론이 못 덮는다", () => {
  expect(canWriteField("direct", "system")).toBe(false);
  expect(canWriteField("direct", "inferred")).toBe(false);
});

test("canWriteField: 시스템값은 직접이 덮고 추론은 못 덮는다", () => {
  expect(canWriteField("system", "direct")).toBe(true);
  expect(canWriteField("system", "inferred")).toBe(false);
});

test("canWriteField: 같은 출처는 갱신 허용", () => {
  expect(canWriteField("system", "system")).toBe(true);
  expect(canWriteField("direct", "direct")).toBe(true);
});

test("readFieldSource: 없는 키·깨진 JSON 은 undefined", () => {
  expect(readFieldSource("{}", "event_at")).toBeUndefined();
  expect(readFieldSource("not json", "event_at")).toBeUndefined();
  expect(
    readFieldSource('{"fieldSources":{"event_at":"direct"}}', "event_at"),
  ).toBe("direct");
});

test("withFieldSource: 기존 JSON 보존하며 출처 추가", () => {
  const out = withFieldSource('{"title":"x"}', "event_at", "system");
  const parsed = JSON.parse(out);
  expect(parsed.title).toBe("x");
  expect(parsed.fieldSources.event_at).toBe("system");
});

test("withFieldSource: 빈/깨진 JSON 도 안전하게 새로 만든다", () => {
  const out = withFieldSource("", "event_at", "direct");
  expect(JSON.parse(out).fieldSources.event_at).toBe("direct");
});
