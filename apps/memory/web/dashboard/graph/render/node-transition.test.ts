import { describe, it, expect } from "bun:test";
import {
  birthStaggerDelay,
  birthStartDelay,
  computeTrailTail,
  planBirthPath,
  planNodeTweens,
  resolveExpansionAnchorId,
  sampleTween,
} from "./node-transition.ts";
import type { GraphDiff } from "./graph-diff.ts";
import type { GraphEdge } from "../graph-view-model.ts";
import type { Vec3 } from "../layout/force-layout.ts";

const diff: GraphDiff = {
  addedNodeIds: ["new"], removedNodeIds: ["gone"], keptNodeIds: ["stay"],
  addedEdgeKeys: [], removedEdgeKeys: [],
};
const prev = new Map<string, Vec3>([["stay", { x: 0, y: 0, z: 0 }], ["gone", { x: 9, y: 0, z: 0 }]]);
const next = new Map<string, Vec3>([["stay", { x: 10, y: 0, z: 0 }], ["new", { x: 5, y: 0, z: 0 }]]);

describe("planNodeTweens", () => {
  it("kept·added·removed 각각 move·born·leave", () => {
    const tws = planNodeTweens(diff, prev, next, 100, 1);
    const byId = new Map(tws.map((t) => [t.nodeId, t]));
    expect(byId.get("stay")!.kind).toBe("move");
    expect(byId.get("new")!.kind).toBe("born");
    expect(byId.get("gone")!.kind).toBe("leave");
  });
});

describe("sampleTween", () => {
  it("born 은 시작에 작고 투명, 끝에 1·1", () => {
    const born = planNodeTweens(
      { ...diff, keptNodeIds: [], removedNodeIds: [] }, prev, next, 100, 1)[0]!;
    const s0 = sampleTween(born, 100);
    const s1 = sampleTween(born, 101);
    expect(s0.scaleMul).toBeLessThan(0.1);
    expect(s0.opacityMul).toBeLessThan(0.1);
    expect(s1.scaleMul).toBeCloseTo(1, 2);
    expect(s1.done).toBe(true);
  });
  it("move 는 옛→새 위치 보간", () => {
    const tws = planNodeTweens(
      { ...diff, addedNodeIds: [], removedNodeIds: [] }, prev, next, 100, 1);
    const mid = sampleTween(tws[0]!, 100.5);
    expect(mid.pos.x).toBeCloseTo(5, 1);
    expect(mid.colorT).toBeCloseTo(0.5, 1);
  });
  it("끝나면 done·끝값 고정", () => {
    const tws = planNodeTweens(
      { ...diff, addedNodeIds: [], removedNodeIds: [] }, prev, next, 100, 1);
    const after = sampleTween(tws[0]!, 999);
    expect(after.done).toBe(true);
    expect(after.pos.x).toBe(10);
  });
  it("leave 는 불투명도가 1→0 으로 사라진다", () => {
    const leave = planNodeTweens(
      { ...diff, addedNodeIds: [], keptNodeIds: [] }, prev, next, 100, 1)[0]!;
    expect(sampleTween(leave, 100).opacityMul).toBeCloseTo(1, 2);
    expect(sampleTween(leave, 100.5).opacityMul).toBeCloseTo(0.5, 2);
    const end = sampleTween(leave, 101);
    expect(end.opacityMul).toBeCloseTo(0, 2);
    expect(end.done).toBe(true);
  });
  it("duration 0 이면 즉시 완료(끝값)", () => {
    const mv = planNodeTweens(
      { ...diff, addedNodeIds: [], removedNodeIds: [] }, prev, next, 100, 0)[0]!;
    const s = sampleTween(mv, 100);
    expect(s.done).toBe(true);
    expect(s.pos.x).toBe(10);   // 끝값 고정
  });
  it("planNodeTweens 는 kept+added+removed 수만큼 트윈을 만든다", () => {
    const tws = planNodeTweens(diff, prev, next, 100, 1);
    expect(tws.length).toBe(3);   // 중복·누락 없음
  });
  it("born 은 중간에 빛 버스트가 peak, 끝·시작엔 0", () => {
    const born = planNodeTweens(
      { ...diff, keptNodeIds: [], removedNodeIds: [] }, prev, next, 100, 1)[0]!;
    expect(sampleTween(born, 100).burst).toBeCloseTo(0, 2);     // 시작 0
    expect(sampleTween(born, 100.5).burst).toBeGreaterThan(0.5); // 중간 peak
    expect(sampleTween(born, 101).burst).toBeCloseTo(0, 2);      // 끝 0
  });
  it("born scaleMul 은 중간에 1 을 넘겨 톡 튄다(오버슈트)", () => {
    const born = planNodeTweens(
      { ...diff, keptNodeIds: [], removedNodeIds: [] }, prev, next, 100, 1)[0]!;
    expect(sampleTween(born, 100.8).scaleMul).toBeGreaterThan(1); // 후반 오버슈트
    expect(sampleTween(born, 101).scaleMul).toBeCloseTo(1, 2);    // 끝은 정확히 1
  });
  it("move·leave 는 burst 0", () => {
    const tws = planNodeTweens(diff, prev, next, 100, 1);
    const byId = new Map(tws.map((t) => [t.nodeId, t]));
    expect(sampleTween(byId.get("stay")!, 100.5).burst).toBe(0);
    expect(sampleTween(byId.get("gone")!, 100.5).burst).toBe(0);
  });
});

