import { describe, expect, test } from "bun:test";
import {
  buildLiveGraphViewModel,
  buildOverviewViewModel,
  buildSearchViewModel,
  graphNodeFromMemory,
  graphNodeFromSearchResult,
  type ApiSearchResponse,
  type GraphOverviewResponse,
  type GraphSearchApiResponse,
} from "./graph-adapter-live";

describe("graph-adapter-live — API rows to graph nodes", () => {
  test("recent memory maps without inventing search-only fields", () => {
    const node = graphNodeFromMemory({
      id: 12,
      content: "오늘 RAG 검색 결과를 다시 봄",
      sourceType: "user_explicit",
      importance: 0.7,
      createdAt: "2026-06-04T00:00:00.000Z",
    });
    expect(node).toMatchObject({
      id: "node:12",
      sourceId: 12,
      type: "memory",
      label: "오늘 RAG 검색 결과를 다시 봄",
      importance: 0.7,
      createdAt: "2026-06-04T00:00:00.000Z",
    });
    expect(node.score).toBeUndefined();
    expect(node.revision).toBeUndefined();
  });

  test("search result preserves score, components, captions, and revision flags", () => {
    const node = graphNodeFromSearchResult({
      id: 21,
      content: "image asset",
      sourceType: "image_asset",
      score: 0.88,
      sources: ["imageVec"],
      components: { imageVecRawCosine: 0.42 },
      assetSha256: "abc",
      captions: { user: null, auto: "yellow jacket character" },
      taggedWith: [{ category: "character", value: "hoodie" }],
      revision: { superseded: false, supersedes: true },
    });
    expect(node.type).toBe("image");
    expect(node.score).toBe(0.88);
    expect(node.components).toEqual({ imageVecRawCosine: 0.42 });
    expect(node.captions).toEqual({ user: null, auto: "yellow jacket character" });
    expect(node.revision).toEqual({ superseded: false, supersedes: true });
    expect(node.meta).toEqual({ assetSha256: "abc" });
  });
});

describe("graph-adapter-live — ViewModel assembly", () => {
  test("builds Top 3 from API order without changing scores", () => {
    const search = makeSearchResponse();
    const vm = buildLiveGraphViewModel({
      stats: { totalMemories: 10, memoriesLast7Days: 3, totalEdges: 5 },
      recent: [
        { id: 1, content: "recent memory", sourceType: "user_explicit" },
      ],
      search,
    });

    expect(vm.search?.top3).toMatchObject([
      { nodeId: "node:101", score: 0.91 },
      { nodeId: "node:102", score: 0.72 },
      { nodeId: "node:103", score: 0.64 },
    ]);
    expect(vm.search?.count).toBe(3);
    expect(vm.stats).toMatchObject({
      totalMemories: 10,
      memoriesLast7Days: 3,
      totalNodes: vm.nodes.length,
      totalEdges: vm.edges.length,
    });
  });

  test("adds only relationship nodes backed by API fields", () => {
    const vm = buildLiveGraphViewModel({ search: makeSearchResponse() });

    expect(vm.nodes.some((node) => node.id === "document:doc-a")).toBe(true);
    expect(vm.nodes.some((node) => node.id === "node:201")).toBe(true);
    expect(vm.nodes.some((node) => node.id === "classification:character:hoodie")).toBe(true);

    expect(vm.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "document:doc-a",
          to: "node:101",
          type: "contains_chunk",
        }),
        expect.objectContaining({
          from: "document:doc-a",
          to: "node:201",
          type: "contains_chunk",
        }),
        expect.objectContaining({
          from: "node:102",
          to: "classification:character:hoodie",
          type: "classified_as",
        }),
      ]),
    );
    expect(vm.search?.highlightedEdgeIds).toEqual(vm.edges.map((edge) => edge.id));
  });

  test("headingPath 가 있는 document_chunk 는 section node/edge 를 합성한다", () => {
    const vm = buildLiveGraphViewModel({
      search: {
        query: "문서",
        count: 1,
        results: [
          {
            id: 301,
            content: "# 제목\n## 중간\n본문",
            sourceType: "document_chunk",
            score: 0.8,
            sources: ["vector"],
            components: { rrf: 0.01 },
            documentRef: {
              parentId: "doc-heading",
              centerIndex: 0,
              title: "구조 문서",
              totalChunks: 1,
              headingPath: ["제목", "중간"],
              headingTitle: "중간",
              headingDepth: 2,
              parentHeadingPath: ["제목"],
              chunkingStrategy: "heading_path",
            },
            neighbors: [],
          },
        ],
      },
    });

    const firstSection = `document-section:${encodeURIComponent("document:doc-heading")}:${encodeURIComponent("제목")}`;
    const secondSection = `${firstSection}/${encodeURIComponent("중간")}`;
    const firstSectionNode = vm.nodes.find((node) => node.id === firstSection);
    const secondSectionNode = vm.nodes.find((node) => node.id === secondSection);
    expect(firstSectionNode?.type).toBe("document_section");
    expect(firstSectionNode?.snippet).toBe("# 제목\n## 중간\n본문");
    expect(secondSectionNode?.label).toBe("## 중간");
    expect(secondSectionNode?.snippet).toBe("# 제목\n## 중간\n본문");
    expect(vm.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "document:doc-heading",
          to: firstSection,
          type: "contains_section",
        }),
        expect.objectContaining({
          from: firstSection,
          to: secondSection,
          type: "contains_section",
        }),
        expect.objectContaining({
          from: secondSection,
          to: "node:301",
          type: "contains_chunk",
        }),
      ]),
    );
    expect(
      vm.edges.some(
        (edge) =>
          edge.from === "document:doc-heading" &&
          edge.to === "node:301" &&
          edge.type === "contains_chunk",
      ),
    ).toBe(false);
  });
});

