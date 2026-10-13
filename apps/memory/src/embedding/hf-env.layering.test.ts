import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOADERS = [
  "./bge-m3.ts",
  "./siglip2.ts",
  "./siglip2-text.ts",
  "../memory/reranker.ts",
];

test("모든 transformers 로더가 hf-env 를 먼저 import (캐시 분열 방지 — P4 D3-d)", () => {
  for (const rel of LOADERS) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const hfEnvAt = src.indexOf("hf-env");
    const transformersAt = src.indexOf("@huggingface/transformers");
    expect(hfEnvAt, `${rel}: hf-env import 부재`).toBeGreaterThanOrEqual(0);
    expect(hfEnvAt, `${rel}: hf-env 가 transformers 뒤`).toBeLessThan(transformersAt);
  }
});

test("hf-env 가 env.cacheDir 를 assets/hf-cache 로 배선", async () => {
  const { HF_CACHE_DIR } = await import("./hf-env.ts");
  const { env } = await import("@huggingface/transformers");
  expect(HF_CACHE_DIR.replaceAll("\\", "/")).toContain("apps/memory/assets/hf-cache");
  expect(env.cacheDir).toBe(HF_CACHE_DIR);
});
