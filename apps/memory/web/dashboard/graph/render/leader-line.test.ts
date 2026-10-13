// resolveVisibleLabelIds 라벨 표시 정책 단위 테스트 — 순수 함수, WebGL 비의존.
// 정책(spec 2026-06-17): 기본은 묶음(entity_group) 라벨만. 선택·호버·검색으로만 그 위에 더한다.
// 개별 엔티티는 그 타입 묶음이 펼침일 때만, 단 선택·호버한 노드는 펼침과 무관하게 살린다(게이트 예외).
import { describe, test, expect } from "bun:test";
import { registerHappyDom } from "../../test-happy-dom.ts";
import { createLabels, resolveVisibleLabelIds } from "./leader-line.ts";
import type { GraphEdge, GraphNode } from "../graph-view-model.ts";

registerHappyDom();

const EMPTY = new Set<string>();
const NO_EXPAND = new Set<string>();

function makeNode(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: "memory",
    label: partial.id,
    ...partial,
  };
}

function edge(from: string, to: string, type = "parent_of"): GraphEdge {
  return { id: `${from}->${to}:${type}`, from, to, type };
}

describe("resolveVisibleLabelIds — 기본은 묶음 라벨만", () => {
  test("선택·호버·검색 없으면 개념·글 라벨은 전부 꺼진다", () => {
    const nodes = [
      makeNode({ id: "c0", type: "concept", importance: 0.95 }),
      makeNode({ id: "m0", type: "memory", importance: 0.9 }),
    ];
    const result = resolveVisibleLabelIds(nodes, null, null, EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("c0")).toBe(false);
    expect(result.has("m0")).toBe(false);
    expect(result.size).toBe(0);
  });

  test("묶음 노드(entity_group) 라벨은 펼침과 무관하게 항상 표시", () => {
    const nodes = [makeNode({ id: "group:work", type: "entity_group" })];
    const result = resolveVisibleLabelIds(nodes, null, null, EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("group:work")).toBe(true);
  });
});

describe("resolveVisibleLabelIds — 선택·호버가 라벨을 켠다", () => {
  test("선택한 글 노드 라벨이 켜진다", () => {
    const nodes = [makeNode({ id: "m", type: "memory", importance: 0.1 })];
    const result = resolveVisibleLabelIds(nodes, "m", null, EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("m")).toBe(true);
  });

  test("호버한 글 노드 자신은 요약 카드가 뜨므로 라벨을 반복하지 않는다", () => {
    const nodes = [makeNode({ id: "m", type: "memory", importance: 0.05 })];
    const result = resolveVisibleLabelIds(nodes, null, "m", EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("m")).toBe(false);
  });

  test("호버한 노드의 1~2단계 연결 노드 라벨이 켜진다", () => {
    const nodes = [
      makeNode({ id: "hover", type: "memory" }),
      makeNode({ id: "one-hop", type: "concept" }),
      makeNode({ id: "two-hop", type: "memory" }),
      makeNode({ id: "three-hop", type: "memory" }),
    ];
    const result = resolveVisibleLabelIds(
      nodes,
      null,
      "hover",
      EMPTY,
      EMPTY,
      NO_EXPAND,
      [
        edge("hover", "one-hop", "tagged_with"),
        edge("one-hop", "two-hop", "tagged_with"),
        edge("two-hop", "three-hop", "tagged_with"),
      ],
    );

    expect(result.has("hover")).toBe(false);
    expect(result.has("one-hop")).toBe(true);
    expect(result.has("two-hop")).toBe(true);
    expect(result.has("three-hop")).toBe(false);
  });

  test("선택한 개별 엔티티(work)는 묶음이 펼침 전이어도 라벨이 켜진다(게이트 예외·항목5)", () => {
    const nodes = [makeNode({ id: "entity:work:a", type: "work" })];
    const result = resolveVisibleLabelIds(nodes, "entity:work:a", null, EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("entity:work:a")).toBe(true);
  });

  test("호버 이웃인 개별 엔티티(person)는 펼침 전이어도 라벨이 켜진다", () => {
    const nodes = [
      makeNode({ id: "hover", type: "memory" }),
      makeNode({ id: "person:p", type: "person" }),
    ];
    const result = resolveVisibleLabelIds(nodes, null, "person:p", EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("person:p")).toBe(false);

    const fromMemory = resolveVisibleLabelIds(
      nodes,
      null,
      "hover",
      EMPTY,
      EMPTY,
      NO_EXPAND,
      [edge("hover", "person:p", "mentions_entity")],
    );
    expect(fromMemory.has("person:p")).toBe(true);
  });
});

