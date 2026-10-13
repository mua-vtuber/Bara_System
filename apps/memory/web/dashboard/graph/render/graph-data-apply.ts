// 데이터 로드 협력 모듈 — GraphController 가 setData·applyData 로 받은 뷰모델을 씬에 반영하는
// 큰 로직을 host 인자로 받아 처리한다(graph-drag·graph-camera·graph-transitions 와 같은 위임 패턴).
//   · setDataInto:  즉시 스냅 경로(전환 없이 노드·엣지·라벨 통째 재구성).
//   · applyDataInto: diff 기반 전환 경로(유지=색·위치 트윈·신규=born·사라짐=leave).
// 컨트롤러는 이 모듈을 조합하는 얇은 오케스트레이터로 남는다.
import * as THREE from "three";

import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import {
  NodeMeshBuilder, planNodeVisuals, applyTweenToEntry,
  buildDegreeMap, nodeSizeOf,
} from "./nodes.ts";
import { radiusOfSize } from "../layout/spacing.ts";
import { diffGraph } from "./graph-diff.ts";
import { planNodeTweens, sampleTween, type NodeTween } from "./node-transition.ts";
import { clearLiveChoreography, type TransitionHost } from "./graph-transitions.ts";
import { EdgeLayer } from "./edges.ts";
import { BirthRippleLayer } from "./birth-ripple.ts";
import { classifyReflowMode } from "./reflow-mode.ts";
import {
  createLabels,
  removeLabels,
} from "./leader-line.ts";
import type { LabelEntry } from "./leader-line.ts";
import { resolveNodeStates } from "./highlight.ts";
import type { EdgeState } from "./highlight.ts";
import { type Vec3 as DragVec3 } from "./drag-relax.ts";
import type {
  DashboardGraphViewModel,
  GraphNode,
  GraphEdge,
} from "../graph-view-model.ts";
import type { Vec3 } from "../layout/force-layout.ts";

// 노드 전환 트윈 길이(초). 0 이면 즉시 스냅(전환 꺼짐). graph-theme.ts 미커밋 튜닝 보존 위해 여기 상수로 둔다(plan 결정 반영).
export const NODE_TRANSITION_DURATION_S = 1.0 as const;

/**
 * setData·applyData 가 씬을 (재)구성할 때 읽고 쓰는 GraphController 멤버 계약.
 * 컨트롤러는 이 인터페이스를 만족하므로 자신을 host 로 넘긴다(graph-drag 등과 같은 패턴).
 *
 * resetDragAndLiveState 가 clearLiveChoreography(TransitionHost 인자)를 호출하므로
 * TransitionHost 를 확장한다 — handle·root·convergeGroup·convergeResolution·nodeEntries·
 * basePositions·activeTweens·tweenFromColor·tweenToColor·activeMerges·activeEmerges·
 * refreshGraphCb 는 거기서 들어온다. 여기서는 데이터 로드 전용 필드만 더한다.
 */
export interface DataApplyHost extends TransitionHost {
  readonly meshBuilder: NodeMeshBuilder;
  readonly edgeLayer: EdgeLayer;
  readonly birthRippleLayer: BirthRippleLayer;
  nodes: GraphNode[];
  edges: GraphEdge[];
  labels: Map<string, LabelEntry>;
  degree: Map<string, number>;
  dragRadii: Map<string, number>;
  lastEdgeStates: Map<string, EdgeState>;
  sessionRecentNodeIds: Map<string, number>;
  expandedGroups: Set<string>;
  // 드래그·정착 상태 — 데이터 교체 때 비운다.
  dragId: string | null;
  dragNeighbors: Set<string>;
  dragTargetPos: DragVec3 | null;
  dragMoved: boolean;
  dragSettling: boolean;
  settleAnchorId: string | null;
  settleNeighbors: Set<string>;
  dragVelocities: Map<string, DragVec3>;
  dragSettleFrames: number;
}

export interface ApplyDataOptions {
  source?: "overview" | "search";
}

/** 시각 계획에 노드가 빠졌을 때 쓰는 기본 시각값(점 크기·기본색). setData·applyData·applyFocus 공통. */
export function fallbackVisual() {
  return {
    tier: "dot" as const,
    size: 0.16,
    dim: false,
    color: GRAPH_RENDER_THEME.nodeDefaultColor,
  };
}

