/**
 * spacing.ts 순수 헬퍼 단위 테스트.
 * radiusOfSize · massOfSize · minGapOf 세 함수의 수학적 계약을 검증한다.
 */
import { describe, it, expect } from "bun:test";
import { radiusOfSize, massOfSize, minGapOf } from "./spacing.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

describe("radiusOfSize", () => {
  it("크기 1일 때 반지름은 radiusFactor 와 같아야 한다", () => {
    const { radiusFactor } = GRAPH_RENDER_THEME.nodeSpacing;
    expect(radiusOfSize(1)).toBeCloseTo(radiusFactor, 9);
  });

  it("크기가 클수록 반지름이 커야 한다 (단조증가)", () => {
    expect(radiusOfSize(2)).toBeGreaterThan(radiusOfSize(1));
    expect(radiusOfSize(1)).toBeGreaterThan(radiusOfSize(0.5));
  });

  it("크기에 정확히 비례해야 한다", () => {
    // radiusOfSize(2) = 2 × radiusOfSize(1)
    expect(radiusOfSize(2)).toBeCloseTo(2 * radiusOfSize(1), 9);
  });
});

describe("massOfSize", () => {
  it("기준 크기(massRefSize)일 때 무게가 정확히 1 이어야 한다", () => {
    const { massRefSize } = GRAPH_RENDER_THEME.nodeSpacing;
    expect(massOfSize(massRefSize)).toBeCloseTo(1, 9);
  });

  it("크기가 클수록 무게가 커야 한다 (단조증가)", () => {
    const ref = GRAPH_RENDER_THEME.nodeSpacing.massRefSize;
    expect(massOfSize(ref * 2)).toBeGreaterThan(massOfSize(ref));
    expect(massOfSize(ref * 3)).toBeGreaterThan(massOfSize(ref * 2));
  });

  it("massExp=2 이면 크기가 2배일 때 무게는 4배여야 한다", () => {
    const ref = GRAPH_RENDER_THEME.nodeSpacing.massRefSize;
    const { massExp } = GRAPH_RENDER_THEME.dragRelax;
    if (massExp === 2) {
      expect(massOfSize(ref * 2)).toBeCloseTo(4, 9);
    }
  });
});

describe("minGapOf", () => {
  it("반지름 0.5, 0.5, 여유 0.4 이면 최소간격은 1.4 여야 한다", () => {
    expect(minGapOf(0.5, 0.5, 0.4)).toBeCloseTo(1.4, 9);
  });

  it("두 반지름 합과 여유분을 더한 값을 반환해야 한다", () => {
    expect(minGapOf(1, 2, 0.5)).toBeCloseTo(3.5, 9);
  });

  it("여유분이 0이면 두 반지름 합과 같아야 한다", () => {
    expect(minGapOf(0.3, 0.7, 0)).toBeCloseTo(1.0, 9);
  });
});
