// 상호작용·렌더 루프 협력 모듈 — GraphController 의 raycast 픽킹, 포인터/클릭/더블클릭/드래그
// 이벤트 처리, 매 프레임 렌더 루프, 라벨 갱신, 노드 상시 드리프트를 host 인자로 받아 처리한다
// (graph-drag·graph-camera·graph-transitions 와 같은 위임 패턴). 컨트롤러는 이벤트 리스너에
// 화살표 함수를 걸어 이 모듈 함수로 위임하는 얇은 오케스트레이터로 남는다.
import * as THREE from "three";

import type { SceneHandle } from "./scene.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import { applyNodeDepthVisuals, setNodeRecentGlowBoost, type NodeEntry } from "./nodes.ts";
import { DustLayer } from "./dust.ts";
import { BirthRippleLayer } from "./birth-ripple.ts";
import { BurstParticlesLayer } from "./burst-particles.ts";
import { PulseRingLayer } from "./pulse-ring.ts";
import { EnergyFlowLayer, type EnergyEdgeEndpoints } from "./energy-flow.ts";
import { EdgeLayer, edgeStrength } from "./edges.ts";
import {
  updateLabelPositions,
  resolveVisibleLabelIds,
} from "./leader-line.ts";
import type { LabelEntry } from "./leader-line.ts";
import { neighborsWithin, type Vec3 as DragVec3 } from "./drag-relax.ts";
import { nodeDriftOffset, seedFromId } from "./node-drift.ts";
import { isNodeUnderDragControl } from "./graph-drag.ts";
import type { NodeTween } from "./node-transition.ts";
import { recentNodeGlowBoost, resolveRecentNodeIds } from "./recent-node.ts";
import type { EdgeState } from "./highlight.ts";
import { toggleGroupExpansion } from "./graph-grouping.ts";
import type {
  GraphNode,
  GraphEdge,
} from "../graph-view-model.ts";

/**
 * 상호작용·렌더 루프가 읽고 쓰는 GraphController 멤버·메서드 계약.
 * 컨트롤러는 이 인터페이스를 만족하므로 자신을 host 로 넘긴다(graph-drag 등과 같은 패턴).
 * 위임 tick 메서드(tickTransition 등)는 컨트롤러가 협력 모듈로 한 단계 더 넘긴다.
 */
export interface InteractionHost {
  readonly handle: SceneHandle;
  readonly raycaster: THREE.Raycaster;
  readonly pointer: THREE.Vector2;
  readonly dustLayer: DustLayer;
  readonly birthRippleLayer: BirthRippleLayer;
  readonly burstParticlesLayer: BurstParticlesLayer;
  readonly pulseRingLayer: PulseRingLayer;
  readonly energyFlowLayer: EnergyFlowLayer;
  readonly edgeLayer: EdgeLayer;
  readonly dragPlane: THREE.Plane;
  readonly dragPoint: THREE.Vector3;

  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeEntries: Map<string, NodeEntry>;
  labels: Map<string, LabelEntry>;
  lastEdgeStates: Map<string, EdgeState>;
  activeTweens: Map<string, NodeTween>;
  sessionRecentNodeIds: Map<string, number>;
  basePositions: Map<string, DragVec3>;
  expandedGroups: Set<string>;

  selectedId: string | null;
  hoveredId: string | null;
  topIds: Set<string>;
  hitIds: Set<string>;

  dragId: string | null;
  dragNeighbors: Set<string>;
  dragTargetPos: DragVec3 | null;
  dragMoved: boolean;
  suppressNextClick: boolean;
  dragVelocities: Map<string, DragVec3>;
  dragSettling: boolean;
  settleAnchorId: string | null;
  settleNeighbors: Set<string>;
  dragSettleFrames: number;

  readonly reducedMotion: boolean;

  rafId: number | null;
  frameCallbacks: Array<() => void>;
  nodeClickCallback: ((nodeId: string) => void) | null;
  hoverCallback: ((id: string | null) => void) | null;

  // 컨트롤러가 협력 모듈로 한 단계 더 넘기는 위임 tick·동작 메서드.
  refreshEdgeStates(): void;
  tickAutoRotation(): void;
  tickTransition(elapsed: number): void;
  tickNodeTransition(elapsed: number): boolean;
  tickMergeTransition(elapsed: number): boolean;
  tickEmergeTransition(elapsed: number): boolean;
  tickDrag(): void;
  finishSettle(): void;
  zoomToOverview(): void;
}

