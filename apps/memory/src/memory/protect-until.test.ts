/**
 * Tests for extractProtectUntil — 한국어 시간 표현 정규식.
 */

import { describe, expect, test } from "bun:test";
import { extractProtectUntil } from "./protect-until.ts";

const NOW = new Date("2026-05-16T00:00:00Z");

describe("extractProtectUntil — YYYY년 패턴", () => {
  test("2027년 → 2027-12-31", () => {
    expect(extractProtectUntil("나 2027년에 면접 있어", NOW)).toBe(
      "2027-12-31"
    );
  });

  test("2027년 1월 → 2027-01-31", () => {
    expect(extractProtectUntil("2027년 1월 면접", NOW)).toBe("2027-01-31");
  });

  test("2027년 1월 15일 → 2027-01-15", () => {
    expect(extractProtectUntil("2027년 1월 15일 면접", NOW)).toBe(
      "2027-01-15"
    );
  });

  test("과거 연도 무시", () => {
    expect(extractProtectUntil("2020년에 한 일", NOW)).toBeNull();
  });

  test("말 안 되는 연도 무시 (2200년)", () => {
    expect(extractProtectUntil("2200년 계획", NOW)).toBeNull();
  });
});

describe("extractProtectUntil — M월 패턴 (연도 미지정)", () => {
  test("9월 1일 → 가장 가까운 미래 (2026년 9월 1일)", () => {
    expect(extractProtectUntil("9월 1일에 만나자", NOW)).toBe("2026-09-01");
  });

  test("3월 (5월보다 이전, 이미 지남) → 내년 3월 마지막 날", () => {
    expect(extractProtectUntil("3월에 시작", NOW)).toBe("2027-03-31");
  });

  test("말 안 되는 월 무시 (13월)", () => {
    expect(extractProtectUntil("13월 계획", NOW)).toBeNull();
  });
});

describe("extractProtectUntil — 상대 표현", () => {
  test("내년 → 다음 해 12-31", () => {
    expect(extractProtectUntil("내년에 결혼", NOW)).toBe("2027-12-31");
  });

  test("내달 → 다음 달 마지막 날", () => {
    expect(extractProtectUntil("내달 마감", NOW)).toBe("2026-06-30");
  });

  test("다음 주 → 7일 후", () => {
    expect(extractProtectUntil("다음 주 회의", NOW)).toBe("2026-05-23");
  });

  test("다음 달 (공백 포함) → 다음 달 마지막 날", () => {
    expect(extractProtectUntil("다음 달 휴가", NOW)).toBe("2026-06-30");
  });
});

describe("extractProtectUntil — 여러 표현 → 가장 먼 미래 선택", () => {
  test("내년 + 9월 → 내년 12-31 선택", () => {
    expect(extractProtectUntil("내년 9월에 시험", NOW)).toBe("2027-12-31");
  });

  test("2027년 + 다음 주 → 2027-12-31", () => {
    expect(extractProtectUntil("2027년 또는 다음 주", NOW)).toBe(
      "2027-12-31"
    );
  });
});

describe("extractProtectUntil — null 반환 케이스", () => {
  test("시간 표현 없는 일반 텍스트", () => {
    expect(extractProtectUntil("커피 마시고 일하자", NOW)).toBeNull();
  });

  test("빈 문자열", () => {
    expect(extractProtectUntil("", NOW)).toBeNull();
  });
});
