/**
 * calibration.test.ts — 채널별 강도 보정 순수 함수 검증.
 *
 * data fixture 사용(순수 함수라 DB·임베더·LLM 의존 없음). mock 객체 없음.
 */
import { describe, test, expect } from "bun:test";
import {
  calibrateTmm,
  calibrateDbsf,
  applyBaselineFloor,
  CALIBRATION_FLOOR,
} from "./calibration.ts";

describe("calibrateTmm — theoretical min-max", () => {
  test("강한 매치(max)는 1.0, theoreticalMin 은 0.0", () => {
    // theoreticalMin = 0, max = 0.8 → (0.8-0)/(0.8-0) = 1.0
    const scores = new Map<number, number>([
      [1, 0.8],
      [2, 0.4],
      [3, 0.0],
    ]);
    const out = calibrateTmm(scores, 0);
    expect(out.get(1)).toBeCloseTo(1.0, 10);
    expect(out.get(2)).toBeCloseTo(0.5, 10); // (0.4-0)/0.8
    expect(out.get(3)).toBeCloseTo(0.0, 10); // (0.0-0)/0.8
  });

  test("약한 매치는 강도에 비례", () => {
    const scores = new Map<number, number>([
      [10, 0.2], // (0.2-0.1)/(0.5-0.1)=0.25
      [11, 0.5], // max → 1.0
      [12, 0.3], // (0.3-0.1)/0.4=0.5
    ]);
    const out = calibrateTmm(scores, 0.1);
    expect(out.get(11)).toBeCloseTo(1.0, 10);
    expect(out.get(10)).toBeCloseTo(0.25, 10);
    expect(out.get(12)).toBeCloseTo(0.5, 10);
  });

  test("theoreticalMin 이 보정 하한을 옮긴다", () => {
    // 같은 raw 점수라도 theoreticalMin 이 다르면 보정값이 달라진다.
    const scores = new Map<number, number>([
      [1, 0.5],
      [2, 1.0],
    ]);
    const outZero = calibrateTmm(scores, 0); // (0.5-0)/(1-0)=0.5
    const outNeg = calibrateTmm(scores, -1); // (0.5-(-1))/(1-(-1))=0.75
    expect(outZero.get(1)).toBeCloseTo(0.5, 10);
    expect(outNeg.get(1)).toBeCloseTo(0.75, 10);
    expect(outZero.get(2)).toBeCloseTo(1.0, 10);
    expect(outNeg.get(2)).toBeCloseTo(1.0, 10);
  });

  test("단일 후보는 0 나눗셈 없이 1.0 (관측된 유일 강도 = 최대)", () => {
    const scores = new Map<number, number>([[42, 0.33]]);
    const out = calibrateTmm(scores, 0);
    expect(out.size).toBe(1);
    expect(out.get(42)).toBe(1.0);
  });

  test("전부 동일값은 denom 0 → 모두 1.0", () => {
    const scores = new Map<number, number>([
      [1, 0.6],
      [2, 0.6],
      [3, 0.6],
    ]);
    const out = calibrateTmm(scores, 0);
    expect(out.get(1)).toBe(1.0);
    expect(out.get(2)).toBe(1.0);
    expect(out.get(3)).toBe(1.0);
  });

  test("max == theoreticalMin (denom 0) → 1.0", () => {
    const scores = new Map<number, number>([[1, 0.0]]);
    const out = calibrateTmm(scores, 0.0);
    expect(out.get(1)).toBe(1.0);
  });

  test("theoreticalMin 보다 낮은 raw 는 0 으로 clip", () => {
    const scores = new Map<number, number>([
      [1, -0.2], // theoreticalMin 0 아래 → clip 0
      [2, 0.5],
    ]);
    const out = calibrateTmm(scores, 0);
    expect(out.get(1)).toBe(0);
    expect(out.get(2)).toBe(1.0);
  });

  test("빈 입력은 빈 맵", () => {
    const out = calibrateTmm(new Map(), 0);
    expect(out.size).toBe(0);
  });

  test("입력 Map 을 변경하지 않는다(불변)", () => {
    const scores = new Map<number, number>([
      [1, 0.8],
      [2, 0.4],
    ]);
    calibrateTmm(scores, 0);
    expect(scores.get(1)).toBe(0.8);
    expect(scores.get(2)).toBe(0.4);
    expect(scores.size).toBe(2);
  });
});

