import { describe, expect, test } from "bun:test";
import type { GraphNode } from "../graph-view-model.ts";
import {
  isRecentNode,
  recentNodeGlowBoost,
  resolveRecentNodeIds,
} from "./recent-node.ts";

function node(id: string, createdAt?: string): GraphNode {
  return { id, type: "memory", label: id, createdAt };
}

describe("recent node helpers", () => {
  const opts = {
    windowHours: 12,
    labelCap: 15,
    glowMultiplier: 1.45,
    pulseDurationS: 20,
    pulseAmplitude: 0.22,
  };
  const now = Date.parse("2026-06-30T12:00:00Z");

  test("createdAt 기준 12시간 안 노드는 recent", () => {
    expect(isRecentNode(node("a", "2026-06-30T01:00:00Z"), new Map(), now, opts)).toBe(true);
    expect(isRecentNode(node("b", "2026-06-29T23:00:00Z"), new Map(), now, opts)).toBe(false);
  });

  test("세션 중 새로 들어온 노드는 createdAt 이 없어도 recent", () => {
    const session = new Map([["a", now - 1000]]);

    expect(isRecentNode(node("a"), session, now, opts)).toBe(true);
    expect(isRecentNode(node("b"), session, now, opts)).toBe(false);
  });

  test("라벨 대상은 최근순 15개까지만 남긴다", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`));
    const session = new Map(nodes.map((n, i) => [n.id, now - i * 1000]));
    const ids = resolveRecentNodeIds(nodes, session, now, opts);

    expect(ids.size).toBe(15);
    expect(ids.has("n0")).toBe(true);
    expect(ids.has("n14")).toBe(true);
    expect(ids.has("n15")).toBe(false);
  });

  test("recent glow boost 는 1 보다 크고 오래된 노드는 1 이다", () => {
    const recent = recentNodeGlowBoost(node("a", "2026-06-30T11:59:50Z"), new Map(), now, 10, opts);
    const old = recentNodeGlowBoost(node("b", "2026-06-29T00:00:00Z"), new Map(), now, 10, opts);

    expect(recent).toBeGreaterThan(1);
    expect(old).toBe(1);
  });
});
