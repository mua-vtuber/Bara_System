import type { GraphDiff } from "./graph-diff.ts";
import { EXPANSION_EDGE_TYPES, otherEndpoint } from "../derived-expansion.ts";
import type { GraphEdge } from "../graph-view-model.ts";
import { seedFromId, type Vec3 } from "../layout/force-layout.ts";

export type TweenKind = "move" | "born" | "leave";

export interface NodeTween {
  nodeId: string;
  kind: TweenKind;
  fromPos: Vec3;
  controlPos?: Vec3;
  toPos: Vec3;
  startedAt: number;
  duration: number;
  staggerDelay?: number;
  birthStartedAt?: number;
  birthTargetRevision?: number;
  birthRippleStarted?: boolean;
  /**
   * T19 — 파생 흩어짐/합쳐짐(scatter/gather) 라이브 추적용 부모 anchor id.
   * born 이면 부모 현재 위치를 fromPos 대신, leave 면 toPos 대신 매 프레임 따라간다
   * (sampleTween 의 liveAnchorPos 인자). fromPos/toPos 스냅샷은 anchor entry 가
   * 나중에 사라졌을 때(pruned) 쓰는 정직한 폴백으로 그대로 남긴다.
   */
  anchorId?: string;
}

export interface TweenSample {
  pos: Vec3;
  scaleMul: number;   // 코어·글로우 크기 배율 (born 0→1, 그 외 1)
  colorT: number;     // 옛 색→새 색 보간 비율 (move 0→1)
  opacityMul: number; // 불투명도 배율 (born 0→1, leave 1→0, move 1)
  burst: number;      // 탄생 광채 버스트 0→peak→0(가산 혼합 글로우 밝힘). born 만 >0, 그 외 0.
  done: boolean;
}

// 탄생 크기 팝 오버슈트 세기(easeOutBack c1). 클수록 더 튄다. 라이브 조절용.
const BORN_SCALE_OVERSHOOT = 2.2;
// 탄생 광채 버스트 진폭(0~1+). 클수록 더 번쩍. 라이브 조절용.
const BORN_BURST_AMPLITUDE = 1.0;

export interface NodeBirthMotionOptions {
  travelDistanceMin: number;
  travelDistanceMax: number;
  arcStrength: number;
  staggerS: number;
  maxStaggerS: number;
  maxConcurrent: number;
}

export interface PlanNodeTweenOptions {
  birth?: NodeBirthMotionOptions;
  animateBirthFlight?: boolean;
  /** T17 — 파생 노드 흩어짐/합쳐짐 anchor 판정용. 없으면(undefined) 기존 유성 비행 경로만 쓴다. */
  edges?: GraphEdge[];
}

