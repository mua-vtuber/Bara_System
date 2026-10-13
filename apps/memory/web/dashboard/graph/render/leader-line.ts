// 리더 라인: 노드 3D 위치 → 화면 2D 좌표 투영 + HTML 라벨 이동
// 견본 graph-3d.js: updateLabels(L1167) 의 view.project(camera) 패턴 이식.
// Three.js 객체 없는 투영 계산은 camera.project 를 직접 사용.
import * as THREE from "three";
import type { GraphEdge, GraphNode, GraphNodeType } from "../graph-view-model.ts";
import { displayTitleForNode } from "../../ui/hashtag-display.ts";

// ---- 상수 -------------------------------------------------------------------

/** 라벨을 점 오른쪽으로 띄우는 X 오프셋 (픽셀) — 점 반지름 + 여백 */
const LABEL_X_OFFSET_PX = 10 as const;

/** 화면 밖 허용 범위 (px) — 이 범위 밖이면 hidden */
const CLIP_MARGIN_X = 80 as const;
const CLIP_MARGIN_Y = 30 as const;

/** 라벨 표시 글자 상한 — 넘으면 말줄임(…). 원본 label 은 보존하고 표시만 단축. */
const LABEL_MAX_CHARS = 16 as const;

/** 표시용 라벨을 만든다 — LABEL_MAX_CHARS 초과 시 잘라 말줄임 처리. */
function truncateLabel(label: string): string {
  if (label.length <= LABEL_MAX_CHARS) return label;
  return label.slice(0, LABEL_MAX_CHARS) + "…";
}

// ---- 라벨 관리 --------------------------------------------------------------

export interface LabelEntry {
  el: HTMLDivElement;
  nodeId: string;
}

/**
 * 라벨 컨테이너와 노드 배열을 받아 HTML div 라벨을 만든다.
 * SVG 아이콘은 MVP 에서 생략 — 텍스트 라벨만.
 */
export function createLabels(
  container: HTMLElement,
  nodes: GraphNode[],
): Map<string, LabelEntry> {
  const map = new Map<string, LabelEntry>();
  for (const node of nodes) {
    const el = document.createElement("div");
    el.className = `node-label type-${node.type}`;
    const label = displayTitleForNode(node);
    // 표시는 단축본, 전체 라벨은 title 로 보존(hover 시 노출).
    el.textContent = truncateLabel(label);
    el.title = label;
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.userSelect = "none";
    container.appendChild(el);
    map.set(node.id, { el, nodeId: node.id });
  }
  return map;
}

/** 라벨 div 전체를 DOM 에서 제거하고 Map 을 비운다. */
export function removeLabels(
  container: HTMLElement,
  labels: Map<string, LabelEntry>,
): void {
  for (const { el } of labels.values()) {
    if (el.parentNode === container) container.removeChild(el);
  }
  labels.clear();
}

// ---- 투영 + 위치 갱신 -------------------------------------------------------

const _projVec = new THREE.Vector3();

/**
 * 매 프레임 호출: 노드 Group 의 월드 좌표를 화면 좌표로 투영해 라벨을 이동한다.
 * 화면 밖 라벨은 hidden 클래스로 숨긴다.
 *
 * 견본 graph-3d.js updateLabels(L1167~1194):
 *   group.getWorldPosition(view); view.project(camera);
 *   x = (view.x * 0.5 + 0.5) * width;
 *   y = (-view.y * 0.5 + 0.5) * height;
 */
