import type { DashboardGraphViewModel, GraphEdge, GraphNode } from "./graph-view-model";

const DERIVED_EXPANSION_NODE_TYPES: ReadonlySet<GraphNode["type"]> = new Set([
  "document_chunk",
  "image_caption",
  "llm_extract",
]);

const COLLAPSIBLE_EXPANSION_NODE_TYPES: ReadonlySet<GraphNode["type"]> = new Set([
  "document_section",
  "document_chunk",
  "image_caption",
  "llm_extract",
]);

// export — node-transition.ts 의 scatter/gather anchor 판정(같은 파생 위계 엣지 기준)이 재사용한다.
export const EXPANSION_EDGE_TYPES: ReadonlySet<string> = new Set([
  "parent_of",
  "contains_section",
  "contains_chunk",
  "merged_into",
]);

export function expansionKeyForGraphNode(node: GraphNode | undefined): string | null {
  return typeof node?.sourceId === "number" ? `node:${node.sourceId}` : null;
}

function isCollapsibleExpansionNode(node: GraphNode | undefined): boolean {
  return node != null && COLLAPSIBLE_EXPANSION_NODE_TYPES.has(node.type);
}

function isExpansionEdge(edge: GraphEdge): boolean {
  return EXPANSION_EDGE_TYPES.has(edge.type);
}

// export — node-transition.ts 의 anchor 판정이 재사용한다.
export function otherEndpoint(edge: GraphEdge, nodeId: string): string | null {
  if (edge.from === nodeId) return edge.to;
  if (edge.to === nodeId) return edge.from;
  return null;
}

function nodeMap(vm: DashboardGraphViewModel): Map<string, GraphNode> {
  return new Map(vm.nodes.map((node) => [node.id, node]));
}

function originNodeIdsForKeys(
  vm: DashboardGraphViewModel,
  expansionKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const node of vm.nodes) {
    const key = expansionKeyForGraphNode(node);
    if (key && expansionKeys.has(key)) ids.add(node.id);
  }
  return ids;
}

export function expansionDescendantNodeIdsForKeys(
  vm: DashboardGraphViewModel,
  expansionKeys: ReadonlySet<string>,
): Set<string> {
  const byId = nodeMap(vm);
  const origins = originNodeIdsForKeys(vm, expansionKeys);
  const descendants = new Set<string>();
  const queue = [...origins];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const current = byId.get(currentId);
    if (!current) continue;

    for (const edge of vm.edges) {
      if (!isExpansionEdge(edge)) continue;
      const nextId = otherEndpoint(edge, currentId);
      if (!nextId || seen.has(nextId)) continue;
      const next = byId.get(nextId);
      if (!isCollapsibleExpansionNode(next)) continue;

      seen.add(nextId);
      descendants.add(nextId);
      queue.push(nextId);
    }
  }

  return descendants;
}

export function collapseExpansionKeysForNode(
  vm: DashboardGraphViewModel,
  nodeId: string,
  expandedKeys: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  const byId = nodeMap(vm);
  const node = byId.get(nodeId);
  const ownKey = expansionKeyForGraphNode(node);
  if (ownKey && expandedKeys.has(ownKey)) keys.add(ownKey);

  if (!node || (!DERIVED_EXPANSION_NODE_TYPES.has(node.type) && node.type !== "document_section")) {
    return keys;
  }

  for (const key of expandedKeys) {
    if (keys.has(key)) continue;
    if (expansionDescendantNodeIdsForKeys(vm, new Set([key])).has(nodeId)) {
      keys.add(key);
    }
  }

  return keys;
}
