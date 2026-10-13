import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const MEMORY_DIR = path.resolve(__dirname);
const RERANKER_SRC = fs
  .readFileSync(path.join(MEMORY_DIR, "reranker.ts"), "utf-8")
  .replaceAll("\r\n", "\n");

describe("Reranker dtype contract", () => {
  test("q8 only — fp32 fallback 없음", () => {
    expect(RERANKER_SRC).toContain('export const RERANKER_DTYPE = "q8"');
    expect(RERANKER_SRC).toContain("dtype: this.dtype");
    expect(RERANKER_SRC).not.toContain('dtype: "fp32"');
    expect(RERANKER_SRC).not.toContain("loadEncoderWithDtypeFallback");
    expect(RERANKER_SRC).not.toContain("fp32 로 자동 활용");
  });
});
