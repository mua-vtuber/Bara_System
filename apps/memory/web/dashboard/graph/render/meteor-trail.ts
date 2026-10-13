import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { GRAPH_RENDER_THEME } from "../graph-theme.ts";
import type { Vec3 } from "../layout/force-layout.ts";

export interface MeteorTrailSegment {
  tail: Vec3;
  head: Vec3;
  color: THREE.Color;
}

/**
 * 세그먼트별 정점 색 배열을 만든다(세그먼트당 tail·head 순 6성분). tail 은 head 색에
 * tailDim 을 곱해 어둡게 — 유성 꼬리가 뒤로 갈수록 사그라드는 감쇠.
 */
export function meteorTrailColors(segments: MeteorTrailSegment[], tailDim: number): number[] {
  const colors: number[] = [];
  for (const seg of segments) {
    colors.push(
      seg.color.r * tailDim, seg.color.g * tailDim, seg.color.b * tailDim,
      seg.color.r, seg.color.g, seg.color.b,
    );
  }
  return colors;
}

export class MeteorTrailLayer {
  private readonly group = new THREE.Group();
  private readonly geometry = new LineSegmentsGeometry();
  private readonly material = new LineMaterial({
    linewidth: GRAPH_RENDER_THEME.nodeBirth.trailWidth,
    worldUnits: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly line: LineSegments2;
  private readonly resolution = new THREE.Vector2(1, 1);

  constructor(scene: THREE.Scene) {
    this.group.name = "meteor-trail-layer";
    this.geometry.setPositions([]);
    this.geometry.setColors([]);
    this.line = new LineSegments2(this.geometry, this.material);
    this.line.frustumCulled = false;
    this.line.renderOrder = -4;
    this.group.add(this.line);
    scene.add(this.group);
  }

  setResolution(width: number, height: number): void {
    this.resolution.set(width, height);
    this.material.resolution.copy(this.resolution);
  }

  update(segments: MeteorTrailSegment[]): void {
    if (segments.length === 0) {
      this.clear();
      return;
    }

    const pos: number[] = [];
    for (const seg of segments) {
      pos.push(seg.tail.x, seg.tail.y, seg.tail.z, seg.head.x, seg.head.y, seg.head.z);
    }
    this.geometry.setPositions(pos);
    this.geometry.setColors(meteorTrailColors(segments, GRAPH_RENDER_THEME.nodeBirth.trailTailDim));
    this.material.opacity = GRAPH_RENDER_THEME.nodeBirth.trailOpacity;
  }

  clear(): void {
    this.geometry.setPositions([]);
    this.geometry.setColors([]);
    this.material.opacity = 0;
  }

  dispose(): void {
    this.clear();
    this.group.parent?.remove(this.group);
    this.geometry.dispose();
    this.material.dispose();
  }
}
