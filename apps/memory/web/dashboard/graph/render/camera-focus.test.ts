import { test, expect } from "bun:test";
import {
  boundingBoxCenter,
  boundingCenter,
  boundingSize,
  easeInOutCubic,
  cameraPoseForNodes,
  cameraPoseForOverview,
} from "./camera-focus";

test("easeInOutCubic 경계", () => {
  expect(easeInOutCubic(0)).toBe(0);
  expect(easeInOutCubic(1)).toBe(1);
  expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5);
});

test("easeInOutCubic 단조 증가", () => {
  let prev = 0;
  for (let i = 1; i <= 100; i++) {
    const cur = easeInOutCubic(i / 100);
    expect(cur).toBeGreaterThanOrEqual(prev);
    prev = cur;
  }
});

test("boundingCenter — 점들의 중심", () => {
  expect(boundingCenter([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }])).toEqual({ x: 1, y: 0, z: 0 });
});

test("boundingCenter — 단일 점", () => {
  expect(boundingCenter([{ x: 3, y: 5, z: 7 }])).toEqual({ x: 3, y: 5, z: 7 });
});

test("boundingCenter — 3점 평균", () => {
  const c = boundingCenter([{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }]);
  expect(c.x).toBeCloseTo(1, 5);
  expect(c.y).toBeCloseTo(1, 5);
  expect(c.z).toBeCloseTo(0, 5);
});

test("boundingBoxCenter — 치우친 점 분포도 경계 박스 가운데를 돌려준다", () => {
  const c = boundingBoxCenter([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ]);
  expect(c).toEqual({ x: 5, y: 0, z: 0 });
});

test("boundingSize — 두 끝 대각선 거리", () => {
  const s = boundingSize([{ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }]);
  expect(s).toBeCloseTo(5, 5);
});

test("boundingSize — 빈 배열", () => {
  expect(boundingSize([])).toBe(0);
});

test("cameraPoseForNodes — target=중심, position 거리 clamp", () => {
  const pose = cameraPoseForNodes([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], { x: 0, y: 0, z: 1 });
  expect(pose).not.toBeNull();
  expect(pose!.target).toEqual({ x: 0.5, y: 0, z: 0 });
  const d = Math.hypot(pose!.position.x - 0.5, pose!.position.y, pose!.position.z);
  expect(d).toBeGreaterThanOrEqual(8);
  expect(d).toBeLessThanOrEqual(18);
});

test("cameraPoseForNodes — 거리 하한 clamp (점 간격 0)", () => {
  const p = { x: 5, y: 5, z: 5 };
  const pose = cameraPoseForNodes([p, p], { x: 0, y: 0, z: 1 });
  expect(pose).not.toBeNull();
  const d = Math.hypot(
    pose!.position.x - p.x,
    pose!.position.y - p.y,
    pose!.position.z - p.z,
  );
  expect(d).toBeCloseTo(8, 3);
});

test("cameraPoseForNodes — 거리 상한 clamp (점 간격 매우 큼)", () => {
  const pose = cameraPoseForNodes(
    [{ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }],
    { x: 0, y: 0, z: 1 },
  );
  expect(pose).not.toBeNull();
  const d = Math.hypot(
    pose!.position.x - 0,
    pose!.position.y - 0,
    pose!.position.z - 0,
  );
  expect(d).toBeCloseTo(18, 3);
});

test("cameraPoseForNodes — currentDir 길이 ~0 이면 기본 방향 사용", () => {
  const pose = cameraPoseForNodes([{ x: 0, y: 0, z: 0 }], { x: 0, y: 0, z: 0 });
  expect(pose).not.toBeNull();
  // 기본 방향 (0, 0.08, 1) 정규화 → z 성분이 양수여야 함
  const diff = {
    x: pose!.position.x - pose!.target.x,
    y: pose!.position.y - pose!.target.y,
    z: pose!.position.z - pose!.target.z,
  };
  expect(diff.z).toBeGreaterThan(0);
});

test("빈 배열 → null", () => {
  expect(cameraPoseForNodes([], { x: 0, y: 0, z: 1 })).toBeNull();
});

test("cameraPoseForOverview — 넓게 퍼진 점들은 18보다 멀리 물러난다", () => {
  // x ±20·y ±15 로 흩어진 점들 — 전체 조망은 18 상한을 넘어 더 멀어져야 한다.
  const points = [
    { x: -20, y: -15, z: 0 },
    { x: 20, y: -15, z: 0 },
    { x: -20, y: 15, z: 0 },
    { x: 20, y: 15, z: 0 },
  ];
  const pose = cameraPoseForOverview(points, { x: 0, y: 0, z: 1 });
  expect(pose).not.toBeNull();
  const d = Math.hypot(
    pose!.position.x - pose!.target.x,
    pose!.position.y - pose!.target.y,
    pose!.position.z - pose!.target.z,
  );
  expect(d).toBeGreaterThan(18);
});

test("cameraPoseForOverview — 접속 기본 화면 최소 거리 30", () => {
  const p = { x: 5, y: 5, z: 5 };
  const pose = cameraPoseForOverview([p, p], { x: 0, y: 0, z: 1 });
  expect(pose).not.toBeNull();
  const d = Math.hypot(
    pose!.position.x - p.x,
    pose!.position.y - p.y,
    pose!.position.z - p.z,
  );
  expect(d).toBeCloseTo(30, 3);
});

test("cameraPoseForOverview — 평균이 아니라 경계 박스 중심을 본다", () => {
  const pose = cameraPoseForOverview([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ], { x: 0, y: 0, z: 1 });
  expect(pose?.target).toEqual({ x: 5, y: 0, z: 0 });
});

test("cameraPoseForOverview — 거리 상한 60", () => {
  // 극단으로 흩어진 점들도 상한 60 을 넘지 않는다.
  const pose = cameraPoseForOverview(
    [{ x: -500, y: 0, z: 0 }, { x: 500, y: 0, z: 0 }],
    { x: 0, y: 0, z: 1 },
  );
  expect(pose).not.toBeNull();
  const d = Math.hypot(
    pose!.position.x - pose!.target.x,
    pose!.position.y - pose!.target.y,
    pose!.position.z - pose!.target.z,
  );
  expect(d).toBeCloseTo(60, 3);
});

test("cameraPoseForOverview — 빈 배열 → null", () => {
  expect(cameraPoseForOverview([], { x: 0, y: 0, z: 1 })).toBeNull();
});