// ---- raycast 픽킹 ----------------------------------------------------------

/**
 * 마우스/포인터 이벤트의 화면 좌표를 NDC(-1~1)로 바꿔 raycaster 를 카메라 기준으로 맞춘다.
 * 클릭·더블클릭·드래그 시작·드래그 이동이 공통으로 쓰는 raycast 준비 단계.
 */
export function setRaycasterFromEvent(host: InteractionHost, event: MouseEvent | PointerEvent): void {
  const el = host.handle.renderer.domElement;
  const rect = el.getBoundingClientRect();
  host.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  host.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  host.raycaster.setFromCamera(host.pointer, host.handle.camera);
}

/**
 * 이벤트 지점에서 raycast 해 맞은 노드 id 를 돌려준다(빈 공간이면 undefined).
 * 히트 메시(entry.hit)만 대상으로 한다 — 클릭·드래그 시작·더블클릭 빈 공간 판정 공통.
 */
export function pickNodeIdAt(host: InteractionHost, event: MouseEvent | PointerEvent): string | undefined {
  setRaycasterFromEvent(host, event);
  const pickables = [...host.nodeEntries.values()].map((e) => e.hit);
  const hits = host.raycaster.intersectObjects(pickables, false);
  return (hits[0]?.object as THREE.Mesh | undefined)?.userData?.["nodeId"] as string | undefined;
}

// ---- 클릭·더블클릭 핸들러 --------------------------------------------------

export function handleCanvasClick(host: InteractionHost, event: MouseEvent): void {
  // 드래그 직후 따라오는 click 한 번은 무시한다(끌어 놓고 상세창이 뜨는 오작동 차단).
  if (host.suppressNextClick) {
    host.suppressNextClick = false;
    return;
  }
  const nodeId = pickNodeIdAt(host, event);
  if (!nodeId) return;

  // 묶음 노드 클릭이면 펼침 토글이 주 동작 — 점은 끄지 않고 이름표만 다음 프레임에 갱신된다.
  const node = host.nodes.find((n) => n.id === nodeId);
  // leave/merge 전환 중엔 nodeEntries 에만 남고 현재 뷰모델에서는 빠진 노드를 raycast 할 수 있다.
  // 그런 과도기 노드는 상세 데이터가 없으므로 클릭을 무시해 "찾을 수 없는 노드" 창을 만들지 않는다.
  if (!node) return;
  if (node?.type === "entity_group" && node.groupType) {
    toggleGroupExpansion(host.expandedGroups, node.groupType);
    return;
  }

  // 비-묶음 노드 클릭 — 토글(열기/맨앞/닫기) 판정은 graph-entry 가 창 상태로 한다.
  host.nodeClickCallback?.(nodeId);
}

export function handleCanvasDblClick(host: InteractionHost, event: MouseEvent): void {
  // 노드를 더블클릭하면 무시 — 빈 공간 더블클릭만 전체 조망으로 물러난다.
  if (pickNodeIdAt(host, event)) return;

  host.zoomToOverview();
}

// ---- 드래그 핸들러 (시각효과 #4) -------------------------------------------

export function handlePointerDown(host: InteractionHost, event: PointerEvent): void {
  const nodeId = pickNodeIdAt(host, event);
  // 빈 공간 → 드래그 안 함(OrbitControls 회전을 그대로 둔다).
  if (!nodeId) return;

  // 묶음 노드도 다른 노드와 똑같이 드래그로 잡는다. 안 끌고 그냥 클릭하면 handleCanvasClick 이
  // 펼침/접힘을 토글하고, 끌어 실제 이동이 있으면 handlePointerUp 이 suppressNextClick 을 세워
  // 그 클릭 한 번을 무시하므로 펼침과 이동이 충돌하지 않는다.

  // 진행 중이던 정착이 있으면 그 위치를 기준으로 동결하고 끊는다(새 드래그가 우선).
  if (host.dragSettling) host.finishSettle();

  host.dragId = nodeId;
  host.dragNeighbors = neighborsWithin(host.edges, nodeId, 2);
  host.dragTargetPos = null;
  host.dragMoved = false;
  host.dragVelocities.clear(); // 새 드래그는 속도 0 에서 시작
  host.handle.controls.enabled = false; // 드래그 중 회전 차단
}

