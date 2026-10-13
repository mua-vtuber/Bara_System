// 엣지 라인 생성·갱신
// 견본 graph-3d.js: createEdges(L618), edgeColorFor(L350), edgeWidthBuckets(L361).
// 시각효과 Task 2: 굵기=강도·색=종류. LineBasicMaterial 은 브라우저에서 굵기(linewidth)를
// 지원하지 않아 항상 1px 이라, three/examples/jsm/lines 의 Line2 계열로 굵기를 그린다.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { GraphNode, GraphEdge } from "../graph-view-model.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import { edgeKey } from "./graph-diff.ts";
import type { EdgeState } from "./highlight.ts";
import type { NodeEntry } from "./nodes.ts";

// ---- 관계선 구별 (spec 3.5·5.2·DCL-3) ----------------------------------------

/**
 * 엔티티 관계선 type(관계명) — 글 연결선과 또렷이 구별해 그린다(spec 3.5·5.2).
 * 서버 entity-relation-vocabulary.ts 의 ENTITY_RELATION_NAMES 8개와 같은 목록을
 * web 에 직접 둔다(브라우저 번들에 서버 모듈을 import 하지 않는다 — 대시보드 정적 .ts 규칙).
 * 4단계 관계명이 늘면 이 목록도 갱신. export 해 두어 테스트가 전수 순회로 검증한다.
 */
export const ENTITY_RELATION_EDGE_TYPES = new Set([
  "created_by",
  "sourced_from",
  "owned_by",
  "related_person",
  "located_at",
  "participated_by",
  "family_of",
  "friend_of",
]);

/**
 * 주어진 엣지 type 이 엔티티 관계선(entity_relation_edges 출처)인지 판정한다.
 * 관계명에 true, 글 연결선(contains_chunk·classified_as·identity 등)에 false.
 * 순수 함수 — 상태·부작용 0.
 */
export function isEntityRelationEdgeType(type: string): boolean {
  return ENTITY_RELATION_EDGE_TYPES.has(type);
}

// ---- 연결 종류 분류 (시각효과 Task 2) ---------------------------------------

/**
 * 프로젝트 소유선 엣지 type(서버 owns_memory) — web 쪽 단일 출처(D5·spec 5.2).
 * 서버 graph.ts 의 OWNS_MEMORY_EDGE_TYPE 와 같은 문자열을 web 에 직접 둔다.
 * 브라우저 번들에 서버 모듈을 import 하지 않는다(대시보드 정적 .ts 규칙).
 * 서버 상수명이 바뀌면 이 값도 같이 갱신한다.
 */
export const OWNS_MEMORY_EDGE_TYPE = "owns_memory" as const;

/** 엣지 한 줄이 어떤 종류의 연결인지 — 색이 이 종류를 나타낸다. */
export type EdgeKind =
  | "memory_link"
  | "entity_relation"
  | "membership"
  | "project_ownership";

/**
 * 엣지 type 을 네 종류로 가른다(색=연결 종류).
 * 서버가 entity_relation_edges 출처를 meta.edgeKind 로 싣는 경우 그 표식을 우선한다.
 * - member_of: membership(묶음 소속선·개별 엔티티를 묶음 노드에 잇는 선)
 * - owns_memory: project_ownership(프로젝트→글 소유 허브 선·D5)
 * - 엔티티 관계명: entity_relation(created_by·located_at 등)
 * - 그 외: memory_link(글↔글 연결선)
 * 순수 함수 — 상태·부작용 0.
 */
export function edgeKind(edgeOrType: GraphEdge | string): EdgeKind {
  const type = typeof edgeOrType === "string" ? edgeOrType : edgeOrType.type;
  if (
    typeof edgeOrType !== "string" &&
    edgeOrType.meta?.edgeKind === "entity_relation"
  ) {
    return "entity_relation";
  }
  if (type === "member_of") return "membership";
  if (type === OWNS_MEMORY_EDGE_TYPE) return "project_ownership";
  if (isEntityRelationEdgeType(type)) return "entity_relation";
  return "memory_link";
}

// ---- 색 상수 (값은 graph-theme.ts GRAPH_RENDER_THEME 단일 출처) --------------

