import { describe, expect, test } from "bun:test";
import { buildFakeGraphViewModel, type FakeBaraShape } from "./graph-adapter-fake";

describe("graph-adapter-fake — docs/web_sample compatibility", () => {
  test("adapts sample-shaped data into the same ViewModel surface", () => {
    const fake: FakeBaraShape = {
      NODES_LIST: [
        { id: "pj_bara", type: "project", label: "bara", importance: 1 },
        { id: "m_1", type: "memory", label: "기억", snippet: "내용" },
      ],
      EDGES: [
        { from: "m_1", to: "pj_bara", type: "belongs_to_project", weight: 0.7 },
      ],
      buildSearchResponse: () => ({
        query: "RAG",
        hits: [{ nodeId: "m_1", score: 0.9 }],
        top3: [{ nodeId: "m_1", score: 0.9 }],
        focus: {
          highlightedNodeIds: ["m_1", "pj_bara"],
          highlightedEdgeIds: ["edge-1"],
        },
      }),
    };

    const vm = buildFakeGraphViewModel(fake, "q_rag");
    expect(vm.nodes.map((node) => node.id)).toEqual(["pj_bara", "m_1"]);
    expect(vm.edges[0]).toMatchObject({
      from: "m_1",
      to: "pj_bara",
      type: "belongs_to_project",
    });
    expect(vm.search).toMatchObject({
      query: "RAG",
      count: 1,
      top3: [{ nodeId: "m_1", score: 0.9 }],
      highlightedNodeIds: ["m_1", "pj_bara"],
      highlightedEdgeIds: ["edge-1"],
    });
  });
});