type PositionEntry = {
  group: { position: { x: number; y: number; z: number } };
};

/** 구조 diff 가 실제로 바뀐 노드·엣지를 담는지 확인한다. */
export function hasStructuralGraphChange(diff: ReturnType<typeof diffGraph>): boolean {
  return diff.addedNodeIds.length > 0 ||
    diff.removedNodeIds.length > 0 ||
    diff.addedEdgeKeys.length > 0 ||
    diff.removedEdgeKeys.length > 0;
}

/**
 * 같은 데이터가 진행 중 전환 위로 한 번 더 들어온 경우엔 기존 트윈을 보존한다.
 * 중복 refresh 가 born 트윈을 곧장 완성 상태로 덮어쓰는 문제를 막는다.
 */
export function shouldPreserveActiveDataTransition(
  diff: ReturnType<typeof diffGraph>,
  hasActiveNodeTween: boolean,
  hasGrowingEdge: boolean,
): boolean {
  return !hasStructuralGraphChange(diff) && (hasActiveNodeTween || hasGrowingEdge);
}

/**
 * 새 전환의 시작점은 basePositions 가 아니라 지금 화면에 실제로 보이는 위치다.
 * 연속 입력·SSE 중복 refresh 로 이전 트윈이 끝나기 전에 applyData 가 다시 들어와도
 * 현재 프레임 위치에서 이어 움직이게 해 마지막 순간 스냅을 막는다.
 */
export function collectCurrentNodePositions(
  nodeEntries: ReadonlyMap<string, PositionEntry>,
  basePositions: ReadonlyMap<string, Vec3>,
): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  for (const [id, pos] of basePositions) out.set(id, { x: pos.x, y: pos.y, z: pos.z });
  for (const [id, entry] of nodeEntries) {
    const p = entry.group.position;
    out.set(id, { x: p.x, y: p.y, z: p.z });
  }
  return out;
}

/**
 * 새 전환 계획을 기존 active tween 위에 병합한다.
 * 핵심: 아직 날아오는 born 은 move 로 덮지 않고, 도착점만 갱신해 앞선 연출을 계속 살린다.
 */
export function mergeNodeTransitionPlan(
  active: ReadonlyMap<string, NodeTween>,
  planned: Iterable<NodeTween>,
): Map<string, NodeTween> {
  const next = new Map(active);
  for (const tween of planned) {
    const existing = next.get(tween.nodeId);
    if (existing?.kind === "born" && tween.kind !== "leave") {
      next.set(tween.nodeId, {
        ...existing,
        toPos: tween.toPos,
        birthTargetRevision: (existing.birthTargetRevision ?? 0) + 1,
      });
      continue;
    }
    next.set(tween.nodeId, tween);
  }
  return next;
}

function transitionDurationsFor(
  source: ApplyDataOptions["source"],
  reflowMode: "local" | "global",
): { birth: number; move: number; edgeDelay: number; edgeGrow: number } {
  if (source === "search") {
    return {
      birth: NODE_TRANSITION_DURATION_S,
      move: NODE_TRANSITION_DURATION_S,
      edgeDelay: 0,
      edgeGrow: NODE_TRANSITION_DURATION_S,
    };
  }
  const birth = GRAPH_RENDER_THEME.nodeBirth.durationS;
  const move = reflowMode === "global"
    ? GRAPH_RENDER_THEME.nodeBirth.globalMoveDurationS
    : GRAPH_RENDER_THEME.nodeBirth.localMoveDurationS;
  return {
    birth,
    move,
    edgeDelay: birth * GRAPH_RENDER_THEME.nodeBirth.edgeDelayRatio,
    edgeGrow: GRAPH_RENDER_THEME.nodeBirth.edgeGrowDurationS,
  };
}

function rememberSessionRecentNodes(host: DataApplyHost, nodeIds: readonly string[], nowMs: number): void {
  for (const id of nodeIds) host.sessionRecentNodeIds.set(id, nowMs);
}

