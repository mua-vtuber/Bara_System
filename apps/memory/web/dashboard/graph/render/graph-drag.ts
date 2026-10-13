// 그래프 드래그·정착 물리(시각효과 #4) — GraphController 에서 분리한 책임 묶음.
// tickDrag / finishSettle / isNodeUnderDragControl 로직을 그대로 옮겨, 컨트롤러는
// 얇은 위임만 남긴다(동작 보존). 가변 상태는 DragHost 인터페이스로 컨트롤러와 공유한다 —
// free 함수가 host 필드를 직접 읽고 쓰므로 컨트롤러 인스턴스가 그대로 호스트가 된다.
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { SceneHandle } from "./scene.ts";
import type { NodeEntry } from "./nodes.ts";
import type { EdgeLayer } from "./edges.ts";
import { relaxStepPhysics, type Vec3 as DragVec3 } from "./drag-relax.ts";
import { nodeDriftOffset, seedFromId } from "./node-drift.ts";
import type { GraphEdge } from "../graph-view-model.ts";
import type { EdgeState } from "./highlight.ts";

// 놓은 뒤 정착 프레임 상한(시각효과 #4) — damping<1 이라 수학적으로 수렴하지만, 어떤 이유로도
// 무한히 안 끝나지 않게 거는 안전 상한. 60fps 기준 약 5초.
const DRAG_SETTLE_MAX_FRAMES = 300 as const;

/**
 * isNodeUnderDragControl 이 읽는 드래그·정착 판정 상태만 추린 좁은 타입. 렌더 루프의
 * applyNodeDrift(graph-interaction.ts) 도 같은 판정을 호출하므로, 전체 DragHost 가 아닌
 * 이 좁은 계약으로 받아 두 호출처가 공유한다.
 */
export interface DragControlState {
  dragId: string | null;
  dragNeighbors: Set<string>;
  dragSettling: boolean;
  settleAnchorId: string | null;
  settleNeighbors: Set<string>;
}

/**
 * 드래그·정착 물리가 읽고 쓰는 컨트롤러 상태 묶음. GraphController 가 이 인터페이스를
 * 구조적으로 만족하므로, 컨트롤러 인스턴스를 그대로 host 로 넘겨 가변 상태를 공유한다.
 */
export interface DragHost extends DragControlState {
  readonly handle: SceneHandle;
  readonly edgeLayer: EdgeLayer;
  nodeEntries: Map<string, NodeEntry>;
  edges: GraphEdge[];
  dragTargetPos: DragVec3 | null;
  dragVelocities: Map<string, DragVec3>;
  dragSettleFrames: number;
  basePositions: Map<string, DragVec3>;
  lastEdgeStates: Map<string, EdgeState>;
  dragRadii: Map<string, number>;
}

/**
 * 렌더 루프 1프레임 드래그 물리(시각효과 #4·속도 기반). 두 단계를 한 함수가 처리한다:
 *  - 활성 드래그(dragId !== null): anchor 를 목표로 followLerp 보간하며 이웃 속도를 누적한다.
 *  - 정착(dragSettling): anchor 는 놓은 위치 고정, 이웃이 남은 속도로 더 다가가다 감쇠로 멈춘다.
 *    모든 이웃 속도 크기의 합이 settleThreshold 이하로 떨어지거나 프레임 상한에 닿으면 정착을 끝낸다.
 */
