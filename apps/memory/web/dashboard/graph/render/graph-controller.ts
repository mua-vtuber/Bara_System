// GraphController: 3D 그래프 렌더의 외부 API 진입점.
// setData / applyFocus / focusNode / onNodeClick 를 제공.
// 내부: scene.ts (씬), nodes.ts (스프라이트), edges.ts (라인),
//       leader-line.ts (라벨 투영), camera-focus.ts (카메라),
//       highlight.ts (상태 계산).
// 큰 로직은 협력 모듈에 위임한다 — graph-data-apply.ts(setData·applyData),
//       graph-interaction.ts(이벤트·렌더 루프), graph-drag.ts(드래그 물리),
//       graph-camera.ts(카메라), graph-transitions.ts(노드·합침·창발 전환).
// 컨트롤러는 상태를 들고 협력 모듈을 조합하는 얇은 오케스트레이터다.
import * as THREE from "three";

import { createScene } from "./scene.ts";
import type { SceneHandle } from "./scene.ts";
import {
  NodeMeshBuilder,
  buildDegreeMap,
} from "./nodes.ts";
import type { NodeEntry } from "./nodes.ts";
import { planNodeVisuals } from "./nodes.ts";
import { type NodeTween } from "./node-transition.ts";
import type { MergeTween } from "./merge-transition.ts";
import type { EmergeTween } from "./emerge-transition.ts";
import {
  tickNodeTransition, applyMerge, clearLiveChoreography,
  tickMergeTransition, applyEmerge, tickEmergeTransition,
  shouldClearSelectionOnRemoval,
  type ConvergeLineHandle, type TransitionHost,
} from "./graph-transitions.ts";
import { EdgeLayer } from "./edges.ts";
import { DustLayer } from "./dust.ts";
import { MeteorTrailLayer } from "./meteor-trail.ts";
import { BirthRippleLayer } from "./birth-ripple.ts";
import { BurstParticlesLayer } from "./burst-particles.ts";
import { PulseRingLayer } from "./pulse-ring.ts";
import { EnergyFlowLayer } from "./energy-flow.ts";
import type { LabelEntry } from "./leader-line.ts";
import {
  moveCameraToPositions, tickTransition, zoomToOverview,
  type CameraHost, type CameraTransition,
} from "./graph-camera.ts";
import { resolveNodeStates, resolveEdgeStates } from "./highlight.ts";
import type { EdgeState } from "./highlight.ts";
import { type Vec3 as DragVec3 } from "./drag-relax.ts";
import { tickDrag, finishSettle, type DragHost } from "./graph-drag.ts";
import {
  setDataInto, applyDataInto, fallbackVisual, type ApplyDataOptions, type DataApplyHost,
} from "./graph-data-apply.ts";
import {
  pickNodeIdAt,
  handleCanvasClick, handleCanvasDblClick,
  handlePointerDown, handlePointerMove, handlePointerUp,
  runRenderLoop, type InteractionHost,
} from "./graph-interaction.ts";
import type {
  DashboardGraphViewModel,
  GraphNode,
  GraphEdge,
  GraphSearchView,
} from "../graph-view-model.ts";
import type { Vec3 } from "../layout/force-layout.ts";

// graph-controller.test.ts 가 기존 경로(./graph-controller.ts)로 직접 import 하므로 re-export 한다.
export { toggleGroupExpansion } from "./graph-grouping.ts";

// ---- GraphController -------------------------------------------------------

