import { describe, expect, test } from "bun:test";
import {
  emptyGraphViewModel,
  iconKindForGraphType,
  labelFromContent,
  nodeKey,
  normalizeGraphNodeType,
  representativeConceptType,
  uniqueGraphEdges,
  uniqueGraphNodes,
} from "./graph-view-model";

describe("엔티티 타입 키 — 정규화 및 아이콘 (Phase 8 재매핑 Task 1)", () => {
  const entitySourceTypes = [
    "work", "creature", "thing", "intake",
    "usable", "material", "place", "schedule",
  ] as const;

  test("8 엔티티 sourceType 은 같은 이름 타입으로 보존된다", () => {
    for (const st of entitySourceTypes) {
      expect(normalizeGraphNodeType(st)).toBe(st);
    }
  });

  test("classification_key 는 분류 키 타입으로 보존된다", () => {
    expect(normalizeGraphNodeType("classification_key")).toBe("classification_key");
  });

  test("미상 sourceType 은 unknown (현행 유지)", () => {
    expect(normalizeGraphNodeType("나몰라")).toBe("unknown");
  });

  test("엔티티 8종은 folder 아이콘, 분류 키는 pin 아이콘", () => {
    for (const st of entitySourceTypes) {
      expect(iconKindForGraphType(st)).toBe("folder");
    }
    expect(iconKindForGraphType("classification_key")).toBe("pin");
  });
});

describe("대표 정체성 우선순위 — 개념 > 분류 > 태그 (꼬임 해소 1단계 결정 1·spec §3.1)", () => {
  test("어느 역할도 없는 순수 개념은 concept 으로 그린다", () => {
    expect(representativeConceptType({})).toBe("concept");
  });

  test("태그-only 역할은 일반 concept 으로 흡수한다(개념과 한데·기존 계약)", () => {
    expect(representativeConceptType({ isTag: true })).toBe("concept");
  });

  test("분류 키 역할이 있으면 classification_key 로 그린다", () => {
    expect(representativeConceptType({ isClassificationKey: true })).toBe(
      "classification_key",
    );
  });

  test("분류 값 역할은 일반 concept 으로 흡수한다(현행 정합)", () => {
    expect(representativeConceptType({ isClassificationValue: true })).toBe("concept");
  });

  test("분류 키와 태그가 겹치면 분류 키 표시가 이긴다(분류 > 태그)", () => {
    expect(
      representativeConceptType({ isClassificationKey: true, isTag: true }),
    ).toBe("classification_key");
  });

  test("분류 값과 태그가 겹치면 일반 concept 으로 합류한다", () => {
    expect(
      representativeConceptType({ isClassificationValue: true, isTag: true }),
    ).toBe("concept");
  });

  test("세 역할이 한 행에 모두 누적돼도 분류 키가 대표가 된다", () => {
    expect(
      representativeConceptType({
        isTag: true,
        isClassificationKey: true,
        isClassificationValue: true,
      }),
    ).toBe("classification_key");
  });
});

describe("같은 이름 한 노드 — 역할 겹친 한 행은 한 노드로만 그린다(결정 1)", () => {
  test("같은 conceptId 가 여러 역할로 들어와도 노드는 1개·중복 0", () => {
    // 같은 이름 태그·분류·개념이 한 concept_nodes 행으로 합류하면 conceptId 도
    // 하나라 그래프 노드 id 도 하나다. 역할이 겹친 여러 입력이 와도 한 노드로만
    // 그려지는지(중복 노드 0) 검증한다.
    const merged = uniqueGraphNodes([
      { id: "concept:cpt_a", type: "tag", label: "커피" },
      { id: "concept:cpt_a", type: "classification_key", label: "커피" },
      { id: "concept:cpt_a", type: "concept", label: "커피" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("concept:cpt_a");
  });

  test("대표 type 표시 규칙을 view 노드 type 으로 그대로 쓸 수 있다", () => {
    const roles = {
      isTag: true,
      isClassificationKey: true,
      isClassificationValue: false,
    };
    const node = {
      id: "concept:cpt_b",
      type: representativeConceptType(roles),
      label: "직업",
    };
    expect(node.type).toBe("classification_key");
    const deduped = uniqueGraphNodes([node]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.type).toBe("classification_key");
  });
});

describe("graph-view-model — ids and type grammar", () => {
  test("nodeKey keeps ids stable and namespaced", () => {
    expect(nodeKey(7)).toBe("node:7");
    expect(nodeKey("abc")).toBe("node:abc");
    expect(nodeKey("document:doc-1")).toBe("document:doc-1");
  });

  test("source_type values map to graph node types", () => {
    expect(normalizeGraphNodeType("document_chunk")).toBe("document_chunk");
    expect(normalizeGraphNodeType("chunk")).toBe("document_chunk");
    expect(normalizeGraphNodeType("image_asset")).toBe("image");
    expect(normalizeGraphNodeType("image_caption")).toBe("image_caption");
    expect(normalizeGraphNodeType("llm_extract")).toBe("llm_extract");
    expect(normalizeGraphNodeType("auto_capture")).toBe("memory");
    expect(normalizeGraphNodeType("unknown_kind")).toBe("unknown");
    expect(normalizeGraphNodeType(undefined)).toBe("memory");
  });

  test("icon grammar matches the dashboard contract", () => {
    expect(iconKindForGraphType("document_chunk")).toBe("page");
    expect(iconKindForGraphType("project")).toBe("folder");
    expect(iconKindForGraphType("concept")).toBe("folder");
    expect(iconKindForGraphType("person")).toBe("folder");
    expect(iconKindForGraphType("image")).toBe("image");
    expect(iconKindForGraphType("tag")).toBe("pin");
    expect(iconKindForGraphType("memory")).toBe("note");
    expect(iconKindForGraphType("image_caption")).toBe("note");
  });
});

describe("graph-view-model — safe defaults", () => {
  test("labelFromContent collapses whitespace and trims long labels", () => {
    expect(labelFromContent("  hello\nworld  ")).toBe("hello world");
    expect(labelFromContent("")).toBe("Untitled");
    expect(labelFromContent("a".repeat(40))).toBe(`${"a".repeat(31)}...`);
  });

  test("emptyGraphViewModel is a renderable zero state", () => {
    expect(emptyGraphViewModel()).toEqual({
      nodes: [],
      edges: [],
      clusters: [],
      stats: { totalNodes: 0, totalEdges: 0 },
      recent: [],
    });
  });

  test("uniqueGraphNodes merges display-only fields without changing ids", () => {
    const nodes = uniqueGraphNodes([
      { id: "node:1", type: "memory", label: "old", score: 0.2 },
      {
        id: "node:1",
        type: "memory",
        label: "new",
        score: 0.9,
        revision: { superseded: true, supersedes: false },
      },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "node:1",
      label: "new",
      score: 0.9,
      revision: { superseded: true, supersedes: false },
    });
  });

  test("uniqueGraphEdges dedups by edge id", () => {
    const edges = uniqueGraphEdges([
      { id: "e1", from: "a", to: "b", type: "x" },
      { id: "e1", from: "a", to: "c", type: "y" },
    ]);
    expect(edges).toEqual([{ id: "e1", from: "a", to: "c", type: "y" }]);
  });
});
