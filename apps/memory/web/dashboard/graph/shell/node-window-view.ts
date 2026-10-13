/**
 * web/dashboard/graph/shell/node-window-view.ts
 * 노드 상세 창(큰 모달) DOM 한 개를 만든다.
 *
 * 본문(노드 메타 줄·snippet·document 마크다운·nodeDetail)은 graph-entry.ts 의
 * buildNodeDetailEl 내용을 그대로 옮겨온 것이다. 차이점은 두 가지뿐:
 *   1. 패널을 화면 중앙 고정(fixed) 대신 좌표 지정(absolute left/top)으로 바꿔
 *      여러 창을 서로 다른 위치에 띄울 수 있게 한다.
 *   2. 제목·경로·닫기 버튼은 고정 헤더에 두고, 본문만 스크롤한다.
 *
 * 색·테두리·그림자·radius·폰트는 모두 토큰(.node-window 클래스)으로 빠진다.
 * 인라인 style 로 남는 것은 위치(left/top)뿐이다. 색 하드코딩 없음.
 *
 * 이 파일은 부품만 만든다 — graph-entry 배선은 별도(Task 6).
 */

import { el } from "./dom.ts";
import { renderMarkdownSafe } from "../graph-markdown.ts";
import { fromGraphNode } from "../../ui/card-view.ts";
import { displayGraphKindLabel } from "../../ui/badges.ts";
import { nodeDetail } from "../../ui/node-detail.ts";
import {
  displaySnippetWithoutHashtags,
  displayTitleForNode,
} from "../../ui/hashtag-display.ts";
import type { DashboardGraphViewModel, GraphEdge, GraphNode } from "../graph-view-model.ts";

export interface NodeWindowViewOpts {
  vm: DashboardGraphViewModel;
  nodeId: string;
  pos: { x: number; y: number };
  /** true 면 본문 snippet 이 타이핑되듯 드러난다. 클릭하면 즉시 전체 본문을 보여준다. */
  animateContent?: boolean;
  /** X(닫기) 버튼을 눌렀을 때. */
  onClose: () => void;
  /** 창을 클릭하거나 드래그를 시작할 때 — 이 창을 맨 앞으로. */
  onFocus: () => void;
  /** 드래그로 옮긴 결과 좌표(viewport 기준). */
  onMove: (pos: { x: number; y: number }) => void;
  /** 관련 노드 링크를 눌렀을 때 — 닫힘 토글 없이 해당 큰 모달을 열거나 앞으로 보낸다. */
  onJumpNode?: (nodeId: string) => void;
  /** 글 노드 내용을 같은 source id 로 수정한다. 성공 후 호출자가 그래프 재로드를 책임진다. */
  onEditNode?: (req: NodeWindowEditRequest) => Promise<void>;
  /** 글 노드에 키워드 태그를 추가한다. 성공 후 호출자가 그래프 재로드를 책임진다. */
  onAddTag?: (req: NodeWindowTagRequest) => Promise<void>;
  /**
   * 글 노드를 휴지통으로 이동한다. 확인 여부·파생 건수 조회는 이 콜백을 넘기는 쪽
   * (graph-entry.ts) 이 책임지고, 여기서는 클릭 시 요청만 그대로 전달한다.
   */
  onTrashNode?: (req: NodeWindowTrashRequest) => Promise<void>;
}

export interface NodeWindowEditRequest {
  nodeId: string;
  sourceId: number;
  content: string;
  reason?: string;
}

export interface NodeWindowTagRequest {
  nodeId: string;
  sourceId: number;
  tag: string;
}

export interface NodeWindowTrashRequest {
  nodeId: string;
  sourceId: number;
}

const ACTIVE_TYPEWRITERS = new WeakMap<HTMLElement, () => boolean>();

/** 현재 창에 타이핑 중인 본문이 있으면 즉시 끝내고 true 를 돌린다. */
export function skipNodeWindowTypewriter(panel: HTMLElement | null): boolean {
  if (!panel) return false;
  const active = panel.querySelectorAll<HTMLElement>(
    '.node-window__snippet[data-typewriter-active="true"]',
  );
  for (const snip of active) {
    const skip = ACTIVE_TYPEWRITERS.get(snip);
    if (skip?.() === true) return true;
  }
  return false;
}

/**
 * 창 하나가 그리는 VM 파생 내용(노드 본문·메타·경로·관련 링크)의 스냅샷 서명.
 * overview 재로드 뒤 이 서명이 그대로면 그 창이 보여줄 내용도 그대로라는 뜻이다.
 */
export function nodeWindowContentSignature(
  vm: DashboardGraphViewModel,
  nodeId: string,
): string {
  return JSON.stringify({
    node: vm.nodes.find((n) => n.id === nodeId) ?? null,
    breadcrumb: deriveNodeBreadcrumb(vm, nodeId),
    links: deriveNodeWindowLinks(vm, nodeId, Number.MAX_SAFE_INTEGER),
  });
}

/**
 * 열린 창들 중 VM 재로드로 내용이 실제로 달라진 창의 nodeId 만 고른다.
 * graph_changed 재로드가 내용 그대로인 창까지 파괴·재생성(본문 재타이핑)하지 않게 하는
 * 판별 기준 — 서명이 같은 창은 살아남고, 달라진 창만 재생성 대상이 된다.
 */
export function nodeWindowIdsNeedingRefresh(
  prevVm: DashboardGraphViewModel,
  nextVm: DashboardGraphViewModel,
  openNodeIds: Iterable<string>,
): string[] {
  const changed: string[] = [];
  for (const nodeId of openNodeIds) {
    if (
      nodeWindowContentSignature(prevVm, nodeId) !==
      nodeWindowContentSignature(nextVm, nodeId)
    ) {
      changed.push(nodeId);
    }
  }
  return changed;
}

/**
 * 드래그되는 노드 상세 창 element 한 개를 만들어 반환한다.
 * 호출자가 z-index 와 부모 컨테이너 마운트를 책임진다(Task 6).
 */
