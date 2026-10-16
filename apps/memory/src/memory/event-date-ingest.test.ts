/**
 * event-date-ingest.test.ts — 메모 저장용 날짜 함수 extractIngestEventDate 검증
 * (docs/decisions/2026-10-16-yearless-date-cleanup-spec.md 10장 T1).
 *
 * 연도 없는 절대 날짜("1월 5일"·"1/5")가 가장 구체적인 표현이면 null — 저장한 해를
 * 지어내지 않고 더 약한 표현으로도 내려가지 않는다. 검색·직접 입력용 함수
 * (extractEventDate·eventDateRange·extractEventDateTime)는 동작 그대로인지 함께 본다.
 *
 * 기준 NOW = 2026-10-16 10:00 (로컬). month 는 0-indexed 라 9 = 10월.
 */
import { describe, test, expect } from "bun:test";
import {
  extractIngestEventDate,
  extractEventDate,
  eventDateRange,
  extractEventDateTime,
} from "./event-date.ts";

const NOW = new Date(2026, 9, 16, 10, 0, 0);

describe("extractIngestEventDate — 연도 없는 절대 날짜는 비운다", () => {
  const nullCases: string[] = [
    "1월 5일까지 제출",
    "1/5 회의",
    "내일 1월 5일 서류",
    "06년 9월 28일",
    "1/2 분량 읽음",
    "지난 7일 동안 1월 5일",
  ];
  test.each(nullCases)("%s → null", (text) => {
    expect(extractIngestEventDate(text, NOW)).toBeNull();
  });
});

describe("extractIngestEventDate — 그 밖의 표현은 extractEventDate 와 같다", () => {
  const cases: Array<[string, string]> = [
    ["2025년 1월 5일 회의", "2025-01-05"],
    ["2025-01-05 회의", "2025-01-05"],
    ["내일 회의", "2026-10-17"],
    // 범위 밖 절대 날짜는 무시하고 다음 표현("내일")으로 간다 — 지금과 같다.
    ["13월 5일 내일", "2026-10-17"],
  ];
  test.each(cases)("%s → %s", (text, expected) => {
    expect(extractIngestEventDate(text, NOW)).toBe(expected);
  });

  test("날짜 표현 없음 → null", () => {
    expect(extractIngestEventDate("그냥 생각", NOW)).toBeNull();
  });
});

describe("연도 있는 숫자 날짜 YYYY/M/D·YYYY.M.D (T1b)", () => {
  const dated: Array<[string, string]> = [
    ["2026/1/5 제출", "2026-01-05"],
    ["2027.1.5 마감", "2027-01-05"],
    ["2026 . 1 . 5", "2026-01-05"],
    ["2026 / 01 / 05 회의", "2026-01-05"],
  ];
  test.each(dated)("저장용 %s → %s (비우지 않음)", (text, expected) => {
    expect(extractIngestEventDate(text, NOW)).toBe(expected);
  });
  test.each(dated)("extractEventDate %s → %s", (text, expected) => {
    expect(extractEventDate(text, NOW)).toBe(expected);
  });

  test("연도 없는 1/5 는 여전히 저장용에서 null", () => {
    expect(extractIngestEventDate("1/5", NOW)).toBeNull();
  });

  test("빗금·점 혼용은 연도 있는 날짜로 보지 않는다", () => {
    // "2026/1.5" — 숫자 날짜로도, 연도 없는 "M/D" 로도 안 잡혀 날짜 없음.
    expect(extractEventDate("2026/1.5", NOW)).toBeNull();
    expect(extractIngestEventDate("2026/1.5", NOW)).toBeNull();
  });

  test("앞뒤에 숫자가 붙으면 안 잡는다", () => {
    // "12026/1/5" 는 연도 있는 날짜가 아니다 — 남는 "1/5" 만 연도 없는 날짜로 잡혀 저장용에서 비운다.
    expect(extractIngestEventDate("12026/1/5", NOW)).toBeNull();
    expect(extractEventDate("2026/1/512", NOW)).toBeNull();
  });

  test("버전 글자는 날짜로 읽지 않는다", () => {
    for (const text of ["v2024.10.3 업데이트", "1.2026.1.5 패치", "2026.1.5.3 빌드"]) {
      expect(extractEventDate(text, NOW)).toBeNull();
      expect(extractIngestEventDate(text, NOW)).toBeNull();
      expect(extractEventDateTime(text, NOW)).toBeNull();
    }
  });

  test("문장 끝 마침표가 붙어도 연도 있는 날짜로 읽는다", () => {
    expect(extractIngestEventDate("마감은 2026.1.5.", NOW)).toBe("2026-01-05");
    expect(extractIngestEventDate("2026.1.5 마감", NOW)).toBe("2026-01-05");
  });

  test("월 범위 밖은 연도 있는 날짜로 쓰지 않고 다음 표현으로 간다(abs_ymd 와 같은 규칙)", () => {
    expect(extractIngestEventDate("2026/13/5 내일", NOW)).toBe("2026-10-17");
  });

  test("검색 시간 범위도 연도 있는 날짜로 푼다", () => {
    expect(eventDateRange("2027.1.5", NOW)).toEqual({ since: "2027-01-05", until: "2027-01-05" });
  });
});

describe("검색·직접 입력용 함수는 저장한 해를 그대로 쓴다(변화 없음)", () => {
  test("extractEventDate", () => {
    expect(extractEventDate("1월 5일까지 제출", NOW)).toBe("2026-01-05");
  });
  test("eventDateRange", () => {
    expect(eventDateRange("1월 5일", NOW)).toEqual({ since: "2026-01-05", until: "2026-01-05" });
  });
  test("extractEventDateTime", () => {
    expect(extractEventDateTime("1월 5일 오후 3시", NOW)).toBe("2026-01-05T15:00");
  });
});