describe("resolveVisibleLabelIds — 개별 엔티티 펼침 게이트", () => {
  test("개별 엔티티(work)는 선택·호버 아니고 펼침 전이면 라벨 숨김", () => {
    const nodes = [makeNode({ id: "entity:work:a", type: "work", importance: 0.95 })];
    const result = resolveVisibleLabelIds(nodes, null, null, EMPTY, EMPTY, NO_EXPAND);
    expect(result.has("entity:work:a")).toBe(false);
  });

  test("그 타입 묶음을 펼치면 그 묶음 자식만 라벨이 켜진다", () => {
    const nodes = [
      makeNode({ id: "entity:work:a", type: "work" }),
      makeNode({ id: "person:p1", type: "person" }),
    ];
    const expanded = new Set(["work"]);
    const result = resolveVisibleLabelIds(nodes, null, null, EMPTY, EMPTY, expanded);
    expect(result.has("entity:work:a")).toBe(true);
    expect(result.has("person:p1")).toBe(false);
  });

  test("펼친 project 묶음은 parent_of 중간 분류 라벨도 켠다", () => {
    const nodes = [
      makeNode({ id: "group:project", type: "entity_group", groupType: "project", label: "프로젝트" }),
      makeNode({ id: "concept:coding", type: "classification_key", label: "코딩" }),
      makeNode({ id: "concept:app", type: "classification_key", label: "앱" }),
      makeNode({ id: "project:bara", type: "project", label: "바라" }),
    ];
    const edges = [
      edge("group:project", "concept:coding"),
      edge("concept:coding", "concept:app"),
      edge("concept:app", "project:bara"),
    ];
    const result = resolveVisibleLabelIds(
      nodes,
      null,
      null,
      EMPTY,
      EMPTY,
      new Set(["project"]),
      edges,
    );

    expect(result.has("group:project")).toBe(true);
    expect(result.has("concept:coding")).toBe(true);
    expect(result.has("concept:app")).toBe(true);
    expect(result.has("project:bara")).toBe(true);
  });

  test("선택한 project 잎은 펼침 전이어도 상위 parent_of 경로 라벨을 켠다", () => {
    const nodes = [
      makeNode({ id: "group:project", type: "entity_group", groupType: "project", label: "프로젝트" }),
      makeNode({ id: "concept:coding", type: "classification_key", label: "코딩" }),
      makeNode({ id: "concept:app", type: "classification_key", label: "앱" }),
      makeNode({ id: "project:bara", type: "project", label: "바라" }),
    ];
    const edges = [
      edge("group:project", "concept:coding"),
      edge("concept:coding", "concept:app"),
      edge("concept:app", "project:bara"),
    ];
    const result = resolveVisibleLabelIds(
      nodes,
      "project:bara",
      null,
      EMPTY,
      EMPTY,
      NO_EXPAND,
      edges,
    );

    expect(result.has("group:project")).toBe(true);
    expect(result.has("concept:coding")).toBe(true);
    expect(result.has("concept:app")).toBe(true);
    expect(result.has("project:bara")).toBe(true);
  });
});

describe("resolveVisibleLabelIds — 검색 라벨(범위 밖·기존 유지)", () => {
  test("검색 top 노드와 hit+importance>0.62 노드 라벨이 더해진다(글·개념)", () => {
    const nodes = [
      makeNode({ id: "top1", type: "memory", importance: 0.0 }),
      makeNode({ id: "hitHi", type: "concept", importance: 0.7 }),
      makeNode({ id: "hitLo", type: "memory", importance: 0.3 }),
    ];
    const topIds = new Set(["top1"]);
    const hitIds = new Set(["hitHi", "hitLo"]);
    const result = resolveVisibleLabelIds(nodes, null, null, topIds, hitIds, NO_EXPAND);
    expect(result.has("top1")).toBe(true);
    expect(result.has("hitHi")).toBe(true);
    expect(result.has("hitLo")).toBe(false);
  });

  test("검색 hit 이 개별 엔티티이고 펼침 전·선택/호버 아니면 게이트가 끈다(결정 D)", () => {
    const nodes = [makeNode({ id: "entity:work:a", type: "work", importance: 0.9 })];
    const hitIds = new Set(["entity:work:a"]);
    const result = resolveVisibleLabelIds(nodes, null, null, EMPTY, hitIds, NO_EXPAND);
    expect(result.has("entity:work:a")).toBe(false);
  });
});

describe("resolveVisibleLabelIds — 최근 생성 라벨", () => {
  test("recent-born 개별 엔티티는 펼침 전에도 라벨을 고정 표시한다", () => {
    const nodes = [makeNode({ id: "entity:work:new", type: "work", importance: 0.1 })];
    const recentIds = new Set(["entity:work:new"]);
    const result = resolveVisibleLabelIds(
      nodes,
      null,
      null,
      EMPTY,
      EMPTY,
      NO_EXPAND,
      [],
      recentIds,
    );

    expect(result.has("entity:work:new")).toBe(true);
  });
});

describe("createLabels — 표시 라벨", () => {
  test("캔버스 라벨에서 메모리 해시태그를 숨긴다", () => {
    const container = document.createElement("div");
    const labels = createLabels(container, [
      makeNode({
        id: "node:tagged",
        type: "memory",
        label: "#아이디어 #작품:소설, 그래프 제목 정리",
        snippet: "#아이디어 #작품:소설, 그래프 제목 정리",
      }),
      makeNode({
        id: "concept:work",
        type: "classification_key",
        label: "작품",
      }),
    ]);

    expect(labels.get("node:tagged")?.el.textContent).toBe("그래프 제목 정리");
    expect(labels.get("node:tagged")?.el.title).toBe("그래프 제목 정리");
    expect(labels.get("concept:work")?.el.textContent).toBe("작품");
  });
});