export function createNodeWindowView(opts: NodeWindowViewOpts): HTMLElement {
  const {
    vm,
    nodeId,
    pos,
    animateContent,
    onClose,
    onFocus,
    onMove,
    onJumpNode,
    onEditNode,
    onAddTag,
    onTrashNode,
  } = opts;
  const node = vm.nodes.find((n) => n.id === nodeId);

  const panel = el("div", { className: "node-window" }) as HTMLDivElement;
  panel.style.left = `${pos.x}px`;
  panel.style.top = `${pos.y}px`;

  // 헤더 밖 본문을 눌러도 이 창을 맨 앞으로 끌어올린다.
  panel.addEventListener("pointerdown", () => onFocus());

  panel.appendChild(
    buildWindowHead({
      panel,
      startPos: pos,
      title: node ? displayTitleForNode(node) : `노드 ${nodeId}`,
      breadcrumb: buildBreadcrumb(vm, nodeId),
      onClose,
      onFocus,
      onMove,
    }),
  );
  panel.appendChild(
    buildBody(
      vm,
      nodeId,
      node,
      animateContent === true,
      onJumpNode,
      onEditNode,
      onAddTag,
      onTrashNode,
    ),
  );

  return panel;
}

// ── 관련 노드 링크 ─────────────────────────────────────────────────────────

const RELATED_LINK_LIMIT = 8;
const MEANING_EXTRACTION_EDGE_TYPES = new Set(["merged_into"]);
const MEANING_EXTRACTION_RELATION_LABELS = new Set(["본문 조각", "이미지 설명", "AI 추출"]);

export interface NodeWindowRelatedLink {
  nodeId: string;
  label: string;
  typeLabel: string;
  relationLabel: string;
  edgeType: string;
  weight?: number;
}

type RankedRelatedLink = NodeWindowRelatedLink & { priority: number };

interface EntityInfoRow {
  key: string;
  value: string;
}

interface EntityInfoSection {
  title: string;
  rows: EntityInfoRow[];
}

interface EntityInfo {
  sections: EntityInfoSection[];
}

/**
 * 큰 모달 하단의 관련 링크 후보.
 * 의도적으로 1-hop(현재 노드와 직접 닿은 edge)만 보여준다 — 사용자가 말한 "1단계 연결".
 */
export function deriveNodeWindowLinks(
  vm: DashboardGraphViewModel,
  nodeId: string,
  limit = RELATED_LINK_LIMIT,
): { links: NodeWindowRelatedLink[]; total: number } {
  const byId = new Map(vm.nodes.map((node) => [node.id, node]));
  const current = byId.get(nodeId);
  if (!current) return { links: [], total: 0 };

  const byTarget = new Map<string, RankedRelatedLink>();
  for (const edge of vm.edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    const otherId = edge.from === nodeId ? edge.to : edge.from;
    if (otherId === nodeId) continue;
    const other = byId.get(otherId);
    if (!other) continue;

    const next: RankedRelatedLink = {
      nodeId: other.id,
      label: displayTitleForNode(other),
      typeLabel: displayNodeTypeMeta(other),
      relationLabel: relationLabelForEdge(edge, current, other),
      edgeType: edge.type,
      weight: edge.weight,
      priority: relationPriority(edge, current, other),
    };
    const prev = byTarget.get(other.id);
    if (!prev || compareRankedLinks(next, prev) < 0) byTarget.set(other.id, next);
  }

  const ranked = [...byTarget.values()].sort(compareRankedLinks);
  return {
    links: ranked.slice(0, Math.max(0, limit)).map(({ priority: _priority, ...link }) => link),
    total: ranked.length,
  };
}

function compareRankedLinks(a: RankedRelatedLink, b: RankedRelatedLink): number {
  const byPriority = b.priority - a.priority;
  if (byPriority !== 0) return byPriority;
  const byWeight = (b.weight ?? 0) - (a.weight ?? 0);
  if (byWeight !== 0) return byWeight;
  const byType = a.typeLabel.localeCompare(b.typeLabel);
  if (byType !== 0) return byType;
  return a.label.localeCompare(b.label);
}

function relationPriority(
  edge: GraphEdge,
  current: GraphNode,
  other: GraphNode,
): number {
  if (isChunkLike(current) || isChunkLike(other)) return 100;
  switch (edge.type) {
    case "owns_memory":
    case "belongs_to_project":
      return 90;
    case "parent_of":
    case "contains_section":
    case "contains_chunk":
    case "member_of":
    case "mentions_entity":
    case "mentions_entity_side":
      return 80;
    case "classified_as":
    case "tagged_with":
    case "mentions":
      return 60;
    case "supports":
    case "derived_from":
    case "merged_into":
    case "supersedes":
      return 50;
    case "related_to":
    case "similar_to":
      return 30;
    default:
      return 10;
  }
}

function relationLabelForEdge(
  edge: GraphEdge,
  current: GraphNode,
  other: GraphNode,
): string {
  switch (edge.type) {
    case "parent_of":
      if (isChunkLike(current) && !isChunkLike(other)) return "원본 글";
      if (isChunkLike(other) && !isChunkLike(current)) return childSliceLabel(other);
      return edge.from === current.id ? "하위" : "상위";
    case "contains_section":
      if (edge.from === current.id) {
        return current.type === "document" ? "목차" : "하위 제목";
      }
      return other.type === "document" ? "원본 문서" : "상위 제목";
    case "contains_chunk":
      if (isChunkLike(other)) return childSliceLabel(other);
      if (isChunkLike(current)) {
        return other.type === "document_section" ? "상위 제목" : "원본 문서";
      }
      return "본문 조각";
    case "owns_memory":
      return current.type === "project" ? "글" : "프로젝트";
    case "belongs_to_project":
      return other.type === "project" ? "프로젝트" : "글";
    case "member_of":
      return current.type === "entity_group" ? "항목" : "묶음";
    case "mentions_entity":
    case "mentions_entity_side":
      return "엔티티";
    case "classified_as":
    case "classification":
      return "분류";
    case "tagged_with":
    case "tag":
      return "태그";
    case "mentions":
    case "mention":
      return "언급";
    case "supports":
      return "근거";
    case "derived_from":
      return "출처";
    case "merged_into":
      return edge.from === current.id ? "원본" : "의미 추출";
    case "supersedes":
      return edge.from === current.id ? "대체함" : "대체됨";
    case "related_to":
    case "similar_to":
      return "관련";
    default:
      return edge.type;
  }
}