function makeSearchResponse(): ApiSearchResponse {
  return {
    query: "RAG",
    count: 3,
    results: [
      {
        id: 101,
        content: "문서 청크 본문",
        sourceType: "document_chunk",
        score: 0.91,
        sources: ["vector", "fts"],
        components: { rrf: 0.016 },
        documentRef: {
          parentId: "doc-a",
          centerIndex: 2,
          title: "RAG notes",
          totalChunks: 5,
        },
        neighbors: [{ id: 201, chunkIndex: 1, content: "앞 청크" }],
      },
      {
        id: 102,
        content: "이미지 노드",
        sourceType: "image_asset",
        score: 0.72,
        sources: ["imageVec"],
        components: { imageVecRawCosine: 0.38 },
        taggedWith: [{ category: "character", value: "hoodie" }],
      },
      {
        id: 103,
        content: "일반 메모",
        sourceType: "user_explicit",
        score: 0.64,
        sources: ["fts"],
        components: { rrf: 0.012 },
      },
    ],
  };
}

// ── /graph/overview · /graph/search 어댑터 테스트 ─────────────────────────

describe("buildOverviewViewModel — /graph/overview 응답 → view-model", () => {
  test("개요 응답 노드·엣지가 view-model 로 변환된다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [
        { id: "node:1", sourceType: "concept", label: "그래프 개념", snippet: "개념 설명" },
        { id: "node:2", sourceType: "memory", label: "메모 글" },
      ],
      edges: [
        { id: "e1", from: "node:1", to: "node:2", type: "tagged_with", weight: 0.9 },
      ],
      stats: { totalNodes: 2, totalEdges: 1 },
    };
    const vm = buildOverviewViewModel(resp);
    expect(vm.nodes).toHaveLength(2);
    expect(vm.nodes[0]!.type).toBe("concept");
    expect(vm.nodes[1]!.type).toBe("memory");
    expect(vm.edges).toHaveLength(1);
    expect(vm.stats.totalNodes).toBe(2);
    expect(vm.stats.totalEdges).toBe(1);
    expect(vm.clusters.length).toBeGreaterThan(0);
  });

  test("sourceType 을 GraphNodeType 으로 정규화한다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [
        { id: "node:10", sourceType: "image_asset", label: "이미지" },
        { id: "node:11", sourceType: "document_chunk", label: "청크" },
        { id: "node:12", sourceType: "unknown_future_type", label: "미지" },
      ],
      edges: [],
    };
    const vm = buildOverviewViewModel(resp);
    expect(vm.nodes[0]!.type).toBe("image");
    expect(vm.nodes[1]!.type).toBe("document_chunk");
    expect(vm.nodes[2]!.type).toBe("unknown");
  });

  test("엔티티 meta 를 view-model 노드로 통과시킨다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [
        {
          id: "entity:work:wrk_1",
          sourceType: "work",
          label: "데못죽",
          meta: {
            entityInfo: {
              sections: [
                { title: "칸", rows: [{ key: "매체", value: "소설" }] },
                { title: "라벨", rows: [{ key: "상태", value: "읽는 중" }] },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    const vm = buildOverviewViewModel(resp);
    expect(vm.nodes[0]!.meta).toEqual(resp.nodes[0]!.meta);
  });

  test("document_chunk parent_of DB edge 는 표시용 section hierarchy 로 정규화된다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [
        { id: "node:40", sourceId: 40, sourceType: "document", label: "구조 문서" },
        {
          id: "node:41",
          sourceId: 41,
          sourceType: "document_chunk",
          label: "본문",
          meta: {
            parentId: "doc-overview",
            chunkIndex: 0,
            headingPath: ["제목"],
            headingTitle: "제목",
            headingDepth: 1,
            parentHeadingPath: [],
            chunkingStrategy: "heading_path",
          },
        },
      ],
      edges: [
        { id: "db-edge", from: "node:41", to: "node:40", type: "parent_of", weight: 1 },
      ],
    };
    const vm = buildOverviewViewModel(resp);
    const sectionId = `document-section:${encodeURIComponent("node:40")}:${encodeURIComponent("제목")}`;
    expect(vm.nodes.some((node) => node.id === sectionId && node.type === "document_section")).toBe(true);
    expect(vm.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "node:40", to: sectionId, type: "contains_section" }),
        expect.objectContaining({ from: sectionId, to: "node:41", type: "contains_chunk" }),
      ]),
    );
    expect(vm.edges.some((edge) => edge.id === "db-edge")).toBe(false);
  });

  test("중복 노드 id 는 uniqueGraphNodes 로 하나로 합쳐진다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [
        { id: "node:5", sourceType: "concept", label: "첫 번째" },
        { id: "node:5", sourceType: "concept", label: "두 번째" },
      ],
      edges: [],
    };
    const vm = buildOverviewViewModel(resp);
    expect(vm.nodes).toHaveLength(1);
  });

  test("recent 는 nodes 에서 nodeId 목록으로 만들어진다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [{ id: "node:3", sourceType: "person", label: "사람" }],
      edges: [],
    };
    const vm = buildOverviewViewModel(resp);
    expect(vm.recent).toEqual([{ nodeId: "node:3" }]);
  });

  test("null 응답 → 빈 view-model 과 동등하다", () => {
    const vm = buildOverviewViewModel(null);
    expect(vm.nodes).toEqual([]);
    expect(vm.edges).toEqual([]);
    expect(vm.clusters).toEqual([]);
    expect(vm.stats.totalNodes).toBe(0);
    expect(vm.stats.totalEdges).toBe(0);
    expect(vm.recent).toEqual([]);
    expect(vm.search).toBeUndefined();
  });

  test("stats 에 totalMemories 가 있으면 view-model 에 전달된다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [],
      edges: [],
      stats: { totalMemories: 42, memoriesLast7Days: 7 },
    };
    const vm = buildOverviewViewModel(resp);
    expect(vm.stats.totalMemories).toBe(42);
    expect(vm.stats.memoriesLast7Days).toBe(7);
  });

  // ── S1-B/S1-C — mapOverviewNode 가 eventAt 을 view-model 로 통과시킨다 ─────────
  test("S1-B/C — 응답 노드의 eventAt 이 view-model 노드로 통과한다", () => {
    const resp: GraphOverviewResponse = {
      nodes: [
        { id: "node:30", sourceType: "memory", label: "일정 있는 글", eventAt: "2026-06-25" },
        { id: "node:31", sourceType: "memory", label: "일정 없는 글" },
      ],
      edges: [],
    };
    const vm = buildOverviewViewModel(resp);
    const withEvent = vm.nodes.find((n) => n.id === "node:30");
    const noEvent = vm.nodes.find((n) => n.id === "node:31");
    expect(withEvent!.eventAt).toBe("2026-06-25");
    // 응답에 eventAt 이 없으면 view-model 에서도 undefined 로 남는다(가짜 값을 만들지 않는다).
    expect(noEvent!.eventAt).toBeUndefined();
  });
});

