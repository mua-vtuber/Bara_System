// group-hub-visual.test.ts — ⑥ 거대 허브 시각 일관화(WebGL 비의존 순수 헬퍼 단정).
// spec docs/decisions/2026-06-13-graph-node-absorption-shortcut-prevention-spec.md §5.4 ⑥·§8 3c·§9.
//
// ⑥ 은 그래프 빌드(graph.ts)에서 ④ 통합 노드의 sourceType 을 "entity_group" 로 올리고
// groupType 을 그 타입(place 등)으로 채우는 *신호*다. 이 테스트는 그 신호가 render 의
// 기존 entity_group 통로(nodeSizeOf 거대 크기 + decorationKindForGroup 자식 장식 + isHub
// 허브 등급)를 그대로 켜는지, 10종 1급 엔티티 타입 대표가 같은 신호로 한 시각에 통일되는지,
// 신호 없는 노드(글·개념·태그)는 시각 불변(회귀 0)인지 단정한다. WebGL 없이 순수 헬퍼만 쓴다.
import { describe, test, expect } from "bun:test";
import { nodeSizeOf, planNodeVisuals, NODE_SIZE } from "./nodes.ts";
import { decorationKindForGroup } from "./decorations.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import { normalizeGraphNodeType } from "../graph-view-model.ts";
import type { GraphNode } from "../graph-view-model.ts";
import type { NodeState } from "./highlight.ts";

/**
 * 서버 graph.ts 가 ⑥ 으로 매긴 신호(sourceType="entity_group"+groupType)를 web 뷰모델
 * 노드로 옮긴다 — graph-adapter-live.ts mapOverviewNode 와 같은 변환(normalizeGraphNodeType).
 * 실제 파이프라인을 그대로 본떠 신호가 render 까지 흐르는지 확인한다.
 */
function asViewModelNode(serverSourceType: string, groupType: string, id: string): GraphNode {
  return {
    id,
    type: normalizeGraphNodeType(serverSourceType),
    sourceType: serverSourceType,
    groupType,
    label: "장소",
  };
}

// 1급 엔티티 10종 타입 + 그 타입 대표 장식(자식과 같은 종류) 표.
// graph.ts GROUP_TYPE_KO 와 decorations.ts DECORATION_BY_TYPE 단일 출처 정합.
const FIRST_CLASS_TYPES: ReadonlyArray<readonly [string, "ring" | "ray"]> = [
  ["person", "ray"],
  ["project", "ring"],
  ["work", "ring"],
  ["material", "ring"],
  ["place", "ring"],
  ["creature", "ring"],
  ["thing", "ring"],
  ["intake", "ring"],
  ["usable", "ring"],
  ["schedule", "ring"],
];

describe("⑥ 거대 허브 시각 — entity_group 신호가 거대 크기+자식 장식을 켠다", () => {
  test("④ 통합 '장소' 노드(entity_group·place)는 거대 크기 + ring 장식", () => {
    const node = asViewModelNode("entity_group", "place", "concept:cpt_place_root");
    // 거대 크기 — degree 무관 NODE_SIZE.max * groupScale.
    expect(nodeSizeOf(node, 0)).toBeCloseTo(NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale);
    expect(nodeSizeOf(node, 99)).toBeCloseTo(NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale);
    // 자식과 같은 장식 — place→ring.
    expect(decorationKindForGroup(node.groupType!)).toBe("ring");
  });

  test("10종 1급 엔티티 타입 대표가 모두 같은 거대 허브 신호로 통일(타입별 안 갈림)", () => {
    const giant = NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale;
    for (const [typeName, expectedDeco] of FIRST_CLASS_TYPES) {
      const node = asViewModelNode("entity_group", typeName, `rep:${typeName}`);
      // 크기는 10종 전부 같은 거대 값(타입별로 안 갈린다).
      expect(nodeSizeOf(node, 0)).toBeCloseTo(giant);
      // 장식은 자식 타입과 같은 종류(사람=빛살·나머지=고리).
      expect(decorationKindForGroup(node.groupType!)).toBe(expectedDeco);
    }
  });

  test("planNodeVisuals — entity_group 통합 노드는 허브 등급(자식 많아 degree≥5)·거대 크기", () => {
    const hub = asViewModelNode("entity_group", "place", "concept:cpt_place_root");
    // 묶음 허브는 자식이 많아 degree≥5 로 자연히 hub tier 다.
    const degree = new Map<string, number>([[hub.id, 6]]);
    const states = new Map<string, NodeState>();
    const visuals = planNodeVisuals([hub], degree, states);
    const v = visuals.get(hub.id)!;
    expect(v.tier).toBe("hub");
    expect(v.size).toBeCloseTo(NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale);
  });
});

describe("⑥ 회귀 0 — entity_group 신호 없는 노드는 시각 불변", () => {
  test("개념(classification_key)·태그·글 노드는 거대 크기를 안 받는다(degree 보간)", () => {
    // ④ 통합 안 된(동명 위계 루트 없는) 분류 키는 classification_key 그대로 — 작게 그려진다.
    const concept: GraphNode = {
      id: "concept:c1", type: "classification_key", sourceType: "classification_key", label: "병원",
    };
    const tag: GraphNode = { id: "concept:t1", type: "tag", sourceType: "tag", label: "메모" };
    const memory: GraphNode = { id: "node:1", type: "memory", sourceType: "text", label: "글" };

    // degree=0 이면 NODE_SIZE.min(거대 크기 아님).
    expect(nodeSizeOf(concept, 0)).toBeCloseTo(NODE_SIZE.min);
    expect(nodeSizeOf(tag, 0)).toBeCloseTo(NODE_SIZE.min);
    expect(nodeSizeOf(memory, 0)).toBeCloseTo(NODE_SIZE.min);
    // 거대 크기와 또렷이 다름.
    const giant = NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale;
    expect(nodeSizeOf(concept, 0)).toBeLessThan(giant);
  });

  test("기존 group:<type> 묶음 노드(작품·사람)도 이미 entity_group 이라 같은 거대 시각", () => {
    // ④ 가 통합 안 한 동명 위계 루트 없는 타입 묶음 노드 — 회귀 0(이미 entity_group).
    const groupWork: GraphNode = {
      id: "group:work", type: "entity_group", sourceType: "entity_group", groupType: "work", label: "작품 (전체)",
    };
    expect(nodeSizeOf(groupWork, 0)).toBeCloseTo(NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale);
    expect(decorationKindForGroup("work")).toBe("ring");
  });
});