describe("meteor born motion", () => {
  const birth = {
    travelDistanceMin: 10,
    travelDistanceMax: 14,
    arcStrength: 0.35,
    staggerS: 0.08,
    maxStaggerS: 0.5,
    maxConcurrent: 40,
  };

  it("born 시작점은 목표점에서 충분히 멀고 node id 기준 결정적이다", () => {
    const target = { x: 5, y: -2, z: 1 };
    const a = planBirthPath("node:new", target, birth);
    const b = planBirthPath("node:new", target, birth);
    const dist = Math.hypot(
      a.fromPos.x - target.x,
      a.fromPos.y - target.y,
      a.fromPos.z - target.z,
    );

    expect(a).toEqual(b);
    expect(dist).toBeGreaterThanOrEqual(10);
    expect(dist).toBeLessThanOrEqual(14.000001);
  });

  it("born 은 먼 시작점에서 곡선으로 날아와 끝값은 목표 위치에 고정된다", () => {
    const born = planNodeTweens(
      { ...diff, keptNodeIds: [], removedNodeIds: [] },
      prev,
      next,
      100,
      1,
      { birth },
    )[0]!;

    const s0 = sampleTween(born, born.birthStartedAt!);
    const s1 = sampleTween(born, born.birthStartedAt! + 1);

    expect(s0.pos).toEqual(born.fromPos);
    expect(s1.pos).toEqual(born.toPos);
    expect(s1.done).toBe(true);
  });

  it("비행을 끄면 기존처럼 최종 위치에서 born 한다", () => {
    const born = planNodeTweens(
      { ...diff, keptNodeIds: [], removedNodeIds: [] },
      prev,
      next,
      100,
      1,
      { birth, animateBirthFlight: false },
    )[0]!;

    expect(born.fromPos).toEqual(born.toPos);
    expect(sampleTween(born, 100).pos).toEqual(born.toPos);
  });

  it("stagger 는 상한을 넘지 않는다", () => {
    expect(birthStaggerDelay(0, birth)).toBe(0);
    expect(birthStaggerDelay(3, birth)).toBeCloseTo(0.24, 5);
    expect(birthStaggerDelay(100, birth)).toBe(0.5);
  });

  it("동시 born 40개 초과분은 다음 batch 로 순차 시작한다", () => {
    expect(birthStartDelay(39, 1.6, birth)).toBe(0.5);
    expect(birthStartDelay(40, 1.6, birth)).toBe(1.6);
    expect(birthStartDelay(43, 1.6, birth)).toBeCloseTo(1.84, 5);
  });
});

