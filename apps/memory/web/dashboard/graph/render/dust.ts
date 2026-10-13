// 배경 먼지 파티클 레이어(시각효과 Task 3) — 노드·엣지와 독립한 별도 레이어다.
// 화면 깊이감을 주려고 멀리 천천히 흐르는 작은 점들을 깐다. 끄려면 이 파일 배선만 떼면 된다.
import * as THREE from "three";

import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { Vec3 } from "../layout/force-layout.ts";

// 결정적 의사난수 — 같은 시드는 같은 수열 (Math.random 금지: 재현·resume 안정).
// force-layout.ts 의 mulberry32 와 같은 알고리즘. 레이어가 독립이라 별도로 가진다.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 먼지 분포 고정 시드 — 같은 화면은 늘 같은 점 무리로 그려진다.
const DUST_SEED = 0x9e3779b1 as const;

// 흐름 방향 전용 시드 — 위치 분포 시드(DUST_SEED)와 겹쳐 상관되지 않게 별도 상수를 섞는다.
// 방향과 시작 위치가 상관되면 화면에 한 방향 흐름선(규칙성)이 생기니 분리한다.
const DUST_FLOW_SEED = 0x27d4eb2f as const;

/**
 * 시드로 구면 균일 분포 단위 방향벡터를 결정적으로 만든다.
 * 먼지마다 다른 방향 → 전체로 보면 사방팔방이라 한 방향 흐름선(규칙성)이 안 생긴다.
 * 구면 균일 분포 공식: z 를 [-1,1] 에서 고르고, 둘레 각 theta 를 [0,2π) 에서 골라
 * 반지름 r = sqrt(1 - z²) 로 x·y 를 잡는다. 결과는 크기 1 단위벡터.
 * Math.random 안 쓰고 mulberry32 로 결정적이라 resume·재현이 안정된다.
 */
export function dustFlowDirection(seed: number): Vec3 {
  const rnd = mulberry32(seed);
  const z = rnd() * 2 - 1;
  const theta = rnd() * 2 * Math.PI;
  const r = Math.sqrt(1 - z * z);
  return { x: r * Math.cos(theta), y: r * Math.sin(theta), z };
}

/**
 * 좌표를 [-spread, +spread] 범위로 순환시킨다(끝에 닿으면 반대편에서 다시 나타난다).
 * 범위 안 값은 그대로 두고, 범위 밖 값은 반대편으로 매핑한다.
 * JS 의 % 는 음수에 음수를 주므로, span 을 한 번 더 더해 양수로 보정한 뒤 빼낸다.
 */
export function wrapCoord(v: number, spread: number): number {
  const span = spread * 2;
  return ((v + spread) % span + span) % span - spread;
}

// 둥근 빛 알갱이 텍스처 — 중심 흰빛에서 가장자리 투명으로 퍼지는 방사형 그라디언트.
// PointsMaterial 기본 점은 정사각형이라, 이 알파를 map 으로 입혀 모서리를 지워 둥글게 만든다.
// 모듈 1회 생성·여러 DustLayer 가 공유한다(점 텍스처는 색·모양이 같아 재사용해도 안전).
let sharedDustTexture: THREE.CanvasTexture | null = null;

function getDustTexture(): THREE.CanvasTexture {
  if (sharedDustTexture) return sharedDustTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // 중심 또렷한 흰빛 → 가장자리 완전 투명. 색조는 PointsMaterial.color 가 입힌다.
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedDustTexture = tex;
  return tex;
}

/**
 * 시간·시드 기반 작은 드리프트 오프셋 — sin/cos 라 결정적·연속이다.
 * 같은 (time, seed) 는 늘 같은 오프셋을 주고, time 이 미세하게 바뀌면 오프셋도 미세하게 바뀐다.
 * 세 축이 서로 다른 위상·속도를 써 점이 단조롭게 한 방향으로 흐르지 않게 한다.
 * 진폭은 토큰 driftAmplitude 안 — 세 축 합쳐도 크기 1 미만으로 은은하게 흐른다.
 */
export function dustDriftOffset(time: number, seed: number): Vec3 {
  const { driftSpeed, driftAmplitude } = GRAPH_RENDER_THEME.dust;
  const a = seed * 0.013;
  return {
    x: Math.sin(time * driftSpeed + a) * driftAmplitude,
    y: Math.cos(time * driftSpeed * 0.8 + a * 1.7) * driftAmplitude,
    z: Math.sin(time * driftSpeed * 0.6 + a * 2.3) * driftAmplitude,
  };
}

/**
 * 배경 먼지 점 레이어. THREE.Points 하나로 토큰 count 개 점을 그린다.
 * renderOrder 음수라 노드·엣지보다 뒤에 깔리고, depthWrite false·AdditiveBlending 으로
 * 앞의 별빛을 가리지 않는다. update 마다 기준 좌표에 드리프트 오프셋을 더해 천천히 흐른다.
 */
