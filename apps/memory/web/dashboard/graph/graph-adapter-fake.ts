import {
  type DashboardGraphViewModel,
  type GraphEdge,
  type GraphNode,
  emptyGraphViewModel,
  uniqueGraphEdges,
  uniqueGraphNodes,
} from "./graph-view-model";

export interface FakeBaraNode {
  id: string;
  type?: string;
  label?: string;
  snippet?: string;
  importance?: number;
  activity?: number;
  createdAt?: number | string;
  memoryAt?: number | string;
  path?: string[];
}

export interface FakeBaraEdge {
  id?: string;
  from: string;
  to: string;
  type?: string;
  weight?: number;
  confidence?: number;
}

export interface FakeBaraSearchHit {
  nodeId: string;
  score?: number;
}

export interface FakeBaraSearchResponse {
  query: string;
  hits: FakeBaraSearchHit[];
  top3: FakeBaraSearchHit[];
  focus?: {
    highlightedNodeIds?: string[];
    highlightedEdgeIds?: string[];
  };
}

export interface FakeBaraShape {
  NODES_LIST?: FakeBaraNode[];
  EDGES?: FakeBaraEdge[];
  buildSearchResponse?: (queryId: string) => FakeBaraSearchResponse | null;
}

export function buildFakeGraphViewModel(
  fake: FakeBaraShape,
  queryId?: string,
): DashboardGraphViewModel {
  const base = emptyGraphViewModel();
  const nodes = uniqueGraphNodes((fake.NODES_LIST ?? []).map(fakeNodeToGraphNode));
  const edges = uniqueGraphEdges((fake.EDGES ?? []).map(fakeEdgeToGraphEdge));
  const searchResponse = queryId ? fake.buildSearchResponse?.(queryId) ?? null : null;

  return {
    ...base,
    nodes,
    edges,
    clusters: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length },
    recent: nodes.slice(0, 20).map((node) => ({ nodeId: node.id })),
    ...(searchResponse
      ? {
          search: {
            query: searchResponse.query,
            count: searchResponse.hits.length,
            top3: searchResponse.top3.map((hit) => ({
              nodeId: hit.nodeId,
              score: hit.score,
            })),
            hits: searchResponse.hits.map((hit) => ({
              nodeId: hit.nodeId,
              score: hit.score,
            })),
            highlightedNodeIds: searchResponse.focus?.highlightedNodeIds ?? [],
            highlightedEdgeIds: searchResponse.focus?.highlightedEdgeIds ?? [],
          },
        }
      : {}),
  };
}

function fakeNodeToGraphNode(node: FakeBaraNode): GraphNode {
  return {
    id: node.id,
    type: node.type === "document_chunk" || node.type === "chunk"
      ? "document_chunk"
      : node.type === "project" ||
          node.type === "concept" ||
          node.type === "person" ||
          node.type === "document" ||
          node.type === "image" ||
          node.type === "decision" ||
          node.type === "tag" ||
          node.type === "memory"
        ? node.type
        : "unknown",
    sourceType: node.type,
    label: node.label ?? node.id,
    snippet: node.snippet,
    path: node.path,
    importance: node.importance,
    createdAt: stringifyDateLike(node.createdAt),
    memoryAt: stringifyDateLike(node.memoryAt),
    meta: typeof node.activity === "number" ? { activity: node.activity } : undefined,
  };
}

function fakeEdgeToGraphEdge(edge: FakeBaraEdge): GraphEdge {
  return {
    id: edge.id ?? `edge:${edge.from}->${edge.to}:${edge.type ?? "related"}`,
    from: edge.from,
    to: edge.to,
    type: edge.type ?? "related",
    weight: edge.weight,
    confidence: edge.confidence,
  };
}

function stringifyDateLike(value: number | string | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}
