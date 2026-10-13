// 노드 시각 계산 — Three.js 스프라이트(Sprite) 기반 노드 생성·갱신
// 견본 graph-3d.js: createNode(L533), nodeBaseSize(L512), nodeVisualTier, colorForNode 이식.
import * as THREE from "three";
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import { DecorationBuilder } from "./decorations.ts";
import type { NodeState } from "./highlight.ts";
import { lerpHexColor } from "./color-lerp.ts";
import type { TweenSample } from "./node-transition.ts";

// ---- 크기 상수 (색·크기 토큰은 graph-theme.ts GRAPH_RENDER_THEME 단일 출처) ----------

/**
 * 노드 크기 하·상한 (1차 키움: min 0.09→0.16, max 0.34→0.52).
 * 3a 개정: 크기는 degree 단일 신호로 정한다(starDegreeCap 정규화). 색은 생명력
 * 입력으로 분리됐다 — 두 채널이 서로 다른 사실(연결 수 vs 생명력)을 나타낸다.
 */
export const NODE_SIZE = {
  min: 0.16,
  max: 0.52,
} as const;

/** 글로우 sprite 크기 배율 */
const GLOW_SCALE = {
  hub: 4.8,
  dot: 2.8,
} as const;

/** 코어 sprite 크기 배율 (2차 키움: dot 1.4→2.2, hub 2.4→3.4 — 점을 글자 높이 정도로) */
const CORE_SCALE = {
  hub: 3.4,
  dot: 2.2,
} as const;

/** hit-sphere 크기 상한 (타입별) */
const HIT_MAX: Record<string, number> = {
  project: 0.62,
  default: 0.44,
};

/** 흐림(dim) 상태 불투명도 */
const DIM_OPACITY = 0.18;

/**
 * 기본 불투명도 (halo 는 토큰 haloOpacity 를 그대로 쓴다).
 * graph-controller 의 합침 페이드(applyOpacityToEntry)도 같은 기준값을 곱하므로 export 한다
 * (값 단일 출처 — 하드코딩 중복 금지).
 */
export const NORMAL_OPACITY_GLOW = 0.46;
export const NORMAL_OPACITY_CORE = 1.0;

// 탄생 광채 버스트가 글로우·헤일로 불투명도에 더하는 이득(가산 혼합 → 밝게 터짐). 라이브 조절용.
const BORN_BURST_OPACITY_GAIN = 0.6;
// 탄생 광채 버스트가 글로우·헤일로 크기에 더하는 배율 이득(더 크게 터짐). 라이브 조절용.
const BORN_BURST_SCALE_GAIN = 0.7;

/** 현재 프레임의 화면 깊이 폭이 이보다 작으면 상대 fade 를 끈다. */
const DEPTH_RANGE_EPSILON = 1e-6 as const;

const EMPTY_PROTECTED_IDS: ReadonlySet<string> = new Set();

// ---- 별 크기·색 보간 (순수 헬퍼 — WebGL 없이 테스트 가능) -------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** degree 를 0~1 로 정규화한다 — 별 크기 신호(3a 개정으로 색과 분리). */
function degreeSignalOf(degree: number): number {
  const cap = GRAPH_RENDER_THEME.starDegreeCap;
  return Math.max(0, Math.min(degree, cap)) / cap;
}

/**
 * 노드 하나의 시각 크기를 계산한다.
 * - entity_group: NODE_SIZE.max * groupScale (degree 무관, 자식 묶음 노드라 크게 그린다).
 * - 그 외: degree 신호를 NODE_SIZE 범위 안에서 선형 보간한 값.
 * graph-entry.ts 초기 배치와 graph-controller.ts 드래그가 같은 헬퍼를 공유하도록 export 한다.
 */
export function nodeSizeOf(node: GraphNode, deg: number): number {
  return node.type === "entity_group"
    ? NODE_SIZE.max * GRAPH_RENDER_THEME.groupScale
    : NODE_SIZE.min + (NODE_SIZE.max - NODE_SIZE.min) * degreeSignalOf(deg);
}

/**
 * 엣지 배열에서 각 노드의 연결 수(degree) Map 을 만든다.
 * 순수 함수 — nodes.ts 에서 export 하여 graph-controller.ts 와 graph-entry.ts 가 공유한다.
 */
