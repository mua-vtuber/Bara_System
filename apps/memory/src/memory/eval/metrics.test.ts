import { describe, expect, test } from "bun:test";
import {
  computeNdcg,
  computeRecallByGroup,
  computeMrr,
  computePrecision,
  computeF1,
  computeMap,
} from "./metrics.ts";

describe("eval metrics — 그룹-최초-충족 순수 함수", () => {
  test("computeRecallByGroup — AND 세 그룹 중 둘 충족 = 2/3", () => {
    // Q3 스타일: [30],[31],[32] AND. ranked 가 30,31 만 잡음.
    const r = computeRecallByGroup([30, 31, 99], [[30], [31], [32]]);
    expect(r).toBeCloseTo(2 / 3);
  });

  test("computeRecallByGroup — OR 한 그룹 하나만 충족해도 1.0", () => {
    // Q1 스타일: [[14,15,16,17,18,21,22]] OR. ranked 에 17 하나만.
    const r = computeRecallByGroup([17], [[14, 15, 16, 17, 18, 21, 22]]);
    expect(r).toBeCloseTo(1.0);
  });

  test("computeNdcg — 같은 그룹 두 번째 충족은 0 기여(중복 방지)", () => {
    // 한 그룹 [30,31] 을 30 과 31 둘 다 상위에 잡아도 첫 충족 1개만.
    const single = computeNdcg([30, 99], [[30, 31]]);
    const both = computeNdcg([30, 31], [[30, 31]]);
    expect(both).toBeCloseTo(single); // 두 번째 충족이 점수를 더 안 올림
  });

  test("computeNdcg — 상위 배치가 하위 배치보다 높은 점수", () => {
    const top = computeNdcg([30, 31, 32], [[30], [31], [32]]);
    const bottom = computeNdcg([99, 98, 30, 31, 32], [[30], [31], [32]]);
    expect(top).toBeGreaterThan(bottom);
  });

  test("computeMrr — 첫 정답 순위 역수", () => {
    expect(computeMrr([99, 30], [[30]])).toBeCloseTo(1 / 2);
    expect(computeMrr([30], [[30]])).toBeCloseTo(1.0);
  });

  test("정답 그룹 0개 = 0 (측정 대상 없음)", () => {
    expect(computeNdcg([1, 2], [])).toBe(0);
    expect(computeRecallByGroup([1, 2], [])).toBe(0);
  });

  test("computePrecision — AND 세 그룹 중 둘 충족, ranked 3개 = 2/3", () => {
    const p = computePrecision([30, 31, 99], [[30], [31], [32]]);
    expect(p).toBeCloseTo(2 / 3);
  });

  test("computePrecision — 같은 그룹 두 번째 충족은 분자에 안 더해짐(중복 방지)", () => {
    // 그룹 [30,31] 하나를 30,31 둘 다 잡아도 hit 은 1 — ranked 2개라 분모는 2.
    const p = computePrecision([30, 31], [[30, 31]]);
    expect(p).toBeCloseTo(1 / 2);
  });

  test("computePrecision — 완전 미스 = 0", () => {
    expect(computePrecision([98, 99], [[30], [31]])).toBe(0);
  });

  test("computePrecision — ranked 0개 = 0 (측정 대상 없음)", () => {
    expect(computePrecision([], [[30]])).toBe(0);
  });

  test("computeF1 — precision·recall 조화평균, 부분 충족", () => {
    // ranked 3개 중 2개가 적중, 그룹 3개 중 2개 충족 → precision=recall=2/3.
    const f1 = computeF1([30, 31, 99], [[30], [31], [32]]);
    expect(f1).toBeCloseTo(2 / 3);
  });

  test("computeF1 — 완전 미스 = 0 (분모 0 회피)", () => {
    expect(computeF1([98, 99], [[30], [31]])).toBe(0);
  });

  test("computeF1 — OR 한 그룹 완전 충족(precision=recall=1) = 1.0", () => {
    expect(computeF1([17], [[14, 15, 16, 17, 18, 21, 22]])).toBeCloseTo(1.0);
  });

  test("computeMap — 단일 그룹 1위 적중 = 1.0", () => {
    expect(computeMap([30], [[30]])).toBeCloseTo(1.0);
  });

  test("computeMap — 두 그룹이 1,2위에 순서대로 적중 = 1.0", () => {
    const m = computeMap([30, 31], [[30], [31]]);
    expect(m).toBeCloseTo(1.0);
  });

  test("computeMap — 두 번째 그룹이 늦게 적중하면 하락", () => {
    // 그룹1 은 rank0(precision@1=1/1), 그룹2 는 rank2(precision@3=2/3) → AP=(1+2/3)/2.
    const m = computeMap([30, 99, 31], [[30], [31]]);
    expect(m).toBeCloseTo((1 + 2 / 3) / 2);
  });

  test("computeMap — 같은 그룹 두 번째 충족은 기여 없음(중복 방지)", () => {
    const single = computeMap([30, 99], [[30, 31]]);
    const both = computeMap([30, 31], [[30, 31]]);
    expect(both).toBeCloseTo(single);
  });

  test("computeMap — 완전 미스 = 0", () => {
    expect(computeMap([98, 99], [[30], [31]])).toBe(0);
  });

  test("computeMap — 정답 그룹 0개 = 0 (측정 대상 없음)", () => {
    expect(computeMap([1, 2], [])).toBe(0);
  });

  test("computeMap — 여러 쿼리 평균(호출부 harness 관례: per-query 계산 후 reduce 평균)", () => {
    const queries: { ranked: number[]; groups: number[][] }[] = [
      { ranked: [30], groups: [[30]] }, // AP = 1.0
      { ranked: [98, 99], groups: [[30], [31]] }, // AP = 0
    ];
    const perQuery = queries.map((q) => computeMap(q.ranked, q.groups));
    const mapScore = perQuery.reduce((s, v) => s + v, 0) / perQuery.length;
    expect(mapScore).toBeCloseTo((1.0 + 0) / 2);
  });
});
