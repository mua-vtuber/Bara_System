import { describe, it, expect } from "bun:test";
import { neighborsWithin, relaxStep, relaxStepPhysics, type Vec3 } from "./drag-relax.ts";
import type { GraphEdge } from "../graph-view-model.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

const edges: GraphEdge[] = [
  { id: "e1", from: "a", to: "b", type: "memory_link", weight: 1 } as GraphEdge,
  { id: "e2", from: "b", to: "c", type: "memory_link", weight: 1 } as GraphEdge,
  { id: "e3", from: "c", to: "d", type: "memory_link", weight: 1 } as GraphEdge,
];

/** 한 줄(a-b-c-d)을 x 축에 5 간격으로 늘어놓은 기본 배치. */
function lineLayout(): Map<string, Vec3> {
  return new Map<string, Vec3>([
    ["a", { x: 0, y: 0, z: 0 }], ["b", { x: 5, y: 0, z: 0 }],
    ["c", { x: 10, y: 0, z: 0 }], ["d", { x: 15, y: 0, z: 0 }],
  ]);
}

/** 좌표 Map 안에서 절댓값이 가장 큰 성분. 발산 여부 판단용. */
function maxAbsComponent(positions: Map<string, Vec3>): number {
  let m = 0;
  for (const p of positions.values()) {
    m = Math.max(m, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  }
  return m;
}

/** 한 벡터의 크기. */
function mag(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** 이웃 집합의 속도 크기 합. 정착 임계 판정과 같은 척도. */
function velSum(velocities: Map<string, Vec3>, ids: Iterable<string>): number {
  let s = 0;
  for (const id of ids) {
    const v = velocities.get(id);
    if (v) s += mag(v);
  }
  return s;
}

/** 물리 스텝 기본 옵션(테마 시작값과 같은 척도). */
const physOpts = { spring: 0.1, damping: 0.82, maxStep: 1.5, maxVel: 0.6 };

describe("neighborsWithin", () => {
  it("1-hop 은 직접 이웃만", () => {
    expect([...neighborsWithin(edges, "a", 1)].sort()).toEqual(["b"]);
  });
  it("2-hop 은 두 단계까지(root 제외)", () => {
    expect([...neighborsWithin(edges, "a", 2)].sort()).toEqual(["b", "c"]);
  });
});

describe("relaxStep", () => {
  it("anchor 위치는 변하지 않고, 이웃 아닌 먼 노드도 불변", () => {
    const positions = lineLayout();
    const base = lineLayout();
    const anchorPos = { x: 2, y: 0, z: 0 };
    const next = relaxStep(
      "a", anchorPos, neighborsWithin(edges, "a", 1), positions, edges, 0.2, 1.5, base,
    );
    expect(next.get("a")).toEqual(anchorPos);            // anchor 고정
    expect(next.get("d")).toEqual({ x: 15, y: 0, z: 0 }); // 먼 노드 불변
    expect(next.get("b")!.x).not.toBe(5);                 // 이웃은 끌려옴
  });

  it("이미 자연 길이 평형이면 거의 안 움직인다(rest length 유지)", () => {
    // anchor 를 원래 위치 그대로 두면 모든 엣지가 자연 길이라 변위가 0 에 가깝다.
    const positions = lineLayout();
    const base = lineLayout();
    const anchorPos = { x: 0, y: 0, z: 0 }; // a 의 원래 위치
    const next = relaxStep(
      "a", anchorPos, neighborsWithin(edges, "a", 2), positions, edges, 0.3, 1.5, base,
    );
    expect(next.get("b")!.x).toBeCloseTo(5, 6);
    expect(next.get("c")!.x).toBeCloseTo(10, 6);
  });

  it("한 스텝 이웃 변위 크기는 maxStep 을 넘지 않는다(클램프)", () => {
    // anchor 를 멀리 끌면 큰 변위가 발생하려 하지만 maxStep 으로 잘린다.
    const positions = lineLayout();
    const base = lineLayout();
    const maxStep = 0.5;
    const before = positions.get("b")!;
    const anchorPos = { x: 200, y: 0, z: 0 }; // 아주 멀리
    const next = relaxStep(
      "a", anchorPos, neighborsWithin(edges, "a", 1), positions, edges, 0.9, maxStep, base,
    );
    const after = next.get("b")!;
    const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    expect(moved).toBeLessThanOrEqual(maxStep + 1e-9);
  });

  it("같은 위치(거리 0) 엣지가 있어도 NaN·발산이 없다", () => {
    // a 와 b 를 같은 좌표에 둬 단위벡터를 못 구하는 경우 — 그 엣지는 건너뛴다.
    const positions = new Map<string, Vec3>([
      ["a", { x: 0, y: 0, z: 0 }], ["b", { x: 0, y: 0, z: 0 }],
      ["c", { x: 10, y: 0, z: 0 }], ["d", { x: 15, y: 0, z: 0 }],
    ]);
    const base = lineLayout();
    const next = relaxStep(
      "a", { x: 0, y: 0, z: 0 }, neighborsWithin(edges, "a", 2), positions, edges, 0.3, 1.5, base,
    );
    for (const p of next.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it("같은 입력을 50회 반복해도 발산하지 않고 유한·수렴 범위에 머문다(핵심 회귀 가드)", () => {
    // 이번 버그의 핵심: 옛 구현은 반복하면 지수적으로 발산했다. rest-length 스프링+클램프로
    // anchor 를 고정 위치에 둔 채 반복하면 이웃이 자연 길이로 수렴해 폭발하지 않는다.
    let positions = lineLayout();
    const base = lineLayout();
    const neighbors = neighborsWithin(edges, "a", 2);
    // anchor 를 원래에서 조금 옮겨 둔 채 50번 완화 — 이웃이 새 평형을 향해 수렴해야 한다.
    const anchorPos = { x: 3, y: 0, z: 0 };
    for (let i = 0; i < 50; i++) {
      positions = relaxStep(
        "a", anchorPos, neighbors, positions, edges, 0.2, 1.5, base,
      );
      for (const p of positions.values()) {
        expect(Number.isFinite(p.x)).toBe(true);
      }
    }
    // 모든 좌표 절댓값이 합리적 상한 안에 머문다(원래 배치 최대 15 근처 + 약간의 이동).
    expect(maxAbsComponent(positions)).toBeLessThan(40);
  });
});

describe("relaxStepPhysics", () => {
  const settleThreshold = 0.004;

  it("anchor 고정·이웃 아닌 먼 노드는 위치·속도 모두 불변", () => {
    const positions = lineLayout();
    const base = lineLayout();
    const velocities = new Map<string, Vec3>();
    const anchorPos = { x: 2, y: 0, z: 0 };
    const { positions: p2, velocities: v2 } = relaxStepPhysics(
      "a", anchorPos, neighborsWithin(edges, "a", 1), positions, velocities, edges, base, physOpts,
    );
    expect(p2.get("a")).toEqual(anchorPos);              // anchor 고정
    expect(p2.get("d")).toEqual({ x: 15, y: 0, z: 0 });   // 먼 노드 위치 불변
    expect(v2.get("d")).toBeUndefined();                  // 먼 노드 속도 안 생김
    expect(p2.get("b")!.x).not.toBe(5);                   // 이웃은 끌려옴
  });

  it("외력 없이 속도만 있으면 한 스텝 뒤 크기가 damping 배 이하로 준다(감쇠 검증)", () => {
    // anchor 를 원래 위치에 두면 모든 엣지가 자연 길이라 스프링 힘이 0 — 속도만 damping 으로 준다.
    const positions = lineLayout();
    const base = lineLayout();
    const velocities = new Map<string, Vec3>([["b", { x: 0.3, y: 0, z: 0 }]]);
    const v0 = mag(velocities.get("b")!);
    const { velocities: v2 } = relaxStepPhysics(
      "a", { x: 0, y: 0, z: 0 }, neighborsWithin(edges, "a", 1), positions, velocities, edges, base, physOpts,
    );
    const v1 = mag(v2.get("b")!);
    expect(v1).toBeLessThanOrEqual(v0 * physOpts.damping + 1e-9);
  });

  it("초기 변위를 준 뒤 anchor 고정·반복하면 속도가 임계 이하로 수렴한다(관성 후 멈춤·핵심 회귀 가드)", () => {
    // anchor 를 옮긴 자리에 고정하고 굴리면 이웃이 관성으로 더 다가가다 감쇠로 멈춘다.
    let positions = lineLayout();
    let velocities = new Map<string, Vec3>();
    const base = lineLayout();
    const neighbors = neighborsWithin(edges, "a", 2);
    const anchorPos = { x: 3, y: 0, z: 0 }; // a 를 옮긴 자리에 고정

    let lastVelSum = Infinity;
    for (let i = 0; i < 120; i++) {
      const out = relaxStepPhysics(
        "a", anchorPos, neighbors, positions, velocities, edges, base, physOpts,
      );
      positions = out.positions;
      velocities = out.velocities;
      for (const p of positions.values()) expect(Number.isFinite(p.x)).toBe(true);
      lastVelSum = velSum(velocities, neighbors);
    }
    // 120프레임 뒤 이웃 속도 합이 정착 임계 이하 — 관성 다 빠지고 멈춤.
    expect(lastVelSum).toBeLessThan(settleThreshold);
  });

  it("anchor 를 아주 멀리 둬도 좌표·속도가 폭발하지 않는다(클램프·damping)", () => {
    let positions = lineLayout();
    let velocities = new Map<string, Vec3>();
    const base = lineLayout();
    const neighbors = neighborsWithin(edges, "a", 2);
    const anchorPos = { x: 500, y: 0, z: 0 }; // 아주 멀리
    for (let i = 0; i < 60; i++) {
      const out = relaxStepPhysics(
        "a", anchorPos, neighbors, positions, velocities, edges, base, physOpts,
      );
      positions = out.positions;
      velocities = out.velocities;
      for (const v of velocities.values()) {
        // 속도는 매 스텝 maxVel 로 클램프된다.
        expect(mag(v)).toBeLessThanOrEqual(physOpts.maxVel + 1e-9);
        expect(Number.isFinite(v.x)).toBe(true);
      }
    }
    // anchor 가 멀어도 한 스텝 위치 변화가 maxStep 으로 잘려 좌표가 유한·합리 범위에 머문다.
    for (const p of positions.values()) expect(Number.isFinite(p.x)).toBe(true);
  });

  it("같은 위치(거리 0) 엣지가 있어도 NaN·발산이 없다", () => {
    const positions = new Map<string, Vec3>([
      ["a", { x: 0, y: 0, z: 0 }], ["b", { x: 0, y: 0, z: 0 }],
      ["c", { x: 10, y: 0, z: 0 }], ["d", { x: 15, y: 0, z: 0 }],
    ]);
    const base = lineLayout();
    const { positions: p2, velocities: v2 } = relaxStepPhysics(
      "a", { x: 0, y: 0, z: 0 }, neighborsWithin(edges, "a", 2), positions, new Map(), edges, base, physOpts,
    );
    for (const p of p2.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
    for (const v of v2.values()) expect(Number.isFinite(v.x)).toBe(true);
  });
});

/** 느슨한 줄(slack rope) + 무게 + 최소거리 보정 테스트. */
describe("relaxStepPhysics — radii(느슨한 줄+무게+최소거리)", () => {
  /** 슬랙 옵션: physOpts 에 세 슬랙 파라미터 추가. */
  const slackOpts = {
    ...{ spring: 0.1, damping: 0.82, maxStep: 1.5, maxVel: 0.6 },
    slackFactor: 1.6,
    pullSpring: 0.08,
    collisionStrength: 0.6,
  };

  // 테스트용 엣지: anchor("anc") — small("s") / anchor("anc") — big("b")
  const twoEdges: GraphEdge[] = [
    { id: "e-s", from: "anc", to: "s", type: "memory_link", weight: 1 } as GraphEdge,
    { id: "e-b", from: "anc", to: "b", type: "memory_link", weight: 1 } as GraphEdge,
  ];

  it("무게 차등: 큰 이웃이 작은 이웃보다 덜 끌린다", () => {
    // anchor 를 원점에서 시작해 base 를 현재 좌표로 설정한다(자연길이=현재거리).
    // 그 뒤 anchor 를 멀리(-8,-8,0) 끌어서 두 이웃 모두 maxDist 너머로 만든다.
    const smallRadius = 0.5;
    const bigRadius = 2.0;
    const smallPos: Vec3 = { x: 5, y: 0, z: 0 };
    const bigPos: Vec3 = { x: 0, y: 5, z: 0 };
    const anchorStart: Vec3 = { x: 0, y: 0, z: 0 };

    const positions = new Map<string, Vec3>([
      ["anc", { ...anchorStart }],
      ["s", { ...smallPos }],
      ["b", { ...bigPos }],
    ]);
    // basePositions = 시작 좌표(자연길이 = 현재거리).
    const base = new Map<string, Vec3>(positions);

    // anchor 를 멀리 끌어 양쪽 줄 모두 팽팽하게 만든다.
    const anchorFar: Vec3 = { x: -8, y: -8, z: 0 };
    const velocities = new Map<string, Vec3>();
    const neighbors = new Set(["s", "b"]);
    const radii = new Map([
      ["anc", smallRadius],
      ["s", smallRadius],
      ["b", bigRadius],
    ]);

    const { positions: p2 } = relaxStepPhysics(
      "anc", anchorFar, neighbors, positions, velocities, twoEdges, base, slackOpts, radii,
    );

    // 각 이웃이 anchor 방향(원점→anchorFar)으로 얼마나 이동했는지 확인.
    const movedSmall = Math.hypot(
      p2.get("s")!.x - smallPos.x,
      p2.get("s")!.y - smallPos.y,
      p2.get("s")!.z - smallPos.z,
    );
    const movedBig = Math.hypot(
      p2.get("b")!.x - bigPos.x,
      p2.get("b")!.y - bigPos.y,
      p2.get("b")!.z - bigPos.z,
    );

    // 작은(가벼운) 이웃이 더 많이 이동해야 한다.
    expect(movedSmall).toBeGreaterThan(movedBig);
  });

  it("최소거리 이하면 떼어낸다", () => {
    // anchor 와 이웃 "a" 가 거의 겹쳐 있어(x=0.1) minGap 보다 훨씬 가깝다.
    const r = 0.5;
    const positions = new Map<string, Vec3>([
      ["anc", { x: 0, y: 0, z: 0 }],
      ["a", { x: 0.1, y: 0, z: 0 }],
    ]);
    const base = new Map<string, Vec3>(positions);
    const velocities = new Map<string, Vec3>();
    const neighbors = new Set(["a"]);
    const singleEdge: GraphEdge[] = [
      { id: "ea", from: "anc", to: "a", type: "memory_link", weight: 1 } as GraphEdge,
    ];
    const radii = new Map([["anc", r], ["a", r]]);

    const { positions: p2 } = relaxStepPhysics(
      "anc", { x: 0, y: 0, z: 0 }, neighbors, positions, velocities, singleEdge, base, slackOpts, radii,
    );

    const dist = Math.abs(p2.get("a")!.x);
    // 한 스텝 뒤 anchor 와 "a" 사이 거리가 초기값(0.1) 보다 커져야 한다.
    expect(dist).toBeGreaterThan(0.1);
  });

  it("radii 미전달 시 기존 자연 길이 동작 유지", () => {
    // radii 없이 호출 — 기존 자연길이 스프링 경로(기존 테스트와 동일 형태).
    const positions = lineLayout();
    const base = lineLayout();
    const velocities = new Map<string, Vec3>();
    const anchorPos = { x: 2, y: 0, z: 0 };
    const result = relaxStepPhysics(
      "a", anchorPos, neighborsWithin(edges, "a", 1), positions, velocities, edges, base,
      { spring: 0.1, damping: 0.82, maxStep: 1.5, maxVel: 0.6 },
      // radii 파라미터 생략
    );
    // 크래시 없이 정의된 결과를 돌려줘야 한다.
    expect(result).toBeDefined();
    expect(result.positions).toBeInstanceOf(Map);
    expect(result.velocities).toBeInstanceOf(Map);
    for (const p of result.positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
    }
  });
});

/**
 * 정착 이징(settle ease) 로직 단위 테스트.
 *
 * graph-controller.ts 의 tickDrag 정착 분기에서 적용하는 이징 수식을 직접 검증한다.
 * WebGL 의존 없이 순수 계산만 다루므로 단위 테스트로 충분하다.
 *
 * 수식: t = min(1, dragSettleFrames / settleEaseFrames)
 *       easedCollision = collisionStrength * t
 */
describe("정착 이징 수식 — easedCollision 단위 검증", () => {
  const { collisionStrength, settleEaseFrames } = GRAPH_RENDER_THEME.dragRelax;

  function easedCollision(dragSettleFrames: number): number {
    const t = Math.min(1, dragSettleFrames / settleEaseFrames);
    return collisionStrength * t;
  }

  it("정착 시작(frame 0)에서 collisionStrength 는 0 이다", () => {
    expect(easedCollision(0)).toBe(0);
  });

  it("이징 구간 절반(settleEaseFrames / 2)에서 절반 강도다", () => {
    const half = settleEaseFrames / 2;
    expect(easedCollision(half)).toBeCloseTo(collisionStrength * 0.5, 9);
  });

  it("settleEaseFrames 에 도달하면 전체 collisionStrength 와 같다", () => {
    expect(easedCollision(settleEaseFrames)).toBeCloseTo(collisionStrength, 9);
  });

  it("settleEaseFrames 를 초과해도 전체 collisionStrength 를 넘지 않는다(상한 고정)", () => {
    expect(easedCollision(settleEaseFrames + 100)).toBeCloseTo(collisionStrength, 9);
  });

  it("모든 프레임에서 easedCollision 이 단조 증가한다(역행 없음)", () => {
    // 0 부터 settleEaseFrames + 5 까지 매 프레임 값이 이전보다 작아지지 않는다.
    let prev = easedCollision(0);
    for (let f = 1; f <= settleEaseFrames + 5; f++) {
      const cur = easedCollision(f);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
  });

  it("정착 단계에서 settleMaxStep 이 maxStep 보다 작다(한 프레임 이동 제한 확인)", () => {
    const { maxStep, settleMaxStep } = GRAPH_RENDER_THEME.dragRelax;
    expect(settleMaxStep).toBeLessThan(maxStep);
  });

  it("정착 단계에서 settleMaxVel 이 maxVel 보다 작다(속도 제한 확인)", () => {
    const { maxVel, settleMaxVel } = GRAPH_RENDER_THEME.dragRelax;
    expect(settleMaxVel).toBeLessThan(maxVel);
  });
});
