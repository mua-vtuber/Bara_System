import { describe, expect, test } from "bun:test";
import {
  collectCurrentNodePositions,
  hasStructuralGraphChange,
  mergeNodeTransitionPlan,
  shouldPreserveActiveDataTransition,
} from "./graph-data-apply.ts";
import type { GraphDiff } from "./graph-diff.ts";
import type { NodeTween } from "./node-transition.ts";
import type { Vec3 } from "../layout/force-layout.ts";

const emptyDiff: GraphDiff = {
  addedNodeIds: [],
  removedNodeIds: [],
  keptNodeIds: ["a"],
  addedEdgeKeys: [],
  removedEdgeKeys: [],
};

describe("graph-data-apply transition guards", () => {
  test("구조 diff 가 비어 있고 전환 중이면 기존 트윈을 보존한다", () => {
    expect(shouldPreserveActiveDataTransition(emptyDiff, true, false)).toBe(true);
    expect(shouldPreserveActiveDataTransition(emptyDiff, false, true)).toBe(true);
  });

  test("구조 변화가 있으면 전환 중이어도 새 applyData 가 돈다", () => {
    const diff: GraphDiff = { ...emptyDiff, addedNodeIds: ["b"] };
    expect(hasStructuralGraphChange(diff)).toBe(true);
    expect(shouldPreserveActiveDataTransition(diff, true, true)).toBe(false);
  });

  test("전환 중이 아니면 같은 데이터도 일반 갱신을 허용한다", () => {
    expect(hasStructuralGraphChange(emptyDiff)).toBe(false);
    expect(shouldPreserveActiveDataTransition(emptyDiff, false, false)).toBe(false);
  });
});

describe("collectCurrentNodePositions", () => {
  test("nodeEntries 의 현재 화면 좌표가 basePositions 보다 우선한다", () => {
    const entries = new Map([
      ["a", { group: { position: { x: 1, y: 2, z: 3 } } }],
    ]);
    const base = new Map<string, Vec3>([
      ["a", { x: 10, y: 20, z: 30 }],
      ["b", { x: 4, y: 5, z: 6 }],
    ]);

    const positions = collectCurrentNodePositions(entries, base);
    expect(positions.get("a")).toEqual({ x: 1, y: 2, z: 3 });
    expect(positions.get("b")).toEqual({ x: 4, y: 5, z: 6 });
  });
});

describe("mergeNodeTransitionPlan", () => {
  test("진행 중인 born 은 새 move 로 덮지 않고 도착점만 갱신한다", () => {
    const existing: NodeTween = {
      nodeId: "new",
      kind: "born",
      fromPos: { x: 10, y: 0, z: 0 },
      controlPos: { x: 5, y: 2, z: 0 },
      toPos: { x: 0, y: 0, z: 0 },
      startedAt: 1,
      birthStartedAt: 1.2,
      duration: 1.6,
      staggerDelay: 0.2,
      birthTargetRevision: 0,
    };
    const planned: NodeTween = {
      nodeId: "new",
      kind: "move",
      fromPos: { x: 3, y: 3, z: 0 },
      toPos: { x: -2, y: 1, z: 0 },
      startedAt: 1.5,
      duration: 2,
    };

    const merged = mergeNodeTransitionPlan(new Map([["new", existing]]), [planned]);
    const tween = merged.get("new");

    expect(tween?.kind).toBe("born");
    expect(tween?.fromPos).toEqual(existing.fromPos);
    expect(tween?.controlPos).toEqual(existing.controlPos);
    expect(tween?.birthStartedAt).toBe(existing.birthStartedAt);
    expect(tween?.toPos).toEqual(planned.toPos);
    expect(tween?.birthTargetRevision).toBe(1);
  });

  test("leave 는 진행 중인 born 보다 우선한다", () => {
    const existing: NodeTween = {
      nodeId: "gone",
      kind: "born",
      fromPos: { x: 5, y: 0, z: 0 },
      toPos: { x: 0, y: 0, z: 0 },
      startedAt: 1,
      duration: 1,
    };
    const leave: NodeTween = {
      nodeId: "gone",
      kind: "leave",
      fromPos: { x: 1, y: 0, z: 0 },
      toPos: { x: 1, y: 0, z: 0 },
      startedAt: 2,
      duration: 1,
    };

    const merged = mergeNodeTransitionPlan(new Map([["gone", existing]]), [leave]);
    expect(merged.get("gone")).toEqual(leave);
  });
});
