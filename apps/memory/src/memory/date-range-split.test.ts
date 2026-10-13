/**
 * date-range-split.test.ts — splitDateRange 단위 테스트(S4).
 *
 * `#날짜:` 값 안 `~` 기간 분할 단일 출처. 순수 함수라 fixture 입력→출력만
 * 검증한다(인터페이스 구현체 mock 없음). 날짜 문자열 → ISO 변환은 이 함수
 * 책임 아님 — 첫 `~` 한 번 분할만 본다.
 */
import { describe, expect, test } from "bun:test";
import { splitDateRange } from "./date-range-split.ts";

describe("splitDateRange", () => {
  test("`~` 로 기간을 앞뒤로 가른다(앞뒤 trim)", () => {
    expect(splitDateRange("6월 28일 ~ 6월 30일")).toEqual({
      start: "6월 28일",
      end: "6월 30일",
    });
  });

  test("`~` 없으면 end=null(단일 날짜)", () => {
    expect(splitDateRange("6월 28일")).toEqual({
      start: "6월 28일",
      end: null,
    });
  });

  test("띄어쓰기 없어도 가른다", () => {
    expect(splitDateRange("6월28일~6월30일")).toEqual({
      start: "6월28일",
      end: "6월30일",
    });
  });

  test("`~` 가 둘 이상이면 첫 `~` 기준으로 한 번만 가른다", () => {
    expect(splitDateRange("6월 1일 ~ 6월 2일 ~ 6월 3일")).toEqual({
      start: "6월 1일",
      end: "6월 2일 ~ 6월 3일",
    });
  });

  test("빈 문자열은 정직하게 start 빈 문자열·end null", () => {
    expect(splitDateRange("")).toEqual({ start: "", end: null });
  });

  test("`~` 만 있으면 trim 후 양쪽 빈 문자열", () => {
    expect(splitDateRange("~")).toEqual({ start: "", end: "" });
  });
});
