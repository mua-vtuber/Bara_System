import { describe, expect, test } from "bun:test";
import { msUntilNextBoundary } from "./schedule-timing.ts";

const MIN = 60_000;
function kst(iso: string): number {
  // 명시 +09:00 으로 epoch 고정 — 테스트가 시스템 TZ 에 안 끌려다님.
  return new Date(iso + "+09:00").getTime();
}

describe("msUntilNextBoundary — 시계 정렬 (KST 자정 anchor)", () => {
  test("interval 30 / offset 0 — 10:07 → 다음 :30 까지 23분", () => {
    expect(msUntilNextBoundary(kst("2026-06-02T10:07:00"), 30, 0)).toBe(23 * MIN);
  });
  test("interval 30 / offset 0 — 정각 10:30 은 지난 것 → 다음 11:00 까지 30분", () => {
    expect(msUntilNextBoundary(kst("2026-06-02T10:30:00"), 30, 0)).toBe(30 * MIN);
  });
  test("interval 30 / offset 15 — 10:07 → 다음 :15 까지 8분", () => {
    expect(msUntilNextBoundary(kst("2026-06-02T10:07:00"), 30, 15)).toBe(8 * MIN);
  });
  test("interval 30 / offset 15 — 10:20 → 다음 :45 까지 25분", () => {
    expect(msUntilNextBoundary(kst("2026-06-02T10:20:00"), 30, 15)).toBe(25 * MIN);
  });
  test("offset 이전(첫 경계 전) — offset 15, now 00:05 → 오늘 00:15 까지 10분", () => {
    expect(msUntilNextBoundary(kst("2026-06-02T00:05:00"), 30, 15)).toBe(10 * MIN);
  });
  test("1440 비정수 약수(7분)도 throw 없이 다음 경계 회신 (근사 정렬 caveat)", () => {
    const delay = msUntilNextBoundary(kst("2026-06-02T10:07:00"), 7, 0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(7 * MIN);
  });
  test("intervalMin < 1 throw", () => {
    expect(() => msUntilNextBoundary(kst("2026-06-02T10:00:00"), 0, 0)).toThrow();
  });
  test("offsetMin < 0 throw", () => {
    expect(() => msUntilNextBoundary(kst("2026-06-02T10:00:00"), 30, -1)).toThrow();
  });
});
