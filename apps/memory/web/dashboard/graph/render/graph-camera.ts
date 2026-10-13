// 그래프 카메라 이동·전환(시각효과 #6·검색 포커스) — GraphController 에서 분리한 책임 묶음.
// moveCameraToPositions / tickTransition / zoomToOverview 로직을 그대로 옮겨, 컨트롤러는
// 얇은 위임만 남긴다(동작 보존). 가변 상태는 CameraHost 인터페이스로 컨트롤러와 공유한다 —
// free 함수가 host.transition 을 직접 읽고 쓰므로 컨트롤러 인스턴스가 그대로 호스트가 된다.
import * as THREE from "three";

import type { SceneHandle } from "./scene.ts";
import type { NodeEntry } from "./nodes.ts";
import { cameraPoseForNodes, cameraPoseForOverview, easeInOutCubic } from "./camera-focus.ts";
import type { Vec3 } from "../layout/force-layout.ts";

// ---- 카메라 전환 상수 -------------------------------------------------------

const TRANSITION_DURATION_S = 1.15 as const;
const TRANSITION_PULLBACK = 1.8 as const;

// ---- 카메라 전환 상태 -------------------------------------------------------

export interface CameraTransition {
  startedAt: number;
  duration: number;
  pullback: number;
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
}

/**
 * 카메라 이동·전환이 읽고 쓰는 컨트롤러 상태 묶음. GraphController 가 이 인터페이스를
 * 구조적으로 만족하므로, 컨트롤러 인스턴스를 그대로 host 로 넘겨 가변 상태를 공유한다.
 */
export interface CameraHost {
  readonly handle: SceneHandle;
  nodes: Array<{ id: string }>;
  basePositions: Map<string, Vec3>;
  nodeEntries: Map<string, NodeEntry>;
  transition: CameraTransition | null;
}

interface CameraPositionEntry {
  group: { position: { x: number; y: number; z: number } };
}

export interface CameraPositionHost {
  nodes: ReadonlyArray<{ id: string }>;
  basePositions: ReadonlyMap<string, Vec3>;
  nodeEntries: ReadonlyMap<string, CameraPositionEntry>;
}

/**
 * 전체 조망은 새 레이아웃의 기준 좌표를 우선 쓴다.
 * nodeEntries 에는 born/leave 전환 중 임시 좌표가 남을 수 있어, 저장 직후 카메라가
 * 화면 밖 탄생 경로나 곧 사라질 노드를 기준으로 흔들리는 일을 막는다.
 */
export function overviewPositionsForCamera(host: CameraPositionHost): Vec3[] {
  const positions: Vec3[] = [];
  for (const node of host.nodes) {
    const base = host.basePositions.get(node.id);
    if (base) {
      positions.push({ x: base.x, y: base.y, z: base.z });
      continue;
    }
    const entry = host.nodeEntries.get(node.id);
    if (!entry) continue;
    const p = entry.group.position;
    positions.push({ x: p.x, y: p.y, z: p.z });
  }

  if (positions.length > 0) return positions;

  for (const entry of host.nodeEntries.values()) {
    const p = entry.group.position;
    positions.push({ x: p.x, y: p.y, z: p.z });
  }
  return positions;
}

/** 주어진 노드 위치들을 담도록 카메라를 부드럽게 이동시킨다(검색 포커스). */
export function moveCameraToPositions(host: CameraHost, positions: Vec3[]): void {
  const cam = host.handle.camera;
  const ctrl = host.handle.controls;

  const dir: Vec3 = {
    x: cam.position.x - ctrl.target.x,
    y: cam.position.y - ctrl.target.y,
    z: cam.position.z - ctrl.target.z,
  };

  const pose = cameraPoseForNodes(positions, dir);
  if (!pose) return;

  host.transition = {
    startedAt: host.handle.clock.getElapsedTime(),
    duration: TRANSITION_DURATION_S,
    pullback: TRANSITION_PULLBACK,
    fromPosition: cam.position.clone(),
    fromTarget: ctrl.target.clone(),
    toPosition: new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
    toTarget:   new THREE.Vector3(pose.target.x,   pose.target.y,   pose.target.z),
  };
}

/** 진행 중인 카메라 전환을 한 프레임 보간한다(easeInOutCubic + pullback). 끝나면 transition 을 null 로 끈다. */
export function tickTransition(host: CameraHost, elapsed: number): void {
  if (!host.transition) return;
  const t = host.transition;
  const cam = host.handle.camera;
  const ctrl = host.handle.controls;

  const raw = Math.max(0, Math.min(1, (elapsed - t.startedAt) / t.duration));
  const eased = easeInOutCubic(raw);

  const pos = t.fromPosition.clone().lerp(t.toPosition, eased);
  const tgt = t.fromTarget.clone().lerp(t.toTarget, eased);

  // 견본 L902-908: pullback 은 전환 중간에 약간 뒤로 빠지는 효과
  if (t.pullback > 0) {
    const away = pos.clone().sub(tgt);
    if (away.lengthSq() > 0.0001) {
      pos.add(away.normalize().multiplyScalar(Math.sin(raw * Math.PI) * t.pullback));
    }
  }

  cam.position.copy(pos);
  ctrl.target.copy(tgt);
  ctrl.update();

  if (raw >= 1) host.transition = null;
}

/** 모든 노드를 담는 전체 조망 거리로 카메라를 부드럽게 물린다(시각효과 #6). */
export function zoomToOverview(host: CameraHost): void {
  const positions = overviewPositionsForCamera(host);
  if (positions.length === 0) return;

  const cam = host.handle.camera;
  const ctrl = host.handle.controls;
  const dir: Vec3 = {
    x: cam.position.x - ctrl.target.x,
    y: cam.position.y - ctrl.target.y,
    z: cam.position.z - ctrl.target.z,
  };

  const pose = cameraPoseForOverview(positions, dir);
  if (!pose) return;

  host.transition = {
    startedAt: host.handle.clock.getElapsedTime(),
    duration: TRANSITION_DURATION_S,
    // 전체 조망은 멀어지는 것이 목적이라 중간에 더 뒤로 빠지는 pullback 을 끈다.
    pullback: 0,
    fromPosition: cam.position.clone(),
    fromTarget: ctrl.target.clone(),
    toPosition: new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
    toTarget:   new THREE.Vector3(pose.target.x,   pose.target.y,   pose.target.z),
  };
}
