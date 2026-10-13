import { describe, expect, test } from "bun:test";
import { cosineSimilarity, distanceToSimilarity } from "./vector-utils.ts";

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] as number) * (v[i] as number);
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

describe("cosineSimilarity", () => {
  test("identical normalized vectors → 1", () => {
    const a = unit([1, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  test("orthogonal normalized vectors → 0", () => {
    const a = unit([1, 0, 0]);
    const b = unit([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  test("opposite normalized vectors → -1", () => {
    const a = unit([1, 0, 0]);
    const b = unit([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  test("known angle (45°) → cos(45°)", () => {
    const a = unit([1, 0]);
    const b = unit([1, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  test("dim mismatch throws", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow();
  });

  test("empty vectors throw (treated as upstream bug)", () => {
    expect(() => cosineSimilarity(new Float32Array(), new Float32Array())).toThrow();
  });
});

describe("distanceToSimilarity", () => {
  test("distance 0 → similarity 1", () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  test("distance 1 → similarity 0 (orthogonal)", () => {
    expect(distanceToSimilarity(1)).toBe(0);
  });

  test("distance 2 → similarity -1 (opposite)", () => {
    expect(distanceToSimilarity(2)).toBe(-1);
  });
});
