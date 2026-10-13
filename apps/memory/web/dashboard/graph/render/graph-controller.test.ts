// planNodeVisuals 순수 헬퍼 단위 테스트 — WebGL 비의존.
// happy-dom 필요 없음 (DOM API 미사용).
import { describe, test, expect } from "bun:test";
import { toggleGroupExpansion } from "./graph-controller.ts";
import { planNodeVisuals, starColorForVitality } from "./nodes.ts";
import { resolveNodeStates } from "./highlight.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { GraphNode } from "../graph-view-model.ts";

// "#rrggbb" 한 채널을 0~255 정수로 푸는 보조 — 색 보간 방향 검증용.
function channel(hex: string, idx: 0 | 1 | 2): number {
  const v = hex.replace("#", "");
  return parseInt(v.slice(idx * 2, idx * 2 + 2), 16);
}

// ---- 테스트 픽스처 (순수 데이터) --------------------------------------------

function makeNode(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: "memory",
    label: partial.id,
    ...partial,
  };
}

// ---- 테스트 -----------------------------------------------------------------

describe("toggleGroupExpansion — 묶음 펼침 토글", () => {
  test("없던 묶음을 클릭하면 펼침 집합에 더해진다", () => {
    const set = new Set<string>();
    toggleGroupExpansion(set, "work");
    expect(set.has("work")).toBe(true);
  });
  test("있던 묶음을 다시 클릭하면 빠진다", () => {
    const set = new Set<string>(["work"]);
    toggleGroupExpansion(set, "work");
    expect(set.has("work")).toBe(false);
  });
});

