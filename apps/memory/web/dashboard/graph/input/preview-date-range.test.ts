/**
 * preview-date-range.test.ts — 클라이언트 `~` 분할이 서버 splitDateRange 와 동등함을 고정(S7).
 *
 * 클라이언트 `preview-date-range.js` 는 코어 `.ts` 를 import 못 하는 브라우저 ES 모듈이라
 * 같은 로직을 다시 쓴다 — 두 산출이 어긋나면 "미리보기엔 이렇게 보였는데 저장은 다름"
 * 불일치가 난다(spec §9-V4). 그래서 케이스마다 두 구현 산출을 직접 비교해 동등성을 고정한다
 * (드리프트 방지). Mock 0 — 두 실제 순수 함수에 데이터를 넣어 산출만 비교.
 */
import { test, expect, describe } from "bun:test";
import { splitDateRange as clientSplit } from "./preview-date-range.js";
import { splitDateRange as serverSplit } from "../../../../src/memory/date-range-split.ts";

describe("preview-date-range — `~` 분할", () => {
  test("앞 ~ 뒤 분할(start·end 둘 채움)", () => {
    expect(clientSplit("6월 28일 ~ 6월 30일")).toEqual({ start: "6월 28일", end: "6월 30일" });
  });

  test("`~` 없으면 end=null(정직한 단일 날짜·가짜값 0)", () => {
    expect(clientSplit("6월 28일")).toEqual({ start: "6월 28일", end: null });
  });

  test("첫 `~` 한 번만 가른다(뒤 `~` 는 end 안에 보존)", () => {
    expect(clientSplit("A ~ B ~ C")).toEqual({ start: "A", end: "B ~ C" });
  });

  test("앞뒤 공백 trim", () => {
    expect(clientSplit("  6월 28일  ~  6월 30일  ")).toEqual({ start: "6월 28일", end: "6월 30일" });
  });

  test("빈 값 → start 빈문자열·end null(못 알아들음 표지의 토대)", () => {
    expect(clientSplit("")).toEqual({ start: "", end: null });
  });
});

describe("preview-date-range — 서버 splitDateRange 와 동등성 고정(드리프트 방지)", () => {
  const cases = [
    "6월 28일 ~ 6월 30일",
    "6월 28일",
    "A ~ B ~ C",
    "  6월 28일  ~  6월 30일  ",
    "",
    "2026-06-28~2026-06-30",
    "오늘 ~",
    "~ 내일",
  ];
  for (const c of cases) {
    test(`동등: ${JSON.stringify(c)}`, () => {
      expect(clientSplit(c)).toEqual(serverSplit(c));
    });
  }
});