/** 엣지 기본 색: 견본 edgeLowColor 기반 단순화. 모듈 로드 시 1회 생성. */
const EDGE_COLOR_LOW = new THREE.Color(GRAPH_RENDER_THEME.edgeLow);
const EDGE_COLOR_HIGH = new THREE.Color(GRAPH_RENDER_THEME.edgeHigh);
/** 엔티티 관계선 색 — edgeRelation 토큰(오로라 보라). 모듈 로드 시 1회 생성. */
const EDGE_COLOR_RELATION = new THREE.Color(GRAPH_RENDER_THEME.edgeRelation);
/** 묶음 소속선 색 — edgeMembership 토큰(옅은 청보라). 모듈 로드 시 1회 생성. */
const EDGE_COLOR_MEMBERSHIP = new THREE.Color(GRAPH_RENDER_THEME.edgeMembership);
/** 프로젝트 소유선 색 — edgeProjectOwnership 토큰(청록). 모듈 로드 시 1회 생성(D5). */
const EDGE_COLOR_PROJECT_OWNERSHIP = new THREE.Color(GRAPH_RENDER_THEME.edgeProjectOwnership);

/** 검색 focus 밖(dim) 엣지만 있는 버킷을 흐리게 깔 때 쓰는 낮은 불투명도. */
const EDGE_OPACITY_DIM = 0.04 as const;

/** weight 가 없을 때 사용하는 기본값 */
const DEFAULT_EDGE_WEIGHT = 0.5 as const;

/** 현재 프레임의 depth 폭이 이보다 작으면 상대 fade 를 끈다. */
const DEPTH_RANGE_EPSILON = 1e-6 as const;

/** 관계선은 idle 화면에서도 읽혀야 하므로 일반 ambient fade 보다 밝게 유지한다. */
const ENTITY_RELATION_AMBIENT_ALPHA_FLOOR = 0.72 as const;
/** 관계선이 검색 focus 밖으로 밀려도 완전히 사라지지 않게 남기는 최소 밝기. */
const ENTITY_RELATION_DIM_ALPHA_FLOOR = 0.18 as const;
/** 관계선 최소 픽셀 두께. */
const ENTITY_RELATION_MIN_LINE_WIDTH = 1.4 as const;
/** 관계선 점선 한 주기(대략 월드 단위). 화면 거리별 dash 개수를 정할 때 쓴다. */
const ENTITY_RELATION_DASH_PERIOD_WORLD = 0.9 as const;
const ENTITY_RELATION_DASH_FILL_RATIO = 0.56 as const;
const ENTITY_RELATION_MIN_DASH_COUNT = 3 as const;
const ENTITY_RELATION_MAX_DASH_COUNT = 18 as const;

/**
 * applyEdgeStates 의 nowS 기본값 — "시각 없음 → 자람 진행도 p=1(완전 길이)".
 * 자람과 무관한 옛 호출처(applyFocus·finishSettle)가 완전 길이로 그리게 하는 센티넬.
 */
const FULL_LENGTH_NOW = Number.POSITIVE_INFINITY;

// ---- 색·굵기 계산 헬퍼 (순수) -----------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 엣지 weight 접근자 — 결측이면 기본값, 0..1 로 clamp. 외부(에너지 흐름 우선순위 등)도 이 함수를 쓴다. */
export function edgeStrength(edge: GraphEdge): number {
  return clamp01(edge.weight ?? DEFAULT_EDGE_WEIGHT);
}

/**
 * weight 를 굵기 버킷 색인으로 양자화한다(시각효과 Task 2).
 * clamp(weight,0,1) → floor(w*steps), 단 마지막 칸을 넘지 않게 steps-1 로 막는다
 * (w=1 이면 floor(steps) 가 되어 범위를 벗어나므로 clamp 필요).
 * 순수 함수 — 상태·부작용 0.
 */
export function edgeWidthBucketIndex(weight: number): number {
  const steps = GRAPH_RENDER_THEME.edgeWidthSteps.length;
  const w = clamp01(weight);
  return Math.min(steps - 1, Math.floor(w * steps));
}

/**
 * weight 에 대응하는 굵기 값(픽셀 단위)을 토큰에서 골라 돌려준다.
 * 약한 연결은 가는 값, 강한 연결은 굵은 값. 순수 함수 — 상태·부작용 0.
 */
export function edgeWidthBucket(weight: number): number {
  // edgeWidthBucketIndex 가 0..length-1 로 clamp 하므로 색인은 항상 유효하다.
  return GRAPH_RENDER_THEME.edgeWidthSteps[edgeWidthBucketIndex(weight)]!;
}

