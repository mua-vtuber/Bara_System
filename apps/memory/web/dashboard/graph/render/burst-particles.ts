// 버스트 입자 레이어(시각효과 Task 11) — 창발(2d) 수렴 완료 시점에 노드 위치에서
// 결정론적으로 흩어지는 작은 입자 무리를 그린다. 순수 샘플러(sampleBurst)를 소비하는
// THREE.Points 레이어 — BirthRippleLayer/DustLayer 와 같은 "스폰 목록 + update + dispose" 패턴.
import * as THREE from "three";

import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { Vec3 } from "../layout/force-layout.ts";

export interface BurstParticle {
  x: number;
  y: number;
  z: number;
  alpha: number;
}

/**
 * mulberry32 계열 결정론 난수 생성기 — 같은 seed 는 항상 같은 수열을 낸다.
 * dust.ts 의 mulberry32 와 같은 알고리즘(레이어가 독립이라 이 파일에도 둔다).
 */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** sampleBurst 시각 튜닝 계수 — 레이어가 GRAPH_RENDER_THEME.effects 의 burst* 토큰을 모아 넘긴다. */
export interface BurstTuning {
  /** 입자 최소 방사 속도(흩어짐 거리 하한 계수). */
  speedMin: number;
  /** 입자 방사 속도 무작위 가산 폭 — min + rand()*var. */
  speedVar: number;
  /** 입자 알파 하한 계수 — 남은 수명 비율(1-t)에 곱해진다. */
  alphaMin: number;
  /** 입자 알파 무작위 가산 폭 — min + rand()*var. */
  alphaVar: number;
}

/**
 * seed 기반 결정론 버스트를 계산한다. elapsedS/durationS 진행률(ease-out)에 따라
 * 구면 균일 분포 방향으로 흩어지며 알파가 사그라든다. elapsedS >= durationS 면
 * 완전히 소멸(alpha 0)한 상태를 돌려준다. 흩어짐 속도·알파 계수는 tuning 으로 받는다.
 */
export function sampleBurst(
  elapsedS: number,
  durationS: number,
  seed: number,
  count: number,
  tuning: BurstTuning,
): BurstParticle[] {
  const t = Math.min(Math.max(elapsedS / durationS, 0), 1);
  const ease = 1 - (1 - t) * (1 - t); // ease-out
  const rand = mulberry(seed);
  const out: BurstParticle[] = [];
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(rand() * 2 - 1);
    const speed = tuning.speedMin + rand() * tuning.speedVar;
    const r = ease * speed;
    out.push({
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
      alpha: elapsedS >= durationS ? 0 : (1 - t) * (tuning.alphaMin + rand() * tuning.alphaVar),
    });
  }
  return out;
}

interface ActiveBurst {
  center: Vec3;
  seed: number;
  startedAt: number;
}

// 둥근 빛 알갱이 텍스처 — dust.ts/birth-ripple.ts 와 같은 방사형 그라디언트 방식.
// 모듈 1회 생성·공유(점 텍스처는 색·모양이 같아 재사용해도 안전).
let sharedBurstTexture: THREE.CanvasTexture | null = null;

function getBurstTexture(): THREE.CanvasTexture {
  if (sharedBurstTexture) return sharedBurstTexture;
  const tk = GRAPH_RENDER_THEME.effects;
  const size = tk.burstTextureSize;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // 양끝 stop(중심 불투명 1 → 가장자리 투명 0)은 스프라이트 형태 정의 — 중간 stop 만 무드 조절점.
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(tk.burstTextureMidStop, `rgba(255,255,255,${tk.burstTextureMidAlpha})`);
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedBurstTexture = tex;
  return tex;
}

/**
 * 버스트 입자 레이어 — 노드 탄생(창발 수렴 완료) 시점에 spawn 을 호출하면
 * 그 위치에서 결정론 입자 무리가 한 번 흩어졌다 사라진다. 여러 버스트가 동시에
 * 진행될 수 있다(activeBursts 배열). THREE.Points 한 개로 모든 활성 버스트 입자를 합쳐 그린다.
 */
export class BurstParticlesLayer {
  private readonly activeBursts: ActiveBurst[] = [];
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.PointsMaterial | null = null;
  private scene: THREE.Scene | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const tk = GRAPH_RENDER_THEME.effects;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    const material = new THREE.PointsMaterial({
      size: tk.burstDotSize,
      map: getBurstTexture(),
      color: new THREE.Color(tk.burstColor),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      vertexColors: false,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = -2;
    points.frustumCulled = false;
    points.name = "burst-particles-layer";
    scene.add(points);
    this.points = points;
    this.geometry = geometry;
    this.material = material;
  }

  /** 지정 위치에서 새 버스트를 시작한다. seed 는 결정론 입자 배치를 정한다(같은 seed=같은 모양). */
  spawn(center: Vec3, seed: number, startedAt: number): void {
    const tk = GRAPH_RENDER_THEME.effects;
    if (tk.burstDurationS <= 0 || tk.burstCount <= 0) return;
    this.activeBursts.push({ center, seed, startedAt });
  }

  /** 모든 활성 버스트를 한 프레임 진행시키고, 끝난 버스트는 목록에서 제거한다. */
  update(elapsed: number): void {
    const geometry = this.geometry;
    const material = this.material;
    if (!geometry || !material) return;
    const tk = GRAPH_RENDER_THEME.effects;

    for (let i = this.activeBursts.length - 1; i >= 0; i--) {
      const burst = this.activeBursts[i]!;
      if (elapsed - burst.startedAt >= tk.burstDurationS) {
        this.activeBursts.splice(i, 1);
      }
    }

    if (this.activeBursts.length === 0) {
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      material.size = tk.burstDotSize;
      return;
    }

    const positions: number[] = [];
    let maxAlpha = 0;
    const tuning: BurstTuning = {
      speedMin: tk.burstSpeedMin,
      speedVar: tk.burstSpeedVar,
      alphaMin: tk.burstAlphaMin,
      alphaVar: tk.burstAlphaVar,
    };
    for (const burst of this.activeBursts) {
      const particles = sampleBurst(elapsed - burst.startedAt, tk.burstDurationS, burst.seed, tk.burstCount, tuning);
      for (const p of particles) {
        positions.push(burst.center.x + p.x, burst.center.y + p.y, burst.center.z + p.z);
        if (p.alpha > maxAlpha) maxAlpha = p.alpha;
      }
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    // PointsMaterial 은 정점별 알파를 직접 지원하지 않는다 — 전체 투명도를 이 프레임의
    // 최대 알파로 근사한다(단일 material 한계, 다중 material 오버엔지니어링 방지).
    material.opacity = maxAlpha;
    material.size = tk.burstDotSize;
  }

  dispose(): void {
    this.activeBursts.length = 0;
    if (this.scene && this.points) this.scene.remove(this.points);
    this.geometry?.dispose();
    this.material?.dispose();
    this.points = null;
    this.geometry = null;
    this.material = null;
    this.scene = null;
  }
}
