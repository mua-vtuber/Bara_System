import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode } from "../graph-view-model.ts";
import { diffGraph } from "./graph-diff.ts";
import { classifyReflowMode } from "./reflow-mode.ts";

function node(id: string, type: GraphNode["type"] = "memory", groupType?: string): GraphNode {
  return { id, type, groupType, label: id };
}

function edge(from: string, to: string, type = "member_of"): GraphEdge {
  return { id: `${from}->${to}:${type}`, from, to, type };
}

describe("classifyReflowMode", () => {
  test("기존 묶음 안에 적은 수의 노드가 추가되면 local", () => {
    const prevNodes = [node("group:work", "entity_group", "work"), node("work:a", "work")];
    const prevEdges = [edge("group:work", "work:a")];
    const nextNodes = [...prevNodes, node("work:b", "work")];
    const nextEdges = [...prevEdges, edge("group:work", "work:b")];
    const diff = diffGraph(prevNodes, prevEdges, nextNodes, nextEdges);

    expect(classifyReflowMode(diff, prevNodes, prevEdges, nextNodes, nextEdges)).toBe("local");
  });

  test("새 entity_group 이 생기면 global", () => {
    const prevNodes = [node("group:work", "entity_group", "work"), node("work:a", "work")];
    const prevEdges = [edge("group:work", "work:a")];
    const nextNodes = [...prevNodes, node("group:place", "entity_group", "place")];
    const nextEdges = [...prevEdges];
    const diff = diffGraph(prevNodes, prevEdges, nextNodes, nextEdges);

    expect(classifyReflowMode(diff, prevNodes, prevEdges, nextNodes, nextEdges)).toBe("global");
  });

  test("새 classification_key 가 생기면 global", () => {
    const prevNodes = [node("concept:root", "concept")];
    const prevEdges: GraphEdge[] = [];
    const nextNodes = [...prevNodes, node("classification:kind:novel", "classification_key")];
    const nextEdges = [edge("concept:root", "classification:kind:novel", "parent_of")];
    const diff = diffGraph(prevNodes, prevEdges, nextNodes, nextEdges);

    expect(classifyReflowMode(diff, prevNodes, prevEdges, nextNodes, nextEdges)).toBe("global");
  });

  test("추가 노드가 많으면 global", () => {
    const prevNodes = [node("group:work", "entity_group", "work")];
    const prevEdges: GraphEdge[] = [];
    const nextNodes = [
      ...prevNodes,
      ...Array.from({ length: 9 }, (_, i) => node(`work:${i}`, "work")),
    ];
    const nextEdges = nextNodes
      .filter((n) => n.id.startsWith("work:"))
      .map((n) => edge("group:work", n.id));
    const diff = diffGraph(prevNodes, prevEdges, nextNodes, nextEdges);

    expect(classifyReflowMode(diff, prevNodes, prevEdges, nextNodes, nextEdges)).toBe("global");
  });
});
