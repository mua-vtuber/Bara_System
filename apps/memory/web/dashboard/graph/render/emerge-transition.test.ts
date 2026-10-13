import { describe, it, expect } from "bun:test";
import { planEmergeTween, sampleEmergeTween } from "./emerge-transition.ts";
import type { Vec3 } from "../layout/force-layout.ts";

const target: Vec3 = { x: 0, y: 0, z: 0 };
const sources = new Map<string, Vec3>([
  ["node:1", { x: 10, y: 0, z: 0 }],
  ["node:2", { x: 0, y: 10, z: 0 }],
]);

describe("planEmergeTween / sampleEmergeTween", () => {
  it("화면에 있는 출처만 수렴선이 된다(없는 출처는 건너뜀)", () => {
    const tw = planEmergeTween("concept:9", ["node:1", "node:2", "node:없음"], sources, target, 100, 1);
    const s = sampleEmergeTween(tw, 100.5);
    expect(s.converge.length).toBe(2); // node:없음 은 빠진다.
    const froms = s.converge.map((c) => c.from);
    expect(froms).toContain("node:1");
    expect(froms).toContain("node:2");
    expect(froms).not.toContain("node:없음");
  });

  it("시작엔 머리가 출처 제자리, 탄생 시작(scale 작음)", () => {
    const tw = planEmergeTween("concept:9", ["node:1"], sources, target, 100, 1);
    const s = sampleEmergeTween(tw, 100);
    expect(s.converge[0]!.headPos.x).toBeCloseTo(10, 1); // 출처 위치에서 출발.
    expect(s.bornScaleMul).toBeLessThan(0.1);
    expect(s.done).toBe(false);
  });

  it("중간엔 머리가 출처→목표 사이로 들어오고 탄생 진행", () => {
    const tw = planEmergeTween("concept:9", ["node:1"], sources, target, 100, 1);
    const s = sampleEmergeTween(tw, 100.5);
    expect(s.converge[0]!.headPos.x).toBeGreaterThan(0);
    expect(s.converge[0]!.headPos.x).toBeLessThan(10);
    expect(s.bornBurst).toBeGreaterThan(0);
  });

  it("끝엔 머리가 목표에 닿고 탄생 정착(scale 1·burst 0)", () => {
    const tw = planEmergeTween("concept:9", ["node:1"], sources, target, 100, 1);
    const s = sampleEmergeTween(tw, 999);
    expect(s.done).toBe(true);
    expect(s.converge[0]!.headPos.x).toBeCloseTo(0, 1);
    expect(s.converge[0]!.headPos.y).toBeCloseTo(0, 1);
    expect(s.bornScaleMul).toBe(1);
    expect(s.bornBurst).toBe(0);
  });

  it("durationS 0 이면 즉시 끝값(연출 꺼짐)", () => {
    const tw = planEmergeTween("concept:9", ["node:1"], sources, target, 100, 0);
    const s = sampleEmergeTween(tw, 100);
    expect(s.done).toBe(true);
    expect(s.converge[0]!.headPos.x).toBeCloseTo(0, 1);
    expect(s.bornScaleMul).toBe(1);
  });

  it("화면에 출처가 하나도 없으면 수렴선 0(탄생만)", () => {
    const tw = planEmergeTween("concept:9", ["node:없음1", "node:없음2"], sources, target, 100, 1);
    const s = sampleEmergeTween(tw, 100.5);
    expect(s.converge.length).toBe(0);
    // 탄생 자체는 여전히 진행한다(노드는 태어난다).
    expect(s.bornScaleMul).toBeGreaterThan(0);
  });

  it("nodeId·목표를 트윈이 보존한다", () => {
    const tw = planEmergeTween("concept:42", ["node:1"], sources, target, 100, 1);
    expect(tw.nodeId).toBe("concept:42");
    expect(tw.targetPos).toEqual(target);
  });
});
