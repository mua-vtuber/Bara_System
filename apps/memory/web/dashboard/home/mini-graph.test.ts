import { describe, expect, test } from "bun:test";
import { registerHappyDom } from "../test-happy-dom.ts";
import { renderMiniGraph } from "./mini-graph.ts";
import type { GraphEdge, GraphNode } from "../graph/graph-view-model.ts";

registerHappyDom();

function node(id: string, importance = 0): GraphNode {
  return { id, type: "memory", label: `메모 ${id}`, importance };
}

function edge(from: string, to: string, index: number, weight = 0.5): GraphEdge {
  return { id: `edge:${index}`, from, to, type: "related_to", weight };
}

describe("renderMiniGraph — dashboard mini graph density", () => {
  test("overview 는 라벨을 5개 이하로 줄이고 점·선을 얇게 그린다", () => {
    const host = document.createElement("div");
    const nodes = Array.from({ length: 24 }, (_, i) => node(`node:${i}`, i === 0 ? 1 : 0));
    const edges = nodes.slice(1).map((n, i) => edge("node:0", n.id, i, i / 20));

    renderMiniGraph(host, {
      overview: { nodes, edges },
      selection: { kind: "none" },
      onPickNode: () => undefined,
    });

    expect(host.querySelectorAll(".mini-graph__label").length).toBeLessThanOrEqual(5);
    for (const circle of host.querySelectorAll(".mini-graph__node-core")) {
      expect(circle.getAttribute("r")).toBe("1.9");
    }
    for (const line of host.querySelectorAll("line")) {
      expect(Number(line.getAttribute("stroke-width"))).toBeLessThanOrEqual(0.62);
    }
  });

  test("선택 노드 주변 그래프는 8개 연결과 중심+3개 라벨만 보인다", () => {
    const host = document.createElement("div");
    const nodes = Array.from({ length: 14 }, (_, i) => node(`node:${i}`));
    const edges = nodes.slice(1).map((n, i) => edge("node:0", n.id, i, 1 - i * 0.03));

    renderMiniGraph(host, {
      overview: { nodes, edges },
      selection: {
        kind: "memory",
        memoryId: 0,
        graphNodeId: "node:0",
        source: "mini-graph",
      },
      onPickNode: () => undefined,
    });

    expect(host.querySelectorAll("line")).toHaveLength(8);
    expect(host.querySelectorAll(".mini-graph__label")).toHaveLength(4);
    expect(host.querySelector(".mini-graph__node--center .mini-graph__node-core")?.getAttribute("r")).toBe("3.8");
  });

  test("새로 들어온 노드에는 중심 파동과 강화 glow class 를 붙인다", () => {
    const host = document.createElement("div");
    const nodes = [node("node:old"), node("node:new", 1)];
    const edges = [edge("node:old", "node:new", 0, 1)];

    renderMiniGraph(host, {
      overview: { nodes, edges },
      selection: { kind: "none" },
      newNodeIds: new Set(["node:new"]),
      onPickNode: () => undefined,
    });

    const newNode = host.querySelector<SVGGElement>('[data-node-id="node:new"]');
    const oldNode = host.querySelector<SVGGElement>('[data-node-id="node:old"]');

    expect(newNode?.classList.contains("mini-graph__node--new")).toBe(true);
    expect(newNode?.querySelector(".mini-graph__birth-ripple")).not.toBeNull();
    expect(newNode?.querySelector(".mini-graph__node-glow")).not.toBeNull();
    expect(oldNode?.classList.contains("mini-graph__node--new")).toBe(false);
    expect(oldNode?.querySelector(".mini-graph__birth-ripple")).toBeNull();
  });
});
