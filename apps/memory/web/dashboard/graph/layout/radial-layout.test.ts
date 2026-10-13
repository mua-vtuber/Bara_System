import { test, expect } from "bun:test";
import { computeRadialLayout } from "./radial-layout.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";

const T = GRAPH_RENDER_THEME.radialLayout;
const N = (id: string, type: string): GraphNode => ({ id, type: type as GraphNode["type"], label: id });
const E = (from: string, to: string, type: string): GraphEdge => ({ id: `${from}->${to}`, from, to, type });
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
const dir = (v: { x: number; y: number; z: number }) => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const sub = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => len(sub(a, b));
const angleBetween = (u: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }) => {
  const a = dir(u), b = dir(v);
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
};

/**
 * group:project 아래 형제 두 가지. 둘 다 직접 자식 2개라 손주가 퍼지는 콘 폭을 형제 간 비교할 수 있다.
 *   project:a = 무성한 가지: 자식 a1·a2, a1 이 다시 손주 2개 → 자손 잎 3
 *   project:b = 단출한 가지: 자식 b1·b2 둘 다 잎     → 자손 잎 2
 * 재귀 콘 분할에서 자식 콘 = 부모 콘 × sqrt(자기 잎/형제 총 잎) 이므로,
 * 자손 잎이 많은 형제(a)가 더 넓은 콘을 받아 그 자식들이 headDir 둘레로 더 넓게 퍼진다.
 */
function tree(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    N("group:project", "entity_group"),
    N("project:a", "project"), N("project:b", "project"),
    N("a1", "memory"), N("a2", "memory"),
    N("a1g1", "memory"), N("a1g2", "memory"),
    N("b1", "memory"), N("b2", "memory"),
  ];
  const edges = [
    E("group:project", "project:a", "member_of"), E("group:project", "project:b", "member_of"),
    E("project:a", "a1", "owns_memory"), E("project:a", "a2", "owns_memory"),
    E("a1", "a1g1", "owns_memory"), E("a1", "a1g2", "owns_memory"),
    E("project:b", "b1", "owns_memory"), E("project:b", "b2", "owns_memory"),
  ];
  return { nodes, edges };
}

test("깊이가 클수록 중심에서 멀다", () => {
  const { nodes, edges } = tree();
  const p = computeRadialLayout(nodes, edges, T);
  const center = p.get("group:project")!;
  expect(dist(p.get("project:a")!, center)).toBeGreaterThan(0);
  expect(dist(p.get("a1")!, center)).toBeGreaterThan(dist(p.get("project:a")!, center));
  expect(dist(p.get("a1g1")!, center)).toBeGreaterThan(dist(p.get("a1")!, center));
});

test("entity_group 직접 자식은 전역 바깥 방향이 아니라 그룹 중심을 둘러싼다", () => {
  const { nodes, edges } = tree();
  const p = computeRadialLayout(nodes, edges, T);
  const root = p.get("group:project")!;
  const aDir = sub(p.get("project:a")!, root);
  const bDir = sub(p.get("project:b")!, root);
  expect(len(aDir)).toBeGreaterThan(T.depthStep);
  expect(len(bDir)).toBeGreaterThan(T.depthStep);
  expect(angleBetween(aDir, bDir)).toBeGreaterThan(0.75);
});

test("무성한 형제가 더 넓은 콘을 받아 자식이 더 벌어진다", () => {
  const { nodes, edges } = tree();
  const p = computeRadialLayout(nodes, edges, T);
  // 형제의 headDir = (형제 − 그 부모) 방향. 그 형제가 받은 콘은 자식들이
  // headDir 둘레로 벌어진 최대 각으로 드러난다.
  const maxChildRho = (parent: string, kids: string[]) => {
    const head = sub(p.get(parent)!, p.get("group:project")!);
    return Math.max(...kids.map((k) => angleBetween(sub(p.get(k)!, p.get(parent)!), head)));
  };
  // project:a(자손 잎 3) > project:b(자손 잎 2). 자손 잎이 많은 형제의 콘이 더 넓어야 한다.
  // 잎수 비례가 죽어(두 콘이 같아지면) 이 단정이 실패한다 — 핀이 단단하다.
  const bushy = maxChildRho("project:a", ["a1", "a2"]);
  const sparse = maxChildRho("project:b", ["b1", "b2"]);
  expect(bushy).toBeGreaterThan(sparse);
});

test("결정적 — 두 번 같은 좌표", () => {
  const { nodes, edges } = tree();
  const a = computeRadialLayout(nodes, edges, T);
  const b = computeRadialLayout(nodes, edges, T);
  for (const id of a.keys()) expect(b.get(id)).toEqual(a.get(id)!);
});

test("묶음 구체끼리는 각 묶음의 실제 펼침 반지름보다 멀리 떨어진다", () => {
  const { nodes, edges } = tree();
  const allNodes = [
    ...nodes,
    N("group:person", "entity_group"),
    N("person:p", "person"),
  ];
  const allEdges = [
    ...edges,
    E("group:person", "person:p", "member_of"),
  ];
  const p = computeRadialLayout(allNodes, allEdges, T);
  const projectCenter = p.get("group:project")!;
  const personCenter = p.get("group:person")!;
  const projectExtent = Math.max(
    ...["project:a", "project:b", "a1", "a2", "a1g1", "a1g2", "b1", "b2"]
      .map((id) => dist(p.get(id)!, projectCenter)),
  );
  const personExtent = dist(p.get("person:p")!, personCenter);
  expect(dist(projectCenter, personCenter)).toBeGreaterThan(projectExtent + personExtent + T.entityClusterGap * 0.75);
});

test("외톨이 글은 바깥 껍질 근처", () => {
  const nodes = [N("node:x", "memory")];
  const p = computeRadialLayout(nodes, [], T);
  expect(len(p.get("node:x")!)).toBeGreaterThan(T.rootSphereRadius);
});