describe("resolveExpansionAnchorId (파생 흩어짐/합쳐짐 anchor 판정)", () => {
  it("parent_of 엣지로 연결된 파생 자식은 반대편을 anchor 로 돌려준다", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "node:child", to: "node:parent", type: "parent_of" },
    ];
    expect(resolveExpansionAnchorId("node:child", edges)).toBe("node:parent");
  });

  it("from·to 어느 쪽에 있어도 반대편을 anchor 로 찾는다", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "node:parent", to: "node:child", type: "contains_chunk" },
    ];
    expect(resolveExpansionAnchorId("node:child", edges)).toBe("node:parent");
  });

  it("파생 위계 엣지 타입이 아니면 anchor 없음(null)", () => {
    const edges: GraphEdge[] = [
      { id: "e1", from: "node:child", to: "node:parent", type: "related_to" },
    ];
    expect(resolveExpansionAnchorId("node:child", edges)).toBeNull();
  });

  it("연결된 엣지가 없으면 anchor 없음(null)", () => {
    expect(resolveExpansionAnchorId("node:orphan", [])).toBeNull();
  });

  it("gather 대상 노드의 엣지는 새 viewModel 이 아니라 옛 host.edges 에만 남아있을 수 있다 — 옛+새 합집합에서 찾는다", () => {
    // 실제 호출부(graph-data-apply.ts)는 host.edges(옛)와 viewModel.edges(새)를 합쳐 넘긴다.
    // 사라지는 자식의 엣지는 새 viewModel 에는 이미 없으므로, 옛 엣지만으로도 anchor 를 찾을 수 있어야 한다.
    const oldEdges: GraphEdge[] = [
      { id: "e1", from: "node:child", to: "node:parent", type: "parent_of" },
    ];
    const newEdges: GraphEdge[] = []; // 자식이 사라진 새 데이터엔 이 엣지가 없다.
    expect(resolveExpansionAnchorId("node:child", [...oldEdges, ...newEdges])).toBe("node:parent");
  });
});

describe("scatter(흩어짐) — anchor 있는 born 은 부모 위치에서 태어난다", () => {
  const scatterDiff: GraphDiff = {
    addedNodeIds: ["node:child"], removedNodeIds: [], keptNodeIds: ["node:parent"],
    addedEdgeKeys: [], removedEdgeKeys: [],
  };
  const edges: GraphEdge[] = [
    { id: "e1", from: "node:child", to: "node:parent", type: "parent_of" },
  ];
  const parentPos: Vec3 = { x: 3, y: 4, z: 0 };
  const childTarget: Vec3 = { x: 20, y: 20, z: 20 };
  const prevPositions = new Map<string, Vec3>([["node:parent", parentPos]]);
  const nextPositions = new Map<string, Vec3>([
    ["node:parent", parentPos],
    ["node:child", childTarget],
  ]);

  it("anchor 가 있으면 fromPos 가 부모의 현재 위치와 같다(원거리 유성 비행 아님)", () => {
    const tws = planNodeTweens(
      scatterDiff, prevPositions, nextPositions, 100, 1, { edges },
    );
    const child = tws.find((t) => t.nodeId === "node:child")!;
    expect(child.kind).toBe("born");
    expect(child.fromPos).toEqual(parentPos);
    expect(child.toPos).toEqual(childTarget);
  });

  it("anchor 가 없으면 기존 원거리 유성 비행 경로를 그대로 쓴다", () => {
    const tws = planNodeTweens(
      { ...scatterDiff, keptNodeIds: [] }, prevPositions, nextPositions, 100, 1, { edges: [] },
    );
    const child = tws.find((t) => t.nodeId === "node:child")!;
    const dist = Math.hypot(
      child.fromPos.x - childTarget.x,
      child.fromPos.y - childTarget.y,
      child.fromPos.z - childTarget.z,
    );
    expect(dist).toBeGreaterThan(1);
  });
});