export class GraphController
  implements DragHost, TransitionHost, CameraHost, DataApplyHost, InteractionHost {
  // 씬 핸들
  readonly handle: SceneHandle;
  // 씬 루트 그룹 (노드·엣지를 담는다)
  readonly root: THREE.Group;
  // 노드 메시 생성기
  readonly meshBuilder: NodeMeshBuilder;
  // 엣지 레이어
  readonly edgeLayer: EdgeLayer;
  // 배경 먼지 레이어 (노드·엣지와 독립·끄기 쉽게 분리)
  readonly dustLayer = new DustLayer();
  // 새 노드 별똥별 꼬리 레이어 — 노드/엣지와 독립한 임시 라인 묶음.
  readonly meteorTrailLayer: MeteorTrailLayer;
  // 새 노드 중심에서 한 번 퍼지는 빛 파동 레이어(탄생 파동 + 병합 충격파 재사용).
  readonly birthRippleLayer: BirthRippleLayer;
  // 창발(탄생) 완료 시 흩어지는 버스트 입자 레이어(Task 11).
  readonly burstParticlesLayer: BurstParticlesLayer;
  // 선택 노드에 붙는 펄스 링 레이어(Task 11) — 선택 변화 때 attach/detach.
  readonly pulseRingLayer: PulseRingLayer;
  // focus 엣지 위를 흐르는 에너지 점 레이어(Task 11).
  readonly energyFlowLayer: EnergyFlowLayer;
  // prefers-reduced-motion 가드(Task 11) — 생성 시 1회 읽는다(매 프레임 재확인 아님).
  // happy-dom 등 matchMedia 가 없는 환경은 feature-detect 로 false(효과 켬) 취급한다.
  readonly reducedMotion: boolean;

  // 현재 데이터
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  nodeEntries = new Map<string, NodeEntry>();
  labels = new Map<string, LabelEntry>();
  // degree 캐시 — setData 때 한 번 계산해 idle 라벨 정렬에 재사용(매 프레임 재계산 회피).
  degree = new Map<string, number>();
  // 드래그 물리에 쓰는 노드 반지름 맵. setData/applyData 에서 degree 와 함께 갱신된다.
  dragRadii = new Map<string, number>();

  // 카메라 전환
  transition: CameraTransition | null = null;

  // 인터랙션 상태
  selectedId: string | null = null;
  hoveredId: string | null = null;
  currentSearch: GraphSearchView | undefined = undefined;
  topIds = new Set<string>();
  hitIds = new Set<string>();
  // 펼쳐진 묶음 type 집합(work·person 등). 클릭으로 토글·새로고침하면 초기화.
  expandedGroups = new Set<string>();

  // Raycast
  readonly raycaster = new THREE.Raycaster();
  readonly pointer = new THREE.Vector2();

  // 드래그 상태 (시각효과 #4) — 드래그 중인 노드 id 와 끌려올 1~2단계 이웃 집합.
  dragId: string | null = null;
  dragNeighbors = new Set<string>();
  // onPointerMove 가 갱신하는 anchor 목표 위치(마우스 평면 교점). 렌더 루프가 여기로 부드럽게
  // lerp 하고 이웃을 relaxStep 1스텝씩 수렴시킨다 — 빠른 마우스 이동에도 휙 점프·overshoot 없음.
  dragTargetPos: DragVec3 | null = null;
  // 드래그 도중 실제 이동이 있었는지. 있으면 직후 따라오는 click 한 번을 무시(상세창 오픈 차단).
  dragMoved = false;
  suppressNextClick = false;
  // 이웃별 속도(관성 물리·시각효과 #4). 활성 드래그·정착 중 누적되고 정착 끝나면 비운다.
  dragVelocities = new Map<string, DragVec3>();
  // 놓은 뒤 정착 단계 여부. true 면 anchor 는 놓은 위치 고정, 이웃은 남은 속도로 더 다가가다 멈춘다.
  dragSettling = false;
  // 정착 중 고정할 anchor id 와 그 이웃 집합(놓을 때 dragId·dragNeighbors 에서 옮겨 담는다).
  settleAnchorId: string | null = null;
  settleNeighbors = new Set<string>();
  // 정착 단계가 어떤 이유로도 무한히 안 끝나지 않게 거는 프레임 카운터(수렴은 damping<1 이 보장·이중 안전).
  dragSettleFrames = 0;
  // anchor 의 화면 평면 위치를 얻을 때 쓰는 카메라 법선 평면과 교점 버퍼.
  readonly dragPlane = new THREE.Plane();
  readonly dragPoint = new THREE.Vector3();
  // 노드 기준 좌표(force 레이아웃 결과·드래그 정착 위치). relaxStep 자연 길이 계산과
  // 후속 Task 6 노드 드리프트가 함께 쓴다. setData 에서 채우고 드래그 종료 때 옮긴 노드만 갱신.
  basePositions = new Map<string, DragVec3>();
  // 직전 검색·호버·선택이 만든 엣지 상태 — 드래그 중 엣지 위치를 매 프레임 갱신할 때
  // 상호작용 강조를 보존하려고 그대로 다시 넘긴다. 비어 있으면 렌더러가 ambient 로 해석한다.
  lastEdgeStates = new Map<string, EdgeState>();

  // 노드 전환 트윈(Task 5) — applyData 가 켜고 tickNodeTransition 이 매 프레임 진행시킨다.
  // activeTweens: 진행 중인 노드별 트윈(move·born·leave). 끝난 트윈은 그 프레임에 지운다.
  // tweenFromColor/tweenToColor: move 트윈 색 보간 양 끝(kept 노드만 채운다).
  activeTweens = new Map<string, NodeTween>();
  activeBirths = new Set<string>();
  pendingBirthQueue: string[] = [];
  sessionRecentNodeIds = new Map<string, number>();
  tweenFromColor = new Map<string, string>();
  tweenToColor = new Map<string, string>();

  // 합침 연출(2c·Task 9) — applyMerge 가 켜고 tickMergeTransition 이 매 프레임 진행시킨다.
  // fromId 를 키로 한 진행 중 흡수 트윈. 끝나면 그 프레임에 from entry 를 dispose 하고 지운다.
  activeMerges = new Map<string, MergeTween>();

  // 창발 연출(2d·Task 10) — applyEmerge 가 켜고 tickEmergeTransition 이 매 프레임 진행시킨다.
  // 진행 중 수렴+탄생 트윈 목록과, 그 트윈이 그리는 임시 수렴선 라인을 한데 묶는다.
  activeEmerges: { tween: EmergeTween; line: ConvergeLineHandle }[] = [];
  // 수렴선 임시 라인을 담는 그룹(연출 끝나면 비운다 — 누수 방지).
  readonly convergeGroup = new THREE.Group();
  // 수렴선 LineMaterial 이 굵기를 그리려면 화면 해상도가 필요하다 — resize 때 갱신한다.
  readonly convergeResolution = new THREE.Vector2(1, 1);

  // 프레임 콜백 배열 — onFrame 으로 등록한다.
  frameCallbacks: Array<() => void> = [];

  // 콜백
  // 비-묶음 노드를 클릭할 때마다 그 nodeId 로 발화한다 — 열기/맨앞/닫기 토글 판정은
  // 호출부(graph-entry)가 창 상태로 한다. 컨트롤러는 어떤 노드가 눌렸는지만 알린다.
  nodeClickCallback: ((nodeId: string) => void) | null = null;
  // 마우스가 올라간 노드가 바뀔 때만 부르는 콜백 — graph-entry 가 호버 요약 팁을 띄운다.
  hoverCallback: ((id: string | null) => void) | null = null;
  // 창발(2d) 목표 노드가 아직 화면에 없을 때, 가짜 위치를 추정하지 않고 정식 데이터를 다시
  // 받으려고 부르는 콜백. graph-entry 가 refreshGraph(overview 재취득+applyData)를 주입한다.
  refreshGraphCb: (() => Promise<void>) | null = null;

  // 애니메이션 루프 ID
  rafId: number | null = null;

  constructor(container: HTMLElement) {
    this.handle = createScene(container);
    this.root = new THREE.Group();
    this.handle.scene.add(this.root);
    this.meshBuilder = new NodeMeshBuilder();
    this.edgeLayer = new EdgeLayer(this.handle.scene, this.handle.camera);
    this.meteorTrailLayer = new MeteorTrailLayer(this.handle.scene);
    this.birthRippleLayer = new BirthRippleLayer(this.handle.scene);
    this.burstParticlesLayer = new BurstParticlesLayer(this.handle.scene);
    this.pulseRingLayer = new PulseRingLayer(this.handle.scene);
    this.energyFlowLayer = new EnergyFlowLayer(this.handle.scene);
    // matchMedia 를 컨트롤러 생성 시 1회만 읽는다(가드, 매 프레임 재확인 아님).
    // happy-dom 등 테스트 환경은 matchMedia 가 없을 수 있어 feature-detect 로 안전하게 처리한다.
    this.reducedMotion = typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.dustLayer.add(this.handle.scene);
    // 창발 수렴선(2d) 임시 라인을 담는 그룹. 노드·엣지와 독립이라 연출 끝나면 통째로 비운다.
    this.handle.scene.add(this.convergeGroup);

    // 엣지 굵기(LineMaterial)는 화면 해상도를 알아야 보인다 — 크기 변경에 따라 갱신.
    // 수렴선 LineMaterial 도 같은 해상도를 쓰므로 함께 갱신한다.
    this.handle.onResize((w, h) => {
      this.edgeLayer.setResolution(w, h);
      this.meteorTrailLayer.setResolution(w, h);
      this.convergeResolution.set(w, h);
      for (const e of this.activeEmerges) e.line.material.resolution.set(w, h);
    });

    // 클릭 이벤트 (raycast)
    this.handle.renderer.domElement.addEventListener("click", this.onCanvasClick);
    // 더블클릭 이벤트 (빈 공간이면 전체 조망으로 줌아웃)
    this.handle.renderer.domElement.addEventListener("dblclick", this.onCanvasDblClick);
    // 드래그 이벤트 (시각효과 #4) — 노드 위 pointerdown 만 드래그, 빈 공간은 OrbitControls 회전.
    // pointerup 은 캔버스 밖에서 손을 떼도 잡으려고 window 에 건다.
    this.handle.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.handle.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);

    runRenderLoop(this);
  }

  // ---- 공개 API -------------------------------------------------------------

  /**
   * 뷰모델과 노드 좌표 Map 을 받아 씬을 (재)구성한다(즉시 스냅 경로).
   * positions 키는 GraphNode.id, 값은 Vec3.
   */
  setData(
    viewModel: DashboardGraphViewModel,
    positions: Map<string, Vec3>,
  ): void {
    this.currentSearch = viewModel.search;
    setDataInto(this, viewModel, positions);
    this.refreshEdgeStates();
  }

  /**
   * 새 뷰모델·좌표를 받아 diff 기반 전환으로 갈아끼운다(Task 5).
   * - 유지된 노드: 메시를 재사용해 위치·생명력 색을 트윈으로 보간한다.
   * - 새 노드: scale·불투명도 0→1 로 떠오른다(born).
   * - 사라진 노드: 불투명도 1→0 으로 사라진 뒤 dispose 된다(leave).
   * setData 는 즉시 스냅 경로로 그대로 둔다(전환 끔·첫 로드 fallback).
   */
  applyData(
    viewModel: DashboardGraphViewModel,
    positions: Map<string, Vec3>,
    options: ApplyDataOptions = {},
  ): void {
    this.currentSearch = viewModel.search;
    applyDataInto(this, viewModel, positions, options);
    this.refreshEdgeStates();
  }

  /** 노드 전환 트윈 한 프레임(Task 5) — graph-transitions.ts 의 tickNodeTransition 에 위임. */
  tickNodeTransition(elapsed: number): boolean {
    return tickNodeTransition(this, elapsed);
  }

  // ---- 합침 연출(2c·Task 9) -------------------------------------------------

  /** 합침 신호 적용(2c·graph-entry 공개 API) — graph-transitions.ts 의 applyMerge 에 위임. */
  applyMerge(from: string, into: string): void {
    applyMerge(this, from, into);
  }

  /** 데이터 교체 때 진행 중 라이브 연출을 비운다 — graph-transitions.ts 의 clearLiveChoreography 에 위임. */
  private clearLiveChoreography(): void {
    clearLiveChoreography(this);
  }

  /** 합침 연출 한 프레임(2c·Task 9) — graph-transitions.ts 의 tickMergeTransition 에 위임. */
  tickMergeTransition(elapsed: number): boolean {
    return tickMergeTransition(this, elapsed);
  }

  // ---- 창발 연출(2d·Task 10) ------------------------------------------------

  /**
   * 창발(2d) 목표 노드가 화면에 없을 때 정식 데이터를 다시 받으려고 부르는 콜백을 등록한다.
   * graph-entry 가 refreshGraph(overview 재취득+applyData)를 넘긴다 — applyEmerge 가 가짜 위치를
   * 추정하지 않고 이 콜백으로 정식 좌표를 받은 뒤 연출을 켠다.
   */
  onRefreshGraph(cb: () => Promise<void>): void {
    this.refreshGraphCb = cb;
  }

  /** 창발 신호 적용(2d·graph-entry 공개 API) — graph-transitions.ts 의 applyEmerge 에 위임. */
  applyEmerge(nodeId: string, fromSources: string[]): void {
    applyEmerge(this, nodeId, fromSources);
  }

  /** 창발 연출 한 프레임(2d·Task 10) — graph-transitions.ts 의 tickEmergeTransition 에 위임. */
  tickEmergeTransition(elapsed: number): boolean {
    return tickEmergeTransition(this, elapsed);
  }

  /**
   * 검색 결과 포커스 적용 (T8 하이라이트 + T7 카메라 이동).
   * search 가 undefined 이면 전체 neutral + 초기 뷰로 복귀.
   */
  applyFocus(search: GraphSearchView | undefined): void {
    this.currentSearch = search;
    const nodeStates = resolveNodeStates(this.nodes, this.edges, search);

    // 히트 세트 갱신
    this.hitIds.clear();
    this.topIds.clear();
    if (search) {
      for (const id of search.highlightedNodeIds) this.hitIds.add(id);
      for (const ref of search.top3) this.topIds.add(ref.nodeId);
    }

    // degree 재계산
    const degree = buildDegreeMap(this.edges);
    const visuals = planNodeVisuals(this.nodes, degree, nodeStates);

    // 각 노드의 불투명도 갱신
    for (const [nodeId, entry] of this.nodeEntries) {
      const visual = visuals.get(nodeId) ?? fallbackVisual();
      this.meshBuilder.applyVisual(entry, visual);
    }

    // 엣지 상태 갱신
    this.refreshEdgeStates();

    // 카메라: top3 노드 전체가 한눈에 담기게 이동한다(사용자 결정: top3 전체 프레이밍).
    // 좌표는 basePositions(방금 applyData 가 채운 새 레이아웃 좌표)에서 읽는다 —
    // entry.group.position 은 전환 트윈 중 유지된 노드가 아직 옛 위치라, 검색 직후
    // 카메라가 옛 좌표를 읽어 엉뚱한 곳을 비추던 원인이었다(트윈이 1초에 걸쳐 옮긴다).
    if (search && search.top3.length > 0) {
      const targetPositions: Vec3[] = [];
      for (const ref of search.top3) {
        const base = this.basePositions.get(ref.nodeId);
        if (base) targetPositions.push({ x: base.x, y: base.y, z: base.z });
      }
      if (targetPositions.length > 0) this.moveCameraToPositions(targetPositions);
    }
  }

  /** 특정 노드 id 로 카메라만 이동한다 — 선택·펄스 링·엣지 강조는 건드리지 않는다.
   *  (파생 노드 접힘 복귀처럼 "보여주되 선택하진 않는" 흐름 전용) */
  focusCameraOnNode(id: string): void {
    const entry = this.nodeEntries.get(id);
    if (!entry) return;
    const p = entry.group.position;
    this.moveCameraToPositions([{ x: p.x, y: p.y, z: p.z }]);
  }

  /** 특정 노드 id 로 카메라를 이동하고, 그 노드를 선택 상태로 만든다. */
  focusNode(id: string): void {
    const entry = this.nodeEntries.get(id);
    if (!entry) return;
    this.focusCameraOnNode(id);
    this.selectedId = id;
    this.refreshEdgeStates();
    // 선택 노드에 펄스 링을 건다(Task 11) — reduced-motion 이면 건너뛴다(가드).
    if (!this.reducedMotion) {
      this.pulseRingLayer.attach(entry.group, this.handle.clock.getElapsedTime());
    }
  }

  /** 검색·호버·선택 상태를 합쳐 엣지 강조를 다시 적용한다. */
  refreshEdgeStates(nowS = this.handle.clock.getElapsedTime()): void {
    const edgeStates = resolveEdgeStates(this.edges, this.currentSearch, {
      hoveredId: this.hoveredId,
      selectedId: this.selectedId,
    });
    this.edgeLayer.applyEdgeStates(this.edges, edgeStates, this.nodeEntries, nowS);
    // 드래그·전환 중 엣지 위치를 매 프레임 다시 그릴 때 이 강조 상태를 그대로 보존한다.
    this.lastEdgeStates = edgeStates;
  }

  /**
   * 외부(검색 해제·overview 복귀)에서 전체 조망 거리로 카메라를 물린다.
   * 빈 공간 더블클릭과 같은 동작을 코드에서 부를 수 있게 공개한다.
   */
  resetCameraToOverview(): void {
    this.zoomToOverview();
  }

  /** 비-묶음 노드를 클릭할 때마다 그 nodeId 로 발화한다(토글 판정은 호출부가 한다). */
  onNodeClick(cb: (nodeId: string) => void): void {
    this.nodeClickCallback = cb;
  }

  /** 마우스가 올라간 노드 id 가 바뀔 때만 발화하는 콜백을 등록한다(매 프레임 발화 아님). */
  onHoverNode(cb: (nodeId: string | null) => void): void {
    this.hoverCallback = cb;
  }

  /**
   * 외부(모달 X 닫기 등)에서 선택을 비운다 — 고정 라벨이 꺼진다.
   * 콜백은 부르지 않는다(모달 쪽이 이미 닫는 흐름이라 되울림 방지).
   */
  clearSelection(): void {
    this.selectedId = null;
    this.refreshEdgeStates();
    // 선택 해제 시 펄스 링을 뗀다(Task 11).
    this.pulseRingLayer.detach();
  }

  /**
   * 선택된 노드가 화면에서 사라질 때(데이터 갱신 pruning·합침 흡수) 호출한다(Task 11 버그 수정).
   * id 가 현재 선택과 다르면 아무 것도 하지 않는다 — 사라진 노드가 선택 중이 아니면
   * 펄스 링은 이미 다른 노드나 없음 상태라 건드릴 이유가 없다.
   */
  clearSelectionIfNode(id: string): void {
    if (!shouldClearSelectionOnRemoval(this.selectedId, id)) return;
    this.clearSelection();
  }

  /** 매 프레임(RAF 루프 끝) 호출할 콜백을 등록한다. */
  onFrame(cb: () => void): void {
    this.frameCallbacks.push(cb);
  }

  /**
   * nodeId 의 노드 Group 을 leader-line.ts 와 같은 투영 수식으로 화면 좌표로 변환한다.
   * group 없거나 화면 밖이면 visible:false 를 돌려준다.
   */
  getNodeScreenPosition(nodeId: string): { x: number; y: number; visible: boolean } | null {
    const entry = this.nodeEntries.get(nodeId);
    if (!entry) return null;
    const container = this.handle.renderer.domElement.parentElement;
    if (!container) return null;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const v = new THREE.Vector3();
    entry.group.getWorldPosition(v);
    v.project(this.handle.camera);
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    const visible =
      v.z > -1 && v.z < 1 &&
      x > -80 && x < w + 80 &&
      y > -30 && y < h + 30;
    return { x, y, visible };
  }

  /** 컨트롤러와 씬을 모두 정리한다. */
  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.handle.renderer.domElement.removeEventListener("click", this.onCanvasClick);
    this.handle.renderer.domElement.removeEventListener("dblclick", this.onCanvasDblClick);
    this.handle.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.handle.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    // 진행 중이던 합침·창발 연출을 정리한다(임시 수렴선 dispose 포함·누수 방지).
    this.clearLiveChoreography();
    this.edgeLayer.dispose();
    this.meteorTrailLayer.dispose();
    this.birthRippleLayer.dispose();
    this.burstParticlesLayer.dispose();
    this.pulseRingLayer.dispose();
    this.energyFlowLayer.dispose();
    this.dustLayer.dispose();
    this.meshBuilder.dispose();
    this.handle.dispose();
  }

  // ---- 카메라 이동 -----------------------------------------------------------

  /** 주어진 노드 위치들을 담도록 카메라를 이동한다 — graph-camera.ts 의 moveCameraToPositions 에 위임. */
  private moveCameraToPositions(positions: Vec3[]): void {
    moveCameraToPositions(this, positions);
  }

  /** 진행 중 카메라 전환을 한 프레임 보간한다 — graph-camera.ts 의 tickTransition 에 위임. */
  tickTransition(elapsed: number): void {
    tickTransition(this, elapsed);
  }

  // ---- 이벤트 핸들러 (graph-interaction.ts 위임) -----------------------------
  // domElement·window 리스너에 거는 화살표 함수. raycast·픽킹·드래그/호버 상태 전이는
  // graph-interaction.ts 의 free 함수에 위임하고, 컨트롤러는 자신을 host 로 넘긴다.

  private readonly onCanvasClick = (event: MouseEvent): void => {
    handleCanvasClick(this, event);
  };

  private readonly onCanvasDblClick = (event: MouseEvent): void => {
    handleCanvasDblClick(this, event);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    handlePointerDown(this, event);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    handlePointerMove(this, event);
  };

  private readonly onPointerUp = (): void => {
    handlePointerUp(this);
  };

  /** 이벤트 지점에서 raycast 해 맞은 노드 id 를 돌려준다 — graph-interaction.ts 의 pickNodeIdAt 에 위임. */
  pickNodeIdAt(event: MouseEvent | PointerEvent): string | undefined {
    return pickNodeIdAt(this, event);
  }

  // ---- 드래그·카메라 물리 위임 -----------------------------------------------

  /** 렌더 루프 1프레임 드래그 물리(시각효과 #4) — graph-drag.ts 의 tickDrag 에 위임. */
  tickDrag(): void {
    tickDrag(this);
  }

  /** 정착 종료(시각효과 #4) — graph-drag.ts 의 finishSettle 에 위임. */
  finishSettle(): void {
    finishSettle(this);
  }

  /** 전체 조망 거리로 카메라를 물린다(시각효과 #6) — graph-camera.ts 의 zoomToOverview 에 위임. */
  zoomToOverview(): void {
    zoomToOverview(this);
  }
}
