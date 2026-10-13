import { describe, expect, test } from "bun:test";
import {
  collapseExpansionKeysForNode,
  expansionDescendantNodeIdsForKeys,
  expansionKeyForGraphNode,
} from "./derived-expansion";
import type { DashboardGraphViewModel, GraphEdge, GraphNode } from "./graph-view-model";

describe("derived expansion state", () => {
  test("원본 노드의 sourceId 로 overview expand 키를 만든다", () => {
    expect(expansionKeyForGraphNode(node("node:1", "memory", 1))).toBe("node:1");
    expect(expansionKeyForGraphNode(node("document:doc", "document"))).toBeNull();
  });

  test("원본을 닫으면 그 원본의 expand 키를 접는다", () => {
    const vm = makeVm(
      [
        node("node:1", "memory", 1),
        node("node:2", "llm_extract", 2),
      ],
      [edge("node:2", "node:1", "merged_into")],
    );

    expect([...collapseExpansionKeysForNode(vm, "node:1", new Set(["node:1"]))]).toEqual([
      "node:1",
    ]);
  });

  test("파생 노드를 닫아도 연결된 원본 expand 키를 접는다", () => {
    const vm = makeVm(
      [
        node("node:10", "memory", 10),
        node("node:11", "document_chunk", 11),
      ],
      [edge("node:11", "node:10", "parent_of")],
    );

    expect([...collapseExpansionKeysForNode(vm, "node:11", new Set(["node:10"]))]).toEqual([
      "node:10",
    ]);
  });

  test("문서 구간을 사이에 둔 청크도 문서 원본 expand 키로 접는다", () => {
    const vm = makeVm(
      [
        node("node:20", "document", 20),
        node("section:20:0", "document_section"),
        node("node:21", "document_chunk", 21),
      ],
      [
        edge("node:20", "section:20:0", "contains_section"),
        edge("section:20:0", "node:21", "contains_chunk"),
      ],
    );

    const expanded = new Set(["node:20"]);
    expect([...collapseExpansionKeysForNode(vm, "node:21", expanded)]).toEqual(["node:20"]);
    expect([...expansionDescendantNodeIdsForKeys(vm, expanded)].sort()).toEqual([
      "node:21",
      "section:20:0",
    ]);
  });

  test("일반 parent_of 위계는 파생 펼침 자식으로 닫지 않는다", () => {
    const vm = makeVm(
      [
        node("node:30", "memory", 30),
        node("concept:a", "concept"),
      ],
      [edge("node:30", "concept:a", "parent_of")],
    );

    expect([...expansionDescendantNodeIdsForKeys(vm, new Set(["node:30"]))]).toEqual([]);
    expect([...collapseExpansionKeysForNode(vm, "concept:a", new Set(["node:30"]))]).toEqual([]);
  });
});

function makeVm(nodes: GraphNode[], edges: GraphEdge[] = []): DashboardGraphViewModel {
  return {
    nodes,
    edges,
    clusters: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length },
    recent: [],
  };
}

function node(id: string, type: GraphNode["type"], sourceId?: number): GraphNode {
  return {
    id,
    type,
    label: id,
    ...(sourceId !== undefined ? { sourceId, sourceType: type } : {}),
  };
}

function edge(from: string, to: string, type: string): GraphEdge {
  return { id: `edge:${from}->${to}:${type}`, from, to, type };
}