function childSliceLabel(node: GraphNode): string {
  if (node.type === "document_chunk") return "본문 조각";
  if (node.type === "image_caption") return "이미지 설명";
  if (node.type === "llm_extract") return "AI 추출";
  return displayNodeTypeMeta(node);
}

function isChunkLike(node: GraphNode): boolean {
  return node.type === "document_chunk" || node.type === "image_caption" || node.type === "llm_extract";
}

// ── 경로 breadcrumb ─────────────────────────────────────────────────────────

const MAX_BREADCRUMB_PARTS = 5;

type ParentCandidate = {
  parentId: string;
  priority: number;
  weight: number;
};

/**
 * 큰 모달 상단의 "프로젝트 > 코딩 > 게임 > 네스트" 경로 라벨.
 *
 * 우선순위:
 *   1. 노드가 명시 path 를 가지고 있으면 그 값을 신뢰한다.
 *   2. path 가 없으면 그래프 관계에서 부모 사슬을 짧게 추론한다.
 *
 * 단독 노드명만 나오는 경우는 제목과 중복이라 표시하지 않는다.
 */
export function deriveNodeBreadcrumb(vm: DashboardGraphViewModel, nodeId: string): string[] {
  const byId = new Map(vm.nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId);
  if (!node) return [];

  const explicit = normalizeBreadcrumbParts([...(node.path ?? []), displayTitleForNode(node)]);
  if ((node.path?.length ?? 0) > 0 && explicit.length >= 2) {
    return trimBreadcrumbParts(explicit);
  }

  const parentOf = chooseBreadcrumbParents(vm.nodes, vm.edges);
  const ids = [nodeId];
  const seen = new Set(ids);
  let current = nodeId;

  for (let guard = 0; guard < 8; guard += 1) {
    const parentId = parentOf.get(current);
    if (!parentId || seen.has(parentId) || !byId.has(parentId)) break;
    ids.push(parentId);
    seen.add(parentId);
    current = parentId;
  }

  const inferred = normalizeBreadcrumbParts(
    ids.reverse().map((id) => {
      const part = byId.get(id);
      return part ? displayTitleForNode(part) : id;
    }),
  );
  return inferred.length >= 2 ? trimBreadcrumbParts(inferred) : [];
}

function buildBreadcrumb(vm: DashboardGraphViewModel, nodeId: string): HTMLElement | null {
  const parts = deriveNodeBreadcrumb(vm, nodeId);
  if (parts.length < 2) return null;

  const children: Array<HTMLElement | string> = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      children.push(el("span", {
        className: "node-window__breadcrumb-sep",
        "aria-hidden": "true",
      }, ">"));
    }
    children.push(el("span", { className: "node-window__breadcrumb-part" }, part));
  });

  return el(
    "nav",
    {
      className: "node-window__breadcrumb",
      "aria-label": "연결 경로",
      title: parts.join(" > "),
    },
    ...children,
  );
}

function chooseBreadcrumbParents(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const candidatesByChild = new Map<string, ParentCandidate[]>();

  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;

    for (const candidate of parentCandidatesForEdge(edge, from, to)) {
      const list = candidatesByChild.get(candidate.childId) ?? [];
      list.push({
        parentId: candidate.parentId,
        priority: candidate.priority,
        weight: edge.weight ?? 0,
      });
      candidatesByChild.set(candidate.childId, list);
    }
  }

  const parentOf = new Map<string, string>();
  for (const [childId, candidates] of candidatesByChild) {
    candidates.sort((a, b) => {
      const byPriority = b.priority - a.priority;
      if (byPriority !== 0) return byPriority;
      const byWeight = b.weight - a.weight;
      if (byWeight !== 0) return byWeight;
      return a.parentId.localeCompare(b.parentId);
    });
    parentOf.set(childId, candidates[0]!.parentId);
  }
  return parentOf;
}

function parentCandidatesForEdge(
  edge: GraphEdge,
  from: GraphNode,
  to: GraphNode,
): Array<{ childId: string; parentId: string; priority: number }> {
  switch (edge.type) {
    case "owns_memory":
    case "member_of":
    case "parent_of":
    case "contains_chunk":
    case "contains_section":
    case "mentions_entity":
      return [{ childId: to.id, parentId: from.id, priority: parentPriority(edge.type) }];
    case "merged_into":
      return [{ childId: from.id, parentId: to.id, priority: parentPriority(edge.type) }];
    case "classified_as":
      return [{ childId: to.id, parentId: from.id, priority: parentPriority(edge.type) }];
    case "belongs_to_project":
      return belongsToProjectCandidates(from, to);
    case "tagged_with":
    case "mentions":
      return shallowerSideCandidates(from, to, 54);
    case "supports":
    case "derived_from":
      return shallowerSideCandidates(from, to, 42);
    default:
      return shallowerSideCandidates(from, to, 20);
  }
}

function parentPriority(edgeType: string): number {
  switch (edgeType) {
    case "owns_memory": return 100;
    case "belongs_to_project": return 98;
    case "merged_into": return 95;
    case "member_of": return 90;
    case "contains_section": return 84;
    case "contains_chunk": return 82;
    case "mentions_entity": return 70;
    case "classified_as": return 55;
    case "parent_of": return 50;
    default: return 20;
  }
}

function belongsToProjectCandidates(
  from: GraphNode,
  to: GraphNode,
): Array<{ childId: string; parentId: string; priority: number }> {
  if (from.type === "project" && to.type !== "project") {
    return [{ childId: to.id, parentId: from.id, priority: parentPriority("belongs_to_project") }];
  }
  if (to.type === "project" && from.type !== "project") {
    return [{ childId: from.id, parentId: to.id, priority: parentPriority("belongs_to_project") }];
  }
  return shallowerSideCandidates(from, to, 40);
}