/** 엣지 한 줄의 실제 픽셀 두께. 관계선은 일반선보다 굵게 보이도록 최소값을 둔다. */
export function edgeLineWidth(edge: GraphEdge): number {
  const base = edgeWidthBucket(edge.weight ?? DEFAULT_EDGE_WEIGHT);
  return edgeKind(edge) === "entity_relation"
    ? Math.max(base, ENTITY_RELATION_MIN_LINE_WIDTH)
    : base;
}

/**
 * focus 오버레이 선의 픽셀 두께 = 그 버킷 배경 굵기 + edgeFocusWidthBoost(토큰 단일 출처).
 * 호버/선택으로 focus 상태가 된 1차 연결선을 배경선보다 굵게 덧그린다(사용자 요청).
 * baseLineWidth 는 그 버킷의 배경 lineWidth(edgeLineWidth 결과) — 가산량만 여기서 더한다.
 * 순수 함수 — 상태·부작용 0.
 */
export function edgeFocusOverlayWidth(baseLineWidth: number): number {
  return baseLineWidth + GRAPH_RENDER_THEME.edgeFocusWidthBoost;
}

/**
 * 굵기 버킷 색인 i 의 기본 투명도(약 흐림→강 또렷)를 토큰에서 골라 돌려준다.
 * edgeWidthSteps 와 같은 인덱스를 공유한다 — 버킷 i 는 굵기·투명도가 함께 단계를 탄다.
 * 순수 함수 — 상태·부작용 0.
 */
function bucketOpacity(bucketIndex: number): number {
  const steps = GRAPH_RENDER_THEME.edgeOpacitySteps;
  // edgeWidthSteps 와 길이가 다른 토큰 편집에 대비해 색인을 범위 안으로 가둔다.
  const idx = Math.max(0, Math.min(steps.length - 1, bucketIndex));
  return steps[idx]!;
}

/** 엣지 상태별 색 강도. 버킷 material opacity 와 곱해져 최종 시각 밝기가 된다. */
export function edgeStateAlpha(state: EdgeState): number {
  switch (state) {
    case "focus":
      return GRAPH_RENDER_THEME.edgeFocusAlpha;
    case "dim":
      return GRAPH_RENDER_THEME.edgeDimAlpha;
    default:
      return GRAPH_RENDER_THEME.edgeAmbientAlpha;
  }
}

/** 현재 화면 깊이 순위에 따른 ambient 엣지 밝기 배율. focus/dim 은 깊이 fade 를 받지 않는다. */
export function edgeDepthFadeMultiplier(state: EdgeState, depth01: number): number {
  if (state !== "ambient") return 1;
  const start = clamp01(GRAPH_RENDER_THEME.edgeAmbientDepthFadeStart);
  const floor = clamp01(GRAPH_RENDER_THEME.edgeAmbientDepthFadeFloor);
  const power = Math.max(0.01, GRAPH_RENDER_THEME.edgeAmbientDepthFadePower);
  const t = clamp01((clamp01(depth01) - start) / Math.max(DEPTH_RANGE_EPSILON, 1 - start));
  return 1 - (1 - floor) * Math.pow(t, power);
}

/** 엣지별 최종 vertex color 밝기. 관계선은 ambient/dim 에서도 최소 밝기를 보장한다. */
export function edgeColorAlpha(edge: GraphEdge, state: EdgeState, depth01: number): number {
  const alpha = edgeStateAlpha(state) * edgeDepthFadeMultiplier(state, depth01);
  if (edgeKind(edge) !== "entity_relation") return alpha;
  if (state === "ambient") return Math.max(alpha, ENTITY_RELATION_AMBIENT_ALPHA_FLOOR);
  if (state === "dim") return Math.max(alpha, ENTITY_RELATION_DIM_ALPHA_FLOOR);
  return alpha;
}

/**
 * 연결 종류(EdgeKind)에 대응하는 전용 색을 돌려준다 — 색=연결 종류(시각효과 Task 2·D5).
 * - entity_relation(created_by·located_at 등): edgeRelation 색(오로라 보라).
 * - membership(member_of·묶음 소속선): edgeMembership 색(옅은 청보라).
 * - project_ownership(owns_memory·프로젝트→글 허브): edgeProjectOwnership 색(청록).
 * memory_link(글↔글)는 strength 그라디언트라 여기서 null 을 돌려준다 — 호출처가 강도 보간을 맡는다.
 * 새 THREE.Color clone 을 돌려주므로 호출처가 자유롭게 변형할 수 있다. 순수 함수 — 상태·부작용 0.
 */