export function tickDrag(host: DragHost): void {
  const active = host.dragId !== null;
  const anchorId = active ? host.dragId : host.settleAnchorId;
  if (anchorId === null) return;
  const anchorEntry = host.nodeEntries.get(anchorId);
  if (!anchorEntry) {
    // anchor 가 사라졌으면 정착을 깔끔히 끝낸다(엔트리 교체 등).
    if (!active) finishSettle(host);
    return;
  }
  const neighbors = active ? host.dragNeighbors : host.settleNeighbors;
  const { spring, maxStep, followLerp, damping, maxVel, settleThreshold,
          slackFactor, pullSpring, collisionStrength,
          settleMaxStep, settleMaxVel, settleEaseFrames } =
    GRAPH_RENDER_THEME.dragRelax;

  const cur = anchorEntry.group.position;
  let anchorPos: DragVec3;
  if (active) {
    // anchor 를 목표 위치로 부드럽게 보간(목표 없으면 현재 위치 유지).
    const target = host.dragTargetPos ?? { x: cur.x, y: cur.y, z: cur.z };
    anchorPos = {
      x: cur.x + (target.x - cur.x) * followLerp,
      y: cur.y + (target.y - cur.y) * followLerp,
      z: cur.z + (target.z - cur.z) * followLerp,
    };
  } else {
    // 정착 중에는 anchor 를 놓은 위치 그대로 고정한다.
    anchorPos = { x: cur.x, y: cur.y, z: cur.z };
  }

  const positions = new Map<string, DragVec3>();
  for (const [id, entry] of host.nodeEntries) {
    const p = entry.group.position;
    positions.set(id, { x: p.x, y: p.y, z: p.z });
  }

  // 활성 드래그와 정착 단계에서 서로 다른 물리 옵션을 사용한다.
  // 정착 단계에서는:
  //  - settleEaseFrames 구간 동안 충돌 보정 강도를 0 에서 전체 값으로 선형으로 늘린다.
  //    → 첫 프레임에 이웃 무리가 한 번에 튀는 "탁" 점프 방지.
  //  - settleMaxStep·settleMaxVel 로 한 프레임 이동량을 작게 제한한다.
  //    → 보정이 누적되더라도 여러 프레임에 걸쳐 천천히 퍼진다.
  let physicsOpts: { spring: number; damping: number; maxStep: number; maxVel: number;
                     slackFactor: number; pullSpring: number; collisionStrength: number };
  if (active) {
    // 활성 드래그: 기존 전체 강도·전체 클램프 그대로.
    physicsOpts = { spring, damping, maxStep, maxVel, slackFactor, pullSpring, collisionStrength };
  } else {
    // 정착: 충돌 보정을 settleEaseFrames 프레임에 걸쳐 0 → collisionStrength 로 선형 증가.
    const t = Math.min(1, host.dragSettleFrames / settleEaseFrames);
    const easedCollision = collisionStrength * t;
    physicsOpts = {
      spring, damping,
      maxStep: settleMaxStep,
      maxVel: settleMaxVel,
      slackFactor, pullSpring,
      collisionStrength: easedCollision,
    };
  }

  const next = relaxStepPhysics(
    anchorId, anchorPos, neighbors, positions, host.dragVelocities,
    host.edges, host.basePositions,
    physicsOpts,
    host.dragRadii,
  );
  host.dragVelocities = next.velocities;

  // 갱신된 위치를 노드 그룹에 반영(anchor + 이웃만 실제로 움직인다).
  anchorEntry.group.position.set(anchorPos.x, anchorPos.y, anchorPos.z);
  for (const nb of neighbors) {
    const np = next.positions.get(nb);
    const e = host.nodeEntries.get(nb);
    if (np && e) e.group.position.set(np.x, np.y, np.z);
  }

  // 정착 단계라면 속도가 충분히 잦아들었는지(또는 프레임 상한) 본 뒤 종료를 판단한다.
  if (!active) {
    host.dragSettleFrames++;
    let velSum = 0;
    for (const nb of neighbors) {
      const v = host.dragVelocities.get(nb);
      if (v) velSum += Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }
    if (velSum <= settleThreshold || host.dragSettleFrames >= DRAG_SETTLE_MAX_FRAMES) {
      finishSettle(host);
    }
  }
  // 엣지 위치는 렌더 루프가 매 프레임 applyEdgeStates 로 따라붙인다(드래그·정착 중).
}

/**
 * 정착 종료(시각효과 #4): anchor·이웃의 현재 위치를 새 기준 좌표(basePositions)로 갱신하고,
 * 속도 Map 을 비우고 정착 플래그를 내린다. 엣지 마지막 갱신은 렌더 루프가 한 번 더 그린다.
 *
 * basePositions 를 그대로 저장하면 다음 프레임 applyNodeDrift 가
 * "basePositions + offset" 를 더할 때 offset 만큼 순간 이동(덜컹)이 난다.
 * 드리프트 재개 시 offset 이 다시 더해지므로 미리 빼서 점프를 없앤다:
 *   저장값 = currentPos - offset(now, seedFromId(id))
 * 다음 프레임 elapsed ≈ now(한 프레임·speed 0.5 느림)이면 offset 이 거의 같아
 * 렌더된 위치가 currentPos 와 연속된다.
 */
export function finishSettle(host: DragHost): void {
  const elapsed = host.handle.clock.getElapsedTime();
  const ids: string[] = [];
  if (host.settleAnchorId) ids.push(host.settleAnchorId);
  for (const nb of host.settleNeighbors) ids.push(nb);
  for (const id of ids) {
    const e = host.nodeEntries.get(id);
    if (e) {
      const p = e.group.position;
      const o = nodeDriftOffset(elapsed, seedFromId(id));
      host.basePositions.set(id, { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z });
    }
  }
  // 마지막으로 엣지를 한 번 더 정렬해 선이 정착 위치에 딱 맞게 한다.
  host.edgeLayer.applyEdgeStates(host.edges, host.lastEdgeStates, host.nodeEntries);

  host.dragSettling = false;
  host.settleAnchorId = null;
  host.settleNeighbors.clear();
  host.dragVelocities.clear();
  host.dragSettleFrames = 0;
}

/**
 * 이 노드가 드래그·정착으로 tickDrag 의 손에 들려 있는지. 그런 노드는 드리프트가 손대면
 * 같은 프레임에 두 곳이 위치를 써서 떨림이 난다 — 드리프트에서 건너뛰려고 한데 묶었다.
 * 활성 드래그면 anchor(dragId)+이웃(dragNeighbors), 정착 중이면 정착 anchor+이웃을 본다.
 */
export function isNodeUnderDragControl(host: DragControlState, id: string): boolean {
  if (id === host.dragId || host.dragNeighbors.has(id)) return true;
  if (host.dragSettling && (id === host.settleAnchorId || host.settleNeighbors.has(id))) {
    return true;
  }
  return false;
}
