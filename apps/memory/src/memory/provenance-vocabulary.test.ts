import { describe, expect, test } from "bun:test";
import {
  PROVENANCE_VALUES,
  assertProvenance,
  isProvenance,
} from "./provenance-vocabulary.ts";

describe("provenance-vocabulary", () => {
  test("출처 값 8개를 단일 출처로 제공한다", () => {
    expect([...PROVENANCE_VALUES]).toEqual([
      "user_input",
      "hashtag",
      "regex",
      "llm_extract",
      "image",
      "evolver",
      "migration",
      "system",
    ]);
    expect(new Set(PROVENANCE_VALUES).size).toBe(PROVENANCE_VALUES.length);
  });

  test("isProvenance 는 등록된 값만 참으로 본다", () => {
    for (const value of PROVENANCE_VALUES) {
      expect(isProvenance(value)).toBe(true);
    }
    expect(isProvenance("manual")).toBe(false);
    expect(isProvenance("")).toBe(false);
    expect(isProvenance(null)).toBe(false);
  });

  test("assertProvenance 는 미등록 값을 loud throw 로 멈춘다", () => {
    expect(() => assertProvenance("hashtag")).not.toThrow();
    expect(() => assertProvenance("manual")).toThrow(/manual/);
  });
});