export function updateLabelPositions(
  labels: Map<string, LabelEntry>,
  nodeGroups: Map<string, THREE.Group>,
  camera: THREE.Camera,
  containerWidth: number,
  containerHeight: number,
  visibleIds: ReadonlySet<string>,
): void {
  const w = containerWidth;
  const h = containerHeight;

  for (const [nodeId, { el }] of labels) {
    const group = nodeGroups.get(nodeId);
    if (!group) {
      el.classList.add("hidden");
      continue;
    }

    if (!visibleIds.has(nodeId)) {
      el.classList.add("hidden");
      continue;
    }

    group.getWorldPosition(_projVec);
    _projVec.project(camera);

    const x = (_projVec.x * 0.5 + 0.5) * w;
    const y = (-_projVec.y * 0.5 + 0.5) * h;

    const inClip =
      _projVec.z > -1 &&
      _projVec.z < 1 &&
      x > -CLIP_MARGIN_X &&
      x < w + CLIP_MARGIN_X &&
      y > -CLIP_MARGIN_Y &&
      y < h + CLIP_MARGIN_Y;

    if (!inClip) {
      el.classList.add("hidden");
    } else {
      el.classList.remove("hidden");
      // 점 오른쪽에 붙여 "● 라벨" 한 줄로 읽히게: left 는 점 + 여백, top 은 점 세로 중앙.
      // 세로 중앙 정렬은 .node-label CSS 의 transform:translateY(-50%) 가 맡는다.
      el.style.left = `${(x + LABEL_X_OFFSET_PX).toFixed(1)}px`;
      el.style.top  = `${y.toFixed(1)}px`;
    }
  }
}

/**
 * 개별 엔티티 타입 집합(신규 8 타입 + project + person·Q6).
 * 이 타입 노드의 이름표는 평소 숨기고, 그 타입 묶음이 펼침일 때만 켠다.
 * 강한 노드 자동 라벨·인터랙션 라벨 모두 이 집합을 게이트로 본다.
 */
const INDIVIDUAL_ENTITY_TYPES: ReadonlySet<GraphNodeType> = new Set<GraphNodeType>([
  "creature", "thing", "intake", "usable", "work", "material", "place", "schedule",
  "project", "person",
]);

const STRUCTURAL_PARENT_FROM_TYPES: ReadonlySet<string> = new Set([
  "owns_memory",
  "member_of",
  "parent_of",
  "mentions_entity",
]);

const EMPTY_EXPAND: ReadonlySet<string> = new Set<string>();

function shouldShowHierarchyContextLabel(node: GraphNode): boolean {
  return (
    node.type === "classification_key" ||
    node.type === "concept" ||
    node.type === "entity_group" ||
    INDIVIDUAL_ENTITY_TYPES.has(node.type)
  );
}

function collectExpandedHierarchyLabels(
  nodes: GraphNode[],
  edges: readonly GraphEdge[],
  expandedGroupTypes: ReadonlySet<string>,
): Set<string> {
  if (expandedGroupTypes.size === 0 || edges.length === 0) return new Set();

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOfChildren = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "parent_of") continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const children = parentOfChildren.get(edge.from) ?? [];
    children.push(edge.to);
    parentOfChildren.set(edge.from, children);
  }

  const visible = new Set<string>();
  const roots = nodes.filter(
    (node) =>
      node.type === "entity_group" &&
      node.groupType != null &&
      expandedGroupTypes.has(node.groupType),
  );
  const queue = roots.map((node) => node.id);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const childId of parentOfChildren.get(parentId) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = byId.get(childId);
      if (child && shouldShowHierarchyContextLabel(child)) visible.add(childId);
      queue.push(childId);
    }
  }
  return visible;
}

function collectSelectedHierarchyLabels(
  nodes: GraphNode[],
  edges: readonly GraphEdge[],
  selectedId: string | null,
): Set<string> {
  if (!selectedId || edges.length === 0) return new Set();

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentsByChild = new Map<string, string[]>();
  const addParent = (childId: string, parentId: string): void => {
    if (!byId.has(childId) || !byId.has(parentId)) return;
    const parents = parentsByChild.get(childId) ?? [];
    parents.push(parentId);
    parentsByChild.set(childId, parents);
  };

  for (const edge of edges) {
    if (STRUCTURAL_PARENT_FROM_TYPES.has(edge.type)) {
      addParent(edge.to, edge.from);
    } else if (edge.type === "merged_into") {
      addParent(edge.from, edge.to);
    }
  }

  const visible = new Set<string>();
  const queue = [selectedId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const childId = queue.shift()!;
    for (const parentId of parentsByChild.get(childId) ?? []) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent && shouldShowHierarchyContextLabel(parent)) visible.add(parentId);
      queue.push(parentId);
    }
  }
  return visible;
}

