import { describe, it, expect } from "bun:test";
import { diffGraph, edgeKey } from "./graph-diff.ts";
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";

const n = (id: string): GraphNode => ({ id, type: "concept", label: id } as GraphNode);
const e = (from: string, to: string, type = "memory_link"): GraphEdge =>
  ({ from, to, type } as GraphEdge);

describe("diffGraph", () => {
  it("빈→일부는 전부 added", () => {
    const d = diffGraph([], [], [n("a"), n("b")], [e("a", "b")]);
    expect(d.addedNodeIds.sort()).toEqual(["a", "b"]);
    expect(d.removedNodeIds).toEqual([]);
    expect(d.keptNodeIds).toEqual([]);
    expect(d.addedEdgeKeys).toEqual([edgeKey(e("a", "b"))]);
  });

  it("일부→빈은 전부 removed", () => {
    const d = diffGraph([n("a")], [e("a", "a")], [], []);
    expect(d.removedNodeIds).toEqual(["a"]);
    expect(d.removedEdgeKeys).toEqual([edgeKey(e("a", "a"))]);
  });

  it("교집합은 kept, 차집합은 add/remove", () => {
    const d = diffGraph(
      [n("a"), n("b")], [e("a", "b")],
      [n("b"), n("c")], [e("b", "c")],
    );
    expect(d.keptNodeIds).toEqual(["b"]);
    expect(d.addedNodeIds).toEqual(["c"]);
    expect(d.removedNodeIds).toEqual(["a"]);
    expect(d.addedEdgeKeys).toEqual([edgeKey(e("b", "c"))]);
    expect(d.removedEdgeKeys).toEqual([edgeKey(e("a", "b"))]);
  });

  it("같은 from·to라도 type 다르면 다른 엣지", () => {
    const d = diffGraph([n("a"), n("b")], [e("a", "b", "memory_link")],
                        [n("a"), n("b")], [e("a", "b", "created_by")]);
    expect(d.addedEdgeKeys).toEqual([edgeKey(e("a", "b", "created_by"))]);
    expect(d.removedEdgeKeys).toEqual([edgeKey(e("a", "b", "memory_link"))]);
  });
});