function shallowerSideCandidates(
  from: GraphNode,
  to: GraphNode,
  priority: number,
): Array<{ childId: string; parentId: string; priority: number }> {
  const fromDepth = breadcrumbDepth(from);
  const toDepth = breadcrumbDepth(to);
  if (fromDepth < toDepth) return [{ childId: to.id, parentId: from.id, priority }];
  if (toDepth < fromDepth) return [{ childId: from.id, parentId: to.id, priority }];
  return [];
}

function breadcrumbDepth(node: GraphNode): number {
  switch (node.type) {
    case "entity_group": return 0;
    case "project": return 1;
    case "person":
    case "concept":
    case "document":
    case "classification_key":
      return 2;
    case "decision":
    case "tag":
    case "document_chunk":
      return 3;
    case "memory":
    case "image":
      return 4;
    case "image_caption":
    case "llm_extract":
      return 5;
    default:
      return 4;
  }
}

function normalizeBreadcrumbParts(parts: Array<string | undefined>): string[] {
  const normalized: string[] = [];
  for (const raw of parts) {
    const part = raw?.replace(/\s+/g, " ").trim();
    if (!part) continue;
    if (normalized[normalized.length - 1] === part) continue;
    normalized.push(part);
  }
  return normalized;
}

function trimBreadcrumbParts(parts: string[]): string[] {
  if (parts.length <= MAX_BREADCRUMB_PARTS) return parts;
  return [parts[0]!, ...parts.slice(-(MAX_BREADCRUMB_PARTS - 1))];
}

// ── 고정 헤더 + 투명 드래그 존 ───────────────────────────────────────────────

interface WindowHeadOptions {
  panel: HTMLDivElement;
  startPos: { x: number; y: number };
  title: string;
  breadcrumb: HTMLElement | null;
  onClose: () => void;
  onFocus: () => void;
  onMove: (pos: { x: number; y: number }) => void;
}

function buildWindowHead(opts: WindowHeadOptions): HTMLElement {
  const { panel, startPos, title, breadcrumb, onClose, onFocus, onMove } = opts;
  const heading = el(
    "div",
    { className: "node-window__heading" },
    el("div", { className: "node-window__title", title }, title),
  );
  if (breadcrumb) heading.appendChild(breadcrumb);

  const head = el(
    "div",
    { className: "node-window__head" },
    buildDragZone(panel, startPos, onFocus, onMove),
    heading,
    buildCloseButton(onClose),
  );
  return head;
}

function buildDragZone(
  panel: HTMLDivElement,
  startPos: { x: number; y: number },
  onFocus: () => void,
  onMove: (pos: { x: number; y: number }) => void,
): HTMLElement {
  const zone = el("div", { className: "node-window__drag-zone", "aria-hidden": "true" });
  wireDrag(zone, panel, startPos, onFocus, onMove);
  return zone;
}

/**
 * 상단의 투명 영역을 잡고 끌면 창이 따라오게 배선한다.
 * 보이는 제목줄은 없지만 기존 다중 창 배치 조작은 유지한다.
 */
function wireDrag(
  handle: HTMLElement,
  panel: HTMLDivElement,
  startPos: { x: number; y: number },
  onFocus: () => void,
  onMove: (pos: { x: number; y: number }) => void,
): void {
  let offX = 0;
  let offY = 0;
  let curX = startPos.x;
  let curY = startPos.y;

  function onPointerMove(ev: PointerEvent): void {
    const rect = panel.getBoundingClientRect();
    const rawX = ev.clientX - offX;
    const rawY = ev.clientY - offY;
    curX = Math.max(0, Math.min(window.innerWidth - rect.width, rawX));
    curY = Math.max(0, Math.min(window.innerHeight - rect.height, rawY));
    panel.style.left = `${curX}px`;
    panel.style.top = `${curY}px`;
    onMove({ x: curX, y: curY });
  }

  function endDrag(ev: PointerEvent): void {
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
  }

  handle.addEventListener("pointerdown", (ev: PointerEvent) => {
    onFocus();
    handle.setPointerCapture(ev.pointerId);
    offX = ev.clientX - curX;
    offY = ev.clientY - curY;
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  });
}

// ── 닫기 버튼 ────────────────────────────────────────────────────────────────

/** 제목줄 없이 모달 우상단에 뜨는 닫기 버튼. */
function buildCloseButton(onClose: () => void): HTMLButtonElement {
  const closeBtn = el("button", {
    type: "button",
    className: "node-window__close",
    title: "닫기",
    "aria-label": "닫기",
  }, "×") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => onClose());
  return closeBtn;
}

// ── 본문(buildNodeDetailEl 이식) ──────────────────────────────────────────────

/** 노드 메타 줄·snippet·nodeDetail 을 담은 본문을 만든다. node 없으면 안내 문구. */
function buildBody(
  vm: DashboardGraphViewModel,
  nodeId: string,
  node: DashboardGraphViewModel["nodes"][number] | undefined,
  animateContent: boolean,
  onJumpNode: ((nodeId: string) => void) | undefined,
  onEditNode: ((req: NodeWindowEditRequest) => Promise<void>) | undefined,
  onAddTag: ((req: NodeWindowTagRequest) => Promise<void>) | undefined,
  onTrashNode: ((req: NodeWindowTrashRequest) => Promise<void>) | undefined,
): HTMLElement {
  const body = el("div", { className: "node-window__body" });

  if (!node) {
    body.appendChild(
      el("p", { className: "node-window__missing" }, `노드 ${nodeId} 정보를 찾을 수 없습니다.`),
    );
    return body;
  }

  // CardView 로 변환한 뒤 nodeDetail 컴포넌트로 표현한다.
  // snippet 과 createdAt 은 아래에서 따로 그리므로 nodeDetail 에는 빼서 넘긴다:
  //   1. snippet 은 document 타입일 때 마크다운 렌더가 필요하므로 아래 본문 블록에서 처리한다
  //      (nodeDetail 은 textContent 만 그려 마크다운을 잃는다).
  //   2. createdAt 은 아래 메타 줄의 "생성"에서 그리므로, 여기서 빼지 않으면 nodeDetail 의
  //      view.date 와 메타 줄이 생성일을 두 번 그린다(중복 차단).
  const viewWithoutSnippet = fromGraphNode({ ...node, createdAt: undefined });
  viewWithoutSnippet.snippet = undefined;
  const detail = nodeDetail(viewWithoutSnippet);
  attachTagAddControl(detail, node, onAddTag);
  body.appendChild(detail);

  const entityInfo = buildEntityInfo(node);
  if (entityInfo) body.appendChild(entityInfo);

  const content = buildContentSection(node, animateContent, onEditNode, onTrashNode);
  if (content) body.appendChild(content);

  // 메타 줄 — 내용 흐름을 먼저 읽은 뒤 확인할 수 있도록 본문 아래에 둔다.
  body.appendChild(buildMetaBlock(node));

  for (const section of buildNodeLinkSections(vm, nodeId, onJumpNode)) {
    body.appendChild(section);
  }

  return body;
}

