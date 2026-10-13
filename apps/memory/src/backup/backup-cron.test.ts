import { describe, test, expect } from "bun:test";
import { msUntilNextRunInZone } from "./backup-cron.ts";

const H = 3600_000;
describe("msUntilNextRunInZone", () => {
  test("Asia/Seoul 04:00 — 서울 12:00 에서 16시간", () => {
    const nowMs = Date.UTC(2026, 6, 3, 3, 0, 0); // 서울 2026-07-03 12:00
    expect(msUntilNextRunInZone("04:00", "Asia/Seoul", nowMs)).toBe(16 * H);
  });
  test("같은 날 미래 시각이면 당일", () => {
    const nowMs = Date.UTC(2026, 6, 3, 3, 0, 0); // 서울 12:00
    expect(msUntilNextRunInZone("13:30", "Asia/Seoul", nowMs)).toBe(1.5 * H);
  });
  test("UTC zone — 시스템 TZ 무관", () => {
    const nowMs = Date.UTC(2026, 6, 3, 10, 0, 0);
    expect(msUntilNextRunInZone("10:30", "UTC", nowMs)).toBe(0.5 * H);
  });
  test("DST 봄 전환(America/New_York, 없는 02:30) — 0 < delay <= 25h 정직 수렴", () => {
    const nowMs = Date.UTC(2026, 2, 8, 6, 0, 0); // 2026-03-08 01:00 EST, 02:00→03:00 skip 날
    const delay = msUntilNextRunInZone("02:30", "America/New_York", nowMs);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(25 * H);
  });
  test("잘못된 cronTime 은 loud throw", () => {
    expect(() => msUntilNextRunInZone("24:00", "UTC", 0)).toThrow("invalid cronTime");
  });
});
