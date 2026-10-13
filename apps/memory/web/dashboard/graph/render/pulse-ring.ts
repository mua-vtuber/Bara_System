// 펄스 링 레이어(시각효과 Task 11) — 선택된 노드 둘레로 무한 반복해 퍼져나가는
// 고리를 그린다. 순수 샘플러(samplePulseRing)를 소비하는 LineLoop 레이어 —
// BirthRippleLayer 와 같은 "노드에 붙어 반복 재생 + dispose" 패턴.
import * as THREE from "three";

import { GRAPH_RENDER_THEME } from "../graph-theme.ts";

export interface PulseRingSample {
  radius: number;
  alpha: number;
}

/**
 * ringIndex/ringCount 위상차를 둔 무한 반복 펄스 한 프레임을 계산한다.
 * phase(0..1) = frac(elapsedS/periodS + ringIndex/ringCount) — 음수 시각도 안전하게 처리한다.
 * radius 는 baseRadius 에서 baseRadius+spread 로 선형 팽창하고, alpha 는 maxAlpha 에서
 * 팽창할수록 0 까지 선형으로 줄어든다.
 */
export function samplePulseRing(
  elapsedS: number,
  periodS: number,
  baseRadius: number,
  spread: number,
  ringIndex: number,
  ringCount: number,
  maxAlpha: number,
): PulseRingSample {
  const raw = elapsedS / periodS + ringIndex / ringCount;
  const phase = raw - Math.floor(raw); // frac, 음수 안전
  return { radius: baseRadius + spread * phase, alpha: (1 - phase) * maxAlpha };
}

const SEGMENTS = 48 as const;

interface RingMesh {
  line: THREE.LineLoop;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
  ringIndex: number;
}

/**
 * 선택 노드에 붙는 펄스 링 레이어. attach 로 노드 그룹에 링을 걸고, update 로 매 프레임
 * 반지름·알파를 갱신한다. detach/dispose 로 씬에서 떼고 자원을 정리한다.
 */
export class PulseRingLayer {
  private readonly group = new THREE.Group();
  private rings: RingMesh[] = [];
  private attachedTo: THREE.Object3D | null = null;
  private startedAt = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = "pulse-ring-layer";
    scene.add(this.group);
  }

  /** target 노드 그룹에 펄스 링을 건다. 이미 다른 노드에 걸려 있으면 먼저 뗀다. */
  attach(target: THREE.Object3D, startedAt: number): void {
    this.detach();
    const tk = GRAPH_RENDER_THEME.effects;
    if (tk.pulseRingCount <= 0) return;

    this.startedAt = startedAt;
    this.attachedTo = target;
    const color = new THREE.Color(tk.pulseRingColor);
    for (let i = 0; i < tk.pulseRingCount; i++) {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array((SEGMENTS + 1) * 3);
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        linewidth: tk.pulseRingWidth,
      });
      const line = new THREE.LineLoop(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = -1;
      this.group.add(line);
      this.rings.push({ line, geometry, material, ringIndex: i });
    }
  }

  /** 걸려 있는 링을 뗀다(선택 해제). GPU 자원도 함께 정리한다. */
  detach(): void {
    for (const ring of this.rings) {
      this.group.remove(ring.line);
      ring.geometry.dispose();
      ring.material.dispose();
    }
    this.rings = [];
    this.attachedTo = null;
  }

  /** 매 프레임 부착 대상 위치를 따라가며 반지름·알파를 갱신한다. */
  update(elapsed: number): void {
    if (!this.attachedTo || this.rings.length === 0) return;
    const tk = GRAPH_RENDER_THEME.effects;
    const pos = this.attachedTo.position;
    this.group.position.copy(pos);

    for (const ring of this.rings) {
      const s = samplePulseRing(
        elapsed - this.startedAt,
        tk.pulseRingPeriodS,
        tk.pulseRingBaseRadius,
        tk.pulseRingSpread,
        ring.ringIndex,
        tk.pulseRingCount,
        tk.pulseRingMaxAlpha,
      );
      const attr = ring.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i <= SEGMENTS; i++) {
        const theta = (i / SEGMENTS) * Math.PI * 2;
        arr[i * 3 + 0] = Math.cos(theta) * s.radius;
        arr[i * 3 + 1] = Math.sin(theta) * s.radius;
        arr[i * 3 + 2] = 0;
      }
      attr.needsUpdate = true;
      ring.material.opacity = s.alpha;
    }
  }

  dispose(): void {
    this.detach();
    this.group.parent?.remove(this.group);
  }
}