function buildContentSection(
  node: DashboardGraphViewModel["nodes"][number],
  animateContent: boolean,
  onEditNode: ((req: NodeWindowEditRequest) => Promise<void>) | undefined,
  onTrashNode: ((req: NodeWindowTrashRequest) => Promise<void>) | undefined,
): HTMLElement | null {
  // 본문 snippet — 짧은 비-document 글에서 label 과 같은 내용이 두 번 나오는 중복을 막는다.
  // document 는 마크다운 본문이 제목과 별개 내용이므로 항상 표시.
  const snip = buildSnippet(node, animateContent);
  const editControls = buildEditControls(node, onEditNode);
  const trashControl = buildTrashControl(node, onTrashNode);
  if (!snip && !editControls && !trashControl) return null;

  const section = el(
    "section",
    { className: "node-window__content", "aria-label": "내용" },
    el("div", { className: "node-window__content-head" }, "내용"),
  );
  if (snip) section.appendChild(snip);
  if (editControls) section.appendChild(editControls);
  if (trashControl) section.appendChild(trashControl);
  return section;
}

const EDITABLE_NODE_TYPES = new Set(["memory", "document_chunk", "image_caption", "llm_extract"]);
const UNEDITABLE_SOURCE_TYPES = new Set(["document", "image_asset"]);

function editableNodeSourceId(node: DashboardGraphViewModel["nodes"][number]): number | null {
  if (!EDITABLE_NODE_TYPES.has(node.type)) return null;
  const sourceKind = node.sourceType ?? node.type;
  if (UNEDITABLE_SOURCE_TYPES.has(sourceKind)) return null;
  if (typeof node.sourceId === "number" && Number.isInteger(node.sourceId) && node.sourceId > 0) {
    return node.sourceId;
  }
  return null;
}

function editInitialContent(node: DashboardGraphViewModel["nodes"][number]): string {
  return displaySnippetWithoutHashtags(node.snippet) ?? node.label ?? "";
}

function attachTagAddControl(
  detail: HTMLElement,
  node: DashboardGraphViewModel["nodes"][number],
  onAddTag: ((req: NodeWindowTagRequest) => Promise<void>) | undefined,
): void {
  const sourceId = editableNodeSourceId(node);
  if (!sourceId || !onAddTag) return;

  let activeDialog: HTMLElement | null = null;
  const addButton = el(
    "button",
    {
      type: "button",
      className: "node-detail__tag-add",
      title: "태그 추가",
      "aria-label": "태그 추가",
    },
    "+",
  ) as HTMLButtonElement;
  addButton.addEventListener("click", () => {
    if (activeDialog?.isConnected) {
      activeDialog.querySelector<HTMLInputElement>(".node-tag-modal__input")?.focus();
      return;
    }
    activeDialog = buildTagDialog({
      node,
      sourceId,
      onAddTag,
      onClose: () => {
        activeDialog?.remove();
        activeDialog = null;
        addButton.focus();
      },
    });
    const host = detail.closest(".node-window") ?? document.body;
    host.appendChild(activeDialog);
    activeDialog.querySelector<HTMLInputElement>(".node-tag-modal__input")?.focus();
  });

  let tagRow = detail.querySelector<HTMLElement>(".node-detail__tags");
  if (!tagRow) {
    tagRow = el(
      "div",
      { className: "node-detail__tags" },
      el("span", { className: "node-detail__tags-label" }, "태그"),
    );
    detail.appendChild(tagRow);
  }
  tagRow.appendChild(addButton);
}

interface TagDialogOptions {
  node: DashboardGraphViewModel["nodes"][number];
  sourceId: number;
  onAddTag: (req: NodeWindowTagRequest) => Promise<void>;
  onClose: () => void;
}

function buildTagDialog(opts: TagDialogOptions): HTMLElement {
  const { node, sourceId, onAddTag, onClose } = opts;
  const overlay = el("div", {
    className: "node-tag-modal",
    role: "presentation",
  });
  const dialog = el("div", {
    className: "node-tag-modal__box",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "태그 추가",
  });
  const title = el("div", { className: "node-tag-modal__title" }, "태그 추가");
  const close = el(
    "button",
    {
      type: "button",
      className: "node-tag-modal__close",
      title: "닫기",
      "aria-label": "닫기",
    },
    "×",
  ) as HTMLButtonElement;
  const head = el("div", { className: "node-tag-modal__head" }, title, close);
  const form = el("form", { className: "node-tag-modal__form" }) as HTMLFormElement;
  const input = document.createElement("input");
  input.className = "node-tag-modal__input";
  input.type = "text";
  input.placeholder = "태그 이름";
  input.setAttribute("aria-label", "태그 이름");

  const status = el("div", {
    className: "node-tag-modal__status",
    role: "status",
    "aria-live": "polite",
  });
  const save = el(
    "button",
    { type: "submit", className: "node-tag-modal__save" },
    "저장",
  ) as HTMLButtonElement;
  const cancel = el(
    "button",
    { type: "button", className: "node-tag-modal__cancel" },
    "취소",
  ) as HTMLButtonElement;
  const actions = el("div", { className: "node-tag-modal__actions" }, save, cancel);

  close.addEventListener("click", onClose);
  cancel.addEventListener("click", onClose);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) onClose();
  });
  overlay.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape") onClose();
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const tag = input.value.trim();
    if (tag.length === 0) {
      status.textContent = "태그 이름을 입력하세요.";
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    status.textContent = "저장 중";
    try {
      await onAddTag({ nodeId: node.id, sourceId, tag });
      status.textContent = "저장됨";
      onClose();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      save.disabled = false;
      cancel.disabled = false;
    }
  });

  form.append(input, actions, status);
  dialog.append(head, form);
  overlay.appendChild(dialog);
  return overlay;
}