export function edgeColorForKind(kind: EdgeKind): THREE.Color | null {
  switch (kind) {
    case "entity_relation":
      return EDGE_COLOR_RELATION.clone();
    case "membership":
      return EDGE_COLOR_MEMBERSHIP.clone();
    case "project_ownership":
      return EDGE_COLOR_PROJECT_OWNERSHIP.clone();
    default:
      return null;
  }
}

/**
 * 엣지 색상 계산 — 색이 연결 종류를 나타낸다(시각효과 Task 2·D5).
 * 종류 전용 색이 있으면 그 색을, 없으면(memory_link·글↔글) strength 에 따른
 * edgeLow→edgeHigh 그라디언트를 돌려준다.
 */
function edgeColor(edge: GraphEdge): THREE.Color {
  const kindColor = edgeColorForKind(edgeKind(edge));
  if (kindColor) return kindColor;
  return EDGE_COLOR_LOW.clone().lerp(EDGE_COLOR_HIGH, edgeStrength(edge));
}

export interface EdgeSegmentRatio {
  start: number;
  end: number;
}

function relationDashCount(length: number): number {
  const safeLength = Math.max(0, Number.isFinite(length) ? length : 0);
  return Math.max(
    ENTITY_RELATION_MIN_DASH_COUNT,
    Math.min(
      ENTITY_RELATION_MAX_DASH_COUNT,
      Math.ceil(safeLength / ENTITY_RELATION_DASH_PERIOD_WORLD),
    ),
  );
}

/**
 * 한 엣지를 몇 개의 시각 segment 로 그릴지 결정한다.
 * 일반선은 0→1 한 줄, 관계선은 여러 조각으로 나눠 점선처럼 보이게 한다.
 */
export function edgeSegmentRatios(edge: GraphEdge, length: number): EdgeSegmentRatio[] {
  if (edgeKind(edge) !== "entity_relation") return [{ start: 0, end: 1 }];

  const count = relationDashCount(length);
  const step = 1 / count;
  const segments: EdgeSegmentRatio[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * step;
    segments.push({
      start,
      end: Math.min(1, start + step * ENTITY_RELATION_DASH_FILL_RATIO),
    });
  }
  return segments;
}