/** 씬에서 노드 그룹을 떼어내고 엔트리 맵을 비운다(데이터 재구성 직전). */
function clearNodes(host: DataApplyHost): void {
  for (const entry of host.nodeEntries.values()) {
    host.root.remove(entry.group);
  }
  host.nodeEntries.clear();
}

/** 사라진 묶음 type 의 펼침 상태를 버린다(아직 화면에 있는 묶음의 펼침은 유지). setData·applyData 공통. */
function prunePresentGroups(host: DataApplyHost): void {
  const presentGroupTypes = new Set<string>();
  for (const n of host.nodes) {
    if (n.type === "entity_group" && n.groupType) presentGroupTypes.add(n.groupType);
  }
  for (const gt of [...host.expandedGroups]) {
    if (!presentGroupTypes.has(gt)) host.expandedGroups.delete(gt);
  }
}

/**
 * 데이터를 통째로 갈아끼울 때(setData·applyData) 진행 중이던 드래그·정착·라이브 연출을 비운다.
 * 옛 노드 id 를 참조하는 상태가 새 노드 집합에선 무효이므로 깔끔히 끊는다 —
 * 드래그/정착 플래그 초기화 + 합침·창발 연출 정리(임시 수렴선 dispose 포함).
 */
function resetDragAndLiveState(host: DataApplyHost): void {
  host.dragId = null;
  host.dragNeighbors.clear();
  host.dragTargetPos = null;
  host.dragMoved = false;
  host.dragSettling = false;
  host.settleAnchorId = null;
  host.settleNeighbors.clear();
  host.dragVelocities.clear();
  host.dragSettleFrames = 0;
  clearLiveChoreography(host);
}

/**
 * 뷰모델과 노드 좌표 Map 을 받아 씬을 (재)구성한다(즉시 스냅 경로).
 * positions 키는 GraphNode.id, 값은 Vec3.
 */
export function setDataInto(
  host: DataApplyHost,
  viewModel: DashboardGraphViewModel,
  positions: Map<string, Vec3>,
): void {
  // 기존 노드 폐기
  clearNodes(host);

  host.nodes = viewModel.nodes;
  host.edges = viewModel.edges;

  const degree = buildDegreeMap(host.edges);
  host.degree = degree;
  host.dragRadii = new Map(host.nodes.map((n) => [n.id, radiusOfSize(nodeSizeOf(n, host.degree.get(n.id) ?? 0))]));
  // 검색 없음 → 전부 neutral
  const states = resolveNodeStates(host.nodes, host.edges, viewModel.search);
  const visuals = planNodeVisuals(host.nodes, degree, states);

  // 기준 좌표 새로 채운다 — relaxStep 자연 길이·후속 드리프트(Task 6)가 쓴다.
  host.basePositions = new Map<string, DragVec3>();

  for (const node of host.nodes) {
    const visual = visuals.get(node.id) ?? fallbackVisual();
    const entry = host.meshBuilder.createEntry(node, visual);

    const pos = positions.get(node.id);
    if (pos) {
      entry.group.position.set(pos.x, pos.y, pos.z);
      host.basePositions.set(node.id, { x: pos.x, y: pos.y, z: pos.z });
    }

    host.root.add(entry.group);
    host.nodeEntries.set(node.id, entry);
  }

  host.edgeLayer.rebuild(host.edges, host.nodeEntries, host.nodes);

  // 라벨 재구성
  removeLabels(host.handle.renderer.domElement.parentElement ?? document.body, host.labels);
  const labelContainer = host.handle.renderer.domElement.parentElement ?? document.body;
  host.labels = createLabels(labelContainer, host.nodes);

  // 사라진 묶음 type 의 펼침 상태는 버리고, 아직 있는 묶음은 펼침을 유지한다.
  prunePresentGroups(host);

  // 새 데이터로 갈아끼웠으니 옛 엣지 강조는 버린다(엣지 id 가 더는 안 맞을 수 있다).
  // 드래그 중 엣지 갱신은 빈 Map(=전부 ambient)으로 시작한다.
  host.lastEdgeStates = new Map<string, EdgeState>();

  // 진행 중이던 드래그·정착·라이브 연출은 새 노드 집합에선 옛 id 참조라 무효 — 깔끔히 비운다.
  resetDragAndLiveState(host);
  host.activeTweens.clear();
  host.activeBirths.clear();
  host.sessionRecentNodeIds.clear();
  host.pendingBirthQueue = [];
  host.meteorTrailLayer.clear();
  host.birthRippleLayer.clear();
}

