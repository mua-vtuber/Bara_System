import { describe, it, expect } from "bun:test";
import { planMergeTween, sampleMergeTween } from "./merge-transition.ts";
import type { Vec3 } from "../layout/force-layout.ts";

const from: Vec3 = { x: 0, y: 0, z: 0 };
const into: Vec3 = { x: 10, y: 0, z: 0 };

describe("planMergeTween / sampleMergeTween", () => {
  it("시작엔 from 제자리·불투명, into 정상 크기·광채 0", () => {
    const tw = planMergeTween("concept:1", "concept:2", from, into, 100, 1);
    const s = sampleMergeTween(tw, 100);
    expect(s.fromPos.x).toBeCloseTo(0, 1);
    expect(s.fromOpacity).toBeCloseTo(1, 1);
    expect(s.intoScaleMul).toBeCloseTo(1, 1);
    expect(s.intoBurst).toBeCloseTo(0, 2);
    expect(s.done).toBe(false);
  });

  it("중간엔 from 이 into 쪽으로 끌려가며 페이드, into 가 부푼다", () => {
    const tw = planMergeTween("concept:1", "concept:2", from, into, 100, 1);
    const s = sampleMergeTween(tw, 100.5);
    // from 위치는 0→10 사이로 들어왔고, 불투명도는 1→0 사이로 빠졌다.
    expect(s.fromPos.x).toBeGreaterThan(0);
    expect(s.fromPos.x).toBeLessThan(10);
    expect(s.fromOpacity).toBeGreaterThan(0);
    expect(s.fromOpacity).toBeLessThan(1);
    // into 흡수 광채(sin) 는 중간(t=0.5)에서 peak.
    expect(s.intoScaleMul).toBeGreaterThan(1);
    expect(s.intoBurst).toBeGreaterThan(0);
  });

  it("끝엔 from 이 into 위치·투명, into 정착(scale 1·burst 0)", () => {
    const tw = planMergeTween("concept:1", "concept:2", from, into, 100, 1);
    const s = sampleMergeTween(tw, 999);
    expect(s.done).toBe(true);
    expect(s.fromPos.x).toBe(10);
    expect(s.fromOpacity).toBe(0);
    expect(s.intoScaleMul).toBe(1);
    expect(s.intoBurst).toBe(0);
  });

  it("durationS 0 이면 즉시 끝값(연출 꺼짐)", () => {
    const tw = planMergeTween("concept:1", "concept:2", from, into, 100, 0);
    const s = sampleMergeTween(tw, 100);
    expect(s.done).toBe(true);
    expect(s.fromPos.x).toBe(10);
    expect(s.fromOpacity).toBe(0);
    expect(s.intoScaleMul).toBe(1);
  });

  it("시작 전(now < start) 도 시작값으로 clamp(발산 방지)", () => {
    const tw = planMergeTween("concept:1", "concept:2", from, into, 100, 1);
    const s = sampleMergeTween(tw, 50);
    expect(s.fromPos.x).toBeCloseTo(0, 1);
    expect(s.fromOpacity).toBeCloseTo(1, 1);
  });

  it("from·into id 와 목표 위치를 트윈이 보존한다", () => {
    const tw = planMergeTween("concept:7", "concept:8", from, into, 100, 1);
    expect(tw.fromId).toBe("concept:7");
    expect(tw.intoId).toBe("concept:8");
    expect(tw.intoPos).toEqual(into);
  });
});