export function buildEditControls(
  node: DashboardGraphViewModel["nodes"][number],
  onEditNode: ((req: NodeWindowEditRequest) => Promise<void>) | undefined,
): HTMLElement | null {
  const sourceId = editableNodeSourceId(node);
  if (!sourceId || !onEditNode) return null;

  const initialContent = editInitialContent(node);
  const wrap = el("div", { className: "node-window__edit" });
  let activeDialog: HTMLElement | null = null;
  const toggle = el(
    "button",
    {
      type: "button",
      className: "node-window__edit-toggle",
      title: "수정",
    },
    "수정",
  ) as HTMLButtonElement;

  toggle.addEventListener("click", () => {
    if (activeDialog?.isConnected) {
      activeDialog.querySelector<HTMLTextAreaElement>(".node-edit-modal__textarea")?.focus();
      return;
    }
    activeDialog = buildEditDialog({
      node,
      sourceId,
      initialContent,
      onEditNode,
      onClose: () => {
        activeDialog?.remove();
        activeDialog = null;
        toggle.focus();
      },
    });
    const host = wrap.closest(".node-window") ?? document.body;
    host.appendChild(activeDialog);
    activeDialog.querySelector<HTMLTextAreaElement>(".node-edit-modal__textarea")?.focus();
  });

  wrap.append(toggle);
  return wrap;
}

interface EditDialogOptions {
  node: DashboardGraphViewModel["nodes"][number];
  sourceId: number;
  initialContent: string;
  onEditNode: (req: NodeWindowEditRequest) => Promise<void>;
  onClose: () => void;
}

function buildEditDialog(opts: EditDialogOptions): HTMLElement {
  const { node, sourceId, initialContent, onEditNode, onClose } = opts;
  const overlay = el("div", {
    className: "node-edit-modal",
    role: "presentation",
  });
  const dialog = el("div", {
    className: "node-edit-modal__box",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "노드 수정",
  });
  const title = el(
    "div",
    { className: "node-edit-modal__title-row" },
    el("span", { className: "node-edit-modal__title" }, "수정"),
    el(
      "span",
      { className: "node-edit-modal__hashtag-warning" },
      "수정은 해시태그 적용이 되지 않습니다.",
    ),
  );
  const close = el(
    "button",
    {
      type: "button",
      className: "node-edit-modal__close",
      title: "닫기",
      "aria-label": "닫기",
    },
    "×",
  ) as HTMLButtonElement;
  const head = el("div", { className: "node-edit-modal__head" }, title, close);

  const form = el("form", { className: "node-edit-modal__form" }) as HTMLFormElement;
  const textarea = document.createElement("textarea");
  textarea.className = "node-edit-modal__textarea";
  textarea.value = initialContent;
  textarea.rows = Math.min(12, Math.max(4, initialContent.split("\n").length + 1));
  textarea.setAttribute("aria-label", "수정 내용");

  const reason = document.createElement("input");
  reason.className = "node-edit-modal__reason";
  reason.type = "text";
  reason.placeholder = "수정 사유";
  reason.setAttribute("aria-label", "수정 사유");

  const status = el("div", {
    className: "node-edit-modal__status",
    role: "status",
    "aria-live": "polite",
  });
  const save = el(
    "button",
    { type: "submit", className: "node-edit-modal__save" },
    "저장",
  ) as HTMLButtonElement;
  const cancel = el(
    "button",
    { type: "button", className: "node-edit-modal__cancel" },
    "취소",
  ) as HTMLButtonElement;
  const actions = el("div", { className: "node-edit-modal__actions" }, save, cancel);

  close.addEventListener("click", onClose);
  cancel.addEventListener("click", onClose);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) onClose();
  });
  overlay.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape") onClose();
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const next = textarea.value;
    if (next.trim().length === 0) {
      status.textContent = "내용이 비어 있습니다.";
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    status.textContent = "저장 중";
    try {
      await onEditNode({
        nodeId: node.id,
        sourceId,
        content: next,
        reason: reason.value.trim() || undefined,
      });
      status.textContent = "저장됨";
      onClose();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      save.disabled = false;
      cancel.disabled = false;
    }
  });

  form.append(textarea, reason, actions, status);
  dialog.append(head, form);
  overlay.appendChild(dialog);
  return overlay;
}

/**
 * 삭제 버튼 — 확인 절차와 파생 건수 조회는 onTrashNode 를 넘기는 쪽(graph-entry.ts,
 * Task 3)이 책임진다. 여기서는 클릭 시 요청만 그대로 전달하고, 실패하면 edit 오류
 * 노출과 같은 요소·문구 양식(role="status" aria-live="polite")으로 안내한다.
 */
