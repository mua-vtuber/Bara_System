/**
 * search-params.test.ts — POST /search body 파싱 헬퍼 단위 테스트(C1 분해).
 *
 * 순수 데이터 입력→출력 검증(store·Hono 의존 0·인터페이스 mock 0). 각 파서의 방어
 * 규칙(비문자열·빈 값·무효 enum 은 undefined / 유효값은 trim 보존)과 resolveDateRange
 * 의 명시>자동 우선순위를 직접 단언한다.
 */

import { describe, expect, test } from "bun:test";
import {
  parsePolarity,
  parseMemoryType,
  parseFilter,
  parseKind,
  parseFieldFilters,
  parsePlace,
  parseImageSearch,
  resolveDateRange,
} from "./search-params.ts";

describe("parsePolarity", () => {
  test("유효 enum 만 통과", () => {
    expect(parsePolarity("positive")).toBe("positive");
    expect(parsePolarity("negative")).toBe("negative");
    expect(parsePolarity("neutral")).toBe("neutral");
  });
  test("무효 값은 undefined", () => {
    expect(parsePolarity("POSITIVE")).toBeUndefined();
    expect(parsePolarity("")).toBeUndefined();
    expect(parsePolarity(123)).toBeUndefined();
    expect(parsePolarity(undefined)).toBeUndefined();
  });
});

describe("parseMemoryType", () => {
  test("유효 enum 만 통과", () => {
    expect(parseMemoryType("fact")).toBe("fact");
    expect(parseMemoryType("episode")).toBe("episode");
    expect(parseMemoryType("insight")).toBe("insight");
  });
  test("무효 값은 undefined", () => {
    expect(parseMemoryType("unknown")).toBeUndefined();
    expect(parseMemoryType("")).toBeUndefined();
    expect(parseMemoryType(null)).toBeUndefined();
  });
});

describe("parseFilter", () => {
  test("값이 1자 이상인 항목만 trim 해 담는다", () => {
    expect(parseFilter({ review: " 만화 ", genre: "액션" })).toEqual({
      review: "만화",
      genre: "액션",
    });
  });
  test("빈 값·공백만은 제외 — 유효 0개면 undefined", () => {
    expect(parseFilter({ a: "  ", b: "" })).toBeUndefined();
  });
  test("비객체·배열·null 은 undefined", () => {
    expect(parseFilter(null)).toBeUndefined();
    expect(parseFilter([])).toBeUndefined();
    expect(parseFilter("str")).toBeUndefined();
  });
});

describe("parseKind", () => {
  test("trim 해 1자 이상이면 그 값", () => {
    expect(parseKind("  가계부 ")).toBe("가계부");
  });
  test("빈 값·비문자열은 undefined", () => {
    expect(parseKind("   ")).toBeUndefined();
    expect(parseKind(42)).toBeUndefined();
  });
});

describe("parseFieldFilters", () => {
  test("key·value 둘 다 1자 이상인 항목만 trim 해 담는다", () => {
    expect(
      parseFieldFilters([
        { key: " 항목 ", value: " 우유 " },
        { key: "수량", value: "" }, // value 빈 값 → 제외
        { key: "", value: "x" }, // key 빈 값 → 제외
      ]),
    ).toEqual([{ key: "항목", value: "우유" }]);
  });
  test("비배열·유효 0개면 undefined", () => {
    expect(parseFieldFilters("x")).toBeUndefined();
    expect(parseFieldFilters([{ key: "", value: "" }])).toBeUndefined();
  });
});

describe("parsePlace", () => {
  test("trim 해 1자 이상이면 그 값", () => {
    expect(parsePlace(" 강남 A마트 ")).toBe("강남 A마트");
  });
  test("빈 값·비문자열은 undefined", () => {
    expect(parsePlace("  ")).toBeUndefined();
    expect(parsePlace(true)).toBeUndefined();
  });
});

describe("parseImageSearch", () => {
  test("명시 true 양식만 image_vec 채널을 켠다", () => {
    expect(parseImageSearch(true)).toBe(true);
    expect(parseImageSearch("true")).toBe(true);
    expect(parseImageSearch("1")).toBe(true);
  });
  test("부재·false·무효 값은 OFF", () => {
    expect(parseImageSearch(false)).toBe(false);
    expect(parseImageSearch(undefined)).toBe(false);
    expect(parseImageSearch("false")).toBe(false);
    expect(parseImageSearch(1)).toBe(false);
  });
});

describe("resolveDateRange", () => {
  const now = new Date("2026-06-15T00:00:00Z");
  test("명시 since/until 둘 다 유효 ISO 면 그대로(자동 추출보다 우선)", () => {
    expect(resolveDateRange("2026-05-01", "2026-05-31", "지난주 일정", now)).toEqual({
      since: "2026-05-01",
      until: "2026-05-31",
    });
  });
  test("절반 입력(한쪽만)이면 명시 통로 건너뛰고 자동 추출로 — 시간 표현 없으면 undefined", () => {
    expect(resolveDateRange("2026-05-01", "bad", "그냥 검색어", now)).toBeUndefined();
  });
  test("명시 없고 query 에 시간 표현 없으면 undefined(필터 미적용)", () => {
    expect(resolveDateRange(undefined, undefined, "커피", now)).toBeUndefined();
  });
});