// handlePointerMove 는 두 갈래다.
//   · 드래그 중이 아니면 → 마우스 밑 노드를 집어 hoveredId 와 엣지 focus 를 갱신한다(항목6 호버 라벨).
//     이벤트 기반이라 마우스가 움직일 때만 계산하고, 가만히 있으면 비용 0.
//   · 드래그 중이면 → anchor 의 목표 위치만 갱신한다(평면 교점). 실제 이동·이웃 수렴은
//     렌더 루프의 tickDrag 가 매 프레임 부드럽게 처리한다.
export function handlePointerMove(host: InteractionHost, event: PointerEvent): void {
  if (!host.dragId) {
    const next = pickNodeIdAt(host, event) ?? null;
    if (next !== host.hoveredId) {
      host.hoveredId = next;
      host.refreshEdgeStates();
      host.hoverCallback?.(next);
    }
    return;
  }
  setRaycasterFromEvent(host, event);

  // 카메라를 향하는 평면을 anchor 의 현재 위치에 두면, ray 와의 교점이 새 목표 위치다.
  const anchorEntry = host.nodeEntries.get(host.dragId);
  if (!anchorEntry) return;
  const camDir = new THREE.Vector3();
  host.handle.camera.getWorldDirection(camDir);
  host.dragPlane.setFromNormalAndCoplanarPoint(camDir, anchorEntry.group.position);
  if (!host.raycaster.ray.intersectPlane(host.dragPlane, host.dragPoint)) return;

  host.dragTargetPos = { x: host.dragPoint.x, y: host.dragPoint.y, z: host.dragPoint.z };
  host.dragMoved = true;
}

export function handlePointerUp(host: InteractionHost): void {
  if (!host.dragId) return;

  // 실제 드래그가 있었으면 직후 따라오는 click 한 번을 무시(노드 상세창 오작동 차단).
  if (host.dragMoved) host.suppressNextClick = true;

  if (host.dragMoved) {
    // 실제로 이동이 있었을 때만 정착 단계를 시작한다.
    // 클릭(이동 없음)에는 정착을 건너뛴다 — 정착 물리가 최소 간격 보정을 실행하면
    // 이웃 노드가 이유 없이 튕기기 때문이다.
    // anchor 는 놓은 위치 고정, 이웃은 남은 속도로 더 다가가다 감쇠로 멈춘다.
    // anchor id·이웃 집합·속도는 그대로 유지하고, 정착이 끝날 때
    // basePositions 를 갱신한다(tickDrag → finishSettle).
    // 드래그 중 누적된 잔여 속도는 그대로 정착 단계로 넘긴다(관성 연출).
    // settleMaxVel(0.25) 클램프가 과도한 튀김을 막으므로 안전하다.
    host.settleAnchorId = host.dragId;
    host.settleNeighbors = new Set(host.dragNeighbors);
    host.dragSettling = true;
    host.dragSettleFrames = 0;
  }

  host.dragId = null;
  host.dragNeighbors.clear();
  host.dragTargetPos = null;
  host.dragMoved = false;
  host.handle.controls.enabled = true; // 회전 복귀(정착은 백그라운드로 잦아든다)
}

// ---- 노드 상시 드리프트 (시각효과 #3·분리형) -------------------------------

/**
 * 드리프트 오프셋을 기준 좌표(basePositions)에 더해 노드를 미세하게 흔든다(시각효과 #3).
 * 드래그·정착 중 노드는 건너뛰어 tickDrag 와 충돌하지 않는다. amplitude 0 이면 통째로
 * 건너뛰어 0 영향 — 이 함수와 runRenderLoop 의 호출 한 줄을 지우면 효과가 깔끔히 사라진다.
 * 노드가 한 군데라도 흔들렸으면 true 를 돌려 렌더 루프가 엣지를 따라 그리게 한다.
 */
