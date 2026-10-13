import { GRAPH_RENDER_THEME } from "../graph/graph-theme.ts";
import type { GraphEdge, GraphNode } from "../graph/graph-view-model.ts";
import type { DashboardSelection, GraphOverviewResponse } from "./types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const OVERVIEW_NODE_LIMIT = 120;
const OVERVIEW_EDGE_LIMIT = 120;
const OVERVIEW_LABEL_LIMIT = 5;
const FOCUS_EDGE_LIMIT = 8;
const FOCUS_NEIGHBOR_LABEL_LIMIT = 3;

interface MiniGraphOptions {
  overview: GraphOverviewResponse | null;
  selection: DashboardSelection;
  onPickNode: (node: GraphNode) => void;
  newNodeIds?: ReadonlySet<string>;
}

interface PositionedNode {
  node: GraphNode;
  x: number;
  y: number;
  label: boolean;
  center: boolean;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function selectedNodeId(selection: DashboardSelection): string | null {
  if (selection.kind === "none") return null;
  return selection.graphNodeId;
}

function nodeColor(node: GraphNode): string {
  return GRAPH_RENDER_THEME.nodeTypeColors[node.type] ?? GRAPH_RENDER_THEME.nodeDefaultColor;
}

function edgeColor(edge: GraphEdge): string {
  if (edge.type === "member_of") return GRAPH_RENDER_THEME.edgeMembership;
  if (edge.type === "owns_memory") return GRAPH_RENDER_THEME.edgeProjectOwnership;
  if (edge.type.includes("_by") || edge.type.includes("_at")) {
    return GRAPH_RENDER_THEME.edgeRelation;
  }
  return GRAPH_RENDER_THEME.edgeHigh;
}

function shortLabel(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  if (clean.length <= 14) return clean;
  return `${clean.slice(0, 13)}…`;
}

function connectedEdges(edges: GraphEdge[], centerId: string): GraphEdge[] {
  return edges
    .filter((edge) => edge.from === centerId || edge.to === centerId)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, FOCUS_EDGE_LIMIT);
}

function nodeWeight(node: GraphNode, degree: Map<string, number>): number {
  return (degree.get(node.id) ?? 0) + (node.importance ?? 0) * 4;
}

function degreeMap(edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return degree;
}

function strongestEdges(edges: GraphEdge[], limit: number): GraphEdge[] {
  return [...edges]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, limit);
}

function edgeStrokeWidth(edge: GraphEdge, mode: "overview" | "focus"): string {
  const weight = edge.weight ?? 0;
  const width =
    mode === "overview"
      ? Math.max(0.12, Math.min(0.62, 0.14 + weight * 0.42))
      : Math.max(0.16, Math.min(0.82, 0.2 + weight * 0.62));
  return width.toFixed(2);
}

function positionNodes(
  center: GraphNode,
  neighbors: GraphNode[],
  edges: GraphEdge[],
): PositionedNode[] {
  const positioned: PositionedNode[] = [
    { node: center, x: 50, y: 50, label: true, center: true },
  ];
  const labelIds = new Set(
    [...neighbors]
      .sort((a, b) => {
        const aw = edges.find((edge) => edge.from === a.id || edge.to === a.id)?.weight ?? 0;
        const bw = edges.find((edge) => edge.from === b.id || edge.to === b.id)?.weight ?? 0;
        return bw - aw;
      })
      .slice(0, FOCUS_NEIGHBOR_LABEL_LIMIT)
      .map((node) => node.id),
  );
  const radius = neighbors.length <= 5 ? 29 : 33;
  neighbors.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, neighbors.length)) * Math.PI * 2;
    positioned.push({
      node,
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      label: labelIds.has(node.id),
      center: false,
    });
  });
  return positioned;
}

function positionOverviewNodes(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  const total = Math.max(1, nodes.length);
  const degree = degreeMap(edges);
  const labelIds = new Set(
    [...nodes]
      .sort((a, b) => nodeWeight(b, degree) - nodeWeight(a, degree))
      .slice(0, OVERVIEW_LABEL_LIMIT)
      .map((node) => node.id),
  );
  return nodes.map((node, index) => {
    if (total === 1) {
      return { node, x: 50, y: 50, label: true, center: false };
    }
    const progress = index / Math.max(1, total - 1);
    const radius = 9 + progress * 39;
    const angle = index * 2.399963229728653;
    return {
      node,
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      label: labelIds.has(node.id),
      center: false,
    };
  });
}

