/**
 * deep-pass-schedule.test.ts — 깊은 패스 다음 정기 실행 시각 계산(순수 함수) 검증.
 *
 * 2026-10-22 결함 재발 방지: 서버를 언제 켜든 같은 실행 기록이면 같은 자정을 겨눠야 한다.
 * 시각은 KST 기준(A1 TZ=Asia/Seoul, 설정 시간대 기본값 KST)으로 고정해 계산한다.
 */
import { describe, expect, test } from "bun:test";
import { msUntilNextDeepPass } from "./deep-pass-schedule.ts";

const kst = (iso: string): number => new Date(`${iso}+09:00`).getTime();
const at = (nowIso: string, intervalDays: number, last: string | null): number => {
  const now = kst(nowIso);
  return now + msUntilNextDeepPass(now, intervalDays, last);
};

describe("msUntilNextDeepPass", () => {
  test("기록 없음 → 다음 자정", () => {
    expect(at("2026-10-22T14:30:00", 7, null)).toBe(kst("2026-10-23T00:00:00"));
  });

  test("기한 전 → 마지막 실행 날짜 + 주기의 자정 (켠 시각과 무관)", () => {
    for (const now of ["2026-10-22T00:00:05", "2026-10-24T08:00:00", "2026-10-28T23:59:59"]) {
      expect(at(now, 7, "2026-10-22 00:00:01")).toBe(kst("2026-10-29T00:00:00"));
    }
  });

  test("낮에 돌린 수동 실행도 그 날짜 기준으로 센다", () => {
    expect(at("2026-10-23T09:00:00", 7, "2026-10-22 15:40:00")).toBe(kst("2026-10-29T00:00:00"));
  });

  test("기한 당일(자정을 놓침)·기한 지남 → 다음 자정", () => {
    expect(at("2026-10-29T10:00:00", 7, "2026-10-22 00:00:01")).toBe(kst("2026-10-30T00:00:00"));
    expect(at("2026-11-10T10:00:00", 7, "2026-10-22 00:00:01")).toBe(kst("2026-11-11T00:00:00"));
  });

  test("주기 1일 → 매일 자정", () => {
    expect(at("2026-10-22T00:00:02", 1, "2026-10-22 00:00:01")).toBe(kst("2026-10-23T00:00:00"));
  });

  test("소수 주기는 올림한 날 수(1.5일 → 2일 뒤 자정)", () => {
    expect(at("2026-10-22T03:00:00", 1.5, "2026-10-22 00:00:01")).toBe(kst("2026-10-24T00:00:00"));
  });

  test("월말·연말을 넘겨도 날짜 차이가 맞다", () => {
    expect(at("2026-12-30T12:00:00", 7, "2026-12-28 00:00:01")).toBe(kst("2027-01-04T00:00:00"));
  });

  test("주기 1 미만은 거부", () => {
    expect(() => msUntilNextDeepPass(Date.now(), 0, null)).toThrow(/intervalDays/);
  });
});