describe("calibrateDbsf — distribution-based 3-시그마", () => {
  test("이상치 섞여도 나머지 보정이 합리적", () => {
    // 대부분 0.1 근방인데 한 값(0.9)이 튄다. mean 은 끌려가지만 std 가 커져
    // ±3σ 경계가 넓어지므로, 정상값들이 0/1 극단으로 포화되지 않고 분포 안에
    // 자연스럽게 위치한다(이상치 강건).
    const scores = new Map<number, number>([
      [1, 0.10],
      [2, 0.12],
      [3, 0.11],
      [4, 0.13],
      [5, 0.90], // 이상치
    ]);
    const out = calibrateDbsf(scores);
    // 모든 출력은 [0,1] 안.
    for (const v of out.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // 가장 큰 이상치가 가장 높은 보정값.
    const top = out.get(5)!;
    for (const id of [1, 2, 3, 4]) {
      expect(top).toBeGreaterThan(out.get(id)!);
    }
    // 정상값들끼리는 원시 강도 순서가 보존된다.
    expect(out.get(4)!).toBeGreaterThan(out.get(1)!);
  });

  test("강도 순서가 단조 보존된다", () => {
    const scores = new Map<number, number>([
      [1, 0.0],
      [2, 0.25],
      [3, 0.5],
      [4, 0.75],
      [5, 1.0],
    ]);
    const out = calibrateDbsf(scores);
    let prev = -Infinity;
    for (const id of [1, 2, 3, 4, 5]) {
      const v = out.get(id)!;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(out.get(1)!).toBeLessThan(out.get(5)!);
  });

  test("std == 0 (전부 동일값) → 모두 0.5 (강약 변별 불가, 중립)", () => {
    const scores = new Map<number, number>([
      [1, 0.4],
      [2, 0.4],
      [3, 0.4],
    ]);
    const out = calibrateDbsf(scores);
    expect(out.get(1)).toBe(0.5);
    expect(out.get(2)).toBe(0.5);
    expect(out.get(3)).toBe(0.5);
  });

  test("단일 후보는 std 0 → 0.5 (0 나눗셈 없음)", () => {
    const scores = new Map<number, number>([[7, 0.77]]);
    const out = calibrateDbsf(scores);
    expect(out.size).toBe(1);
    expect(out.get(7)).toBe(0.5);
  });

  test("출력은 항상 [0,1] clip (±3σ 밖 포화)", () => {
    // 극단 분포: 한 값이 평균에서 3σ 훨씬 밖.
    const scores = new Map<number, number>([
      [1, 0.0],
      [2, 0.0],
      [3, 0.0],
      [4, 0.0],
      [5, 100.0],
    ]);
    const out = calibrateDbsf(scores);
    for (const v of out.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("빈 입력은 빈 맵", () => {
    const out = calibrateDbsf(new Map());
    expect(out.size).toBe(0);
  });

  test("입력 Map 을 변경하지 않는다(불변)", () => {
    const scores = new Map<number, number>([
      [1, 0.1],
      [2, 0.9],
    ]);
    calibrateDbsf(scores);
    expect(scores.get(1)).toBe(0.1);
    expect(scores.get(2)).toBe(0.9);
    expect(scores.size).toBe(2);
  });
});

describe("CALIBRATION_FLOOR — 누락 채널 floor", () => {
  test("두 방식 키가 존재하고 number 타입", () => {
    expect(typeof CALIBRATION_FLOOR.tmm).toBe("number");
    expect(typeof CALIBRATION_FLOOR.dbsf).toBe("number");
  });

  test("값은 보정 출력 하한 0.0 (0 으로 뭉개는 게 아닌 정직한 하한)", () => {
    expect(CALIBRATION_FLOOR.tmm).toBe(0.0);
    expect(CALIBRATION_FLOOR.dbsf).toBe(0.0);
  });
});

describe("applyBaselineFloor — 채널별 절대 baseline floor 게이트", () => {
  test("raw 가 baseline 미만인 노드의 보정 강도를 0 으로 덮는다", () => {
    // dbsf 가 상대 분포로 잡음 노드(raw 0.16)에 1.0 을 줬다고 가정.
    const calibrated = new Map<number, number>([
      [1, 1.0], // raw 0.16 — baseline 0.17 미만 → 0 으로 컷.
      [2, 0.4], // raw 0.30 — baseline 이상 → 보존.
    ]);
    const raw = new Map<number, number>([
      [1, 0.16],
      [2, 0.3],
    ]);
    const out = applyBaselineFloor(calibrated, raw, 0.17);
    expect(out.get(1)).toBe(0);
    expect(out.get(2)).toBe(0.4);
  });

  test("dbsf 분별력 유지 — baseline 이상 노드는 보정값 그대로", () => {
    const calibrated = new Map<number, number>([
      [1, 0.2],
      [2, 0.5],
      [3, 0.9],
    ]);
    const raw = new Map<number, number>([
      [1, 0.18],
      [2, 0.25],
      [3, 0.4],
    ]);
    const out = applyBaselineFloor(calibrated, raw, 0.17);
    expect(out.get(1)).toBe(0.2);
    expect(out.get(2)).toBe(0.5);
    expect(out.get(3)).toBe(0.9);
  });

  test("raw 가 정확히 baseline 이면 통과(미만만 컷)", () => {
    const calibrated = new Map<number, number>([[1, 0.7]]);
    const raw = new Map<number, number>([[1, 0.17]]);
    const out = applyBaselineFloor(calibrated, raw, 0.17);
    expect(out.get(1)).toBe(0.7);
  });

  test("baseline = 0 이면 한 노드도 안 컷(게이트 비활성 = off 동치)", () => {
    const calibrated = new Map<number, number>([
      [1, 1.0],
      [2, 0.3],
    ]);
    const raw = new Map<number, number>([
      [1, 0.0],
      [2, 0.16],
    ]);
    const out = applyBaselineFloor(calibrated, raw, 0);
    expect(out.get(1)).toBe(1.0);
    expect(out.get(2)).toBe(0.3);
  });

  test("raw 에 없는 노드는 baseline 판정 건너뛰고 보정값 보존(외톨이 보호)", () => {
    const calibrated = new Map<number, number>([
      [1, 0.6],
      [2, 0.9],
    ]);
    const raw = new Map<number, number>([[1, 0.16]]); // 2 는 raw 없음.
    const out = applyBaselineFloor(calibrated, raw, 0.17);
    expect(out.get(1)).toBe(0); // raw 0.16 < 0.17 → 컷.
    expect(out.get(2)).toBe(0.9); // raw 모름 → 보존.
  });

  test("빈 보정 Map → 빈 Map", () => {
    const out = applyBaselineFloor(new Map(), new Map(), 0.17);
    expect(out.size).toBe(0);
  });

  test("입력 Map 들을 변경하지 않는다(불변)", () => {
    const calibrated = new Map<number, number>([
      [1, 1.0],
      [2, 0.4],
    ]);
    const raw = new Map<number, number>([
      [1, 0.16],
      [2, 0.3],
    ]);
    applyBaselineFloor(calibrated, raw, 0.17);
    expect(calibrated.get(1)).toBe(1.0);
    expect(calibrated.get(2)).toBe(0.4);
    expect(raw.get(1)).toBe(0.16);
    expect(raw.size).toBe(2);
  });
});