function buildTrashControl(
  node: DashboardGraphViewModel["nodes"][number],
  onTrashNode: ((req: NodeWindowTrashRequest) => Promise<void>) | undefined,
): HTMLElement | null {
  const sourceId = editableNodeSourceId(node);
  if (!sourceId || !onTrashNode) return null;

  const wrap = el("div", { className: "node-window__trash" });
  const toggle = el(
    "button",
    {
      type: "button",
      className: "node-window__trash-toggle",
      title: "삭제",
    },
    "삭제",
  ) as HTMLButtonElement;
  const status = el("div", {
    className: "node-window__trash-status",
    role: "status",
    "aria-live": "polite",
  });

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    status.textContent = "";
    try {
      await onTrashNode({ nodeId: node.id, sourceId });
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      // 성공 경로에서 창이 닫히면 재활성화는 아무 효과가 없어 무해하다.
      // 사용자가 확인 취소로 정상 resolve 된 경우(창이 그대로 열려 있음)에도
      // 버튼이 영구 비활성 상태로 남지 않도록 무조건 풀어준다.
      toggle.disabled = false;
    }
  });

  wrap.append(toggle, status);
  return wrap;
}

/** 엔티티 노드의 칸/라벨/별칭 표시 블록. */
function buildEntityInfo(node: DashboardGraphViewModel["nodes"][number]): HTMLElement | null {
  const info = readEntityInfo(node);
  if (!info) return null;

  const section = el("section", {
    className: "node-window__entity-info",
    "aria-label": "엔티티 정보",
  });
  for (const group of info.sections) {
    appendEntityGroup(section, group.title, group.rows);
  }
  return section;
}

function appendEntityGroup(parent: HTMLElement, heading: string, rows: EntityInfoRow[]): void {
  if (rows.length === 0) return;
  const flat = shouldRenderFlatEntityGroup(heading, rows);
  const group = el(
    "div",
    {
      className: flat
        ? "node-window__entity-group node-window__entity-group--flat"
        : "node-window__entity-group",
    },
  );
  if (!flat) group.appendChild(el("div", { className: "node-window__entity-head" }, heading));
  for (const row of rows) {
    group.appendChild(
      el(
        "div",
        { className: "node-window__entity-row" },
        el("span", { className: "node-window__entity-key" }, row.key),
        el("span", { className: "node-window__entity-value" }, row.value),
      ),
    );
  }
  parent.appendChild(group);
}

function shouldRenderFlatEntityGroup(heading: string, rows: EntityInfoRow[]): boolean {
  if (heading === "칸") return true;
  if (heading === "라벨") return true;
  if (heading === "특성 라벨") return true;
  return rows.length === 1 && rows[0]?.key === heading;
}

function readEntityInfo(node: DashboardGraphViewModel["nodes"][number]): EntityInfo | null {
  const entityInfo = isRecord(node.meta?.entityInfo) ? node.meta.entityInfo : null;
  if (!entityInfo) return null;

  const sections = readEntitySections(entityInfo.sections);
  return sections.length > 0 ? { sections } : null;
}

function readEntitySections(value: unknown): EntityInfoSection[] {
  if (!Array.isArray(value)) return [];
  const sections: EntityInfoSection[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const rows = readEntityRows(item.rows);
    if (rows.length === 0) continue;
    sections.push({ title, rows });
  }
  return sections;
}

function readEntityRows(value: unknown): EntityInfoRow[] {
  if (!Array.isArray(value)) return [];
  const rows: EntityInfoRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    const text = typeof item.value === "string" ? item.value.trim() : "";
    if (!key || !text) continue;
    rows.push({ key, value: text });
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 종류·중요도·신뢰도·생성·수정·마지막 접근·반복 언급 메타 줄 묶음. */
function buildMetaBlock(node: DashboardGraphViewModel["nodes"][number]): HTMLElement {
  const metaRows: [string, string][] = [];
  metaRows.push(["종류", displayNodeTypeMeta(node)]);
  if (typeof node.importance === "number") {
    metaRows.push(["중요도", node.importance.toFixed(2)]);
  }
  if (typeof node.confidence === "number") {
    metaRows.push(["신뢰도", node.confidence.toFixed(2)]);
  }
  if (node.createdAt != null) {
    metaRows.push(["생성", node.createdAt]);
  }
  if (node.updatedAt != null) {
    metaRows.push(["마지막 수정", node.updatedAt]);
  }
  if (node.lastAccessedAt != null) {
    metaRows.push(["마지막 접근", node.lastAccessedAt]);
  }
  if (node.mentionCount != null) {
    metaRows.push(["반복 언급", `${node.mentionCount}회`]);
  }

  const metaBlock = el("div", { className: "node-window__meta" });
  for (const [label, value] of metaRows) {
    metaBlock.appendChild(
      el(
        "div",
        { className: "node-window__meta-row" },
        el("span", { className: "node-window__meta-label" }, label),
        el("span", { className: "node-window__meta-value" }, value),
      ),
    );
  }
  return metaBlock;
}

function displayNodeTypeMeta(node: DashboardGraphViewModel["nodes"][number]): string {
  if (node.type === "entity_group" && node.groupType != null) {
    return `${displayGraphKindLabel(node.groupType)} 묶음`;
  }
  return displayGraphKindLabel(node.type);
}

function isMeaningExtractionLink(link: NodeWindowRelatedLink): boolean {
  return (
    MEANING_EXTRACTION_EDGE_TYPES.has(link.edgeType) ||
    MEANING_EXTRACTION_RELATION_LABELS.has(link.relationLabel)
  );
}

/** 부가정보 아래 맨 아래에 놓는 1-hop 링크 섹션들. 의미추출은 관련 노드와 따로 둔다. */
function buildNodeLinkSections(
  vm: DashboardGraphViewModel,
  nodeId: string,
  onJumpNode: ((nodeId: string) => void) | undefined,
): HTMLElement[] {
  const { links } = deriveNodeWindowLinks(vm, nodeId, Number.MAX_SAFE_INTEGER);
  if (links.length === 0) return [];

  const meaningLinks = links.filter(isMeaningExtractionLink);
  const relatedLinks = links.filter((link) => !isMeaningExtractionLink(link));
  const sections: HTMLElement[] = [];

  const meaningSection = buildMeaningExtractionLinks(meaningLinks, onJumpNode);
  if (meaningSection) sections.push(meaningSection);

  const relatedSection = buildRelatedLinks(relatedLinks, onJumpNode);
  if (relatedSection) sections.push(relatedSection);

  return sections;
}

function buildMeaningExtractionLinks(
  links: NodeWindowRelatedLink[],
  onJumpNode: ((nodeId: string) => void) | undefined,
): HTMLElement | null {
  if (links.length === 0) return null;

  const list = el("div", { className: "node-window__extracts-list" });
  for (const link of links) {
    list.appendChild(buildLinkButton(link, onJumpNode, false));
  }

  return el(
    "details",
    { className: "node-window__extracts" },
    el("summary", { className: "node-window__extracts-summary" }, `의미추출(${links.length}개)`),
    list,
  );
}

function buildRelatedLinks(
  links: NodeWindowRelatedLink[],
  onJumpNode: ((nodeId: string) => void) | undefined,
): HTMLElement | null {
  if (links.length === 0) return null;

  const visibleLinks = links.slice(0, RELATED_LINK_LIMIT);
  const heading =
    links.length > visibleLinks.length
      ? `관련 노드 (${visibleLinks.length}/${links.length})`
      : `관련 노드 (${links.length})`;
  const list = el("div", { className: "node-window__links-list" });
  for (const link of visibleLinks) {
    list.appendChild(buildLinkButton(link, onJumpNode, true));
  }

  return el(
    "section",
    { className: "node-window__links", "aria-label": "관련 노드" },
    el("div", { className: "node-window__links-head" }, heading),
    list,
  );
}

function buildLinkButton(
  link: NodeWindowRelatedLink,
  onJumpNode: ((nodeId: string) => void) | undefined,
  showRelation: boolean,
): HTMLButtonElement {
  const children: Array<HTMLElement | string> = [];
  if (showRelation) {
    children.push(el("span", { className: "node-window__link-rel" }, link.relationLabel));
  }
  children.push(
    el(
      "span",
      { className: "node-window__link-main" },
      el("span", { className: "node-window__link-label" }, link.label),
    ),
  );
  const button = el(
    "button",
    {
      type: "button",
      className: showRelation
        ? "node-window__link"
        : "node-window__link node-window__link--single",
      title: `${link.relationLabel}: ${link.label}`,
      dataset: { nodeId: link.nodeId },
    },
    ...children,
  ) as HTMLButtonElement;
  if (onJumpNode) {
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onJumpNode(link.nodeId);
    });
  }
  return button;
}