export function buildDegreeMap(edges: GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to,   (deg.get(e.to)   ?? 0) + 1);
  }
  return deg;
}

/**
 * 생명력으로 별 색을 정한다 — starSpectrum 두 stop 사이를 RGB 선형 보간한다.
 * 생명력은 이미 0~1 이라 정규화 없이 그대로 쓴다(degree cap 무관). 생명력이 낮으면
 * 붉은·주황(죽어감), 높으면 금·흰빛(살아있음)에 가깝다.
 * 순수 함수라 graph-controller.test.ts 에서 직접 검증한다.
 */
export function starColorForVitality(vitality: number): string {
  const t = Math.max(0, Math.min(1, vitality));
  const spectrum = GRAPH_RENDER_THEME.starSpectrum;

  // 첫 stop 이하·마지막 stop 이상은 끝 색을 그대로 쓴다.
  if (t <= spectrum[0]![0]) return spectrum[0]![1];
  const last = spectrum[spectrum.length - 1]!;
  if (t >= last[0]) return last[1];

  // t 를 감싸는 두 stop 을 찾아 그 사이 비율로 보간한다.
  for (let i = 0; i < spectrum.length - 1; i++) {
    const [lo, loColor] = spectrum[i]!;
    const [hi, hiColor] = spectrum[i + 1]!;
    if (t >= lo && t <= hi) {
      const span = hi - lo;
      const frac = span === 0 ? 0 : (t - lo) / span;
      return lerpHexColor(loColor, hiColor, frac);
    }
  }
  return last[1];
}

// ---- 텍스처 생성 헬퍼 ------------------------------------------------------

/**
 * 방사형 그라디언트 캔버스 텍스처를 만든다.
 * 견본 makePlainNodeTexture / makeGlowTexture 패턴 이식.
 */