describe("T19 Problem A — anchor 있는 born/leave 는 sampleTween 에 liveAnchorPos 를 넘기면 라이브 위치로 수렴한다", () => {
  const scatterDiff: GraphDiff = {
    addedNodeIds: ["node:child"], removedNodeIds: [], keptNodeIds: ["node:parent"],
    addedEdgeKeys: [], removedEdgeKeys: [],
  };
  const edges: GraphEdge[] = [
    { id: "e1", from: "node:child", to: "node:parent", type: "parent_of" },
  ];
  const parentPosAtPlanTime: Vec3 = { x: 3, y: 4, z: 0 };
  const childTarget: Vec3 = { x: 20, y: 20, z: 20 };
  const prevPositions = new Map<string, Vec3>([["node:parent", parentPosAtPlanTime]]);
  const nextPositions = new Map<string, Vec3>([
    ["node:parent", parentPosAtPlanTime],
    ["node:child", childTarget],
  ]);

  it("RED였던 동작 — anchorId 가 트윈에 기록된다(스냅샷 fromPos 와 별개)", () => {
    const tws = planNodeTweens(scatterDiff, prevPositions, nextPositions, 100, 1, { edges });
    const child = tws.find((t) => t.nodeId === "node:child")!;
    expect(child.anchorId).toBe("node:parent");
    // 스냅샷 fromPos 는 기존처럼 그대로 유지된다(폴백용).
    expect(child.fromPos).toEqual(parentPosAtPlanTime);
  });

  it("liveAnchorPos 를 넘기면 스냅샷이 아니라 그 위치로 수렴한다(부모가 트윈 계획 후 이동한 경우)", () => {
    const tws = planNodeTweens(scatterDiff, prevPositions, nextPositions, 100, 1, { edges });
    const child = tws.find((t) => t.nodeId === "node:child")!;
    // 부모가 레이아웃 리플로우로 계획 시점 이후 다른 위치로 옮겨갔다고 가정.
    const parentMovedTo: Vec3 = { x: 50, y: -10, z: 2 };
    const sWithLive = sampleTween(child, child.birthStartedAt!, parentMovedTo);
    const sSnapshotOnly = sampleTween(child, child.birthStartedAt!);
    // 트윈 시작 시점(t=0)엔 fromPos 자체가 head 위치이므로, liveAnchorPos 를 넘기면
    // 옛 스냅샷(parentPosAtPlanTime)이 아니라 parentMovedTo 로 head 가 나와야 한다.
    expect(sWithLive.pos).toEqual(parentMovedTo);
    expect(sSnapshotOnly.pos).toEqual(parentPosAtPlanTime);
  });

  it("liveAnchorPos 를 넘기지 않으면(anchor entry 사라짐) 스냅샷 폴백으로 자연히 떨어진다", () => {
    const tws = planNodeTweens(scatterDiff, prevPositions, nextPositions, 100, 1, { edges });
    const child = tws.find((t) => t.nodeId === "node:child")!;
    const s = sampleTween(child, child.birthStartedAt!, undefined);
    expect(s.pos).toEqual(parentPosAtPlanTime);
  });

  it("anchor 가 없는 일반 유성 비행 born 은 liveAnchorPos 를 넘겨도 영향받지 않는다(anchorId 없음)", () => {
    const tws = planNodeTweens(
      { ...scatterDiff, keptNodeIds: [] }, prevPositions, nextPositions, 100, 1, { edges: [] },
    );
    const child = tws.find((t) => t.nodeId === "node:child")!;
    expect(child.anchorId).toBeUndefined();
    const withBogusLive = sampleTween(child, child.birthStartedAt!, { x: 999, y: 999, z: 999 });
    const withoutLive = sampleTween(child, child.birthStartedAt!);
    expect(withBogusLive.pos).toEqual(withoutLive.pos);
  });

  it("gather(leave) 도 liveAnchorPos 를 넘기면 최신 부모 위치로 수렴한다", () => {
    const gatherDiff: GraphDiff = {
      addedNodeIds: [], removedNodeIds: ["node:child"], keptNodeIds: ["node:parent"],
      addedEdgeKeys: [], removedEdgeKeys: [],
    };
    const parentPos: Vec3 = { x: -6, y: 2, z: 1 };
    const childPos: Vec3 = { x: 9, y: 9, z: 9 };
    const prevPos = new Map<string, Vec3>([["node:parent", parentPos], ["node:child", childPos]]);
    const nextPos = new Map<string, Vec3>([["node:parent", parentPos]]);
    const tws = planNodeTweens(gatherDiff, prevPos, nextPos, 100, 1, { edges });
    const child = tws.find((t) => t.nodeId === "node:child")!;
    expect(child.anchorId).toBe("node:parent");

    const parentMovedTo: Vec3 = { x: 12, y: 12, z: 12 };
    const sEnd = sampleTween(child, 101, parentMovedTo);
    expect(sEnd.pos).toEqual(parentMovedTo);
    const sEndSnapshot = sampleTween(child, 101);
    expect(sEndSnapshot.pos).toEqual(parentPos);
  });
});