export function applyNodeDrift(host: InteractionHost, elapsed: number): boolean {
  if (GRAPH_RENDER_THEME.nodeDrift.amplitude === 0) return false;
  let moved = false;
  for (const [id, entry] of host.nodeEntries) {
    if (isNodeUnderDragControl(host, id)) continue;
    // 전환 트윈이 위치를 소유한 노드는 드리프트가 건드리지 않는다(Task 5 순서 결함 차단).
    // 트윈이 같은 프레임 앞서 정한 보간 위치를 여기서 basePosition+오프셋으로 덮으면 move
    // 미끄러짐이 사라지고 최종 위치로 튄다. 트윈이 끝나 activeTweens 에서 빠지면 그때부터
    // 새 basePosition 둘레로 드리프트가 다시 흔든다.
    if (host.activeTweens.has(id)) continue;
    const base = host.basePositions.get(id);
    if (!base) continue;
    // seedFromId(id) 로 결정적 시드를 계산한다 — 순회 순서 무관하게 같은 id 는
    // 항상 같은 위상을 가져 finishSettle 에서 offset 을 재현할 수 있다.
    const o = nodeDriftOffset(elapsed, seedFromId(id));
    entry.group.position.set(base.x + o.x, base.y + o.y, base.z + o.z);
    moved = true;
  }
  return moved;
}

// ---- 라벨 갱신 -------------------------------------------------------------

/**
 * 보이는 라벨을 추려 화면 위치를 갱신한다(렌더 루프 매 프레임). 노드 그룹 위치·선택/호버/
 * top3/히트/펼침 상태로 보일 라벨 id 를 정한 뒤 leader-line 의 updateLabelPositions 에 넘긴다.
 */
export function updateLabels(host: InteractionHost): void {
  const nodeGroups = new Map<string, THREE.Group>();
  for (const [id, entry] of host.nodeEntries) {
    nodeGroups.set(id, entry.group);
  }
  const visibleLabelIds = resolveVisibleLabelIds(
    host.nodes,
    host.selectedId,
    host.hoveredId,
    host.topIds,
    host.hitIds,
    host.expandedGroups,
    host.edges,
    resolveRecentNodeIds(
      host.nodes,
      host.sessionRecentNodeIds,
      Date.now(),
      GRAPH_RENDER_THEME.recentNode,
    ),
  );
  const container = host.handle.renderer.domElement.parentElement;
  if (!container) return;
  updateLabelPositions(
    host.labels,
    nodeGroups,
    host.handle.camera,
    container.clientWidth || window.innerWidth,
    container.clientHeight || window.innerHeight,
    visibleLabelIds,
  );
}

function collectProtectedNodeIds(host: InteractionHost): Set<string> {
  const ids = new Set<string>();
  if (host.selectedId) ids.add(host.selectedId);
  if (host.hoveredId) ids.add(host.hoveredId);
  if (host.dragId) ids.add(host.dragId);
  if (host.settleAnchorId) ids.add(host.settleAnchorId);
  for (const id of host.topIds) ids.add(id);
  for (const id of host.hitIds) ids.add(id);
  return ids;
}

function applyRecentNodeVisuals(host: InteractionHost, elapsed: number): void {
  const nowMs = Date.now();
  const nodeById = new Map(host.nodes.map((node) => [node.id, node]));
  for (const [id, entry] of host.nodeEntries) {
    const node = nodeById.get(id);
    if (!node) {
      setNodeRecentGlowBoost(entry, 1);
      continue;
    }
    setNodeRecentGlowBoost(
      entry,
      recentNodeGlowBoost(
        node,
        host.sessionRecentNodeIds,
        nowMs,
        elapsed,
        GRAPH_RENDER_THEME.recentNode,
      ),
    );
  }
}

// ---- 에너지 흐름 대상 엣지 수집(Task 11) -----------------------------------

/**
 * lastEdgeStates 가 "focus" 로 표시한 엣지만 골라 양 끝 노드의 현재 위치를 모은다.
 * 노드가 화면에 없는 엣지는 건너뛴다(정직 — 그릴 게 없으면 생략).
 * weight 는 edgeStrength(결측 기본값·clamp 포함)로 채운다 — EnergyFlowLayer 가
 * MAX_ENERGY_EDGES 초과 시 weight 큰 순서로 남기는 우선순위로 쓴다.
 */
function collectFocusEdgeEndpoints(host: InteractionHost): EnergyEdgeEndpoints[] {
  const out: EnergyEdgeEndpoints[] = [];
  for (const edge of host.edges) {
    if (host.lastEdgeStates.get(edge.id) !== "focus") continue;
    const fromEntry = host.nodeEntries.get(edge.from);
    const toEntry = host.nodeEntries.get(edge.to);
    if (!fromEntry || !toEntry) continue;
    const a = fromEntry.group.position;
    const b = toEntry.group.position;
    out.push({
      from: { x: a.x, y: a.y, z: a.z },
      to: { x: b.x, y: b.y, z: b.z },
      weight: edgeStrength(edge),
    });
  }
  return out;
}

