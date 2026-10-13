import { test, expect } from "bun:test";
import { resolveNodeStates, resolveEdgeStates } from "./highlight";
import type { GraphNode, GraphEdge, GraphSearchView } from "../graph-view-model";

const nodes: GraphNode[] = [
  { id: "a", type: "memory", label: "a" },
  { id: "b", type: "memory", label: "b" },
  { id: "c", type: "memory", label: "c" },
];
const edges: GraphEdge[] = [{ id: "ab", from: "a", to: "b", type: "x" }];

const makeSearch = (nodeIds: string[], edgeIds: string[]): GraphSearchView => ({
  query: "test",
  count: 1,
  top3: [],
  hits: [],
  highlightedNodeIds: nodeIds,
  highlightedEdgeIds: edgeIds,
});

test("search 없으면 모두 neutral", () => {
  const s = resolveNodeStates(nodes, edges, undefined);
  expect([...s.values()].every((v) => v === "neutral")).toBe(true);
});

test("search 없으면 노드 수만큼 항목 존재", () => {
  const s = resolveNodeStates(nodes, edges, undefined);
  expect(s.size).toBe(nodes.length);
});

test("hit / related / dim 구분", () => {
  const search = makeSearch(["a"], ["ab"]);
  const s = resolveNodeStates(nodes, edges, search);
  expect(s.get("a")).toBe("hit");
  expect(s.get("b")).toBe("related");
  expect(s.get("c")).toBe("dim");
});

test("hit 쪽에서만 이웃 탐색 (to→from 방향)", () => {
  // b가 hit이면 a(from)도 related
  const search = makeSearch(["b"], ["ab"]);
  const s = resolveNodeStates(nodes, edges, search);
  expect(s.get("b")).toBe("hit");
  expect(s.get("a")).toBe("related");
  expect(s.get("c")).toBe("dim");
});

test("hit 노드가 없으면 모두 dim", () => {
  const search = makeSearch([], []);
  const s = resolveNodeStates(nodes, edges, search);
  expect([...s.values()].every((v) => v === "dim")).toBe(true);
});

test("hit 와 related 동시 해당이면 hit 우선", () => {
  // a와 b 둘 다 hit — b가 a의 이웃이지만 hit로 표시
  const search = makeSearch(["a", "b"], ["ab"]);
  const s = resolveNodeStates(nodes, edges, search);
  expect(s.get("a")).toBe("hit");
  expect(s.get("b")).toBe("hit");
  expect(s.get("c")).toBe("dim");
});

test("resolveEdgeStates search·상호작용 없으면 모두 ambient", () => {
  const none = resolveEdgeStates(edges, undefined);
  expect(none.get("ab")).toBe("ambient");
});

test("resolveEdgeStates 검색 highlight 는 focus", () => {
  const search = makeSearch(["a"], ["ab"]);
  const e = resolveEdgeStates(edges, search);
  expect(e.get("ab")).toBe("focus");
});

test("resolveEdgeStates highlightedEdgeIds 에 없으면 dim", () => {
  const extraEdges: GraphEdge[] = [
    { id: "ab", from: "a", to: "b", type: "x" },
    { id: "bc", from: "b", to: "c", type: "x" },
  ];
  const search = makeSearch(["a"], ["ab"]);
  const e = resolveEdgeStates(extraEdges, search);
  expect(e.get("ab")).toBe("focus");
  expect(e.get("bc")).toBe("dim");
});

test("resolveEdgeStates 결과 크기는 엣지 수와 동일", () => {
  const none = resolveEdgeStates(edges, undefined);
  expect(none.size).toBe(edges.length);
});

test("resolveEdgeStates hoveredId 에 직접 닿은 엣지만 focus", () => {
  const extraEdges: GraphEdge[] = [
    { id: "ab", from: "a", to: "b", type: "x" },
    { id: "cd", from: "c", to: "d", type: "x" },
  ];
  const e = resolveEdgeStates(extraEdges, undefined, { hoveredId: "a" });
  expect(e.get("ab")).toBe("focus");
  expect(e.get("cd")).toBe("ambient");
});

test("resolveEdgeStates selectedId 는 검색 밖 incident edge 도 focus 로 올린다", () => {
  const extraEdges: GraphEdge[] = [
    { id: "ab", from: "a", to: "b", type: "x" },
    { id: "bc", from: "b", to: "c", type: "x" },
    { id: "cd", from: "c", to: "d", type: "x" },
  ];
  const search = makeSearch(["a"], ["ab"]);
  const e = resolveEdgeStates(extraEdges, search, { selectedId: "c" });
  expect(e.get("ab")).toBe("focus");
  expect(e.get("bc")).toBe("focus");
  expect(e.get("cd")).toBe("focus");
});
