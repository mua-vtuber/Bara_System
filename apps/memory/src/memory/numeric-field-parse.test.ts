import { test, expect } from "bun:test";
import { parseNumericFieldValue } from "./numeric-field-parse.ts";

test("콤마 천단위 제거·단위 문자 무시", () => {
  expect(parseNumericFieldValue("3,000원")).toBe(3000);
  expect(parseNumericFieldValue("12.5kg")).toBe(12.5);
  expect(parseNumericFieldValue("1,234.56")).toBe(1234.56);
});

test("마이너스 허용", () => {
  expect(parseNumericFieldValue("-5")).toBe(-5);
});

test("숫자 없으면 null(못 읽는 값·0 변환 금지)", () => {
  expect(parseNumericFieldValue("비쌈")).toBeNull();
  expect(parseNumericFieldValue("abc")).toBeNull();
  expect(parseNumericFieldValue("")).toBeNull();
});

test("여러 숫자 섞이면 첫 토큰(결정적)", () => {
  expect(parseNumericFieldValue("3000~5000")).toBe(3000);
});