function makeRadialTexture(
  size: number,
  stops: ReadonlyArray<readonly [number, string]>,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  const cy = size / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.44);
  for (const [offset, color] of stops) {
    grad.addColorStop(offset, color);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTex(): THREE.CanvasTexture {
  return makeRadialTexture(96, GRAPH_RENDER_THEME.glowStops);
}

function makeCoreTex(): THREE.CanvasTexture {
  return makeRadialTexture(96, GRAPH_RENDER_THEME.coreStops);
}

// ---- NodeVisual 계산 (순수 헬퍼 — WebGL 없이 테스트 가능) -----------------

export type NodeTier = "hub" | "dot";

export interface NodeVisual {
  tier: NodeTier;
  size: number;
  dim: boolean;
  /** 별 색 — 생명력으로 보간한 스펙트럼 색(붉은→흰빛). 생명력 없는 엔티티는 기본색. */
  color: string;
}

/**
 * 노드 배열로부터 각 노드의 시각 계획을 계산하는 순수 헬퍼.
 *
 * 허브 조건:
 *   - type === "project" | "person"
 *   - importance >= 0.8
 *   - degree >= 5
 *
 * dim = state === "dim"
 *
 * 3a 개정으로 색·크기 채널이 분리됐다:
 *   - 크기 = degree 단일 신호(연결이 많을수록 큰 별).
 *   - 색 = 생명력(node.vitality)으로 보간. 생명력 없는 엔티티(개념·사람)는 기본색.
 *
 * 반환값은 Map<nodeId, NodeVisual>.
 * Three.js 객체 없이 동작 — graph-controller.test.ts 에서 직접 테스트.
 */
export function planNodeVisuals(
  nodes: GraphNode[],
  degree: Map<string, number>,
  states: Map<string, NodeState>,
): Map<string, NodeVisual> {
  const result = new Map<string, NodeVisual>();

  for (const node of nodes) {
    const deg = degree.get(node.id) ?? 0;
    const imp = node.importance ?? 0;

    const isHub =
      node.type === "project" ||
      node.type === "person" ||
      imp >= 0.8 ||
      deg >= 5;

    // tier 는 라벨 우선순위·glow/core 배율용으로 유지(크기·색과 별개 일).
    const tier: NodeTier = isHub ? "hub" : "dot";

    // 크기: nodeSizeOf 단일 출처 — graph-entry.ts 초기 배치와 동일 계산을 보장한다.
    const size = nodeSizeOf(node, deg);

    // 색: 생명력이 있으면 스펙트럼 보간, 없으면(개념·사람) 기본색.
    const color =
      typeof node.vitality === "number"
        ? starColorForVitality(node.vitality)
        : GRAPH_RENDER_THEME.nodeDefaultColor;

    const state = states.get(node.id) ?? "neutral";
    const dim = state === "dim";

    result.set(node.id, { tier, size, dim, color });
  }

  return result;
}

// ---- NodeEntry: 씬 안의 단일 노드 오브젝트 그룹 ---------------------------

export interface NodeEntry {
  nodeId: string;
  group: THREE.Group;
  halo: THREE.Sprite;
  glow: THREE.Sprite;
  core: THREE.Sprite;
  hit: THREE.Mesh;
  /**
   * 타입별 장식(3b) — 없을 수 있다(글·문서 등). 종류마다 다른 Object3D 다:
   * 빛살=Sprite(빌보드), 고리=토러스 Mesh, 유리조각=곡면 파편 Group.
   */
  decoration?: THREE.Object3D;
  /**
   * createEntry 가 정한 기준 sprite 크기(scale 한 변 길이). born 트윈이 scaleMul 을 여기에
   * 절대 곱해 적용한다 — 매 프레임 누적 곱이 아니라 기준값에서 다시 계산해 발산을 막는다.
   */
  baseHaloScale: number;
  baseGlowScale: number;
  baseCoreScale: number;
  /**
   * 화면 깊이 보정이 곱해지기 전의 현재 기준 불투명도/크기.
   * 트윈·검색 dim·합침 페이드는 이 값을 갱신하고, 렌더 직전 깊이 보정이 material 에 최종 반영한다.
   */
  depthBaseHaloOpacity: number;
  depthBaseGlowOpacity: number;
  depthBaseCoreOpacity: number;
  depthBaseHaloScale: number;
  depthBaseGlowScale: number;
  depthBaseCoreScale: number;
  /** 최근 생성 노드 강조 배율. 1 이면 기본 밝기. */
  recentGlowBoost: number;
}

export interface NodeDepthVisualMultipliers {
  haloOpacity: number;
  glowOpacity: number;
  coreOpacity: number;
  haloScale: number;
  glowScale: number;
  coreScale: number;
}

const NEUTRAL_NODE_DEPTH_VISUAL: NodeDepthVisualMultipliers = {
  haloOpacity: 1,
  glowOpacity: 1,
  coreOpacity: 1,
  haloScale: 1,
  glowScale: 1,
  coreScale: 1,
} as const;

/**
 * 화면 안의 상대 깊이(0=가장 앞, 1=가장 뒤)에 따른 노드 별빛 배율.
 * 절대 카메라 거리를 쓰지 않아 줌아웃해도 전체가 함께 흐려지지 않는다.
 * 선택/호버/검색 히트처럼 보호된 노드는 뒤쪽에 있어도 흐리지 않고 앞쪽 초점 배율을 유지한다.
 */
export function nodeDepthVisualMultiplier(
  depth01: number,
  protectedNode = false,
): NodeDepthVisualMultipliers {
  const depth = clamp01(depth01);
  const start = clamp01(GRAPH_RENDER_THEME.nodeDepthFadeStart);
  const power = Math.max(0.01, GRAPH_RENDER_THEME.nodeDepthFadePower);
  const coreFloor = clamp01(GRAPH_RENDER_THEME.nodeDepthBackCoreFloor);
  const glowFloor = clamp01(GRAPH_RENDER_THEME.nodeDepthBackGlowFloor);
  const haloFloor = clamp01(GRAPH_RENDER_THEME.nodeDepthBackHaloFloor);
  const frontGlowBoost = Math.max(1, GRAPH_RENDER_THEME.nodeDepthFrontGlowBoost);
  const frontCoreScale = Math.max(1, GRAPH_RENDER_THEME.nodeDepthFrontCoreScale);

  const frontT = protectedNode
    ? 1
    : 1 - clamp01(depth / Math.max(DEPTH_RANGE_EPSILON, start));
  const recedeT = protectedNode
    ? 0
    : Math.pow(
      clamp01((depth - start) / Math.max(DEPTH_RANGE_EPSILON, 1 - start)),
      power,
    );

  return {
    haloOpacity: 1 - (1 - haloFloor) * recedeT,
    glowOpacity: (1 + (frontGlowBoost - 1) * frontT) * (1 - (1 - glowFloor) * recedeT),
    coreOpacity: 1 - (1 - coreFloor) * recedeT,
    haloScale: 1,
    glowScale: 1,
    coreScale: 1 + (frontCoreScale - 1) * frontT,
  };
}

function applyNodeDepthMultipliers(entry: NodeEntry, m: NodeDepthVisualMultipliers): void {
  const haloMat = entry.halo.material as THREE.SpriteMaterial;
  const glowMat = entry.glow.material as THREE.SpriteMaterial;
  const coreMat = entry.core.material as THREE.SpriteMaterial;

  const boost = Math.max(1, entry.recentGlowBoost ?? 1);
  haloMat.opacity = Math.min(1, entry.depthBaseHaloOpacity * m.haloOpacity * boost);
  glowMat.opacity = Math.min(1, entry.depthBaseGlowOpacity * m.glowOpacity * boost);
  coreMat.opacity = Math.min(1, entry.depthBaseCoreOpacity * m.coreOpacity * (1 + (boost - 1) * 0.25));

  const hs = entry.depthBaseHaloScale * m.haloScale;
  const gs = entry.depthBaseGlowScale * m.glowScale;
  const cs = entry.depthBaseCoreScale * m.coreScale;
  entry.halo.scale.set(hs, hs, 1);
  entry.glow.scale.set(gs, gs, 1);
  entry.core.scale.set(cs, cs, 1);
}

/** 합침·퇴장 페이드처럼 세 레이어가 같은 배율로 사라질 때 기준 opacity 를 갱신한다. */
export function setNodeOpacityBase(entry: NodeEntry, opacityMul: number): void {
  const o = clamp01(opacityMul);
  entry.depthBaseHaloOpacity = GRAPH_RENDER_THEME.haloOpacity * o;
  entry.depthBaseGlowOpacity = NORMAL_OPACITY_GLOW * o;
  entry.depthBaseCoreOpacity = NORMAL_OPACITY_CORE * o;
  applyNodeDepthMultipliers(entry, NEUTRAL_NODE_DEPTH_VISUAL);
}

export function setNodeRecentGlowBoost(entry: NodeEntry, boost: number): void {
  entry.recentGlowBoost = Math.max(1, boost);
  applyNodeDepthMultipliers(entry, NEUTRAL_NODE_DEPTH_VISUAL);
}

/**
 * 현재 카메라에서 노드들의 상대 화면 깊이를 모아 별빛을 보정한다.
 * 깊이 정규화는 프레임 안의 min/max 로만 계산하므로 카메라를 뒤로 빼도 전체가 같이 흐려지지 않는다.
 */
export function applyNodeDepthVisuals(
  entries: Map<string, NodeEntry>,
  camera: THREE.Camera,
  protectedIds: ReadonlySet<string> = EMPTY_PROTECTED_IDS,
): void {
  if (entries.size === 0) return;

  const depths = new Map<string, number>();
  const world = new THREE.Vector3();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const [id, entry] of entries) {
    entry.group.getWorldPosition(world);
    const depth = world.project(camera).z;
    if (!Number.isFinite(depth)) continue;
    depths.set(id, depth);
    if (depth < min) min = depth;
    if (depth > max) max = depth;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    for (const entry of entries.values()) applyNodeDepthMultipliers(entry, NEUTRAL_NODE_DEPTH_VISUAL);
    return;
  }

  const span = max - min;
  for (const [id, entry] of entries) {
    const depth = depths.get(id);
    const depth01 =
      depth == null || span <= DEPTH_RANGE_EPSILON
        ? 0
        : clamp01((depth - min) / span);
    applyNodeDepthMultipliers(
      entry,
      nodeDepthVisualMultiplier(depth01, protectedIds.has(id)),
    );
  }
}

