import { describe, expect, test } from "bun:test";
import {
  basePositionForDriftContinuity,
  birthRippleCenterForTween,
  MAX_BIRTH_TRAILS,
  shouldClearSelectionOnRemoval,
  shouldEmitBirthTrail,
} from "./graph-transitions.ts";
import { nodeDriftOffset, seedFromId } from "./node-drift.ts";
import type { NodeTween } from "./node-transition.ts";
import type { Vec3 } from "../layout/force-layout.ts";

describe("basePositionForDriftContinuity", () => {
  test("base + 현재 drift offset 이 렌더 위치와 이어진다", () => {
    const id = "node:steady";
    const elapsed = 42.25;
    const rendered: Vec3 = { x: 3, y: -2, z: 7 };

    const base = basePositionForDriftContinuity(id, rendered, elapsed);
    const offset = nodeDriftOffset(elapsed, seedFromId(id));

    expect(base.x + offset.x).toBeCloseTo(rendered.x, 10);
    expect(base.y + offset.y).toBeCloseTo(rendered.y, 10);
    expect(base.z + offset.z).toBeCloseTo(rendered.z, 10);
  });
});

describe("birthRippleCenterForTween", () => {
  test("born 리플 중심은 별똥별 출발점이 아니라 최종 노드 위치다", () => {
    const toPos: Vec3 = { x: 1, y: 2, z: 3 };
    const tween: NodeTween = {
      nodeId: "node:new",
      kind: "born",
      fromPos: { x: 40, y: -12, z: 8 },
      controlPos: { x: 12, y: 9, z: 5 },
      toPos,
      startedAt: 10,
      birthStartedAt: 10,
      duration: 1,
    };

    expect(birthRippleCenterForTween(tween)).toEqual(toPos);
  });
});

describe("shouldEmitBirthTrail (T17 — 동시 유성 꼬리 상한)", () => {
  test("cap 미만이면 꼬리를 그린다", () => {
    expect(shouldEmitBirthTrail(0, MAX_BIRTH_TRAILS)).toBe(true);
    expect(shouldEmitBirthTrail(MAX_BIRTH_TRAILS - 1, MAX_BIRTH_TRAILS)).toBe(true);
  });

  test("cap 에 도달하면 이후 꼬리는 건너뛴다(노드 비행 자체는 계속된다)", () => {
    expect(shouldEmitBirthTrail(MAX_BIRTH_TRAILS, MAX_BIRTH_TRAILS)).toBe(false);
    expect(shouldEmitBirthTrail(MAX_BIRTH_TRAILS + 5, MAX_BIRTH_TRAILS)).toBe(false);
  });

  test("기본 상수는 32", () => {
    expect(MAX_BIRTH_TRAILS).toBe(32);
  });
});

describe("shouldClearSelectionOnRemoval", () => {
  test("사라지는 노드가 현재 선택과 같으면 true(펄스 링 고아 방지)", () => {
    expect(shouldClearSelectionOnRemoval("node:selected", "node:selected")).toBe(true);
  });

  test("사라지는 노드가 현재 선택과 다르면 false(다른 노드 선택은 건드리지 않는다)", () => {
    expect(shouldClearSelectionOnRemoval("node:selected", "node:other")).toBe(false);
  });

  test("선택이 없으면(null) 항상 false", () => {
    expect(shouldClearSelectionOnRemoval(null, "node:any")).toBe(false);
  });
});
