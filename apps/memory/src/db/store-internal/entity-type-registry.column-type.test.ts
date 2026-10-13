/**
 * entity-type-registry.column-type.test.ts — 코드 8종 칸 datatype 표지 검증 (단계6b T1).
 *
 * columnDataTypeOf 가 코드 8종 한 칸이 숫자형/날짜형/글자형인지 돌려준다.
 * 유통기한은 날짜형이고, 나머지 현재 코드 칸은 글자형이다. 순수 함수·fixture 검증.
 */
import { test, expect } from "bun:test";
import { columnDataTypeOf } from "./entity-type-registry.ts";

test("섭취 유통기한은 날짜형이고 나머지 코드 칸은 글자형", () => {
  expect(columnDataTypeOf("intake", "유통기한")).toBe("date");
  expect(columnDataTypeOf("place", "주소")).toBe("text");
  expect(columnDataTypeOf("usable", "사용법")).toBe("text");
  expect(columnDataTypeOf("material", "주제")).toBe("text");
});

// 일정(schedule)은 전용 칸이 없는 0칸 종류라(spec 2026-06-28 — 날짜는 글 event_at 으로
// 모음) "날짜" 는 미등록 칸이다 — columnDataTypeOf 는 미등록 칸에 글자형 default 를 준다.
test("일정의 '날짜' 는 더는 칸이 아니라 미등록 칸 default(글자형·정직)", () => {
  expect(columnDataTypeOf("schedule", "날짜")).toBe("text");
});

test("코드 종류 아님·미등록 칸은 글자형 default(정직)", () => {
  expect(columnDataTypeOf("person", "아무칸")).toBe("text");
  expect(columnDataTypeOf("intake", "없는칸")).toBe("text");
});