function collectHoverNeighborLabels(
  nodes: GraphNode[],
  edges: readonly GraphEdge[],
  hoveredId: string | null,
  maxDepth = 2,
): Set<string> {
  if (!hoveredId || edges.length === 0 || maxDepth <= 0) return new Set();

  const byId = new Set(nodes.map((node) => node.id));
  if (!byId.has(hoveredId)) return new Set();

  const adjacency = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    if (!byId.has(from) || !byId.has(to)) return;
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  };

  for (const edge of edges) {
    add(edge.from, edge.to);
    add(edge.to, edge.from);
  }

  const visible = new Set<string>();
  const seen = new Set<string>([hoveredId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: hoveredId, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    for (const nextId of adjacency.get(current.id) ?? []) {
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      visible.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }

  return visible;
}

/**
 * 어떤 노드 라벨을 화면에 표시할지 결정한다.
 *
 * 표시 정책(spec 2026-06-17):
 *   1. 인터랙션/검색 라벨 — selected·hovered·검색 top·(hit+importance>0.62)로 켠다.
 *   2. 묶음·개별 엔티티 게이트 — 묶음 노드(entity_group)는 항상 표시,
 *      개별 엔티티(INDIVIDUAL_ENTITY_TYPES)는 그 타입 묶음이 펼침일 때만 표시.
 *      단 selected·hovered 한 노드는 펼침과 무관하게 살린다(클릭·마우스오버 라벨).
 *
 * 기본 화면(선택·호버·검색 없음)에는 묶음 라벨만 남는다 — 강한 허브 자동 표시는 제거했다.
 * expandedGroupTypes 는 선택 인자 — 넘기지 않으면 빈 집합(개별 엔티티 전부 숨김).
 */
export function resolveVisibleLabelIds(
  nodes: GraphNode[],
  selectedId: string | null,
  hoveredId: string | null,
  topIds: ReadonlySet<string>,
  hitIds: ReadonlySet<string>,
  expandedGroupTypes: ReadonlySet<string> = EMPTY_EXPAND,
  edges: readonly GraphEdge[] = [],
  recentIds: ReadonlySet<string> = EMPTY_EXPAND,
): Set<string> {
  const visible = new Set<string>();
  const hierarchyContextIds = new Set<string>([
    ...collectExpandedHierarchyLabels(nodes, edges, expandedGroupTypes),
    ...collectSelectedHierarchyLabels(nodes, edges, selectedId),
  ]);
  const hoverNeighborIds = collectHoverNeighborLabels(nodes, edges, hoveredId, 2);

  // 1) 인터랙션/검색 라벨 — 선택·호버 이웃·검색 top·검색 hit(중요도>0.62).
  // 호버한 노드 자신은 옆에 요약 카드가 뜨므로 이름표를 반복하지 않는다.
  for (const node of nodes) {
    const isSelected = node.id === selectedId;
    const isHoverNeighbor = hoverNeighborIds.has(node.id);
    const isTop = topIds.has(node.id);
    const isRecent = recentIds.has(node.id);
    const isHighlightedImportant = hitIds.has(node.id) && (node.importance ?? 0) > 0.62;

    if (isSelected || isHoverNeighbor || isTop || isRecent || isHighlightedImportant) {
      visible.add(node.id);
    }
    if (hierarchyContextIds.has(node.id)) visible.add(node.id);
  }

  // 2) 묶음·개별 엔티티 게이트.
  //   · 묶음 노드(entity_group)는 항상 표시.
  //   · 개별 엔티티는 그 타입 묶음이 펼침일 때만 표시 — 아니면 위에서 들어왔어도 제거.
  //     단 selected·hovered 한 그 노드는 펼침과 무관하게 살린다(항목5·6 게이트 예외).
  for (const node of nodes) {
    if (node.type === "entity_group") {
      visible.add(node.id);
    } else if (INDIVIDUAL_ENTITY_TYPES.has(node.type)) {
      const isExempt =
        node.id === selectedId ||
        hoverNeighborIds.has(node.id) ||
        recentIds.has(node.id) ||
        hierarchyContextIds.has(node.id);
      if (expandedGroupTypes.has(node.type) || isExempt) visible.add(node.id);
      else visible.delete(node.id);
    }
  }

  return visible;
}
