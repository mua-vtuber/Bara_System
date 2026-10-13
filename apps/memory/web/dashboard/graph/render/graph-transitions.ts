// 그래프 라이브 연출 트윈(Task 5·2c·2d) — GraphController 에서 분리한 책임 묶음.
// 노드 전환(move·born·leave)·합침 흡수(2c)·창발 수렴+탄생(2d) 트윈 로직을 그대로 옮겨,
// 컨트롤러는 얇은 위임만 남긴다(동작 보존). 가변 상태는 TransitionHost 인터페이스로
// 컨트롤러와 공유한다 — free 함수가 host 필드를 직접 읽고 쓰므로 컨트롤러 인스턴스가 그대로 호스트다.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import type { SceneHandle } from "./scene.ts";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import {
  applyTweenToEntry, disposeEntry, setNodeOpacityBase,
} from "./nodes.ts";
import type { NodeEntry } from "./nodes.ts";
import { computeTrailTail, sampleTween, type NodeTween } from "./node-transition.ts";
import { planMergeTween, sampleMergeTween, type MergeTween } from "./merge-transition.ts";
import { planEmergeTween, sampleEmergeTween, type EmergeTween } from "./emerge-transition.ts";
import { nodeDriftOffset, seedFromId } from "./node-drift.ts";
import type { MeteorTrailLayer, MeteorTrailSegment } from "./meteor-trail.ts";
import type { BirthRippleLayer } from "./birth-ripple.ts";
import type { BurstParticlesLayer } from "./burst-particles.ts";
import type { Vec3 as DragVec3 } from "./drag-relax.ts";
import type { Vec3 } from "../layout/force-layout.ts";

// 합침(2c) 흡수 연출 길이(초). 0 이면 즉시 흡수(연출 꺼짐) — from 노드를 트윈 없이 바로 치운다.
const MERGE_TRANSITION_DURATION_S = 1.0 as const;

// 창발(2d) 수렴+탄생 연출 길이(초). 0 이면 연출 생략 — nodeId 노드는 refreshGraph 로 그냥 나타난다.
const EMERGE_TRANSITION_DURATION_S = 1.0 as const;

// 수렴선(2d) 색·굵기. 탄생으로 빨려드는 임시 선이라 또렷한 흰빛 가는 선으로 그린다.
const CONVERGE_LINE_COLOR = 0xffffff as const;
const CONVERGE_LINE_WIDTH = 1.4 as const;

// T17 — 동시에 그릴 유성 꼬리 상한. 넘는 born 은 꼬리 없이 그대로 날아간다(노드 비행 자체는
// 계속됨 — 시각 효과만 생략, 기능 저하 아님). GPU 라인 지오메트리 재구성 비용을 절제한다.
export const MAX_BIRTH_TRAILS = 32 as const;

/** T17 — 지금까지 그린 꼬리 수(emitted)가 cap 미만이면 이번 born 도 꼬리를 그린다. */
export function shouldEmitBirthTrail(emittedCount: number, cap: number): boolean {
  return emittedCount < cap;
}

// ---- 창발 수렴선(2d·Task 10) 임시 라인 ------------------------------------

/**
 * 한 창발 연출의 수렴선 묶음을 그리는 임시 라인 핸들. 출처 수만큼 선분을 한 LineSegments2
 * 로 그린다(각 선분: 출처 위치 → 머리 위치). 매 프레임 머리 위치만 갱신하고, 연출이
 * 끝나면 dispose 로 geometry·material 을 정리한다(누수 방지).
 */
export interface ConvergeLineHandle {
  line: LineSegments2;
  geometry: LineSegmentsGeometry;
  material: LineMaterial;
  dispose: () => void;
}

