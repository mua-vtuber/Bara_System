// 에너지 흐름 레이어(시각효과 Task 11) — focus 상태 엣지 위를 흐르는 작은 빛 점들을 그린다.
// 순수 샘플러(energyDotOffsets)를 소비하는 THREE.Points 레이어 — DustLayer 와 같은
// "고정 크기 버퍼 + update 갱신 + dispose" 패턴. focus 엣지 수가 많아도 상한선을 둬 과도한
// draw call·정점 수를 막는다.
import * as THREE from "three";

import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { Vec3 } from "../layout/force-layout.ts";

/** 렌더 부담 상한 — focus 엣지가 이보다 많으면 weight 큰 순서로 이 개수만 에너지 흐름을 그린다. */
export const MAX_ENERGY_EDGES = 24 as const;

/** 엣지 위 에너지 점들의 0..1 오프셋을 계산한다. offsets[i] = frac(elapsedS*speed + i/count). */
export function energyDotOffsets(elapsedS: number, speed: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const raw = elapsedS * speed + i / count;
    out.push(raw - Math.floor(raw));
  }
  return out;
}

export interface EnergyEdgeEndpoints {
  from: Vec3;
  to: Vec3;
  /** 엣지 weight(0..1) — 상한 초과 시 큰 순서로 남길 우선순위. */
  weight: number;
}

/**
 * 렌더 부담 상한을 적용한다. MAX_ENERGY_EDGES 이하면 원본 배열을 그대로 돌려주고(복사·정렬 0),
 * 초과할 때만 복사본을 weight 내림차순으로 정렬해 상위 MAX_ENERGY_EDGES 개만 남긴다.
 * sort 는 안정 정렬이라 동률 엣지는 원래 순서를 유지한다 — 같은 입력이면 프레임 간
 * 선별 결과가 흔들리지 않아 깜빡임이 없다.
 */
export function capEnergyEdges(edges: EnergyEdgeEndpoints[]): EnergyEdgeEndpoints[] {
  if (edges.length <= MAX_ENERGY_EDGES) return edges;
  return [...edges].sort((a, b) => b.weight - a.weight).slice(0, MAX_ENERGY_EDGES);
}

// 둥근 빛 알갱이 텍스처 — dust.ts/burst-particles.ts 와 같은 방사형 그라디언트 방식.
let sharedEnergyTexture: THREE.CanvasTexture | null = null;

function getEnergyTexture(): THREE.CanvasTexture {
  if (sharedEnergyTexture) return sharedEnergyTexture;
  const tk = GRAPH_RENDER_THEME.effects;
  const size = tk.energyFlowTextureSize;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // 양끝 stop(중심 불투명 1 → 가장자리 투명 0)은 스프라이트 형태 정의 — 중간 stop 만 무드 조절점.
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(tk.energyFlowTextureMidStop, `rgba(255,255,255,${tk.energyFlowTextureMidAlpha})`);
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedEnergyTexture = tex;
  return tex;
}

/**
 * focus 엣지 위를 흐르는 에너지 점 레이어. update 에 focus 엣지의 양 끝 좌표 목록을
 * 넘기면 엣지마다 energyDotOffsets 로 위치를 보간해 THREE.Points 하나로 그린다.
 * MAX_ENERGY_EDGES 를 넘으면 weight 큰 엣지부터만 그린다(렌더 부담 상한).
 */
export class EnergyFlowLayer {
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
      size: tk.energyFlowDotSize,
      map: getEnergyTexture(),
      color: new THREE.Color(tk.energyFlowColor),
      transparent: true,
      opacity: tk.energyFlowOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = -1;
    points.frustumCulled = false;
    points.name = "energy-flow-layer";
    scene.add(points);
    this.points = points;
    this.geometry = geometry;
    this.material = material;
  }

  /** focus 엣지 양 끝 좌표 목록으로 에너지 점 위치를 한 프레임 갱신한다. */
  update(edges: EnergyEdgeEndpoints[], elapsed: number): void {
    const geometry = this.geometry;
    if (!geometry) return;
    const tk = GRAPH_RENDER_THEME.effects;

    if (edges.length === 0 || tk.energyFlowDotsPerEdge <= 0) {
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      return;
    }

    const capped = capEnergyEdges(edges);
    const offsets = energyDotOffsets(elapsed, tk.energyFlowSpeed, tk.energyFlowDotsPerEdge);
    const positions = new Float32Array(capped.length * tk.energyFlowDotsPerEdge * 3);
    let idx = 0;
    for (const edge of capped) {
      for (const off of offsets) {
        positions[idx++] = edge.from.x + (edge.to.x - edge.from.x) * off;
        positions[idx++] = edge.from.y + (edge.to.y - edge.from.y) * off;
        positions[idx++] = edge.from.z + (edge.to.z - edge.from.z) * off;
      }
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  }

  dispose(): void {
    if (this.scene && this.points) this.scene.remove(this.points);
    this.geometry?.dispose();
    this.material?.dispose();
    this.points = null;
    this.geometry = null;
    this.material = null;
    this.scene = null;
  }
}
