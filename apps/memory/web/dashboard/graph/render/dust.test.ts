// 먼지 드리프트 오프셋 순수 함수 단위 테스트 — WebGL 비의존 (시각효과 Task 3).
// THREE.Points 생성·position 갱신은 WebGL 없이 검증 불가라 테스트하지 않는다.
// 시간·시드 기반 드리프트 오프셋이 결정적이고 연속이며 작은 진폭 안에 드는지만 검증한다.
import { describe, test, expect } from "bun:test";
import { dustDriftOffset, dustFlowDirection, wrapCoord } from "./dust.ts";

describe("dustDriftOffset — 시간·시드 기반 먼지 드리프트 (시각효과 Task 3)", () => {
  test("같은 시간·시드는 같은 오프셋 (결정적)", () => {
    const a = dustDriftOffset(1.5, 42);
    const b = dustDriftOffset(1.5, 42);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });

  test("시간이 미세하게 바뀌면 오프셋도 미세하게 바뀐다 (연속)", () => {
    const a = dustDriftOffset(1.0, 42);
    const b = dustDriftOffset(1.001, 42);
    expect(Math.abs(b.x - a.x)).toBeLessThan(0.01);
    expect(Math.abs(b.y - a.y)).toBeLessThan(0.01);
    expect(Math.abs(b.z - a.z)).toBeLessThan(0.01);
  });

  test("오프셋 크기는 1 미만 (작은 진폭 안)", () => {
    const ids = [0, 1, 42, 137, 999, 1399];
    for (const seed of ids) {
      const o = dustDriftOffset(3.7, seed);
      expect(Math.hypot(o.x, o.y, o.z)).toBeLessThan(1);
    }
  });

  test("시드가 다르면 (대개) 위상이 갈려 오프셋이 다르다", () => {
    const a = dustDriftOffset(2.0, 10);
    const b = dustDriftOffset(2.0, 11);
    expect(a.x === b.x && a.y === b.y && a.z === b.z).toBe(false);
  });
});

describe("dustFlowDirection — 시드별 구면 균일 단위 방향벡터 (라이브 7차 흐름)", () => {
  test("결과는 크기 1 단위벡터", () => {
    const ids = [0, 1, 42, 137, 999, 1399];
    for (const seed of ids) {
      const d = dustFlowDirection(seed);
      expect(Math.abs(Math.hypot(d.x, d.y, d.z) - 1)).toBeLessThan(1e-6);
    }
  });

  test("같은 시드는 같은 방향벡터 (결정적)", () => {
    const a = dustFlowDirection(42);
    const b = dustFlowDirection(42);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });

  test("시드가 다르면 대체로 다른 방향벡터", () => {
    const a = dustFlowDirection(10);
    const b = dustFlowDirection(11);
    expect(a.x === b.x && a.y === b.y && a.z === b.z).toBe(false);
  });
});

describe("wrapCoord — 좌표를 [-spread, +spread] 범위로 순환 (라이브 7차 경계 순환)", () => {
  const spread = 50;

  test("범위 안 값은 그대로 둔다", () => {
    expect(wrapCoord(0, spread)).toBeCloseTo(0, 6);
    expect(wrapCoord(25, spread)).toBeCloseTo(25, 6);
    expect(wrapCoord(-25, spread)).toBeCloseTo(-25, 6);
  });

  test("spread 를 넘는 값은 반대편으로 매핑한다", () => {
    expect(wrapCoord(spread + 1, spread)).toBeCloseTo(-spread + 1, 6);
    expect(wrapCoord(spread + 10, spread)).toBeCloseTo(-spread + 10, 6);
  });

  test("음수로 크게 넘는 값도 올바르게 범위 안으로 들어온다", () => {
    expect(wrapCoord(-spread - 1, spread)).toBeCloseTo(spread - 1, 6);
    const w = wrapCoord(-spread - 333, spread);
    expect(w).toBeGreaterThanOrEqual(-spread);
    expect(w).toBeLessThan(spread);
  });

  test("경계 ±spread 는 같은 점으로 순환한다", () => {
    expect(wrapCoord(spread, spread)).toBeCloseTo(-spread, 6);
  });
});