function appendNode(
  svg: SVGSVGElement,
  item: PositionedNode,
  onPickNode: (node: GraphNode) => void,
  newNodeIds: ReadonlySet<string>,
): void {
  const isNew = newNodeIds.has(item.node.id);
  const group = svgEl("g", {
    class: item.center
      ? `mini-graph__node mini-graph__node--center${isNew ? " mini-graph__node--new" : ""}`
      : `mini-graph__node${isNew ? " mini-graph__node--new" : ""}`,
    role: "button",
    tabindex: "0",
    "aria-label": item.node.label,
    "data-node-id": item.node.id,
  });
  group.setAttribute("style", `color:${nodeColor(item.node)}`);
  if (isNew) {
    group.append(svgEl("circle", {
      class: "mini-graph__birth-ripple",
      cx: String(item.x),
      cy: String(item.y),
      r: item.center ? "4.2" : "2.2",
    }));
  }
  group.append(svgEl("circle", {
    class: "mini-graph__node-glow",
    cx: String(item.x),
    cy: String(item.y),
    r: item.center ? "6.2" : "3.2",
  }));
  const circle = svgEl("circle", {
    class: "mini-graph__node-core",
    cx: String(item.x),
    cy: String(item.y),
    r: item.center ? "3.8" : "1.9",
    fill: nodeColor(item.node),
  });
  group.append(circle);
  group.addEventListener("click", () => onPickNode(item.node));
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPickNode(item.node);
    }
  });
  svg.append(group);
}

function appendLabel(svg: SVGSVGElement, item: PositionedNode): void {
  const text = svgEl("text", {
    class: item.center ? "mini-graph__label mini-graph__label--center" : "mini-graph__label",
    x: String(item.center ? item.x + 6 : item.x + 4),
    y: String(item.y - 4),
  });
  text.textContent = shortLabel(item.node.label);
  svg.append(text);
}

function renderOverviewGraph(
  host: HTMLElement,
  overview: GraphOverviewResponse,
  onPickNode: (node: GraphNode) => void,
  newNodeIds: ReadonlySet<string>,
): void {
  const visibleNodes = overview.nodes.slice(0, OVERVIEW_NODE_LIMIT);
  if (visibleNodes.length === 0) {
    host.append(emptyState("그래프에 표시할 노드가 아직 없습니다."));
    return;
  }

  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = strongestEdges(
    overview.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    OVERVIEW_EDGE_LIMIT,
  );
  const positioned = positionOverviewNodes(visibleNodes, visibleEdges);
  const posById = new Map(positioned.map((item) => [item.node.id, item]));
  const svg = svgEl("svg", {
    class: "mini-graph__svg mini-graph__svg--overview",
    viewBox: "0 0 100 100",
    role: "img",
    "aria-label": "전체 그래프 overview",
  });

  for (const edge of visibleEdges) {
    const from = posById.get(edge.from);
    const to = posById.get(edge.to);
    if (!from || !to) continue;
    svg.append(svgEl("line", {
      class: "mini-graph__edge",
      x1: String(from.x),
      y1: String(from.y),
      x2: String(to.x),
      y2: String(to.y),
      stroke: edgeColor(edge),
      "stroke-width": edgeStrokeWidth(edge, "overview"),
    }));
  }

  for (const item of positioned) appendNode(svg, item, onPickNode, newNodeIds);
  for (const item of positioned.filter((p) => p.label)) appendLabel(svg, item);
  host.append(svg);
}

export function renderMiniGraph(host: HTMLElement, options: MiniGraphOptions): void {
  host.replaceChildren();

  const centerId = selectedNodeId(options.selection);
  const newNodeIds = options.newNodeIds ?? new Set<string>();
  if (!options.overview) {
    host.append(emptyState("그래프 로딩 중..."));
    return;
  }

  if (!centerId) {
    renderOverviewGraph(
      host,
      options.overview,
      options.onPickNode,
      newNodeIds,
    );
    return;
  }

  const nodeById = new Map(options.overview.nodes.map((node) => [node.id, node]));
  const center = nodeById.get(centerId);
  if (!center) {
    host.append(emptyState("선택한 노드를 그래프 overview에서 찾지 못했습니다."));
    return;
  }

  const edges = connectedEdges(options.overview.edges, centerId);
  const neighbors = edges
    .map((edge) => nodeById.get(edge.from === centerId ? edge.to : edge.from))
    .filter((node): node is GraphNode => node != null)
    .filter((node, index, arr) => arr.findIndex((n) => n.id === node.id) === index);

  if (neighbors.length === 0) {
    host.append(emptyState("주변 연결이 아직 없습니다."));
    return;
  }

  const positioned = positionNodes(center, neighbors, edges);
  const posById = new Map(positioned.map((item) => [item.node.id, item]));
  const svg = svgEl("svg", {
    class: "mini-graph__svg",
    viewBox: "0 0 100 100",
    role: "img",
    "aria-label": `${center.label} 주변 관계`,
  });

  for (const edge of edges) {
    const from = posById.get(edge.from);
    const to = posById.get(edge.to);
    if (!from || !to) continue;
    const line = svgEl("line", {
      class: "mini-graph__edge",
      x1: String(from.x),
      y1: String(from.y),
      x2: String(to.x),
      y2: String(to.y),
      stroke: edgeColor(edge),
      "stroke-width": edgeStrokeWidth(edge, "focus"),
    });
    svg.append(line);
  }

  for (const item of positioned) {
    appendNode(svg, item, options.onPickNode, newNodeIds);
  }
  for (const item of positioned.filter((p) => p.label)) appendLabel(svg, item);

  host.append(svg);
}

function emptyState(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "mini-graph__empty";
  node.textContent = text;
  return node;
}
