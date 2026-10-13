import { describe, expect, test } from "bun:test";

import { sampleBirthRipple } from "./birth-ripple.ts";

const tokens = {
  durationS: 2,
  startScale: 1,
  endScale: 9,
  opacity: 0.5,
  fadePower: 1.5,
  attackFraction: 0.12,
  // 텍스처 계수는 샘플러가 안 쓰지만 GraphBirthRippleTokens 형이라 fixture 에 포함.
  textureSize: 128,
  ringInnerStop: 0.34,
  ringPeakStop: 0.45,
  ringPeakAlpha: 0.78,
  ringOuterStop: 0.56,
  ringOuterAlpha: 0.26,
};

describe("sampleBirthRipple", () => {
  test("시작 직후엔 작고 빠르게 밝아진다", () => {
    const start = sampleBirthRipple(10, 10, tokens);
    const early = sampleBirthRipple(10.12, 10, tokens);

    expect(start.scaleMul).toBeCloseTo(tokens.startScale);
    expect(start.opacity).toBe(0);
    expect(early.scaleMul).toBeGreaterThan(start.scaleMul);
    expect(early.opacity).toBeGreaterThan(0);
  });

  test("중간엔 확장되고, 끝엔 투명하게 정착한다", () => {
    const mid = sampleBirthRipple(11, 10, tokens);
    const end = sampleBirthRipple(12, 10, tokens);

    expect(mid.scaleMul).toBeGreaterThan(tokens.startScale);
    expect(mid.scaleMul).toBeLessThan(tokens.endScale);
    expect(mid.opacity).toBeGreaterThan(0);
    expect(end.done).toBe(true);
    expect(end.scaleMul).toBe(tokens.endScale);
    expect(end.opacity).toBe(0);
  });

  test("attackFraction 이 페이드-인 구간을 정한다 (토큰 반영)", () => {
    const tk = { ...tokens, fadePower: 1, attackFraction: 0.5 };
    // t=0.25 → attack 0.5, fade 0.75 → opacity 0.5*0.5*0.75
    expect(sampleBirthRipple(10.5, 10, tk).opacity).toBeCloseTo(0.5 * 0.5 * 0.75, 6);
    // t=0.5 → attack 1(페이드-인 완료), fade 0.5 → opacity 0.5*1*0.5
    expect(sampleBirthRipple(11, 10, tk).opacity).toBeCloseTo(0.5 * 0.5, 6);
  });

  test("duration 이 0 이면 꺼진 상태로 끝값을 돌려준다", () => {
    const sample = sampleBirthRipple(10, 10, { ...tokens, durationS: 0 });

    expect(sample.done).toBe(true);
    expect(sample.opacity).toBe(0);
    expect(sample.scaleMul).toBe(tokens.endScale);
  });
});
