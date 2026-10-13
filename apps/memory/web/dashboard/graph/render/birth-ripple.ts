import * as THREE from "three";

import { GRAPH_RENDER_THEME, type GraphBirthRippleTokens } from "../graph-theme.ts";
import type { Vec3 } from "../layout/force-layout.ts";

interface BirthRipple {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  startedAt: number;
  baseScale: number;
}

/** trigger 확장 옵션 — 기본값은 기존 동작(테마 색·기본 폭)과 동일하다. */
export interface BirthRippleTriggerOptions {
  /** 파동 색. 생략 시 trigger 가 받은 color 인자를 그대로 쓴다(기존 동작). */
  color?: string;
  /**
   * 파동 폭(크기) 배율 — baseScale 에 곱해진다. 생략 시 1(기존 동작 그대로).
   * 병합 충격파처럼 더 두꺼운 파동을 원할 때 1 보다 큰 값을 준다.
   */
  width?: number;
}

export interface BirthRippleSample {
  scaleMul: number;
  opacity: number;
  done: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function sampleBirthRipple(
  nowS: number,
  startedAt: number,
  tokens: GraphBirthRippleTokens = GRAPH_RENDER_THEME.birthRipple,
): BirthRippleSample {
  if (tokens.durationS <= 0 || tokens.opacity <= 0) {
    return { scaleMul: tokens.endScale, opacity: 0, done: true };
  }

  const t = clamp01((nowS - startedAt) / tokens.durationS);
  if (t >= 1) return { scaleMul: tokens.endScale, opacity: 0, done: true };

  const scaleMul = tokens.startScale +
    (tokens.endScale - tokens.startScale) * easeOutCubic(t);
  // Math.max 하한은 fadePower 와 같은 0 나눗셈·역전 방지 가드.
  const attack = clamp01(t / Math.max(0.01, tokens.attackFraction));
  const fade = Math.pow(1 - t, Math.max(0.01, tokens.fadePower));
  return {
    scaleMul,
    opacity: tokens.opacity * attack * fade,
    done: false,
  };
}

let sharedRippleTexture: THREE.CanvasTexture | null = null;

function getRippleTexture(): THREE.CanvasTexture {
  if (sharedRippleTexture) return sharedRippleTexture;
  const tk = GRAPH_RENDER_THEME.birthRipple;
  const size = tk.textureSize;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // 양끝 stop(중심 0·가장자리 1, alpha 0)과 안쪽 경계의 alpha 0 은 "속이 빈 고리" 형태
  // 정의(구조) — 위치·밝기 조절점만 토큰.
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(tk.ringInnerStop, "rgba(255,255,255,0)");
  grad.addColorStop(tk.ringPeakStop, `rgba(255,255,255,${tk.ringPeakAlpha})`);
  grad.addColorStop(tk.ringOuterStop, `rgba(255,255,255,${tk.ringOuterAlpha})`);
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedRippleTexture = tex;
  return tex;
}

export class BirthRippleLayer {
  private readonly group = new THREE.Group();
  private readonly ripples: BirthRipple[] = [];

  constructor(scene: THREE.Scene) {
    this.group.name = "birth-ripple-layer";
    scene.add(this.group);
  }

  trigger(
    pos: Vec3,
    color: THREE.Color,
    baseScale: number,
    startedAt: number,
    options: BirthRippleTriggerOptions = {},
  ): void {
    const tokens = GRAPH_RENDER_THEME.birthRipple;
    if (tokens.durationS <= 0 || tokens.opacity <= 0) return;

    const material = new THREE.SpriteMaterial({
      map: getRippleTexture(),
      color: options.color !== undefined ? new THREE.Color(options.color) : color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(pos.x, pos.y, pos.z);
    sprite.renderOrder = -3;
    sprite.frustumCulled = false;
    this.group.add(sprite);
    const widthMul = options.width ?? 1;
    this.ripples.push({ sprite, material, startedAt, baseScale: baseScale * widthMul });
  }

  update(elapsed: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const ripple = this.ripples[i]!;
      const sample = sampleBirthRipple(elapsed, ripple.startedAt);
      if (sample.done) {
        this.group.remove(ripple.sprite);
        ripple.material.dispose();
        this.ripples.splice(i, 1);
        continue;
      }
      const scale = ripple.baseScale * sample.scaleMul;
      ripple.sprite.scale.set(scale, scale, 1);
      ripple.material.opacity = sample.opacity;
    }
  }

  clear(): void {
    for (const ripple of this.ripples) {
      this.group.remove(ripple.sprite);
      ripple.material.dispose();
    }
    this.ripples.length = 0;
  }

  dispose(): void {
    this.clear();
    this.group.parent?.remove(this.group);
    sharedRippleTexture?.dispose();
    sharedRippleTexture = null;
  }
}
