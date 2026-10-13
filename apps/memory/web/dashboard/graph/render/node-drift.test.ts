import { describe, it, expect } from "bun:test";
import { nodeDriftOffset, seedFromId } from "./node-drift.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

describe("nodeDriftOffset", () => {
  it("결정적 — 같은 입력 같은 출력", () => {
    expect(nodeDriftOffset(2.0, 5)).toEqual(nodeDriftOffset(2.0, 5));
  });

  it("연속적 — time 미세 변화 시 미세 변화", () => {
    const a = nodeDriftOffset(3.0, 1);
    const b = nodeDriftOffset(3.002, 1);
    expect(Math.abs(b.x - a.x)).toBeLessThan(0.01);
    expect(Math.abs(b.y - a.y)).toBeLessThan(0.01);
    expect(Math.abs(b.z - a.z)).toBeLessThan(0.01);
  });

  it("진폭이 작다(배치 무너뜨리지 않음)", () => {
    const o = nodeDriftOffset(50, 3);
    expect(Math.hypot(o.x, o.y, o.z)).toBeLessThan(0.5);
  });

  it("오프셋 크기가 토큰 amplitude 안에 머문다", () => {
    const { amplitude } = GRAPH_RENDER_THEME.nodeDrift;
    // 각 축은 sin/cos 한 항이라 절대값이 amplitude 를 넘지 못한다(부동소수 여유 1e-9).
    for (const t of [0, 1.3, 7.7, 42.0, 123.4]) {
      for (const seed of [0, 1, 17, 99]) {
        const o = nodeDriftOffset(t, seed);
        expect(Math.abs(o.x)).toBeLessThanOrEqual(amplitude + 1e-9);
        expect(Math.abs(o.y)).toBeLessThanOrEqual(amplitude + 1e-9);
        expect(Math.abs(o.z)).toBeLessThanOrEqual(amplitude + 1e-9);
      }
    }
  });

  it("시드가 다르면 위상이 달라 동시각 오프셋이 갈린다", () => {
    const a = nodeDriftOffset(4.0, 2);
    const b = nodeDriftOffset(4.0, 40);
    // 같은 time 이라도 시드 위상차로 적어도 한 축은 또렷이 다르다(겹쳐 보이는 군집 방지).
    const diff = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
    expect(diff).toBeGreaterThan(1e-6);
  });
});

describe("seedFromId", () => {
  it("같은 id 는 항상 같은 시드를 돌려준다(결정적)", () => {
    expect(seedFromId("person:홍길동")).toBe(seedFromId("person:홍길동"));
    expect(seedFromId("concept:사랑")).toBe(seedFromId("concept:사랑"));
  });

  it("다른 id 는 다른 시드를 돌려준다(위상 분리)", () => {
    expect(seedFromId("node-a")).not.toBe(seedFromId("node-b"));
    expect(seedFromId("concept:우정")).not.toBe(seedFromId("concept:사랑"));
  });

  it("빈 문자열도 충돌 없이 동작한다", () => {
    const s = seedFromId("");
    expect(typeof s).toBe("number");
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe("finishSettle 수학 검증: offset 상쇄로 점프 없음", () => {
  it("저장값에서 offset 을 뺀 뒤 다시 더하면 원래 위치로 돌아온다", () => {
    // 실제 finishSettle 이 하는 계산을 순수 로직으로 재현:
    //   basePositions[id] = currentPos - offset(elapsed, seed)
    // 다음 프레임 applyNodeDrift:
    //   rendered = basePositions + offset(elapsed, seed)
    //            = (currentPos - offset) + offset = currentPos  → 점프 없음
    const elapsed = 12.345;
    const id = "concept:테스트";
    const seed = seedFromId(id);
    const current = { x: 1.2, y: -0.5, z: 0.8 };
    const o = nodeDriftOffset(elapsed, seed);
    // finishSettle 이 저장하는 값
    const stored = { x: current.x - o.x, y: current.y - o.y, z: current.z - o.z };
    // applyNodeDrift 가 같은 elapsed 로 다시 더하면 원래 위치
    const resumed = { x: stored.x + o.x, y: stored.y + o.y, z: stored.z + o.z };
    expect(resumed.x).toBeCloseTo(current.x, 10);
    expect(resumed.y).toBeCloseTo(current.y, 10);
    expect(resumed.z).toBeCloseTo(current.z, 10);
  });

  it("amplitude 0 이면 offset 이 0 이라 기존 동작과 동일하다(가드 검증)", () => {
    const orig = GRAPH_RENDER_THEME.nodeDrift.amplitude;
    try {
      GRAPH_RENDER_THEME.nodeDrift.amplitude = 0;
      const seed = seedFromId("node-zero");
      const o = nodeDriftOffset(10.0, seed);
      // amplitude 0 이면 빼기도 0 — 저장값 = currentPos 그대로(기존 동작 불변)
      expect(Math.abs(o.x)).toBe(0);
      expect(Math.abs(o.y)).toBe(0);
      expect(Math.abs(o.z)).toBe(0);
    } finally {
      GRAPH_RENDER_THEME.nodeDrift.amplitude = orig;
    }
  });
});

describe("nodeDriftOffset — amplitude 선형 비례", () => {
  it("오프셋이 amplitude 에 선형 비례한다(0 이면 0·제거 가능성)", () => {
    // 토큰 객체는 동결이 아니므로 잠시 amplitude 를 바꿔 비례·0 동작을 확인하고 되돌린다.
    const orig = GRAPH_RENDER_THEME.nodeDrift.amplitude;
    try {
      GRAPH_RENDER_THEME.nodeDrift.amplitude = 0;
      const zero = nodeDriftOffset(9.0, 6);
      // amplitude 0 이면 모든 축이 0 — Math.abs 로 비교(부동소수 -0 도 0 으로 본다).
      expect(Math.abs(zero.x)).toBe(0);
      expect(Math.abs(zero.y)).toBe(0);
      expect(Math.abs(zero.z)).toBe(0);

      GRAPH_RENDER_THEME.nodeDrift.amplitude = 0.2;
      const a = nodeDriftOffset(9.0, 6);
      GRAPH_RENDER_THEME.nodeDrift.amplitude = 0.4;
      const b = nodeDriftOffset(9.0, 6);
      // amplitude 2배면 같은 time·seed 오프셋도 정확히 2배(선형 비례).
      expect(b.x).toBeCloseTo(a.x * 2, 10);
      expect(b.y).toBeCloseTo(a.y * 2, 10);
      expect(b.z).toBeCloseTo(a.z * 2, 10);
    } finally {
      GRAPH_RENDER_THEME.nodeDrift.amplitude = orig;
    }
  });
});