describe("buildSearchViewModel — /graph/search 응답 → view-model", () => {
  function makeGraphSearchResponse(): GraphSearchApiResponse {
    return {
      query: "RAG 검색",
      count: 2,
      hits: [
        { nodeId: "node:10", score: 0.88 },
        { nodeId: "node:11", score: 0.65 },
      ],
      top3: [
        { nodeId: "node:10", score: 0.88 },
        { nodeId: "node:11", score: 0.65 },
      ],
      subgraph: {
        nodes: [
          { id: "node:10", sourceType: "memory", label: "RAG 메모", snippet: "검색 내용" },
          { id: "node:11", sourceType: "concept", label: "RAG 개념" },
        ],
        edges: [
          { id: "e:10-11:tagged_with", from: "node:10", to: "node:11", type: "tagged_with", weight: 0.7 },
        ],
      },
      focus: {
        centerNodeId: "node:10",
        highlightedNodeIds: ["node:10", "node:11"],
        highlightedEdgeIds: ["e:10-11:tagged_with"],
      },
    };
  }

  test("search 칸이 채워진다", () => {
    const vm = buildSearchViewModel(makeGraphSearchResponse());
    expect(vm.search).toBeDefined();
    expect(vm.search!.query).toBe("RAG 검색");
    expect(vm.search!.count).toBe(2);
    expect(vm.search!.top3[0]!.nodeId).toBe("node:10");
    expect(vm.search!.top3[0]!.score).toBe(0.88);
    expect(vm.search!.hits).toHaveLength(2);
    expect(vm.search!.highlightedNodeIds).toContain("node:10");
    expect(vm.search!.highlightedNodeIds).toContain("node:11");
    expect(vm.search!.highlightedEdgeIds).toContain("e:10-11:tagged_with");
  });

  test("subgraph 노드·엣지가 view-model 노드·엣지로 변환된다", () => {
    const vm = buildSearchViewModel(makeGraphSearchResponse());
    expect(vm.nodes).toHaveLength(2);
    expect(vm.edges).toHaveLength(1);
    expect(vm.nodes.some((n) => n.id === "node:10")).toBe(true);
    expect(vm.nodes.some((n) => n.id === "node:11")).toBe(true);
  });

  test("null 응답 → 빈 view-model, search 칸 없음", () => {
    const vm = buildSearchViewModel(null);
    expect(vm.nodes).toEqual([]);
    expect(vm.edges).toEqual([]);
    expect(vm.search).toBeUndefined();
  });
});