// ---- NodeMeshBuilder: 텍스처를 한 번만 만들어 재사용 ---------------------

export class NodeMeshBuilder {
  private readonly glowTex: THREE.CanvasTexture;
  private readonly coreTex: THREE.CanvasTexture;
  private readonly hitGeo: THREE.SphereGeometry;
  private readonly decorationBuilder: DecorationBuilder;

  constructor() {
    this.glowTex = makeGlowTex();
    this.coreTex = makeCoreTex();
    // 견본 hitGeometry = SphereGeometry(1, 16, 10)
    this.hitGeo = new THREE.SphereGeometry(1, 16, 10);
    this.decorationBuilder = new DecorationBuilder();
  }

  /** 단일 노드에 대한 Three.js Group(halo+glow+core+hit)을 만든다. */
  createEntry(node: GraphNode, visual: NodeVisual): NodeEntry {
    const group = new THREE.Group();
    group.userData["nodeId"] = node.id;

    // 별 색은 planNodeVisuals 가 생명력으로 보간해 둔 visual.color 를 쓴다
    // (생명력 없는 개념·사람은 기본색).
    const color = new THREE.Color(visual.color);
    const { tier, size, dim } = visual;

    // 후광(halo) sprite — glow 보다 넓고 옅게(가장 바깥). glowTex 재사용.
    const haloOpacity = dim ? DIM_OPACITY : GRAPH_RENDER_THEME.haloOpacity;
    const haloMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color,
      transparent: true,
      opacity: haloOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Sprite(haloMat);
    const haloSz = size * GRAPH_RENDER_THEME.haloScale;
    halo.scale.set(haloSz, haloSz, 1);
    group.add(halo);

    // 글로우 sprite
    const glowOpacity = dim ? DIM_OPACITY : NORMAL_OPACITY_GLOW;
    const glowMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color,
      transparent: true,
      opacity: glowOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glow = new THREE.Sprite(glowMat);
    const glowSz = size * (tier === "hub" ? GLOW_SCALE.hub : GLOW_SCALE.dot);
    glow.scale.set(glowSz, glowSz, 1);
    group.add(glow);

    // 코어 sprite
    const coreOpacity = dim ? DIM_OPACITY : NORMAL_OPACITY_CORE;
    const coreMat = new THREE.SpriteMaterial({
      map: this.coreTex,
      color,
      transparent: true,
      opacity: coreOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const core = new THREE.Sprite(coreMat);
    const coreSz = size * (tier === "hub" ? CORE_SCALE.hub : CORE_SCALE.dot);
    core.scale.set(coreSz, coreSz, 1);
    group.add(core);

    // 히트 메시 (투명 — raycast 전용)
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const hit = new THREE.Mesh(this.hitGeo, hitMat);
    const maxHit = HIT_MAX[node.type] ?? HIT_MAX["default"]!;
    hit.scale.setScalar(Math.min(size * 2.7, maxHit));
    hit.userData["nodeId"] = node.id;
    group.add(hit);

    // 타입별 장식(3b·Phase8 재매핑) — 매핑에 있는 타입만 장식 Object3D 를 받는다(없으면 undefined).
    // node.id 를 전달해 고리 기울기를 결정적으로 흩는다(spec 3.6·DCL-3).
    const decoration =
      this.decorationBuilder.createDecoration(node.type, size, dim, node.id, node.groupType) ?? undefined;
    if (decoration) group.add(decoration);

    return {
      nodeId: node.id, group, halo, glow, core, hit, decoration,
      baseHaloScale: haloSz, baseGlowScale: glowSz, baseCoreScale: coreSz,
      depthBaseHaloOpacity: haloOpacity,
      depthBaseGlowOpacity: glowOpacity,
      depthBaseCoreOpacity: coreOpacity,
      depthBaseHaloScale: haloSz,
      depthBaseGlowScale: glowSz,
      depthBaseCoreScale: coreSz,
      recentGlowBoost: 1,
    };
  }

  /**
   * 기존 NodeEntry 의 불투명도를 NodeVisual 에 맞춰 갱신한다.
   * 씬 재구성 없이 applyFocus 때 호출.
   */
  applyVisual(entry: NodeEntry, visual: NodeVisual): void {
    const { dim } = visual;
    const haloMat = entry.halo.material as THREE.SpriteMaterial;
    const glowMat = entry.glow.material as THREE.SpriteMaterial;
    const coreMat = entry.core.material as THREE.SpriteMaterial;
    entry.depthBaseHaloOpacity = dim ? DIM_OPACITY : GRAPH_RENDER_THEME.haloOpacity;
    entry.depthBaseGlowOpacity = dim ? DIM_OPACITY : NORMAL_OPACITY_GLOW;
    entry.depthBaseCoreOpacity = dim ? DIM_OPACITY : NORMAL_OPACITY_CORE;
    haloMat.opacity = entry.depthBaseHaloOpacity;
    glowMat.opacity = entry.depthBaseGlowOpacity;
    coreMat.opacity = entry.depthBaseCoreOpacity;
    if (entry.decoration) this.decorationBuilder.applyDim(entry.decoration, dim);
  }

  dispose(): void {
    this.glowTex.dispose();
    this.coreTex.dispose();
    this.hitGeo.dispose();
    this.decorationBuilder.dispose();
  }
}

// ---- 트윈 적용·정리 헬퍼 (Task 5 전환 경로) -------------------------------

/**
 * 트윈 한 프레임을 NodeEntry 에 적용한다.
 * - opacityMul: born 떠오름·leave 사라짐 (기준 불투명도에 곱)
 * - scaleMul: born 크기 (기준 scale 에 절대 곱 — 누적 곱 금지)
 * - colorT + fromColor/toColor: move 색 보간 (없으면 색 변경 안 함)
 */
export function applyTweenToEntry(
  entry: NodeEntry, s: TweenSample, fromColor?: string, toColor?: string,
): void {
  const core = entry.core.material as THREE.SpriteMaterial;
  const glow = entry.glow.material as THREE.SpriteMaterial;
  const halo = entry.halo.material as THREE.SpriteMaterial;

  entry.depthBaseCoreOpacity = NORMAL_OPACITY_CORE * s.opacityMul;
  entry.depthBaseGlowOpacity = NORMAL_OPACITY_GLOW * s.opacityMul;
  entry.depthBaseHaloOpacity = GRAPH_RENDER_THEME.haloOpacity * s.opacityMul;

  // 크기: 기준 scale 에 절대 적용(누적 발산 방지). sprite 는 (sz, sz, 1).
  const cs = entry.baseCoreScale * s.scaleMul;
  const gs = entry.baseGlowScale * s.scaleMul;
  const hs = entry.baseHaloScale * s.scaleMul;
  entry.depthBaseCoreScale = cs;
  entry.depthBaseGlowScale = gs;
  entry.depthBaseHaloScale = hs;

  // 탄생 광채 버스트(born 만 s.burst>0) — 글로우·헤일로만 밝게·크게 터뜨린다(코어는 제외).
  if (s.burst > 0) {
    // 가산 혼합이라 정상 위로 올리면 더 밝게 터진다. 1 로 clamp.
    entry.depthBaseGlowOpacity = Math.min(
      1,
      entry.depthBaseGlowOpacity + s.burst * BORN_BURST_OPACITY_GAIN,
    );
    entry.depthBaseHaloOpacity = Math.min(
      1,
      entry.depthBaseHaloOpacity + s.burst * BORN_BURST_OPACITY_GAIN,
    );
    const burstScale = 1 + s.burst * BORN_BURST_SCALE_GAIN;
    entry.depthBaseGlowScale = gs * burstScale;
    entry.depthBaseHaloScale = hs * burstScale;
  }
  applyNodeDepthMultipliers(entry, NEUTRAL_NODE_DEPTH_VISUAL);

  // 색이 안 바뀐 kept 노드(fromColor === toColor)는 매 프레임 lerp·color.set 3번이 낭비라 건너뛴다.
  if (fromColor && toColor && fromColor !== toColor) {
    const c = lerpHexColor(fromColor, toColor, s.colorT);
    core.color.set(c); glow.color.set(c); halo.color.set(c);
  }
}

/** 노드 퇴장 시 material 을 정리한다(메모리 누수 방지). */
export function disposeEntry(entry: NodeEntry): void {
  (entry.halo.material as THREE.Material).dispose();
  (entry.glow.material as THREE.Material).dispose();
  (entry.core.material as THREE.Material).dispose();
  (entry.hit.material as THREE.Material).dispose();
  if (entry.decoration) {
    entry.decoration.traverse?.((o: any) => { o.material?.dispose?.(); o.geometry?.dispose?.(); });
  }
}