export class DustLayer {
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.PointsMaterial | null = null;
  private scene: THREE.Scene | null = null;
  // 기준 좌표 — 시작 위치. 흐름 + 드리프트를 매 프레임 여기서 절대 계산한다(누적 안 함).
  private base: Float32Array | null = null;
  // 먼지마다 고유한 흐름 방향(단위벡터) — base 와 짝지어 등속 흐름 방향을 정한다.
  private dirs: Float32Array | null = null;

  /** 씬에 먼지 레이어를 추가한다. spread 정육면체 안에 결정적으로 분포한다. */
  add(scene: THREE.Scene): void {
    const tk = GRAPH_RENDER_THEME.dust;
    const rnd = mulberry32(DUST_SEED);
    const base = new Float32Array(tk.count * 3);
    const dirs = new Float32Array(tk.count * 3);
    for (let i = 0; i < tk.count; i++) {
      // [-spread, +spread] 정육면체 안 균일 분포.
      base[i * 3 + 0] = (rnd() * 2 - 1) * tk.spread;
      base[i * 3 + 1] = (rnd() * 2 - 1) * tk.spread;
      base[i * 3 + 2] = (rnd() * 2 - 1) * tk.spread;
      // 먼지마다 고유한 흐름 방향 — 위치 시드와 겹치지 않게 별도 시드에서 파생한다.
      const dir = dustFlowDirection(DUST_FLOW_SEED + i);
      dirs[i * 3 + 0] = dir.x;
      dirs[i * 3 + 1] = dir.y;
      dirs[i * 3 + 2] = dir.z;
    }

    const geometry = new THREE.BufferGeometry();
    // 시작 좌표 = 기준 좌표 복사본(드리프트가 매 프레임 덮어쓴다).
    geometry.setAttribute("position", new THREE.BufferAttribute(base.slice(), 3));

    const material = new THREE.PointsMaterial({
      size: tk.size,
      map: getDustTexture(),
      color: new THREE.Color(tk.color),
      transparent: true,
      opacity: tk.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geometry, material);
    // 노드·엣지보다 한참 뒤에 깔린다.
    points.renderOrder = -20;
    // 화면 밖 컬링으로 통째로 사라지지 않게(배경이라 늘 그린다).
    points.frustumCulled = false;

    scene.add(points);
    this.scene = scene;
    this.points = points;
    this.geometry = geometry;
    this.material = material;
    this.base = base;
    this.dirs = dirs;
  }

  /**
   * 경과 시간으로 각 점을 갱신한다 — 고유 방향 등속 흐름 + 경계 순환 위에 미세 드리프트를 얹는다.
   * 각 축: base + dir*elapsed*flowSpeed 로 흐른 위치를 wrapCoord 로 범위 안에 순환시키고,
   * 그 위에 dustDriftOffset 떨림을 더해 직선 흐름을 살짝 굽혀 유기적으로 보이게 한다.
   * 누적 변수 없이 elapsed 로 매 프레임 절대 계산한다(결정적·resume 안정).
   */
  update(elapsed: number): void {
    const geometry = this.geometry;
    const base = this.base;
    const dirs = this.dirs;
    if (!geometry || !base || !dirs) return;
    const { flowSpeed, spread } = GRAPH_RENDER_THEME.dust;
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const n = base.length / 3;
    const travel = elapsed * flowSpeed;
    for (let i = 0; i < n; i++) {
      const off = dustDriftOffset(elapsed, i);
      const fx = base[i * 3 + 0]! + dirs[i * 3 + 0]! * travel;
      const fy = base[i * 3 + 1]! + dirs[i * 3 + 1]! * travel;
      const fz = base[i * 3 + 2]! + dirs[i * 3 + 2]! * travel;
      arr[i * 3 + 0] = wrapCoord(fx, spread) + off.x;
      arr[i * 3 + 1] = wrapCoord(fy, spread) + off.y;
      arr[i * 3 + 2] = wrapCoord(fz, spread) + off.z;
    }
    attr.needsUpdate = true;
  }

  /** 레이어를 씬에서 떼고 GPU 자원을 정리한다. */
  dispose(): void {
    if (this.scene && this.points) this.scene.remove(this.points);
    this.geometry?.dispose();
    this.material?.dispose();
    // 공유 텍스처도 정리하고 캐시를 비운다 — 다음 add 가 다시 만든다.
    sharedDustTexture?.dispose();
    sharedDustTexture = null;
    this.points = null;
    this.geometry = null;
    this.material = null;
    this.scene = null;
    this.base = null;
    this.dirs = null;
  }
}