function segmentEndpoint(
  a: THREE.Vector3,
  b: THREE.Vector3,
  t: number,
): { x: number; y: number; z: number } {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

// ---- 굵기 버킷별 라인 묶음 -------------------------------------------------

interface BucketSegment {
  edge: GraphEdge;
  start: number;
  end: number;
}

/** 한 굵기 버킷의 그리기 자원 — geometry·material·line 과 색인 매핑. */
interface BucketBundle {
  /** 굵기·투명도 토큰 색인(edgeWidthSteps·edgeOpacitySteps 공유). off 복귀 시 기본 투명도 계산에 쓴다. */
  bucketIndex: number;
  /** 실제 LineMaterial linewidth. 관계선은 토큰 버킷보다 굵을 수 있어 별도 보관한다. */
  lineWidth: number;
  line: LineSegments2;
  geometry: LineSegmentsGeometry;
  material: LineMaterial;
  /**
   * focus 오버레이 선 — 이 버킷의 배경선 위에 focus 세그먼트만 더 굵고(+edgeFocusWidthBoost)
   * 더 진하게(edgeFocusOverlayOpacity) 덧그린다. focus 세그먼트가 없으면 visible=false 로 빠진다.
   */
  focusLine: LineSegments2;
  focusGeometry: LineSegmentsGeometry;
  focusMaterial: LineMaterial;
  /** 실제 그려지는 segment 목록. 관계선은 한 edge 가 여러 segment 로 나뉜다. */
  segments: BucketSegment[];
}

interface EdgeDepthRange {
  depths: Map<string, number>;
  min: number;
  max: number;
}

export interface EdgeGrowWindow {
  startedAt: number;
  durationS: number;
}

export function edgeGrowProgress(win: EdgeGrowWindow | undefined, nowS: number): number {
  if (!win || win.durationS <= 0) return 1;
  return clamp01((nowS - win.startedAt) / win.durationS);
}

/**
 * 기존에 자라는 엣지는 그대로 두고 새 key 만 시작 시간을 부여한다.
 * 연속 입력으로 applyData 가 다시 돌아도 앞선 연결선 자람이 중간에 완성 상태로 튀지 않게 한다.
 */
export function mergeEdgeGrowWindows(
  current: ReadonlyMap<string, EdgeGrowWindow>,
  keys: ReadonlySet<string>,
  startedAt: number,
  durationS: number,
): Map<string, EdgeGrowWindow> {
  const next = new Map(current);
  if (durationS <= 0) {
    for (const key of keys) next.delete(key);
    return next;
  }
  for (const key of keys) {
    const existing = next.get(key);
    if (!existing || startedAt - existing.startedAt >= existing.durationS) {
      next.set(key, { startedAt, durationS });
    }
  }
  return next;
}

export function pruneFinishedEdgeGrowWindows(
  current: ReadonlyMap<string, EdgeGrowWindow>,
  nowS: number,
): Map<string, EdgeGrowWindow> {
  const next = new Map<string, EdgeGrowWindow>();
  for (const [key, win] of current) {
    if (win.durationS > 0 && nowS - win.startedAt < win.durationS) {
      next.set(key, win);
    }
  }
  return next;
}

// ---- EdgeLayer: 씬 안의 엣지 라인 집합 -------------------------------------

/**
 * 엣지를 굵기 버킷별로 나눠 그린다(시각효과 Task 2).
 * 버킷마다 LineMaterial(linewidth=edgeWidthSteps[i] 픽셀) + LineSegments2 한 개.
 * LineMaterial 은 화면 해상도(resolution)를 알아야 굵기가 보이므로 캔버스 크기로 설정하고
 * resize 시 갱신한다(setResolution).
 */
export class EdgeLayer {
  private group: THREE.Group;
  private buckets: BucketBundle[] = [];
  private resolution = new THREE.Vector2(1, 1);
  private depthA = new THREE.Vector3();
  private depthB = new THREE.Vector3();

  // 새 엣지 자람 연출(Task 6) — edgeKey(from to type)별 시작 시각을 따로 들고 간다.
  // 연속 입력으로 두 번째 applyData 가 와도 먼저 자라던 연결선 상태를 잃지 않는다.
  private growWindows = new Map<string, EdgeGrowWindow>();

  constructor(scene: THREE.Scene, private readonly camera: THREE.Camera) {
    this.group = new THREE.Group();
    this.group.name = "edge-layer";
    scene.add(this.group);
  }

  /**
   * 새로 들어온 엣지 key 집합을 자람 상태로 등록한다(Task 6).
   * keys 는 edgeKey(from to type) 형식(graph-diff 와 같은 규칙). 빈 집합이면 자라는 엣지가 없다.
   * startedAt·durationS 는 노드 전환 트윈과 같은 시계·길이를 받아 함께 진행한다.
   */
  setGrowing(keys: Set<string>, startedAt: number, durationS: number): void {
    this.growWindows = mergeEdgeGrowWindows(this.growWindows, keys, startedAt, durationS);
  }

  /**
   * 자라는 중인 엣지가 하나라도 있는지(Task 6). 렌더 루프가 노드 트윈과 별개로 자람을
   * 이어 갱신할지 판단할 때 쓴다 — 트윈이 일찍 비어도 자람이 멈추지 않게 한다.
   */
  isGrowing(): boolean {
    return this.growWindows.size > 0;
  }

  /**
   * 한 엣지의 자람 진행도 p(0→1)를 돌려준다 — 선형(노드 트윈과 같은 타이밍).
   * 자라는 엣지가 아니거나 길이가 0 이면 1(완전히 자란 상태). nowS 가 없으면(=FULL_LENGTH_NOW) 항상 1.
   * 순수 계산 — 부작용 0.
   */
  private growProgress(edge: GraphEdge, nowS: number): number {
    return edgeGrowProgress(this.growWindows.get(edgeKey(edge)), nowS);
  }

  /**
   * 자라는 엣지가 모두 끝났는지(또는 자람이 없는지) 본 뒤 끝났으면 상태를 비운다.
   * 끝나면 매 프레임 단축 계산이 사라지고 엣지는 완전 길이로 그려진다.
   */
  private clearGrowIfDone(nowS: number): void {
    if (this.growWindows.size === 0) return;
    this.growWindows = pruneFinishedEdgeGrowWindows(this.growWindows, nowS);
  }

  /**
   * LineMaterial 의 해상도를 캔버스 크기로 맞춘다(굵기가 보이려면 필수).
   * 렌더 루프 바깥에서 1회·resize 마다 호출. 살아있는 버킷 material 에 모두 반영한다.
   */
  setResolution(width: number, height: number): void {
    this.resolution.set(width, height);
    for (const b of this.buckets) {
      b.material.resolution.copy(this.resolution);
      // focus 오버레이도 굵기가 보이려면 같은 해상도가 필요하다.
      b.focusMaterial.resolution.copy(this.resolution);
    }
  }

  /**
   * 현재 카메라에서 각 엣지 midpoint 의 상대 깊이 범위를 모은다.
   * 절대 거리가 아니라 이 프레임 안의 앞/뒤 순위만 쓰므로 줌아웃해도 전체가 같이 흐려지지 않는다.
   */
  private collectDepthRange(nodeEntries: Map<string, NodeEntry>): EdgeDepthRange {
    const depths = new Map<string, number>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const bucket of this.buckets) {
      for (const segment of bucket.segments) {
        const edge = segment.edge;
        const fromEntry = nodeEntries.get(edge.from);
        const toEntry = nodeEntries.get(edge.to);
        if (!fromEntry || !toEntry) continue;

        const zA = this.depthA.copy(fromEntry.group.position).project(this.camera).z;
        const zB = this.depthB.copy(toEntry.group.position).project(this.camera).z;
        const depth = (zA + zB) * 0.5;
        if (!Number.isFinite(depth)) continue;

        depths.set(edge.id, depth);
        if (depth < min) min = depth;
        if (depth > max) max = depth;
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) return { depths, min: 0, max: 0 };
    return { depths, min, max };
  }

  private normalizedDepth(depth: number | undefined, range: EdgeDepthRange): number {
    if (depth == null || !Number.isFinite(depth)) return 0;
    const span = range.max - range.min;
    if (span <= DEPTH_RANGE_EPSILON) return 0;
    return clamp01((depth - range.min) / span);
  }

  /**
   * 엣지 배열과 노드 위치 Map 으로 버킷별 LineSegments2 를 (재)구성한다.
   * 이미 있으면 폐기 후 새로 만든다.
   */
  rebuild(
    edges: GraphEdge[],
    nodeEntries: Map<string, NodeEntry>,
    _nodes: GraphNode[],
  ): void {
    this.clear();

    // 같은 width/material 로 그릴 segment 를 모은다. 관계선은 일반 버킷보다 굵은 별도 bundle 을 탄다.
    const byBucket = new Map<string, { bucketIndex: number; lineWidth: number; segments: BucketSegment[] }>();
    for (const edge of edges) {
      const fromEntry = nodeEntries.get(edge.from);
      const toEntry = nodeEntries.get(edge.to);
      if (!fromEntry || !toEntry) continue;
      const idx = edgeWidthBucketIndex(edge.weight ?? DEFAULT_EDGE_WEIGHT);
      const lineWidth = edgeLineWidth(edge);
      const key = `${idx}:${lineWidth}`;
      let bucket = byBucket.get(key);
      if (!bucket) {
        bucket = { bucketIndex: idx, lineWidth, segments: [] };
        byBucket.set(key, bucket);
      }
      const length = fromEntry.group.position.distanceTo(toEntry.group.position);
      for (const segment of edgeSegmentRatios(edge, length)) {
        bucket.segments.push({ edge, start: segment.start, end: segment.end });
      }
    }

    for (const bucket of byBucket.values()) {
      if (bucket.segments.length === 0) continue;
      const posArr: number[] = [];
      const colArr: number[] = [];
      for (const segment of bucket.segments) {
        const edge = segment.edge;
        // rebuild 단계에서 byBucket 에 넣을 때 양 끝 entry 가 있음을 이미 확인.
        const a = nodeEntries.get(edge.from)!.group.position;
        const b = nodeEntries.get(edge.to)!.group.position;
        // rebuild 는 시각만 — setGrowing 은 applyData 가 rebuild 뒤에 부르므로 여기선 growWindows 가
        // 보통 비어 p=1(완전 길이)이다. 다음 프레임 applyEdgeStates 가 nowS 로 단축을 이어 그린다.
        const p = this.growProgress(edge, FULL_LENGTH_NOW);
        const end = Math.min(segment.end, p);
        const start = Math.min(segment.start, end);
        const from = segmentEndpoint(a, b, start);
        const to = segmentEndpoint(a, b, end);
        posArr.push(from.x, from.y, from.z, to.x, to.y, to.z);
        const c = edgeColor(edge);
        const alpha = edgeColorAlpha(edge, "ambient", 0);
        colArr.push(
          c.r * alpha, c.g * alpha, c.b * alpha,
          c.r * alpha, c.g * alpha, c.b * alpha,
        );
      }

      const geo = new LineSegmentsGeometry();
      geo.setPositions(posArr);
      geo.setColors(colArr);

      const mat = new LineMaterial({
        linewidth: bucket.lineWidth,
        // 굵기는 픽셀 단위로 그린다(worldUnits=false). world 단위면 카메라 가까이서
        // 굵기가 막대처럼 부풀어 화면을 덮는다 — 샘플 graph-3d.js L670 과 같은 선택.
        worldUnits: false,
        vertexColors: true,
        transparent: true,
        // 버킷 기본 투명도 — 약한 연결은 더 흐리고, 강한 연결은 더 또렷하다.
        opacity: bucketOpacity(bucket.bucketIndex),
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
      mat.resolution.copy(this.resolution);

      const line = new LineSegments2(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = -10;
      this.group.add(line);

      // focus 오버레이 — 같은 버킷 위에 더 굵고 더 진하게 1차 연결선만 덧그린다.
      // renderOrder -9: 배경 엣지(-10)보다 위, 노드(renderOrder 미설정=기본 0)보다 아래라
      // focus 선이 배경선을 덮되 노드는 가리지 않는다(nodes.ts 는 renderOrder 를 두지 않는다).
      const focusGeo = new LineSegmentsGeometry();
      const focusMat = new LineMaterial({
        linewidth: edgeFocusOverlayWidth(bucket.lineWidth),
        worldUnits: false,
        vertexColors: true,
        transparent: true,
        opacity: GRAPH_RENDER_THEME.edgeFocusOverlayOpacity,
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
      focusMat.resolution.copy(this.resolution);
      const focusLine = new LineSegments2(focusGeo, focusMat);
      focusLine.frustumCulled = false;
      focusLine.renderOrder = -9;
      // 생성 시엔 빈 geometry — focus 세그먼트가 생기는 프레임에 applyEdgeStates 가 채우고 켠다.
      focusLine.visible = false;
      this.group.add(focusLine);

      this.buckets.push({
        bucketIndex: bucket.bucketIndex,
        lineWidth: bucket.lineWidth,
        line,
        geometry: geo,
        material: mat,
        focusLine,
        focusGeometry: focusGeo,
        focusMaterial: focusMat,
        segments: bucket.segments,
      });
    }
  }

  /**
   * 엣지 상태 Map 을 받아 각 버킷 geometry 의 색·위치를 갱신한다.
   * 상태가 "ambient"/"dim" 인 엣지는 색을 낮춰 배경 구조로 깐다. 버킷별로 같은 순서를 되짚는다.
   * nowS(현재 시각·초)를 넘기면 자라는 엣지(setGrowing)를 길이 0→full 로 단축해 그린다(Task 6).
   * 기본값 FULL_LENGTH_NOW 는 자람 진행도 p=1(완전 길이)을 줘 — 시각만 단축이라 옛 호출처는 그대로 완전 길이로 그린다.
   */
  applyEdgeStates(
    _edges: GraphEdge[],
    edgeStates: Map<string, EdgeState>,
    nodeEntries: Map<string, NodeEntry>,
    nowS = FULL_LENGTH_NOW,
  ): void {
    const depthRange = this.collectDepthRange(nodeEntries);

    for (const bucket of this.buckets) {
      const posArr: number[] = [];
      const colArr: number[] = [];
      // 같은 버킷의 focus 세그먼트만 따로 모아 오버레이 geometry 를 채운다.
      // 배경(posArr)에서는 focus 세그먼트를 빼지 않는다 — 오버레이가 더 굵게 위에 덮으므로
      // 밑에 배경선이 깔려도 삐져나오지 않고, 배경 굵기·색·fade 동작은 0 변경으로 유지된다.
      const focusPosArr: number[] = [];
      const focusColArr: number[] = [];

      let anyFocus = false;
      let anyAmbient = false;
      let anyDim = false;

      for (const segment of bucket.segments) {
        const edge = segment.edge;
        const fromEntry = nodeEntries.get(edge.from);
        const toEntry = nodeEntries.get(edge.to);
        // rebuild 시 존재가 확인된 엣지들 — 노드 제거가 없는 상태 갱신이라 그대로 있다.
        if (!fromEntry || !toEntry) continue;

        const state = edgeStates.get(edge.id) ?? "ambient";
        if (state === "focus") anyFocus = true;
        else if (state === "dim") anyDim = true;
        else anyAmbient = true;

        const c = edgeColor(edge);
        const depth01 = this.normalizedDepth(depthRange.depths.get(edge.id), depthRange);
        const alpha = edgeColorAlpha(edge, state, depth01);

        const a = fromEntry.group.position;
        const b = toEntry.group.position;
        // 자라는 엣지면 먼 끝(to)을 p 만큼만 그린다 — a + (b-a)*p. 평소엔 p=1 이라 완전 길이.
        const p = this.growProgress(edge, nowS);
        const end = Math.min(segment.end, p);
        const start = Math.min(segment.start, end);
        const from = segmentEndpoint(a, b, start);
        const to = segmentEndpoint(a, b, end);
        posArr.push(from.x, from.y, from.z, to.x, to.y, to.z);
        colArr.push(
          c.r * alpha, c.g * alpha, c.b * alpha,
          c.r * alpha, c.g * alpha, c.b * alpha,
        );

        // focus 세그먼트는 배경과 동일한 p/start/end 로 계산한 위치를 오버레이에도 담는다
        // (밑선과 어긋나지 않게). alpha 는 이미 state="focus" 로 계산돼 focus floor 도 반영됨.
        if (state === "focus") {
          focusPosArr.push(from.x, from.y, from.z, to.x, to.y, to.z);
          focusColArr.push(
            c.r * alpha, c.g * alpha, c.b * alpha,
            c.r * alpha, c.g * alpha, c.b * alpha,
          );
        }
      }

      // LineSegmentsGeometry 는 setPositions/setColors 로 통째 갱신한다
      // (BufferAttribute 직접 수정과 달리 인스턴스 속성을 다시 채워야 한다).
      bucket.geometry.setPositions(posArr);
      bucket.geometry.setColors(colArr);

      // focus 오버레이: 세그먼트가 있을 때만 geometry 를 실제 데이터로 채우고 켠다.
      // 없으면 visible=false 로 렌더에서 완전히 빠지게만 두고 직전 버퍼는 건드리지 않는다.
      // (빈 배열 setPositions([]) 는 LineSegmentsGeometry 에서 0-인스턴스 버퍼를 만들어 대체로
      //  안전하나, 이 레이어는 three 씬 통합 테스트로 실측하지 못하므로 안전 우선으로 빈 갱신을
      //  피한다 — 어차피 visible=false 면 그려지지 않아 이전 데이터가 화면에 남지 않는다.)
      if (focusPosArr.length > 0) {
        bucket.focusGeometry.setPositions(focusPosArr);
        bucket.focusGeometry.setColors(focusColArr);
        bucket.focusLine.visible = true;
      } else {
        bucket.focusLine.visible = false;
      }

      // 버킷별 투명도: focus/ambient 엣지가 있으면 그 버킷 기본 투명도(강도별 차등),
      // 전부 dim 이면 한 번 더 낮춘다. 엣지별 차이는 vertex color alpha 로 낸다.
      bucket.material.opacity = anyFocus || anyAmbient
        ? bucketOpacity(bucket.bucketIndex)
        : anyDim
          ? EDGE_OPACITY_DIM
          : bucketOpacity(bucket.bucketIndex);
    }

    // 모든 자람이 끝났으면(또는 자람이 없으면) 상태를 비워 다음 프레임부터 단축 계산을 멈춘다.
    this.clearGrowIfDone(nowS);
  }

  private clear(): void {
    for (const bucket of this.buckets) {
      this.group.remove(bucket.line);
      bucket.geometry.dispose();
      bucket.material.dispose();
      // focus 오버레이 리소스도 함께 제거·해제한다.
      this.group.remove(bucket.focusLine);
      bucket.focusGeometry.dispose();
      bucket.focusMaterial.dispose();
    }
    this.buckets = [];
  }

  dispose(): void {
    this.clear();
    this.group.parent?.remove(this.group);
  }
}
