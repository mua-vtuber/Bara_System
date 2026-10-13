import { describe, expect, test } from "bun:test";
import { samplePulseRing } from "./pulse-ring.ts";

// 토큰 기본값과 같은 데이터 fixture — 옛 리터럴 0.55 그대로.
const MAX_ALPHA = 0.55;

describe("samplePulseRing", () => {
  test("주기 시작 시 radius 는 baseRadius", () => {
    expect(samplePulseRing(0, 2, 10, 20, 0, 2, MAX_ALPHA).radius).toBeCloseTo(10, 6);
  });

  test("반주기 지나면 radius 는 baseRadius + spread 절반", () => {
    expect(samplePulseRing(1, 2, 10, 20, 0, 2, MAX_ALPHA).radius).toBeCloseTo(20, 6);
  });

  test("ringIndex 1 은 위상이 0.5 어긋난다", () => {
    // ringIndex 0, elapsed 0 -> phase 0 -> radius baseRadius
    const ring0 = samplePulseRing(0, 2, 10, 20, 0, 2, MAX_ALPHA);
    // ringIndex 1, elapsed 0 -> phase 0.5 -> radius baseRadius + spread*0.5
    const ring1 = samplePulseRing(0, 2, 10, 20, 1, 2, MAX_ALPHA);
    expect(ring0.radius).toBeCloseTo(10, 6);
    expect(ring1.radius).toBeCloseTo(20, 6);
  });

  test("alpha 는 진행률에 반비례한다(진행할수록 감소)", () => {
    const early = samplePulseRing(0.1, 2, 10, 20, 0, 1, MAX_ALPHA);
    const late = samplePulseRing(1.8, 2, 10, 20, 0, 1, MAX_ALPHA);
    expect(late.alpha).toBeLessThan(early.alpha);
  });

  test("위상 0 의 alpha 는 maxAlpha 그대로다 (토큰 반영)", () => {
    expect(samplePulseRing(0, 2, 10, 20, 0, 1, 0.7).alpha).toBeCloseTo(0.7, 6);
    expect(samplePulseRing(0, 2, 10, 20, 0, 1, MAX_ALPHA).alpha).toBeCloseTo(MAX_ALPHA, 6);
  });

  test("무한 반복 — 한 주기 지나면 다시 시작 위상으로 돌아온다", () => {
    const a = samplePulseRing(0.3, 2, 10, 20, 0, 1, MAX_ALPHA);
    const b = samplePulseRing(2.3, 2, 10, 20, 0, 1, MAX_ALPHA);
    expect(a.radius).toBeCloseTo(b.radius, 6);
    expect(a.alpha).toBeCloseTo(b.alpha, 6);
  });

  test("음수 시각도 frac 처리로 안전하게 0..1 위상을 만든다", () => {
    const s = samplePulseRing(-0.5, 2, 10, 20, 0, 1, MAX_ALPHA);
    expect(s.radius).toBeGreaterThanOrEqual(10);
    expect(s.radius).toBeLessThanOrEqual(30);
    expect(Number.isFinite(s.alpha)).toBe(true);
  });
});
