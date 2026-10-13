import { expect, test } from "bun:test";
import { SEARCH_RADIAL_LAYOUT } from "./search-layout.ts";
import { computeRadialLayout } from "./radial-layout.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import { boundingSize } from "../render/camera-focus.ts";
import type { GraphEdge, GraphNode } from "../graph-view-model.ts";

const overviewTokens = GRAPH_RENDER_THEME.radialLayout;

const N = (id: string, type: GraphNode["type"] = "memory"): GraphNode => ({ id, type, label: id });
const E = (from: string, to: string, type = "related"): GraphEdge => ({ id: `${from}->${to}:${type}`, from, to, type });

test("검색 레이아웃은 독립 hit 를 overview orphan shell 보다 가까이 모은다", () => {
  const nodes = [
    N("node:1"), N("node:2"), N("node:3"),
    N("group:work", "entity_group"), N("node:context"),
  ];
  const edges = [E("group:work", "node:context", "parent_of")];

  const overview = computeRadialLayout(nodes, edges, overviewTokens);
  const search = computeRadialLayout(nodes, edges, SEARCH_RADIAL_LAYOUT);
  const hitIds = ["node:1", "node:2", "node:3"];
  const overviewHitSize = boundingSize(hitIds.map((id) => overview.get(id)!));
  const searchHitSize = boundingSize(hitIds.map((id) => search.get(id)!));

  expect(SEARCH_RADIAL_LAYOUT.orphanShellRadius).toBeLessThan(overviewTokens.orphanShellRadius);
  expect(searchHitSize).toBeLessThan(overviewHitSize * 0.35);
  expect(searchHitSize).toBeLessThanOrEqual(18);
});
