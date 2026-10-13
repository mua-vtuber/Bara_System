/**
 * direct-field-tag.test.ts — 활용 단계2 ② 직접 입력 칸 파서 단위 검증.
 *
 * 직접 입력 칸 키(node_field 갈래)는 값에 띄어쓰기가 들어간다("6월 25일").
 * 쉼표 경계로만 값을 뽑고, 값이 비면 errors 로 올린다. 기존 엔티티 태그는
 * 무시한다(회귀 0). 순수 함수 — now·DB·LLM 의존 0.
 */

import { describe, expect, test } from "bun:test";
import { parseDirectFieldTags } from "./direct-field-tag.ts";
import { loadReservedKeys } from "./hashtag-reserved-keys.ts";

const KEYS = loadReservedKeys();

describe("parseDirectFieldTags — 쉼표 경계·값 안 공백 허용", () => {
  test("쉼표가 값의 끝 — 띄어쓰기 있는 값을 그대로 받는다", () => {
    const out = parseDirectFieldTags(
      "여행 #일정시작:6월 1일, #일정종료:6월 5일,",
      KEYS,
    );
    expect(out.fields).toEqual([
      { column: "event_at", value: "6월 1일" },
      { column: "event_until", value: "6월 5일" },
    ]);
  });

  test("쉼표 없으면 줄 끝까지 — 마지막 태그 쉼표 누락 받아줌", () => {
    const out = parseDirectFieldTags("약속 메모 #날짜:6월 25일", KEYS);
    expect(out.fields).toEqual([{ column: "event_at", value: "6월 25일" }]);
  });

  test("줄바꿈이 쉼표보다 먼저면 그 줄에서 끊는다", () => {
    const out = parseDirectFieldTags("#날짜:6월 25일\n다음 줄 본문", KEYS);
    expect(out.fields).toEqual([{ column: "event_at", value: "6월 25일" }]);
  });

  test("기존 엔티티 태그(#사람:·#작품:)는 무시 — node_field 키 아님", () => {
    const out = parseDirectFieldTags("#사람:민수, #작품:소설,", KEYS);
    expect(out.fields).toEqual([]);
  });

  test("값이 비면(쉼표 바로/줄 끝) errors 로 올린다 — 거짓 채움 0", () => {
    const out = parseDirectFieldTags("#날짜:, 본문", KEYS);
    expect(out.fields).toEqual([]);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]!.tag).toBe("#날짜:");
  });

  test("값 앞뒤 공백은 trim", () => {
    const out = parseDirectFieldTags("#날짜:  6월 25일  ,", KEYS);
    expect(out.fields).toEqual([{ column: "event_at", value: "6월 25일" }]);
  });
});

describe("parseDirectFieldTags — place 갈래(활용 단계2 ③)", () => {
  test("place — 쉼표 경계로 공백 있는 장소명을 받는다", () => {
    const out = parseDirectFieldTags("#장소:강남 A마트,", KEYS);
    expect(out.places).toEqual(["강남 A마트"]);
  });

  test("place — 쉼표 없으면 줄 끝까지", () => {
    const out = parseDirectFieldTags("여행 #장소:속초", KEYS);
    expect(out.places).toEqual(["속초"]);
  });

  test("place + node_field 공존 — 둘 다 제 갈래로", () => {
    const out = parseDirectFieldTags("#일정시작:6월 1일, #장소:속초,", KEYS);
    expect(out.fields).toEqual([{ column: "event_at", value: "6월 1일" }]);
    expect(out.places).toEqual(["속초"]);
  });

  test("기존 콜론 엔티티 태그는 무시(회귀 0)", () => {
    const out = parseDirectFieldTags("#사람:민수, #작품:소설,", KEYS);
    expect(out.fields).toEqual([]);
    expect(out.places).toEqual([]);
  });

  test("빈 값 #장소:, 는 errors(거짓 채움 0)", () => {
    const out = parseDirectFieldTags("#장소:, 본문", KEYS);
    expect(out.places).toEqual([]);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]!.tag).toBe("#장소:");
  });
});