/**
 * snippet 블록을 만든다. 표시 대상이 아니면 null.
 * - 비-document 는 snippet 이 label 과 같으면(짧은 글) 중복이라 생략한다.
 * - 문서 계열 노드는 마크다운 블록(제목·리스트·코드)도 보여줘야 해 innerHTML 사용.
 */
const MARKDOWN_SNIPPET_NODE_TYPES = new Set(["document", "document_section", "document_chunk"]);
const TYPEWRITER_MAX_TICKS = 130;
const TYPEWRITER_INTERVAL_MS = 18;

function buildSnippet(
  node: DashboardGraphViewModel["nodes"][number],
  animateContent: boolean,
): HTMLElement | null {
  const cleanSnippet = displaySnippetWithoutHashtags(node.snippet);
  const displayLabel = displayTitleForNode(node);
  const labelSameAsSnippet =
    node.snippet != null &&
    cleanSnippet != null &&
    cleanSnippet.trim() === displayLabel.trim();
  const renderAsMarkdown = MARKDOWN_SNIPPET_NODE_TYPES.has(node.type);
  const showSnippet =
    cleanSnippet != null && (renderAsMarkdown || !labelSameAsSnippet);
  if (!showSnippet) return null;

  const snip = el("div", { className: "node-window__snippet graph-node-snippet" });
  let renderFull = (): void => {
    snip.textContent = cleanSnippet!;
  };
  if (renderAsMarkdown) {
    // 문서 계열 글은 마크다운 블록(제목·리스트·코드)도 표시해야 하므로 innerHTML 사용.
    // (p 안에 블록 요소를 넣으면 브라우저가 p 를 강제로 닫아 표시가 깨진다.)
    try {
      const html = renderMarkdownSafe(cleanSnippet!);
      renderFull = () => {
        snip.innerHTML = html;
      };
    } catch (e) {
      console.warn("[graph] 마크다운 렌더 실패 — 평문 표시:", e);
    }
  }

  if (animateContent && !prefersReducedMotion()) {
    startSnippetTypewriter(snip, cleanSnippet!, renderFull);
  } else {
    renderFull();
  }
  return snip;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function startSnippetTypewriter(
  snip: HTMLElement,
  fullText: string,
  renderFull: () => void,
): void {
  const chars = Array.from(fullText);
  if (chars.length === 0) {
    renderFull();
    return;
  }

  snip.classList.add("node-window__snippet--typing");
  snip.dataset["typewriterActive"] = "true";
  snip.textContent = "";

  let index = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const step = Math.max(1, Math.ceil(chars.length / TYPEWRITER_MAX_TICKS));

  const finish = (): boolean => {
    if (done) return false;
    done = true;
    if (timer !== null) clearTimeout(timer);
    ACTIVE_TYPEWRITERS.delete(snip);
    delete snip.dataset["typewriterActive"];
    snip.classList.remove("node-window__snippet--typing");
    renderFull();
    return true;
  };

  ACTIVE_TYPEWRITERS.set(snip, finish);
  snip.addEventListener("pointerdown", (ev) => {
    if (!finish()) return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  const tick = (): void => {
    if (done) return;
    if (!snip.isConnected) {
      // 타이핑 도중 창이 DOM 에서 제거되면(닫힘·재생성) 떨어져 나간 노드에 계속 쓰지 않고 즉시 끝낸다.
      finish();
      return;
    }
    index = Math.min(chars.length, index + step);
    snip.textContent = chars.slice(0, index).join("");
    if (index >= chars.length) {
      finish();
      return;
    }
    timer = setTimeout(tick, TYPEWRITER_INTERVAL_MS);
  };

  timer = setTimeout(tick, TYPEWRITER_INTERVAL_MS);
}