/**
 * 새 뷰모델·좌표를 받아 diff 기반 전환으로 갈아끼운다(Task 5).
 * - 유지된 노드: 메시를 재사용해 위치·생명력 색을 트윈으로 보간한다.
 * - 새 노드: scale·불투명도 0→1 로 떠오른다(born).
 * - 사라진 노드: 불투명도 1→0 으로 사라진 뒤 dispose 된다(leave).
 * setData 는 즉시 스냅 경로로 그대로 둔다(전환 끔·첫 로드 fallback).
 */
export function applyDataInto(
  host: DataApplyHost,
  viewModel: DashboardGraphViewModel,
  positions: Map<string, Vec3>,
  options: ApplyDataOptions = {},
): void {
  // 전환 꺼짐(길이 0) 또는 첫 로드(기존 노드 없음)면 즉시 스냅 경로로 간다.
  if (NODE_TRANSITION_DURATION_S <= 0 || host.nodeEntries.size === 0) {
    setDataInto(host, viewModel, positions);
    return;
  }

  const source = options.source ?? "overview";
  const diff = diffGraph(host.nodes, host.edges, viewModel.nodes, viewModel.edges);
  if (shouldPreserveActiveDataTransition(diff, host.activeTweens.size > 0, host.edgeLayer.isGrowing())) {
    host.nodes = viewModel.nodes;
    host.edges = viewModel.edges;
    return;
  }
  // 옛 좌표는 현재 렌더된 위치를 우선한다. basePositions 는 이미 다음 목표 좌표로 바뀌어
  // 있을 수 있어, 연속 refresh 중간에 쓰면 노드가 목표 위치로 즉시 튄다.
  const prevPos = collectCurrentNodePositions(host.nodeEntries, host.basePositions);

  // 새 시각(색·크기) 계획. 검색 강조는 전환 시점엔 neutral 로 둔다(applyFocus 가 따로 갱신).
  const degree = buildDegreeMap(viewModel.edges);
  const states = resolveNodeStates(viewModel.nodes, viewModel.edges, viewModel.search);
  const visuals = planNodeVisuals(viewModel.nodes, degree, states);
  const reflowMode = classifyReflowMode(
    diff,
    host.nodes,
    host.edges,
    viewModel.nodes,
    viewModel.edges,
    { maxLocalAddedNodes: GRAPH_RENDER_THEME.nodeBirth.maxLocalAddedNodes },
  );
  const durations = transitionDurationsFor(source, reflowMode);
  const now = host.handle.clock.getElapsedTime();
  const plannedTweens = planNodeTweens(
    diff,
    prevPos,
    positions,
    now,
    durations.birth,
    {
      birth: GRAPH_RENDER_THEME.nodeBirth,
      animateBirthFlight: source !== "search",
      // T17 — 파생 노드 확장/축소(scatter/gather) anchor 판정용. scatter(added)는 신규
      // viewModel.edges 에서, gather(removed)는 옛 host.edges 에서 부모 연결을 찾아야 한다
      // (사라지는 노드의 엣지는 새 viewModel 에 이미 없다) — 두 엣지 집합을 합쳐 넘긴다.
      // reduced-motion(Task 11 가드)이면 빈 배열을 넘겨 scatter/gather 자체를 끈다 —
      // resolveExpansionAnchorId 가 항상 null 을 돌려주므로 즉시 등장/제자리 페이드로 폴백한다.
      edges: host.reducedMotion ? [] : [...host.edges, ...viewModel.edges],
    },
  ).map((tween) => ({
    ...tween,
    duration: tween.kind === "born" ? durations.birth : durations.move,
  }));
  const plannedById = new Map(plannedTweens.map((tween) => [tween.nodeId, tween]));

  // 새로 들어온 노드: 메시를 만들어 좌표에 놓되, born 트윈이 scale 0 에서 떠오르게 한다.
  for (const id of diff.addedNodeIds) {
    const node = viewModel.nodes.find((nd) => nd.id === id);
    if (!node) continue;
    const visual = visuals.get(id) ?? fallbackVisual();
    const entry = host.meshBuilder.createEntry(node, visual);
    const pos = positions.get(id);
    const planned = plannedById.get(id);
    const initialPos = planned?.fromPos ?? pos;
    if (initialPos) entry.group.position.set(initialPos.x, initialPos.y, initialPos.z);
    host.root.add(entry.group);
    host.nodeEntries.set(id, entry);
    // born 트윈 시작 전에 t=0 초기 상태(scale 0, opacity 0)를 즉시 적용한다.
    // createEntry 가 완전한 크기·불투명도로 메시를 만들어 최소 한 프레임 동안
    // 그대로 보이는 문제를 막기 위함. sampleTween 에 startedAt=now 를 넘기면
    // t=0 으로 평가되어 bornPop(0)≈0, opacityMul=0 이 돌아온다.
    if (planned) applyTweenToEntry(entry, sampleTween(planned, now));
  }

  // 유지된 노드: 색 보간 양 끝을 기록한다(현재 메시 색 → 새 시각 색).
  host.tweenFromColor.clear();
  host.tweenToColor.clear();
  for (const id of diff.keptNodeIds) {
    const entry = host.nodeEntries.get(id);
    if (!entry) continue;
    const curColor = "#" + (entry.core.material as THREE.SpriteMaterial).color.getHexString();
    const toColor = visuals.get(id)?.color ?? GRAPH_RENDER_THEME.nodeDefaultColor;
    host.tweenFromColor.set(id, curColor);
    host.tweenToColor.set(id, toColor);
  }

  // 트윈 병합. 진행 중인 born 은 지우지 않고 새 목표만 갱신한다.
  host.activeTweens = mergeNodeTransitionPlan(host.activeTweens, plannedTweens);
  if (source === "overview") rememberSessionRecentNodes(host, diff.addedNodeIds, Date.now());

  // 데이터를 새 것으로 교체. 사라진 노드는 leave 트윈이 끝날 때 dispose 되므로 여기선
  // nodeEntries 에서 빼지 않는다(트윈 끝까지 보여야 한다).
  host.nodes = viewModel.nodes;
  host.edges = viewModel.edges;
  host.degree = degree;
  host.dragRadii = new Map(host.nodes.map((n) => [n.id, radiusOfSize(nodeSizeOf(n, host.degree.get(n.id) ?? 0))]));


  // 기준 좌표를 새 좌표로 다시 채운다(드리프트·정착이 쓴다).
  host.basePositions = new Map<string, DragVec3>();
  for (const [id, pos] of positions) {
    host.basePositions.set(id, { x: pos.x, y: pos.y, z: pos.z });
  }

  // 엣지·라벨 재구성.
  host.edgeLayer.rebuild(host.edges, host.nodeEntries, host.nodes);
  // 새로 들어온 엣지는 길이 0→full 로 자란다(Task 6). 노드 트윈과 같은 시계·길이를 써 함께 진행한다.
  // 유지된(바뀌지 않은) 엣지는 키가 빠져 있어 완전 길이로 그대로 그려진다.
  host.edgeLayer.setGrowing(new Set(diff.addedEdgeKeys), now + durations.edgeDelay, durations.edgeGrow);
  removeLabels(host.handle.renderer.domElement.parentElement ?? document.body, host.labels);
  const labelContainer = host.handle.renderer.domElement.parentElement ?? document.body;
  host.labels = createLabels(labelContainer, host.nodes);

  // 사라진 묶음 type 의 펼침 상태는 버리고, 아직 있는 묶음은 펼침을 유지한다.
  prunePresentGroups(host);

  // 새 데이터로 갈아끼웠으니 옛 엣지 강조는 버린다.
  host.lastEdgeStates = new Map<string, EdgeState>();

  // 진행 중이던 드래그·정착·라이브 연출은 새 노드 집합에선 옛 id 참조라 무효 — 깔끔히 비운다.
  resetDragAndLiveState(host);
}