const DEFAULT_BIRTH_MOTION: NodeBirthMotionOptions = {
  travelDistanceMin: 10,
  travelDistanceMax: 14,
  arcStrength: 0.35,
  staggerS: 0.08,
  maxStaggerS: 0.5,
  maxConcurrent: 40,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 탄생 크기 팝 — 0→(중간 1 초과 오버슈트)→정확히 1. easeOutBack(끝점 0·1 보존). */
function bornPop(t: number): number {
  const x = clamp01(t);
  const c1 = BORN_SCALE_OVERSHOOT;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

function rand01(seed: number, salt: number): number {
  let x = seed ^ Math.imul(salt + 1, 0x9e3779b9);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 0xffffffff;
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function mul(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function quadraticBezier(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const ab = lerpVec(a, c, t);
  const cb = lerpVec(c, b, t);
  return lerpVec(ab, cb, t);
}

/**
 * T17 — 파생 노드 흩어짐/합쳐짐(scatter/gather) anchor 판정.
 * derived-expansion.ts 의 EXPANSION_EDGE_TYPES(parent_of·contains_section·contains_chunk·
 * merged_into)로 연결된 반대편 노드를 부모 anchor 후보로 돌려준다. 여러 후보가 있으면
 * edges 배열 순서상 첫 매치를 쓴다(결정적). 없으면 null — 호출부가 기존 유성 비행/제자리
 * 페이드로 폴백한다.
 */
export function resolveExpansionAnchorId(nodeId: string, edges: readonly GraphEdge[]): string | null {
  for (const edge of edges) {
    if (!EXPANSION_EDGE_TYPES.has(edge.type)) continue;
    const other = otherEndpoint(edge, nodeId);
    if (other) return other;
  }
  return null;
}

export function birthStaggerDelay(index: number, opts: NodeBirthMotionOptions): number {
  return Math.min(Math.max(0, opts.maxStaggerS), Math.max(0, index) * Math.max(0, opts.staggerS));
}

export function birthStartDelay(index: number, durationS: number, opts: NodeBirthMotionOptions): number {
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
  const batch = Math.floor(Math.max(0, index) / maxConcurrent);
  const batchIndex = Math.max(0, index) % maxConcurrent;
  return batch * Math.max(0, durationS) + birthStaggerDelay(batchIndex, opts);
}

export function planBirthPath(
  nodeId: string,
  target: Vec3,
  opts: NodeBirthMotionOptions = DEFAULT_BIRTH_MOTION,
): { fromPos: Vec3; controlPos: Vec3 } {
  const seed = seedFromId(nodeId);
  const theta = rand01(seed, 1) * Math.PI * 2;
  const z = -0.55 + rand01(seed, 2) * 1.1;
  const radial = Math.sqrt(Math.max(0.01, 1 - z * z));
  const dir = unit({
    x: Math.cos(theta) * radial,
    y: Math.sin(theta) * radial,
    z,
  });
  const min = Math.max(0, opts.travelDistanceMin);
  const max = Math.max(min, opts.travelDistanceMax);
  const distance = min + (max - min) * rand01(seed, 3);
  const fromPos = add(target, mul(dir, distance));
  const ref = Math.abs(dir.z) < 0.86 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const arcDir = unit(cross(dir, ref));
  const mid = lerpVec(fromPos, target, 0.5);
  const controlPos = add(mid, mul(arcDir, distance * Math.max(0, opts.arcStrength)));
  return { fromPos, controlPos };
}

/** 시각 진행을 0~1 로 clamp 한다(발산 방지). */
function progress(nowS: number, startedAt: number, duration: number): number {
  if (duration <= 0) return 1;
  return clamp01((nowS - startedAt) / duration);
}

/**
 * T19(Problem B) — 유성 꼬리 tail 위치를 "시간 오프셋"이 아니라 "화면 거리 기준 최소 길이"로 구한다.
 *
 * 근본 원인: 옛 방식은 tail = sampleTween(tween, elapsed - duration*ratio).pos 로, 진행 시간을
 * 거슬러 올라가 과거 위치를 다시 샘플링했다. born 의 총 이동 거리(fromPos→toPos)가 짧으면
 * (예: scatter — 부모 anchor 위치에서 태어나는 경우, depthStep=2.0 유닛 안팎) 그 비율만큼
 * 거슬러 올라가도 head 와 거의 같은 위치라 tail-head 선분 길이가 0에 가까워져 화면에 보이지
 * 않는다. 유성 비행(원거리, 10~14 유닛)에서만 우연히 충분한 길이가 나왔던 것.
 *
 * 해결: head 에서 "진행 방향의 역방향"으로 minLength 만큼 뗀 지점을 tail 로 삼는다 — 이동
 * 거리와 무관하게 화면 스케일 대비 항상 유의미한 선분 길이를 보장한다. 단 시작점(pathStart)을
 * 넘어서 튀어나가지 않도록 head-pathStart 거리로 clamp 한다(총 이동 거리가 minLength 보다
 * 짧으면 pathStart 까지만 그린다 — 실제보다 길게 그리는 거짓말을 하지 않는다).
 *
 * @param head 현재 프레임의 노드 위치(sampleTween(tween, elapsed).pos)
 * @param pathStart 이 트윈의 이동 시작점(born=fromPos, leave=toPos 방향 반대편 fromPos)
 * @param minLength 화면 스케일 대비 보장할 최소 꼬리 길이(월드 유닛)
 */
export function computeTrailTail(head: Vec3, pathStart: Vec3, minLength: number): Vec3 {
  const toStart = { x: pathStart.x - head.x, y: pathStart.y - head.y, z: pathStart.z - head.z };
  const distToStart = Math.hypot(toStart.x, toStart.y, toStart.z);
  if (distToStart <= minLength) return pathStart;
  const dir = unit(toStart);
  return add(head, mul(dir, minLength));
}

/** diff 와 옛·새 위치로 노드별 트윈을 만든다. nowS·durationS 단위는 초. kept→move·added→born·removed→leave. */
export function planNodeTweens(
  diff: GraphDiff, prevPos: Map<string, Vec3>, nextPos: Map<string, Vec3>,
  nowS: number, durationS: number, options: PlanNodeTweenOptions = {},
): NodeTween[] {
  const tweens: NodeTween[] = [];
  const origin: Vec3 = { x: 0, y: 0, z: 0 };

  for (const id of diff.keptNodeIds) {
    // 정상 경로에선 kept 노드가 두 맵에 다 있다(같은 diffGraph 출처). 빠지면 상류 불일치 — 렌더 루프를 죽이지 않으려 origin 으로 두되, 이는 정합 깨짐 신호다.
    tweens.push({ nodeId: id, kind: "move", startedAt: nowS, duration: durationS,
      fromPos: prevPos.get(id) ?? nextPos.get(id) ?? origin,
      toPos: nextPos.get(id) ?? prevPos.get(id) ?? origin });
  }
  const birth = options.birth ?? DEFAULT_BIRTH_MOTION;
  const edges = options.edges ?? [];
  const addedIds = [...diff.addedNodeIds].sort((a, b) => seedFromId(a) - seedFromId(b));
  for (let i = 0; i < addedIds.length; i++) {
    const id = addedIds[i]!;
    const at = nextPos.get(id) ?? origin;
    // T17 scatter — 파생 부모가 화면에 있으면 그 위치에서 태어나 목표로 흩어진다.
    // 부모가 없으면(anchor 없음·animateBirthFlight=false) 기존 유성 비행/즉시 등장으로 폴백한다.
    const anchorId = options.animateBirthFlight === false ? null : resolveExpansionAnchorId(id, edges);
    const anchorPos = anchorId ? (nextPos.get(anchorId) ?? prevPos.get(anchorId)) : undefined;
    const flight = options.animateBirthFlight === false
      ? { fromPos: at, controlPos: at }
      : anchorPos
        ? { fromPos: anchorPos, controlPos: lerpVec(anchorPos, at, 0.5) }
        : planBirthPath(id, at, birth);
    const staggerDelay = birthStartDelay(i, durationS, birth);
    tweens.push({
      nodeId: id,
      kind: "born",
      startedAt: nowS,
      birthStartedAt: nowS + staggerDelay,
      staggerDelay,
      duration: durationS,
      fromPos: flight.fromPos,
      controlPos: flight.controlPos,
      toPos: at,
      birthTargetRevision: 0,
      // T19 — anchor 가 실제로 born 경로에 쓰였을 때(anchorPos 존재)만 기록한다.
      // animateBirthFlight=false 나 anchor 없음(유성 비행 폴백)이면 라이브 추적 대상이 아니다.
      anchorId: anchorPos ? anchorId ?? undefined : undefined,
    });
  }
  for (const id of diff.removedNodeIds) {
    const at = prevPos.get(id) ?? origin;
    // T17 gather — 파생 부모가 화면에 남아 있으면 그 위치로 빨려들며 사라진다.
    // 부모가 없으면 기존처럼 제자리에서 페이드(fromPos == toPos).
    const anchorId = resolveExpansionAnchorId(id, edges);
    const anchorPos = anchorId ? (prevPos.get(anchorId) ?? nextPos.get(anchorId)) : undefined;
    const toPos = anchorPos ?? at;
    tweens.push({
      nodeId: id, kind: "leave", startedAt: nowS, duration: durationS, fromPos: at, toPos,
      // T19 — anchor 가 실제로 gather 경로에 쓰였을 때만 기록한다.
      anchorId: anchorPos ? anchorId ?? undefined : undefined,
    });
  }
  return tweens;
}

/**
 * 현재 시각 nowS(초)의 트윈 진행값을 돌려준다. born=떠오름(scale·opacity 0→1)·leave=사라짐(opacity 1→0)·move=위치+색 보간.
 *
 * T19 — liveAnchorPos 가 주어지면(anchor 가 있는 born/leave 한정), 스냅샷 fromPos/toPos 대신
 * 그 값으로 보간한다. anchor 노드가 트윈 계획 시점 이후 다른 위치로 이동해도(레이아웃 리플로우 등)
 * 매 프레임 최신 위치로 수렴하게 하기 위함이다. anchor entry 가 사라졌으면(pruned) 호출부가
 * undefined 를 넘겨 스냅샷 폴백으로 자연히 떨어진다. 순수 함수 원칙 유지 — Date.now·Math.random 없음.
 */
export function sampleTween(tween: NodeTween, nowS: number, liveAnchorPos?: Vec3): TweenSample {
  const startedAt = tween.kind === "born"
    ? tween.birthStartedAt ?? tween.startedAt + (tween.staggerDelay ?? 0)
    : tween.startedAt;
  const t = progress(nowS, startedAt, tween.duration);
  const done = t >= 1;
  switch (tween.kind) {
    case "born": {
      const fromPos = tween.anchorId && liveAnchorPos ? liveAnchorPos : tween.fromPos;
      const moveT = easeOutCubic(t);
      const pos = tween.controlPos
        ? quadraticBezier(fromPos, tween.controlPos, tween.toPos, moveT)
        : lerpVec(fromPos, tween.toPos, moveT);
      const burst = BORN_BURST_AMPLITUDE * Math.sin(Math.PI * t);
      return { pos, scaleMul: bornPop(t), colorT: 1, opacityMul: clamp01(t * 1.15), burst, done };
    }
    case "leave": {
      const toPos = tween.anchorId && liveAnchorPos ? liveAnchorPos : tween.toPos;
      const pos = lerpVec(tween.fromPos, toPos, t);
      return { pos, scaleMul: 1, colorT: 1, opacityMul: 1 - t, burst: 0, done };
    }
    case "move": default: {
      const moveT = easeInOutCubic(t);
      const pos = lerpVec(tween.fromPos, tween.toPos, moveT);
      return { pos, scaleMul: 1, colorT: moveT, opacityMul: 1, burst: 0, done };
    }
  }
}
