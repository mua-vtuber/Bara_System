import { describe, expect, test } from "bun:test";
import { sampleBurst, type BurstTuning } from "./burst-particles.ts";

// 토큰 기본값과 같은 데이터 fixture — 옛 리터럴(0.6/0.8/0.5/0.5) 그대로.
const TUNING: BurstTuning = { speedMin: 0.6, speedVar: 0.8, alphaMin: 0.5, alphaVar: 0.5 };

describe("sampleBurst", () => {
  test("같은 seed·시각이면 같은 결과 (결정론)", () => {
    expect(sampleBurst(0.3, 1, 42, 12, TUNING)).toEqual(sampleBurst(0.3, 1, 42, 12, TUNING));
  });

  test("진행할수록 바깥으로 흩어지고 알파가 준다", () => {
    const early = sampleBurst(0.1, 1, 7, 8, TUNING);
    const late = sampleBurst(0.9, 1, 7, 8, TUNING);
    const dist = (p: { x: number; y: number; z: number }) => Math.hypot(p.x, p.y, p.z);
    expect(dist(late[0]!)).toBeGreaterThan(dist(early[0]!));
    expect(late[0]!.alpha).toBeLessThan(early[0]!.alpha);
  });

  test("수명 종료 후 알파 0", () => {
    for (const p of sampleBurst(1.2, 1, 7, 8, TUNING)) expect(p.alpha).toBe(0);
  });

  test("count 만큼 파티클을 만든다", () => {
    expect(sampleBurst(0.5, 1, 1, 20, TUNING).length).toBe(20);
  });

  test("다른 seed 면 다른 배치를 만든다", () => {
    const a = sampleBurst(0.5, 1, 1, 8, TUNING);
    const b = sampleBurst(0.5, 1, 2, 8, TUNING);
    expect(a).not.toEqual(b);
  });

  test("alpha 는 음수가 아니다", () => {
    for (const p of sampleBurst(0.4, 1, 99, 16, TUNING)) {
      expect(p.alpha).toBeGreaterThanOrEqual(0);
    }
  });

  test("tuning 계수가 속도·알파에 그대로 반영된다 (var 0 이면 정확값)", () => {
    // speedVar/alphaVar 0 → 모든 입자 거리 = ease*speedMin, 알파 = (1-t)*alphaMin.
    const t = 0.5;
    const ease = 1 - (1 - t) * (1 - t);
    const flat: BurstTuning = { speedMin: 2, speedVar: 0, alphaMin: 0.7, alphaVar: 0 };
    for (const p of sampleBurst(t, 1, 5, 6, flat)) {
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(ease * 2, 6);
      expect(p.alpha).toBeCloseTo((1 - t) * 0.7, 6);
    }
  });
});
