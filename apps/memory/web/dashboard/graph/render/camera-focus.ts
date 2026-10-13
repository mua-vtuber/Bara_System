// 카메라 포커스·프레이밍 순수 계산
// Three.js 객체 없이 수학만 — 견본 graph-3d.js frameNodes(L916) 이식.
import type { Vec3 } from "../layout/force-layout";

// 견본 clamp 헬퍼 (graph-3d.js 내 clamp 함수와 동일)
const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/**
 * 견본 graph-3d.js L872 easeInOutCubic 그대로.
 * t: 0→1, 반환값: 0→1 (단조 증가, 양 끝 기울기 0)
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 점 배열의 무게 중심.
 * 견본: box.getCenter() 와 같은 결과(AABB 중심 아닌 평균 — 단, 균등 분포 가정).
 */
export function boundingCenter(points: Vec3[]): Vec3 {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of points) {
    c.x += p.x;
    c.y += p.y;
    c.z += p.z;
  }
  const n = points.length || 1;
  return { x: c.x / n, y: c.y / n, z: c.z / n };
}

/** 점 배열의 AABB 중심. 전체 조망처럼 모든 점을 화면에 담아야 할 때 쓴다. */
export function boundingBoxCenter(points: Vec3[]): Vec3 {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };
  const first = points[0]!;
  const min = { x: first.x, y: first.y, z: first.z };
  const max = { x: first.x, y: first.y, z: first.z };
  for (const p of points) {
    if (p.x < min.x) min.x = p.x;
    if (p.y < min.y) min.y = p.y;
    if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x;
    if (p.y > max.y) max.y = p.y;
    if (p.z > max.z) max.z = p.z;
  }
  return {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
}

/**
 * 점 배열의 AABB 대각선 길이.
 * 견본: box.getSize(new THREE.Vector3()).length() 와 동일.
 * 빈 배열 → 0.
 */
export function boundingSize(points: Vec3[]): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  const min = { x: first.x, y: first.y, z: first.z };
  const max = { x: first.x, y: first.y, z: first.z };
  for (const p of points) {
    if (p.x < min.x) min.x = p.x;
    if (p.y < min.y) min.y = p.y;
    if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x;
    if (p.y > max.y) max.y = p.y;
    if (p.z > max.z) max.z = p.z;
  }
  return Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z);
}

/**
 * 노드 위치 배열로부터 카메라 pose(position·target)를 계산.
 *
 * 견본 graph-3d.js L916 frameNodes 로직 이식:
 *   - target  = boundingCenter(points)
 *   - dist    = clamp(size * 1.45, 8, 18)
 *   - dir     = normalize(currentDir), 길이 ~0 이면 (0, 0.08, 1) 사용
 *   - position = target + dir * dist
 *
 * 빈 점 배열 → null.
 */
export function cameraPoseForNodes(
  points: Vec3[],
  currentDir: Vec3,
): { position: Vec3; target: Vec3 } | null {
  if (points.length === 0) return null;

  const target = boundingCenter(points);
  const size = boundingSize(points);

  // 견본 L925-926: dir = camera.position.sub(controls.target); if lengthSq<0.0001 dir.set(0,0.08,1)
  let { x, y, z } = currentDir;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < 0.0001) {
    x = 0;
    y = 0.08;
    z = 1;
  }
  const len = Math.hypot(x, y, z) || 1;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;

  // 견본 L928: clamp(size * 1.45, 8, 18)
  const dist = clamp(size * 1.45, 8, 18);

  return {
    position: {
      x: target.x + nx * dist,
      y: target.y + ny * dist,
      z: target.z + nz * dist,
    },
    target,
  };
}

/**
 * 전체 조망 pose — cameraPoseForNodes 와 같은 방식이되 거리 상한을 크게 잡아
 * 그래프 전체가 화면에 담기게 한다. 빈 공간을 더블클릭하면 한눈에 보는 거리로 물러난다.
 * 접속 기본 화면이 너무 가까워 보이지 않게 최소 거리는 30 으로 둔다. 상한 값(60)은 라이브로 조정 가능.
 *
 * 빈 점 배열 → null.
 */
export function cameraPoseForOverview(
  points: Vec3[],
  currentDir: Vec3,
): { position: Vec3; target: Vec3 } | null {
  if (points.length === 0) return null;

  const target = boundingBoxCenter(points);
  const size = boundingSize(points);

  let { x, y, z } = currentDir;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < 0.0001) {
    x = 0;
    y = 0.08;
    z = 1;
  }
  const len = Math.hypot(x, y, z) || 1;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;

  // cameraPoseForNodes 의 상한 18 → 60 으로 키우고, 접속 기본 화면은 최소 30 거리에서 시작한다.
  const dist = clamp(size * 1.45, 30, 60);

  return {
    position: {
      x: target.x + nx * dist,
      y: target.y + ny * dist,
      z: target.z + nz * dist,
    },
    target,
  };
}
