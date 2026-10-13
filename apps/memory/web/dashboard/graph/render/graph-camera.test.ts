import { describe, expect, test } from "bun:test";

import { overviewPositionsForCamera } from "./graph-camera.ts";

function entry(x: number, y: number, z: number) {
  return { group: { position: { x, y, z } } };
}

describe("overviewPositionsForCamera", () => {
  test("현재 노드의 basePositions 를 우선하고 사라지는 중인 nodeEntries 는 제외한다", () => {
    const positions = overviewPositionsForCamera({
      nodes: [{ id: "a" }, { id: "b" }],
      basePositions: new Map([
        ["a", { x: 1, y: 2, z: 3 }],
        ["b", { x: 4, y: 5, z: 6 }],
      ]),
      nodeEntries: new Map([
        ["a", entry(100, 100, 100)],
        ["gone", entry(999, 999, 999)],
      ]),
    });

    expect(positions).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    ]);
  });

  test("basePositions 에 없는 현재 노드는 화면 좌표로 보강한다", () => {
    const positions = overviewPositionsForCamera({
      nodes: [{ id: "a" }, { id: "b" }],
      basePositions: new Map([
        ["a", { x: 1, y: 2, z: 3 }],
      ]),
      nodeEntries: new Map([
        ["b", entry(7, 8, 9)],
      ]),
    });

    expect(positions).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 7, y: 8, z: 9 },
    ]);
  });

  test("현재 노드 목록이 비었으면 기존 nodeEntries 로 fallback 한다", () => {
    const positions = overviewPositionsForCamera({
      nodes: [],
      basePositions: new Map(),
      nodeEntries: new Map([
        ["legacy", entry(-1, -2, -3)],
      ]),
    });

    expect(positions).toEqual([{ x: -1, y: -2, z: -3 }]);
  });
});