/** 수렴선 LineSegments2 한 개를 만든다. 선분 개수는 출처 수와 같다(처음엔 길이 0 점). */
function createConvergeLine(
  resolution: THREE.Vector2,
  sourceCount: number,
): ConvergeLineHandle {
  const geometry = new LineSegmentsGeometry();
  // 각 선분은 두 끝점(6 float). 처음엔 모두 0 으로 두고 매 프레임 갱신한다.
  geometry.setPositions(new Array(Math.max(1, sourceCount) * 6).fill(0));
  const material = new LineMaterial({
    color: CONVERGE_LINE_COLOR,
    linewidth: CONVERGE_LINE_WIDTH,
    worldUnits: false,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.resolution.copy(resolution);
  const line = new LineSegments2(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = -5;
  return {
    line,
    geometry,
    material,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * 라이브 연출 트윈이 읽고 쓰는 컨트롤러 상태 묶음. GraphController 가 이 인터페이스를
 * 구조적으로 만족하므로, 컨트롤러 인스턴스를 그대로 host 로 넘겨 가변 상태를 공유한다.
 */
export interface TransitionHost {
  readonly handle: SceneHandle;
  readonly root: THREE.Group;
  readonly convergeGroup: THREE.Group;
  readonly convergeResolution: THREE.Vector2;
  nodeEntries: Map<string, NodeEntry>;
  basePositions: Map<string, DragVec3>;
  activeTweens: Map<string, NodeTween>;
  activeBirths: Set<string>;
  pendingBirthQueue: string[];
  tweenFromColor: Map<string, string>;
  tweenToColor: Map<string, string>;
  activeMerges: Map<string, MergeTween>;
  activeEmerges: { tween: EmergeTween; line: ConvergeLineHandle }[];
  meteorTrailLayer: MeteorTrailLayer;
  birthRippleLayer: BirthRippleLayer;
  burstParticlesLayer: BurstParticlesLayer;
  /**
   * prefers-reduced-motion 가드(Task 11) — 컨트롤러 생성 시 1회 읽은 값.
   * true 면 버스트·펄스 링·에너지 흐름·병합 충격파 스폰을 건너뛴다(매 프레임 재확인 아님).
   */
  reducedMotion: boolean;
  refreshGraphCb: (() => Promise<void>) | null;
  /**
   * 펼스 링(Task 11) 고아 방지 — 선택된 노드가 leave 트윈 dispose 나 합침 흡수로 화면에서
   * 사라질 때, 그 노드 id 가 현재 선택과 같으면 선택을 비우고 펄스 링을 뗀다. clearSelection()
   * 과 같은 정리를 하되, 노드 사라짐 경로(tickNodeTransition·removeMergedFrom)에서만 부른다.
   */
  clearSelectionIfNode(id: string): void;
}

export function birthRippleCenterForTween(tween: NodeTween): Vec3 {
  return tween.toPos;
}

/**
 * 펄스 링 고아 방지(Task 11 버그 수정) 판단 — 화면에서 사라지는 노드 id 가 현재 선택과
 * 같을 때만 true. GraphController.clearSelectionIfNode 가 이 순수 판단을 그대로 쓴다
 * (THREE 씬 없이 로직만 단위 테스트하기 위해 분리).
 */
export function shouldClearSelectionOnRemoval(
  selectedId: string | null,
  removedNodeId: string,
): boolean {
  return selectedId === removedNodeId;
}

/**
 * 트윈이 끝난 직후 드리프트가 다시 켜져도 화면 위치가 이어지도록 기준 좌표를 보정한다.
 * 다음 프레임 렌더 위치 = base + driftOffset 이므로, base 에 현재 offset 을 미리 빼 둔다.
 */
export function basePositionForDriftContinuity(id: string, renderedPos: Vec3, elapsed: number): DragVec3 {
  const offset = nodeDriftOffset(elapsed, seedFromId(id));
  return {
    x: renderedPos.x - offset.x,
    y: renderedPos.y - offset.y,
    z: renderedPos.z - offset.z,
  };
}

/**
 * 노드 전환 트윈 한 프레임(Task 5). 진행 중 트윈이 없으면 false 를 돌려 엣지 재계산을 건너뛴다.
 * move=위치·색 보간·born=떠오름·leave=사라짐. 끝난 leave 는 dispose, 끝난 그 외는 기준 좌표에 안착.
 */
export function tickNodeTransition(host: TransitionHost, elapsed: number): boolean {
  if (host.activeTweens.size === 0) {
    host.activeBirths.clear();
    host.meteorTrailLayer.clear();
    return false;
  }

  const finished: string[] = [];
  const trailSegments: MeteorTrailSegment[] = [];
  const pendingBirthQueue: string[] = [];
  host.activeBirths.clear();
  for (const [id, tween] of host.activeTweens) {
    // T19 — anchor 가 있는 born/leave 는 매 프레임 anchor 의 현재 렌더 위치를 따라간다.
    // anchor entry 가 이미 사라졌으면(pruned) undefined 를 넘겨 스냅샷 fromPos/toPos 폴백으로
    // 자연히 떨어진다(정직한 폴백 — 에러를 삼키지 않고 그냥 옛 값을 쓴다).
    const anchorEntry = tween.anchorId ? host.nodeEntries.get(tween.anchorId) : undefined;
    const liveAnchorPos = anchorEntry
      ? { x: anchorEntry.group.position.x, y: anchorEntry.group.position.y, z: anchorEntry.group.position.z }
      : undefined;
    const s = sampleTween(tween, elapsed, liveAnchorPos);
    const entry = host.nodeEntries.get(id);
    if (entry) {
      entry.group.position.set(s.pos.x, s.pos.y, s.pos.z);
      applyTweenToEntry(entry, s, host.tweenFromColor.get(id), host.tweenToColor.get(id));
      if (tween.kind === "born" && !s.done) {
        const birthStartedAt = tween.birthStartedAt ?? tween.startedAt + (tween.staggerDelay ?? 0);
        if (elapsed < birthStartedAt) {
          pendingBirthQueue.push(id);
        } else {
          host.activeBirths.add(id);
          if (!tween.birthRippleStarted) {
            const color = (entry.core.material as THREE.SpriteMaterial).color.clone();
            host.birthRippleLayer.trigger(
              birthRippleCenterForTween(tween),
              color,
              entry.baseCoreScale,
              elapsed,
            );
            tween.birthRippleStarted = true;
          }
        }
        if (
          elapsed >= birthStartedAt && s.opacityMul > 0.02 &&
          shouldEmitBirthTrail(trailSegments.length, MAX_BIRTH_TRAILS)
        ) {
          // T19(Problem B) — 옛 방식(elapsed 를 거슬러 sampleTween 재호출)은 born 의 총 이동
          // 거리가 짧으면(scatter — anchor 부모 위치에서 태어남, depthStep=2.0 유닛 안팎)
          // tail 이 head 와 거의 같은 위치가 되어 화면에 안 보였다(근거: task-19-report.md).
          // computeTrailTail 은 시간이 아니라 "head 에서 이동 시작점 방향으로 최소 길이"
          // 기준으로 tail 을 구해, 이동 거리와 무관하게 화면 스케일 대비 길이를 보장한다.
          const pathStart = tween.anchorId && liveAnchorPos ? liveAnchorPos : tween.fromPos;
          const tail = computeTrailTail(s.pos, pathStart, GRAPH_RENDER_THEME.nodeBirth.trailMinLength);
          const color = (entry.core.material as THREE.SpriteMaterial).color.clone();
          trailSegments.push({ tail, head: s.pos, color });
        }
      }
    }
    if (s.done) finished.push(id);
  }
  host.pendingBirthQueue = pendingBirthQueue;
  host.meteorTrailLayer.update(trailSegments);

  for (const id of finished) {
    const tween = host.activeTweens.get(id);
    const entry = host.nodeEntries.get(id);
    if (tween && entry) {
      if (tween.kind === "leave") {
        host.root.remove(entry.group);
        disposeEntry(entry);
        host.nodeEntries.delete(id);
        // 데이터 갱신으로 pruning 되어 사라진 노드가 선택 중이었으면 펄스 링이 죽은 위치에
        // 고아로 남지 않게 선택을 비운다.
        host.clearSelectionIfNode(id);
      } else {
        // 끝난 move·born 은 현재 렌더 위치와 드리프트가 이어지도록 기준 좌표를 보정해 안착시킨다.
        const p = entry.group.position;
        host.basePositions.set(id, basePositionForDriftContinuity(id, { x: p.x, y: p.y, z: p.z }, elapsed));
      }
    }
    host.activeTweens.delete(id);
    host.activeBirths.delete(id);
  }

  return true;
}

// ---- 합침 연출(2c·Task 9) -------------------------------------------------

/**
 * 합침 신호 적용(2c). from 노드가 into 로 끌려가 겹치며 사라지고, into 가 흡수 광채로
 * 잠깐 부풀었다 정착한다. from·into 중 화면에 없으면 안전 무시한다(정직 — 그릴 게 없으면
 * 연출을 생략하고, 다음 refreshGraph 가 정식 데이터와 정합을 맞춘다).
 *
 * 연출 길이(MERGE_TRANSITION_DURATION_S)가 0 이면 즉시 흡수 — from 을 트윈 없이 바로 치운다.
 */
export function applyMerge(host: TransitionHost, from: string, into: string): void {
  const fromEntry = host.nodeEntries.get(from);
  const intoEntry = host.nodeEntries.get(into);
  // 둘 중 하나라도 화면에 없으면 그릴 게 없다 — 정직하게 연출을 생략한다.
  if (!fromEntry || !intoEntry) return;

  // 길이 0 이면 즉시 흡수: from 을 바로 제거한다(연출 꺼짐).
  if (MERGE_TRANSITION_DURATION_S <= 0) {
    removeMergedFrom(host, from);
    return;
  }

  const fromPos = fromEntry.group.position;
  const intoPos = intoEntry.group.position;
  const now = host.handle.clock.getElapsedTime();
  const tween = planMergeTween(
    from, into,
    { x: fromPos.x, y: fromPos.y, z: fromPos.z },
    { x: intoPos.x, y: intoPos.y, z: intoPos.z },
    now, MERGE_TRANSITION_DURATION_S,
  );
  // 같은 from 이 이미 흡수 중이면 새 트윈으로 갈아끼운다(중복 신호 방어).
  host.activeMerges.set(from, tween);
}

/**
 * 데이터를 통째로 갈아끼울 때(setData·applyData) 진행 중이던 라이브 연출을 비운다.
 * 옛 노드 id 를 참조하는 트윈이 새 노드 집합에선 무효이므로 깔끔히 끊는다(드래그 정리와
 * 같은 이유). 다음 라이브 신호가 새 노드 집합 위에서 연출을 새로 켠다.
 */
export function clearLiveChoreography(host: TransitionHost): void {
  host.activeMerges.clear();
  // 진행 중이던 창발 수렴선 임시 라인을 dispose 한다(누수 방지) — 옛 id 참조라 무효.
  for (const e of host.activeEmerges) {
    host.convergeGroup.remove(e.line.line);
    e.line.dispose();
  }
  host.activeEmerges = [];
}

/** 흡수가 끝난 from 노드를 씬·기준 좌표에서 정리한다(트윈 끝 또는 즉시 흡수). */
export function removeMergedFrom(host: TransitionHost, from: string): void {
  const entry = host.nodeEntries.get(from);
  if (entry) {
    host.root.remove(entry.group);
    disposeEntry(entry);
    host.nodeEntries.delete(from);
  }
  host.basePositions.delete(from);
  // 흡수로 사라진 노드가 선택 중이었으면 펄스 링이 죽은 위치에 고아로 남지 않게 선택을 비운다.
  host.clearSelectionIfNode(from);
}

/**
 * 합침 연출 한 프레임(2c·Task 9). 진행 중 흡수가 없으면 false 를 돌려 엣지 재계산을 건너뛴다.
 * from 은 into 로 보간 이동하며 페이드, into 는 흡수 광채로 부풀었다 정착한다. 끝난 흡수는
 * from entry 를 dispose 하고 nodeEntries·basePositions 에서 뺀다(이후 refreshGraph 가 정합).
 */
export function tickMergeTransition(host: TransitionHost, elapsed: number): boolean {
  if (host.activeMerges.size === 0) return false;

  const finished: string[] = [];
  for (const [fromId, tween] of host.activeMerges) {
    const s = sampleMergeTween(tween, elapsed);
    const fromEntry = host.nodeEntries.get(fromId);
    // from 을 into 로 보간 이동시키고 페이드한다(위치·불투명도 직접 적용).
    if (fromEntry) {
      fromEntry.group.position.set(s.fromPos.x, s.fromPos.y, s.fromPos.z);
      applyOpacityToEntry(fromEntry, s.fromOpacity);
    }
    // into 흡수 광채·부풀음 — applyTweenToEntry 가 받는 TweenSample 형태로 변환해 재사용한다.
    // into 는 위치·색 불변이라 pos 는 현재 위치, opacityMul 1, scaleMul·burst 만 연출값을 준다.
    const intoEntry = host.nodeEntries.get(tween.intoId);
    if (intoEntry) {
      const p = intoEntry.group.position;
      applyTweenToEntry(intoEntry, {
        pos: { x: p.x, y: p.y, z: p.z },
        scaleMul: s.intoScaleMul,
        colorT: 1,
        opacityMul: 1,
        burst: s.intoBurst,
        done: s.done,
      });
    }
    if (s.done) finished.push(fromId);
  }

  for (const fromId of finished) {
    const tween = host.activeMerges.get(fromId);
    // 병합 완료 프레임에 into 위치에서 충격파를 1회 스폰한다(Task 11) — 기존 탄생 파동
    // 레이어(BirthRippleLayer)를 재사용하되, 색·폭 옵션으로 병합 전용 룩을 낸다.
    // reduced-motion 이면 건너뛴다(가드).
    if (tween && !host.reducedMotion) {
      const intoEntry = host.nodeEntries.get(tween.intoId);
      if (intoEntry) {
        const p = intoEntry.group.position;
        const tk = GRAPH_RENDER_THEME.effects;
        host.birthRippleLayer.trigger(
          { x: p.x, y: p.y, z: p.z },
          new THREE.Color(tk.mergeShockwaveColor),
          intoEntry.baseCoreScale,
          elapsed,
          { color: tk.mergeShockwaveColor, width: tk.mergeShockwaveWidthMul },
        );
      }
    }
    removeMergedFrom(host, fromId);
    host.activeMerges.delete(fromId);
  }

  return true;
}

/**
 * NodeEntry 의 halo·glow·core 불투명도에 배율을 곱한다(합침 from 페이드용).
 * 기준 불투명도(NORMAL_OPACITY_*·haloOpacity)는 nodes.ts 단일 출처를 import 해 곱한다 —
 * 0 이면 완전 투명, 1 이면 정상.
 */
function applyOpacityToEntry(entry: NodeEntry, opacity: number): void {
  const o = Math.max(0, Math.min(1, opacity));
  setNodeOpacityBase(entry, o);
}

// ---- 창발 연출(2d·Task 10) ------------------------------------------------

/**
 * 창발 신호 적용(2d). fromSources 중 화면에 있는 노드에서 nodeId 목표로 수렴선이 모이고,
 * 목표에서 번쩍이며 nodeId 노드가 탄생한다(흡수 아닌 탄생). fromSources 중 화면에 없는
 * 노드는 건너뛴다(정직).
 *
 * nodeId 가 아직 화면에 없으면 — 가짜 위치를 추정하지 않는다. 정식 데이터를 받아야 정확한
 * 좌표가 정해지므로, refreshGraph 콜백으로 overview 를 다시 받은 뒤(그 안에서 nodeId 가
 * 정식 좌표로 born) 한 번 더 연출을 시도한다. 그래도 없으면(임계 직후 아직 미반영) 수렴선만
 * grace 하게 생략한다 — 노드 자체는 다음 overview 갱신에서 정식 born 트윈으로 자연히 나타난다.
 *
 * 연출 길이(EMERGE_TRANSITION_DURATION_S)가 0 이면 연출을 생략한다(노드는 refreshGraph 로 나타남).
 */
export function applyEmerge(host: TransitionHost, nodeId: string, fromSources: string[]): void {
  if (EMERGE_TRANSITION_DURATION_S <= 0) return;

  const targetEntry = host.nodeEntries.get(nodeId);
  // 목표 노드가 아직 화면에 없으면 가짜 위치를 만들지 않는다 — refreshGraph 로 정식 좌표를
  // 받은 뒤 재시도한다. refreshGraph 가 없으면(주입 안 됨) 정직하게 연출을 생략한다.
  if (!targetEntry) {
    if (host.refreshGraphCb) {
      host.refreshGraphCb()
        .then(() => {
          const e = host.nodeEntries.get(nodeId);
          if (e) startEmerge(host, nodeId, fromSources, e);
        })
        .catch((err: unknown) => {
          console.error("[graph-controller] applyEmerge refreshGraph 오류:", err);
        });
    }
    return;
  }

  startEmerge(host, nodeId, fromSources, targetEntry);
}

/** 목표 entry 가 화면에 있는 것이 확인된 뒤, 수렴선+탄생 트윈을 실제로 켠다. */
function startEmerge(host: TransitionHost, nodeId: string, fromSources: string[], targetEntry: NodeEntry): void {
  const tp = targetEntry.group.position;
  // 화면에 있는 출처만 위치를 모은다(없는 출처는 planEmergeTween 이 건너뛴다 — 정직).
  const sourcePositions = new Map<string, Vec3>();
  for (const sid of fromSources) {
    const e = host.nodeEntries.get(sid);
    if (e) {
      const p = e.group.position;
      sourcePositions.set(sid, { x: p.x, y: p.y, z: p.z });
    }
  }
  const now = host.handle.clock.getElapsedTime();
  const tween = planEmergeTween(
    nodeId, fromSources, sourcePositions,
    { x: tp.x, y: tp.y, z: tp.z },
    now, EMERGE_TRANSITION_DURATION_S,
  );
  const line = createConvergeLine(host.convergeResolution, tween.sources.length);
  host.convergeGroup.add(line.line);
  host.activeEmerges.push({ tween, line });

  // 창발 수렴 완료(=탄생) 시점에 노드 위치에서 버스트 입자를 한 번 흩뿌린다(Task 11).
  // reduced-motion 이면 건너뛴다(가드, 매 프레임 재확인 아님). seed 는 nodeId 해시라
  // 같은 노드는 항상 같은 입자 배치를 낸다(결정론).
  if (!host.reducedMotion) {
    host.burstParticlesLayer.spawn(
      { x: tp.x, y: tp.y, z: tp.z },
      seedFromId(nodeId),
      now,
    );
  }
}

/**
 * 창발 연출 한 프레임(2d·Task 10). 진행 중 창발이 없으면 false. 수렴선 머리는 출처에서
 * 목표로 모이고, 목표 노드는 탄생 팝·광채로 떠오른다. 끝난 창발은 임시 수렴선을 dispose 하고
 * 진행 목록에서 뺀다(누수 방지). 목표 노드 자신의 정식 위치·존재는 refreshGraph 가 책임진다.
 */
export function tickEmergeTransition(host: TransitionHost, elapsed: number): boolean {
  if (host.activeEmerges.length === 0) return false;

  const survivors: { tween: EmergeTween; line: ConvergeLineHandle }[] = [];
  for (const active of host.activeEmerges) {
    const s = sampleEmergeTween(active.tween, elapsed);

    // 수렴선 선분 끝점을 갱신한다(출처 위치 → 머리 위치). 머리는 목표로 보간 이동한다.
    const posArr: number[] = [];
    for (const cl of s.converge) {
      const src = active.tween.sources.find((so) => so.id === cl.from);
      if (!src) continue;
      posArr.push(src.pos.x, src.pos.y, src.pos.z, cl.headPos.x, cl.headPos.y, cl.headPos.z);
    }
    if (posArr.length > 0) active.line.geometry.setPositions(posArr);

    // 목표 노드 탄생 팝·광채 — applyTweenToEntry 가 받는 TweenSample 형태로 변환해 재사용한다.
    const targetEntry = host.nodeEntries.get(active.tween.nodeId);
    if (targetEntry) {
      const p = targetEntry.group.position;
      applyTweenToEntry(targetEntry, {
        pos: { x: p.x, y: p.y, z: p.z },
        scaleMul: s.bornScaleMul,
        colorT: 1,
        opacityMul: 1,
        burst: s.bornBurst,
        done: s.done,
      });
    }

    if (s.done) {
      // 연출이 끝났으면 임시 수렴선을 씬에서 빼고 자원을 정리한다(누수 방지).
      host.convergeGroup.remove(active.line.line);
      active.line.dispose();
    } else {
      survivors.push(active);
    }
  }
  host.activeEmerges = survivors;

  return true;
}
