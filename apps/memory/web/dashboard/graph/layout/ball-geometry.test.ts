import { describe, it, expect } from "bun:test";
import { fibonacciAnchors } from "./ball-geometry.ts";

describe("fibonacciAnchors", () => {
  it("결정적이고 구 표면에 놓인다", () => {
    const r = 10;
    const a1 = fibonacciAnchors(["person", "place", "work"], r);
    const a2 = fibonacciAnchors(["person", "place", "work"], r);
    for (const id of ["person", "place", "work"]) {
      const p = a1.get(id)!;
      const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      expect(len).toBeCloseTo(r, 5);
      expect(a2.get(id)).toEqual(p);
    }
  });
  it("빈 입력은 빈 Map", () => {
    expect(fibonacciAnchors([], 10).size).toBe(0);
  });
});
