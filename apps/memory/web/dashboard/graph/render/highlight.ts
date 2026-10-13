import type { GraphNode, GraphEdge, GraphSearchView } from "../graph-view-model";

export type NodeState = "neutral" | "hit" | "related" | "dim";
export type EdgeState = "ambient" | "focus" | "dim";

export interface EdgeFocusOptions {
  hoveredId?: string | null;
  selectedId?: string | null;
}

/**
 * 검색 focus 기준으로 각 노드의 시각 상태를 결정한다.
 *
 * - search 없음 → 모든 노드 "neutral"
 * - search 있음:
 *   - highlightedNodeIds 에 포함된 노드 → "hit"
 *   - hit 노드와 엣지로 직접 연결된 1-hop 이웃 → "related"
 *   - 그 외 → "dim"
 *   hit 이 related 이웃과 겹치면 hit 우선.
 */
export function resolveNodeStates(
  nodes: GraphNode[],
  edges: GraphEdge[],
  search: GraphSearchView | undefined,
): Map<string, NodeState> {
  const out = new Map<string, NodeState>();

  if (!search) {
    for (const n of nodes) out.set(n.id, "neutral");
    return out;
  }

  const hits = new Set(search.highlightedNodeIds);

  const related = new Set<string>();
  for (const e of edges) {
    if (hits.has(e.from)) related.add(e.to);
    if (hits.has(e.to)) related.add(e.from);
  }

  for (const n of nodes) {
    if (hits.has(n.id)) {
      out.set(n.id, "hit");
    } else if (related.has(n.id)) {
      out.set(n.id, "related");
    } else {
      out.set(n.id, "dim");
    }
  }

  return out;
}

/**
 * 검색·호버·선택 focus 기준으로 각 엣지의 표시 상태를 결정한다.
 *
 * - search/호버/선택 없음 → 모든 엣지 "ambient"
 * - 호버/선택 노드에 직접 닿은 엣지 → "focus"
 * - search 있음 → highlightedEdgeIds 또는 호버/선택 incident 엣지는 "focus", 나머지 "dim"
 */
export function resolveEdgeStates(
  edges: GraphEdge[],
  search: GraphSearchView | undefined,
  focus: EdgeFocusOptions = {},
): Map<string, EdgeState> {
  const out = new Map<string, EdgeState>();
  const focusedNodeIds = new Set(
    [focus.selectedId, focus.hoveredId].filter((id): id is string => !!id),
  );
  const focusedEdgeIds = search ? new Set(search.highlightedEdgeIds) : undefined;

  for (const e of edges) {
    const incidentFocus = focusedNodeIds.has(e.from) || focusedNodeIds.has(e.to);
    if (focusedEdgeIds) {
      out.set(e.id, focusedEdgeIds.has(e.id) || incidentFocus ? "focus" : "dim");
    } else {
      out.set(e.id, incidentFocus ? "focus" : "ambient");
    }
  }

  return out;
}