describe("T19 Problem B — computeTrailTail 은 이동 거리와 무관하게 최소 길이를 보장한다", () => {
  it("이동 거리가 최소 길이보다 길면 head 에서 정확히 minLength 만큼 뗀 지점", () => {
    const head: Vec3 = { x: 0, y: 0, z: 0 };
    const pathStart: Vec3 = { x: 10, y: 0, z: 0 };
    const tail = computeTrailTail(head, pathStart, 2);
    expect(tail.x).toBeCloseTo(2, 6);
    expect(tail.y).toBeCloseTo(0, 6);
    expect(tail.z).toBeCloseTo(0, 6);
  });

  it("이동 거리가 최소 길이보다 짧으면(scatter 시나리오) pathStart 를 그대로 돌려준다 — 넘어서 튀어나가지 않는다", () => {
    const head: Vec3 = { x: 0, y: 0, z: 0 };
    const pathStart: Vec3 = { x: 0.3, y: 0, z: 0 }; // 총 이동거리 0.3 < minLength 0.9
    const tail = computeTrailTail(head, pathStart, 0.9);
    expect(tail).toEqual(pathStart);
  });

  it("실측 재현 — scatter anchor 거리(depthStep=2.0)에서 옛 ratio 방식은 tail-head 거리가 0.36(안 보임), 새 방식은 0.9 보장", () => {
    const head: Vec3 = { x: 1.5, y: 0, z: 0 }; // 진행 중(부모→자식 이동 절반 지점 근사)
    const pathStart: Vec3 = { x: 0, y: 0, z: 0 }; // anchor(부모) 위치, depthStep=2.0 만큼 떨어짐
    const oldRatioTailDist = 2.0 * 0.18; // 옛 trailLengthRatio 산식
    expect(oldRatioTailDist).toBeCloseTo(0.36, 6);

    const tail = computeTrailTail(head, pathStart, 0.9);
    const dist = Math.hypot(tail.x - head.x, tail.y - head.y, tail.z - head.z);
    expect(dist).toBeCloseTo(0.9, 6);
    expect(dist).toBeGreaterThan(oldRatioTailDist);
  });

  it("유성 비행(원거리 10~14 유닛)에서는 minLength 가 이동 거리보다 훨씬 짧아 head 근처만 그린다", () => {
    const head: Vec3 = { x: 5, y: 0, z: 0 };
    const pathStart: Vec3 = { x: 14, y: 0, z: 0 }; // 원거리 유성 비행 시작점
    const tail = computeTrailTail(head, pathStart, 0.9);
    const dist = Math.hypot(tail.x - head.x, tail.y - head.y, tail.z - head.z);
    expect(dist).toBeCloseTo(0.9, 6);
  });
});

describe("gather(합쳐짐) — anchor 있는 leave 는 부모 위치로 빨려든다", () => {
  const gatherDiff: GraphDiff = {
    addedNodeIds: [], removedNodeIds: ["node:child"], keptNodeIds: ["node:parent"],
    addedEdgeKeys: [], removedEdgeKeys: [],
  };
  const edges: GraphEdge[] = [
    { id: "e1", from: "node:child", to: "node:parent", type: "parent_of" },
  ];
  const parentPos: Vec3 = { x: -6, y: 2, z: 1 };
  const childPos: Vec3 = { x: 9, y: 9, z: 9 };
  const prevPositions = new Map<string, Vec3>([
    ["node:parent", parentPos],
    ["node:child", childPos],
  ]);
  const nextPositions = new Map<string, Vec3>([["node:parent", parentPos]]);

  it("anchor 가 있으면 leave 트윈의 toPos 가 부모 위치로 수렴한다", () => {
    const tws = planNodeTweens(
      gatherDiff, prevPositions, nextPositions, 100, 1, { edges },
    );
    const child = tws.find((t) => t.nodeId === "node:child")!;
    expect(child.kind).toBe("leave");
    expect(child.fromPos).toEqual(childPos);
    expect(child.toPos).toEqual(parentPos);
  });

  it("anchor 가 없으면 기존처럼 제자리에서 사라진다(fromPos == toPos)", () => {
    const tws = planNodeTweens(
      { ...gatherDiff, keptNodeIds: [] }, prevPositions, nextPositions, 100, 1, { edges: [] },
    );
    const child = tws.find((t) => t.nodeId === "node:child")!;
    expect(child.fromPos).toEqual(child.toPos);
  });
});
