import { describe, expect, test } from "bun:test";
import * as THREE from "three";

import { meteorTrailColors, type MeteorTrailSegment } from "./meteor-trail.ts";

const seg = (r: number, g: number, b: number): MeteorTrailSegment => ({
  tail: { x: 0, y: 0, z: 0 },
  head: { x: 1, y: 0, z: 0 },
  color: new THREE.Color(r, g, b),
});

describe("meteorTrailColors", () => {
  test("세그먼트당 tail·head 순 6성분을 만든다", () => {
    expect(meteorTrailColors([seg(1, 0.5, 0.25), seg(0.2, 0.4, 0.6)], 0.15).length).toBe(12);
    expect(meteorTrailColors([], 0.15)).toEqual([]);
  });

  test("tail 은 head 색 × tailDim, head 는 원색 그대로 (토큰 반영)", () => {
    const out = meteorTrailColors([seg(1, 0.5, 0.25)], 0.15);
    expect(out.slice(0, 3)).toEqual([1 * 0.15, 0.5 * 0.15, 0.25 * 0.15]);
    expect(out.slice(3, 6)).toEqual([1, 0.5, 0.25]);
  });

  test("tailDim 0 이면 꼬리 끝이 완전히 검게 사그라든다", () => {
    expect(meteorTrailColors([seg(1, 1, 1)], 0).slice(0, 3)).toEqual([0, 0, 0]);
  });
});