// ---- 렌더 루프 -------------------------------------------------------------

/**
 * RAF 렌더 루프를 시작한다(매 프레임 호출). 카메라 전환·노드 전환·합침/창발 연출·드래그
 * 물리·상시 드리프트를 한 프레임씩 진행하고, 노드가 움직였으면 엣지를 다시 그린 뒤 라벨을
 * 갱신하고 프레임 콜백을 부른 다음 씬을 렌더한다. host.rafId 에 다음 프레임 핸들을 적는다.
 */
export function runRenderLoop(host: InteractionHost): void {
  const loop = () => {
    host.rafId = requestAnimationFrame(loop);
    const elapsed = host.handle.clock.getElapsedTime();

    host.dustLayer.update(elapsed);
    host.birthRippleLayer.update(elapsed);
    // 신규 이펙트(Task 11) — reduced-motion 이면 스폰 자체를 건너뛰므로(가드) 여기 update 는
    // 진행 중이던 항목만 계속 진행시킨다(이미 스폰된 게 없으면 사실상 no-op).
    if (!host.reducedMotion) {
      host.burstParticlesLayer.update(elapsed);
      host.pulseRingLayer.update(elapsed);
      host.energyFlowLayer.update(collectFocusEdgeEndpoints(host), elapsed);
    }
    host.tickAutoRotation();
    host.handle.controls.update();
    host.tickTransition(elapsed);

    // 노드 전환 트윈(Task 5) — move·born·leave 를 한 프레임 진행시킨다. 진행 중이면 true.
    const tweening = host.tickNodeTransition(elapsed);

    // 합침(2c)·창발(2d) 연출을 한 프레임 진행시킨다. 진행 중이면 엣지가 노드를 따라오게
    // 아래 엣지 갱신 조건에 합류한다(흡수로 from 이 움직이거나 탄생으로 노드가 떠오르면 선도 갱신).
    const merging = host.tickMergeTransition(elapsed);
    const emerging = host.tickEmergeTransition(elapsed);

    // 활성 드래그(anchor 를 목표로 당기며 이웃 속도 누적) 또는 놓은 뒤 정착(anchor 고정·이웃이
    // 남은 속도로 더 다가가다 멈춤) 중에는 한 스텝 물리를 굴린다.
    const draggingOrSettling = host.dragId !== null || host.dragSettling;
    if (draggingOrSettling) {
      host.tickDrag();
    }

    // 상시 드리프트(시각효과 #3) — 드래그·정착이 건드리지 않는 모든 노드를 기준 좌표 둘레로
    // 미세하게 흔든다. amplitude 0 이면 내부에서 통째로 건너뛴다(떼어내기 보존).
    const drifting = applyNodeDrift(host, elapsed);

    // 노드가 한 군데라도 움직였으면 엣지 끝점을 다시 그려 선이 노드를 따라오게 한다.
    // applyEdgeStates 는 nodeEntries 의 현재 위치를 다시 읽어 라인 끝점을 갱신하고,
    // 직전 검색·호버·선택 강조(lastEdgeStates)를 그대로 넘겨 상태 표시를 보존한다.
    // elapsed 를 넘겨 새 엣지 자람(Task 6)도 같은 프레임에 길이 0→full 로 진행시킨다.
    // 엣지 자람은 노드 트윈과 독립으로 진행될 수 있어 isGrowing 도 갱신 트리거에 넣는다.
    if (draggingOrSettling || drifting || tweening || merging || emerging || host.edgeLayer.isGrowing()) {
      host.edgeLayer.applyEdgeStates(host.edges, host.lastEdgeStates, host.nodeEntries, elapsed);
    }

    applyRecentNodeVisuals(host, elapsed);
    applyNodeDepthVisuals(host.nodeEntries, host.handle.camera, collectProtectedNodeIds(host));
    updateLabels(host);

    for (const cb of host.frameCallbacks) cb();
    host.handle.renderer.render(host.handle.scene, host.handle.camera);
  };
  host.rafId = requestAnimationFrame(loop);
}
