import { describe, expect, test } from "bun:test";
import { normalizeProjectId } from "./project-scope.ts";

describe("normalizeProjectId", () => {
  test("undefined/null/non-string/empty/whitespace -> null", () => {
    expect(normalizeProjectId(undefined)).toBeNull();
    expect(normalizeProjectId(null)).toBeNull();
    expect(normalizeProjectId(7)).toBeNull();
    expect(normalizeProjectId("")).toBeNull();
    expect(normalizeProjectId("   ")).toBeNull();
  });

  test("string project ids are trimmed", () => {
    expect(normalizeProjectId(" prj_bara ")).toBe("prj_bara");
  });
});
