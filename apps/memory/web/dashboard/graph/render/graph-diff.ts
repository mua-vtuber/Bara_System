import type { GraphNode, GraphEdge } from "../graph-view-model.ts";

export interface GraphDiff {
  addedNodeIds: string[];
  removedNodeIds: string[];
  keptNodeIds: string[];
  addedEdgeKeys: string[];
  removedEdgeKeys: string[];
}

/** 엣지 동일성 키 — from·to·type 셋이 같아야 같은 엣지. */
export function edgeKey(edge: GraphEdge): string {
  return `${edge.from} ${edge.to} ${edge.type}`;
}

export function diffGraph(
  prevNodes: GraphNode[], prevEdges: GraphEdge[],
  nextNodes: GraphNode[], nextEdges: GraphEdge[],
): GraphDiff {
  const prevIds = new Set(prevNodes.map((nd) => nd.id));
  const nextIds = new Set(nextNodes.map((nd) => nd.id));

  const addedNodeIds: string[] = [];
  const keptNodeIds: string[] = [];
  for (const nd of nextNodes) {
    if (prevIds.has(nd.id)) keptNodeIds.push(nd.id);
    else addedNodeIds.push(nd.id);
  }
  const removedNodeIds = prevNodes.map((nd) => nd.id).filter((id) => !nextIds.has(id));

  const prevEdgeKeys = new Set(prevEdges.map(edgeKey));
  const nextEdgeKeys = new Set(nextEdges.map(edgeKey));
  const addedEdgeKeys = [...nextEdgeKeys].filter((k) => !prevEdgeKeys.has(k));
  const removedEdgeKeys = [...prevEdgeKeys].filter((k) => !nextEdgeKeys.has(k));

  return { addedNodeIds, removedNodeIds, keptNodeIds, addedEdgeKeys, removedEdgeKeys };
}
