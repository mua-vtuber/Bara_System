// nodes.ts 순수 헬퍼 단위 테스트 — WebGL 비의존.
import { describe, test, expect } from "bun:test";
import {
  nodeDepthVisualMultiplier,
  nodeSizeOf,
  NODE_SIZE,
} from "./nodes.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { GraphNode } from "../graph-view-model.ts";

// 최소 픽스처 — 크기 계산에 필요한 칸만 채운다.
function makeNode(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return { type: "memory", label: partial.id, ...partial };
}

describe("nodeSizeOf — 노드 크기 계산", () => {
  test("entity_group 노드는 degree 에 무관하게 동일 크기를 돌려준다", () => {
    const g = makeNode({ id: "g1", type: "entity_group" });
    const sizeAt0 = nodeSizeOf(g as GraphNode, 0);
    const sizeAt99 = nodeSizeOf(g as GraphNode, 99);
    expect(sizeAt0).toBe(sizeAt99);
    // 값도 검증한다 — NODE_SIZE.max * groupScale 이 단일 출처.
    expect(sizeAt0).toBeCloseTo(NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale);
  });

  test("일반 노드는 degree 가 클수록 크기가 커진다", () => {
    const n = makeNode({ id: "n1", type: "memory" });
    const sizeAt0 = nodeSizeOf(n as GraphNode, 0);
    const sizeAt10 = nodeSizeOf(n as GraphNode, 10);
    expect(sizeAt10).toBeGreaterThan(sizeAt0);
  });

  test("일반 노드 degree=0 은 NODE_SIZE.min 을 돌려준다", () => {
    const n = makeNode({ id: "n1", type: "concept" });
    expect(nodeSizeOf(n as GraphNode, 0)).toBeCloseTo(NODE_SIZE.min);
  });
});

describe("nodeDepthVisualMultiplier — 화면 상대 깊이 별빛 보정", () => {
  test("가장 앞쪽 노드는 글로우와 코어 초점을 살짝 올린다", () => {
    const m = nodeDepthVisualMultiplier(0);
    expect(m.glowOpacity).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthFrontGlowBoost);
    expect(m.coreScale).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthFrontCoreScale);
    expect(m.haloOpacity).toBeCloseTo(1);
  });

  test("가장 뒤쪽 노드는 높은 floor 만큼만 얕게 물러난다", () => {
    const m = nodeDepthVisualMultiplier(1);
    expect(m.coreOpacity).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthBackCoreFloor);
    expect(m.glowOpacity).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthBackGlowFloor);
    expect(m.haloOpacity).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthBackHaloFloor);
    expect(m.coreScale).toBeCloseTo(1);
  });

  test("보호된 노드는 뒤쪽에 있어도 흐려지지 않는다", () => {
    const m = nodeDepthVisualMultiplier(1, true);
    expect(m.coreOpacity).toBeCloseTo(1);
    expect(m.glowOpacity).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthFrontGlowBoost);
    expect(m.haloOpacity).toBeCloseTo(1);
    expect(m.coreScale).toBeCloseTo(GRAPH_RENDER_THEME.nodeDepthFrontCoreScale);
  });
});
