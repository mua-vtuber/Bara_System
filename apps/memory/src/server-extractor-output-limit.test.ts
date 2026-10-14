/**
 * server-extractor-output-limit.test.ts — 설정 llm.extractor.maxOutputTokens 가
 * createMemoryApi 가 만든 추출기까지 전달되는지 검증한다(extractor-output-limit spec 4.2).
 * 실제 부팅 통로 + 실제 SQLite + Ollama 대역 서버(test-utils/provider-stand-in.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "./server.ts";
import { MEMORY_DEFAULTS } from "./settings/memory-schema.ts";
import type { MemorySettings } from "./settings/memory-settings.ts";
import { startProviderStandIn, type ProviderStandIn } from "./test-utils/provider-stand-in.ts";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT } from "./memory/extractor-output-limit.ts";

const WIRED_LIMIT = EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT * 2;

let standIn: ProviderStandIn;
let dir: string;
let shutdown: () => void;
let wiredLimit: number | undefined;

beforeAll(async () => {
  standIn = startProviderStandIn();
  dir = mkdtempSync(join(tmpdir(), "bara-extractor-limit-"));
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.reranker.enabled = false;
  settings.db.embeddingModel = "bge-m3";
  settings.backup.dir = join(dir, "backups");
  settings.llm.extractor.provider = "ollama";
  settings.llm.extractor.ollamaUrl = standIn.origin;
  settings.llm.extractor.maxOutputTokens = WIRED_LIMIT;
  const api = await createMemoryApi({
    dbPath: ":memory:",
    assetDir: join(dir, "assets"),
    sseTokenFilePath: join(dir, "sse-tokens.json"),
    settingsFilePath: join(dir, "memory-settings.json"),
    llmProvider: "ollama",
    settings,
  });
  shutdown = api.shutdown;
  wiredLimit = api.extractor?.maxOutputTokens;
}, 120_000);

afterAll(() => {
  shutdown();
  standIn.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("createMemoryApi — 추출기 출력 한도 배선", () => {
  test("settings.llm.extractor.maxOutputTokens 가 추출기 인스턴스 값이 된다", () => {
    expect(wiredLimit).toBe(WIRED_LIMIT);
  });
});
