import { describe, expect, test } from "bun:test";
import {
  MAX_ENERGY_EDGES,
  capEnergyEdges,
  energyDotOffsets,
  type EnergyEdgeEndpoints,
} from "./energy-flow.ts";

describe("energyDotOffsets", () => {
  test("offsets 길이는 count 와 같다", () => {
    expect(energyDotOffsets(0, 1, 4).length).toBe(4);
  });

  test("전부 0..1 범위 안이다", () => {
    for (const o of energyDotOffsets(3.7, 2, 10)) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(1);
    }
  });

  test("등간격 위상차 — elapsed 0, speed 1, count 4", () => {
    expect(energyDotOffsets(0, 1, 4)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  test("시간이 지나면 오프셋이 진행한다", () => {
    const a = energyDotOffsets(0, 1, 4);
    const b = energyDotOffsets(0.1, 1, 4);
    expect(b[0]).toBeCloseTo(a[0]! + 0.1, 6);
  });

  test("count 0 이면 빈 배열", () => {
    expect(energyDotOffsets(1, 1, 0)).toEqual([]);
  });
});

describe("capEnergyEdges", () => {
  // from.x 를 식별 태그로 쓴다 — 어떤 엣지가 살아남았는지 추적용.
  const edge = (weight: number, tag: number): EnergyEdgeEndpoints => ({
    from: { x: tag, y: 0, z: 0 },
    to: { x: 0, y: 0, z: 0 },
    weight,
  });

  test("상한 이하면 원본 배열을 그대로 돌려준다(복사·정렬 없음)", () => {
    const edges = Array.from({ length: MAX_ENERGY_EDGES }, (_, i) => edge(i / 100, i));
    expect(capEnergyEdges(edges)).toBe(edges);
    expect(capEnergyEdges([])).toEqual([]);
  });

  test("상한 초과면 weight 상위 MAX_ENERGY_EDGES 개만 남는다", () => {
    // weight 0..29 오름차순 30개 — 하위 6개(0..5)가 잘려야 한다.
    const edges = Array.from({ length: 30 }, (_, i) => edge(i / 100, i));
    const capped = capEnergyEdges(edges);
    expect(capped.length).toBe(MAX_ENERGY_EDGES);
    const weights = capped.map((e) => e.weight);
    expect(Math.min(...weights)).toBeCloseTo(6 / 100, 9);
    expect(capped[0]!.weight).toBeCloseTo(29 / 100, 9);
    // 원본은 정렬로 훼손되지 않는다.
    expect(edges[0]!.weight).toBeCloseTo(0, 9);
  });

  test("동률 weight 는 원래 순서를 유지한다(안정 정렬 — 프레임 간 깜빡임 방지)", () => {
    const edges = Array.from({ length: 30 }, (_, i) => edge(0.5, i));
    const capped = capEnergyEdges(edges);
    expect(capped.map((e) => e.from.x)).toEqual(
      Array.from({ length: MAX_ENERGY_EDGES }, (_, i) => i),
    );
    // 같은 입력이면 결과도 같다.
    expect(capEnergyEdges(edges)).toEqual(capped);
  });

  test("동률과 비동률이 섞여도 weight 내림차순 + 동률 내 원래 순서", () => {
    const edges = [
      ...Array.from({ length: 20 }, (_, i) => edge(0.3, i)),
      ...Array.from({ length: 10 }, (_, i) => edge(0.9, 100 + i)),
    ];
    const capped = capEnergyEdges(edges);
    expect(capped.length).toBe(MAX_ENERGY_EDGES);
    // 0.9 엣지 10개 전부 앞쪽에, 원래 순서대로.
    expect(capped.slice(0, 10).map((e) => e.from.x)).toEqual(
      Array.from({ length: 10 }, (_, i) => 100 + i),
    );
    // 나머지 14칸은 0.3 엣지의 앞 14개.
    expect(capped.slice(10).map((e) => e.from.x)).toEqual(
      Array.from({ length: 14 }, (_, i) => i),
    );
  });
});
