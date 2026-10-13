import type { GraphEdge, GraphNode } from "../graph-view-model.ts";
import { buildHierarchy } from "../layout/radial-hierarchy.ts";
import type { GraphDiff } from "./graph-diff.ts";

export type ReflowMode = "local" | "global";

export interface ReflowModeOptions {
  maxLocalAddedNodes: number;
}

const DEFAULT_REFLOW_OPTIONS: ReflowModeOptions = {
  maxLocalAddedNodes: 8,
};

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function rootSet(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  return new Set(buildHierarchy(nodes, edges).roots);
}

export function classifyReflowMode(
  diff: GraphDiff,
  prevNodes: GraphNode[],
  prevEdges: GraphEdge[],
  nextNodes: GraphNode[],
  nextEdges: GraphEdge[],
  options: ReflowModeOptions = DEFAULT_REFLOW_OPTIONS,
): ReflowMode {
  if (diff.addedNodeIds.length > options.maxLocalAddedNodes) return "global";

  const nextById = new Map(nextNodes.map((node) => [node.id, node]));
  for (const id of diff.addedNodeIds) {
    const node = nextById.get(id);
    if (!node) continue;
    if (node.type === "entity_group" || node.type === "classification_key") {
      return "global";
    }
  }

  const prevRoots = rootSet(prevNodes, prevEdges);
  const nextRoots = rootSet(nextNodes, nextEdges);
  return sameSet(prevRoots, nextRoots) ? "local" : "global";
}