describe("planNodeVisuals — hub/dot 분기", () => {
  test("project 타입은 항상 hub", () => {
    const nodes = [makeNode({ id: "n1", type: "project" })];
    const degree = new Map([["n1", 1]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n1")?.tier).toBe("hub");
  });

  test("person 타입은 항상 hub", () => {
    const nodes = [makeNode({ id: "n2", type: "person" })];
    const degree = new Map([["n2", 2]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n2")?.tier).toBe("hub");
  });

  test("importance >= 0.8 이면 hub", () => {
    const nodes = [makeNode({ id: "n3", type: "concept", importance: 0.8 })];
    const degree = new Map([["n3", 0]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n3")?.tier).toBe("hub");
  });

  test("degree >= 5 이면 hub (견본 T9 조건)", () => {
    const nodes = [makeNode({ id: "n4", type: "memory" })];
    const degree = new Map([["n4", 9]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n4")?.tier).toBe("hub");
  });

  test("memory 타입 degree=1 → dot", () => {
    const nodes = [makeNode({ id: "n5", type: "memory" })];
    const degree = new Map([["n5", 1]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n5")?.tier).toBe("dot");
  });

  test("concept 타입 importance=0.3, degree=2 → dot", () => {
    const nodes = [makeNode({ id: "n6", type: "concept", importance: 0.3 })];
    const degree = new Map([["n6", 2]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n6")?.tier).toBe("dot");
  });

  test("importance 경계값 0.79 → dot", () => {
    const nodes = [makeNode({ id: "n7", type: "tag", importance: 0.79 })];
    const degree = new Map([["n7", 0]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n7")?.tier).toBe("dot");
  });

  test("degree 경계값 4 → dot", () => {
    const nodes = [makeNode({ id: "n8", type: "memory" })];
    const degree = new Map([["n8", 4]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("n8")?.tier).toBe("dot");
  });
});

describe("planNodeVisuals — dim 플래그", () => {
  test("검색 없으면 neutral → dim=false", () => {
    const nodes = [makeNode({ id: "m1", type: "memory" })];
    const degree = new Map<string, number>();
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("m1")?.dim).toBe(false);
  });

  test("검색 결과에서 highlight 밖 노드 → dim=true", () => {
    const nodes = [
      makeNode({ id: "hit", type: "concept" }),
      makeNode({ id: "dimmed", type: "memory" }),
    ];
    const search = {
      query: "test",
      count: 1,
      top3: [{ nodeId: "hit" }],
      hits: [{ nodeId: "hit" }],
      highlightedNodeIds: ["hit"],
      highlightedEdgeIds: [],
    };
    const states = resolveNodeStates(nodes, [], search);
    const degree = new Map<string, number>();
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("hit")?.dim).toBe(false);
    expect(result.get("dimmed")?.dim).toBe(true);
  });

  test("1-hop 이웃(related)은 dim=false", () => {
    const nodes = [
      makeNode({ id: "a", type: "concept" }),
      makeNode({ id: "b", type: "memory" }),
      makeNode({ id: "c", type: "memory" }),
    ];
    const edges = [{ id: "e1", from: "a", to: "b", type: "related_to" }];
    const search = {
      query: "q",
      count: 1,
      top3: [{ nodeId: "a" }],
      hits: [{ nodeId: "a" }],
      highlightedNodeIds: ["a"],
      highlightedEdgeIds: ["e1"],
    };
    const states = resolveNodeStates(nodes, edges, search);
    const degree = new Map<string, number>();
    const result = planNodeVisuals(nodes, degree, states);
    // a=hit(not dim), b=related(not dim), c=dim
    expect(result.get("a")?.dim).toBe(false);
    expect(result.get("b")?.dim).toBe(false);
    expect(result.get("c")?.dim).toBe(true);
  });
});

describe("planNodeVisuals — size 범위", () => {
  // NODE_SIZE 1차 키움 후 범위: min 0.16 ~ max 0.52.
  test("size 는 항상 0.16 이상 0.52 이하", () => {
    const nodes: GraphNode[] = [
      makeNode({ id: "s1", type: "project",   importance: 1.0 }),
      makeNode({ id: "s2", type: "memory",    importance: 0.0 }),
      makeNode({ id: "s3", type: "concept",   importance: 0.5 }),
    ];
    const degree = new Map([["s1", 10], ["s2", 0], ["s3", 3]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    for (const [, v] of result) {
      expect(v.size).toBeGreaterThanOrEqual(0.16);
      expect(v.size).toBeLessThanOrEqual(0.52);
    }
  });
});

describe("starColorForVitality — 생명력 별 색 보간", () => {
  test("생명력 0 은 스펙트럼 첫 stop(붉은=죽어감)", () => {
    const first = GRAPH_RENDER_THEME.starSpectrum[0]![1];
    expect(starColorForVitality(0)).toBe(first);
  });

  test("생명력 1 은 스펙트럼 마지막 stop(흰빛=살아있음)", () => {
    const last = GRAPH_RENDER_THEME.starSpectrum.at(-1)![1];
    expect(starColorForVitality(1)).toBe(last);
  });

  test("0~1 밖 입력은 끝 색으로 clamp 한다", () => {
    const first = GRAPH_RENDER_THEME.starSpectrum[0]![1];
    const last = GRAPH_RENDER_THEME.starSpectrum.at(-1)![1];
    expect(starColorForVitality(-0.5)).toBe(first);
    expect(starColorForVitality(1.5)).toBe(last);
  });

  test("생명력이 오를수록 더 밝아진다 — G 채널이 단조 증가한다", () => {
    // 오로라 재조율: 어두운 보라 #5a4a9a → 청록 #38e8ff → 흰 #f0ecff.
    // B 채널은 청록·백색 구간에서 255 로 포화돼 단조 증가 검증에 못 쓰지만(둘 다 최대치 근접),
    // G 채널은 74→153→232→234→236 로 끝까지 단조 증가해 생명력 변별을 그대로 증명한다.
    // 실데이터가 오늘 균일해도 헬퍼 자체는 생명력을 변별함을 인위 입력으로 증명한다.
    const samples = [0.0, 0.25, 0.5, 0.75, 1.0].map((v) => starColorForVitality(v));
    for (let i = 1; i < samples.length; i++) {
      expect(channel(samples[i]!, 1)).toBeGreaterThan(channel(samples[i - 1]!, 1));
    }
  });

  test("스펙트럼 stop 과 정확히 겹치는 생명력은 그 stop 색과 일치한다", () => {
    // starSpectrum stop 위치 = 0 / 0.25 / 0.5 / 0.75 / 1.
    const second = GRAPH_RENDER_THEME.starSpectrum[1]![1];
    expect(starColorForVitality(0.25)).toBe(second);
    const fourth = GRAPH_RENDER_THEME.starSpectrum[3]![1];
    expect(starColorForVitality(0.75)).toBe(fourth);
  });
});

describe("planNodeVisuals — 크기=degree / 색=생명력 (채널 분리)", () => {
  test("연결이 많은 노드가 연결 적은 노드보다 크다(크기=degree)", () => {
    const nodes: GraphNode[] = [
      makeNode({ id: "weak", type: "memory", vitality: 0.5 }),
      makeNode({ id: "strong", type: "memory", vitality: 0.5 }),
    ];
    // 같은 생명력, degree 만 다르게 둬 크기가 degree 만 따르는지 본다.
    const degree = new Map([["weak", 1], ["strong", 12]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("strong")!.size).toBeGreaterThan(result.get("weak")!.size);
  });

  test("크기는 degree 만 따른다 — 생명력이 달라도 같은 degree 면 같은 크기", () => {
    const nodes: GraphNode[] = [
      makeNode({ id: "dying", type: "memory", vitality: 0.05 }),
      makeNode({ id: "alive", type: "memory", vitality: 0.95 }),
    ];
    const degree = new Map([["dying", 4], ["alive", 4]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("dying")!.size).toBeCloseTo(result.get("alive")!.size, 10);
  });

  test("색은 생명력만 따른다 — degree 가 달라도 같은 생명력이면 같은 색", () => {
    const nodes: GraphNode[] = [
      makeNode({ id: "few", type: "memory", vitality: 0.6 }),
      makeNode({ id: "many", type: "memory", vitality: 0.6 }),
    ];
    const degree = new Map([["few", 1], ["many", 12]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("few")!.color).toBe(starColorForVitality(0.6));
    expect(result.get("many")!.color).toBe(starColorForVitality(0.6));
  });

  test("생명력 없는 엔티티(개념·사람)는 기본색을 받는다", () => {
    const nodes: GraphNode[] = [
      makeNode({ id: "concept:c1", type: "concept" }),
      makeNode({ id: "person:p1", type: "person" }),
    ];
    const degree = new Map([["concept:c1", 3], ["person:p1", 3]]);
    const states = resolveNodeStates(nodes, [], undefined);
    const result = planNodeVisuals(nodes, degree, states);
    expect(result.get("concept:c1")!.color).toBe(GRAPH_RENDER_THEME.nodeDefaultColor);
    expect(result.get("person:p1")!.color).toBe(GRAPH_RENDER_THEME.nodeDefaultColor);
  });
});
