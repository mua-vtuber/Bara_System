/**
 * extractor-output-limit.paths.test.ts — 백필·저장 직후 추출·본문 넣어 추출이 모두 같은 출력 한도 설정
 * (llm.extractor.maxOutputTokens)을 Ollama 요청의 options.num_predict 로 보내는지 고정한다
 * (extractor-output-limit spec 7장).
 * createMemoryApi 로 부팅한 실제 통로 + 실제 SQLite + 실제 bge-m3 + Ollama 대역 HTTP 서버(mock 클래스 0).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "../server.ts";
import { startBackfillScheduler } from "../scheduler.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-schema.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { TEST_EXTRACTION_BACKFILL_RETRY } from "../test-utils/backfill-retry.ts";
import { startProviderStandIn, type ProviderStandIn, type RecordedRequest } from "../test-utils/provider-stand-in.ts";
import { EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT } from "./extractor-output-limit.ts";

const WIRED_LIMIT = EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT * 2;
const CHAT_PATH = "/api/chat";
const LOG_PREFIX = "[extractor-output-limit.paths.test]";
/** 짧은 단일 의미 건너뛰기에 걸리지 않게 문장 둘로 쓴다. */
const memo = (tag: string) => `${tag} 회의에서 예산을 정했다. 다음 주에는 일정표를 다시 본다.`;

let standIn: ProviderStandIn;
let dir: string;
let api: Awaited<ReturnType<typeof createMemoryApi>>;
let settings: MemorySettings;

beforeAll(async () => {
  standIn = startProviderStandIn();
  dir = mkdtempSync(join(tmpdir(), "bara-extractor-limit-paths-"));
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.reranker.enabled = false;
  // 정규식 1단이 저장 때 짧은 조각 노드를 만들면 백필 후보가 그 조각이 되어 LLM 을 부르지 않는다.
  settings.extractor.regex.enabled = false;
  settings.db.embeddingModel = "bge-m3";
  settings.backup.dir = join(dir, "backups");
  settings.llm.extractor.provider = "ollama";
  settings.llm.extractor.ollamaUrl = standIn.origin;
  settings.llm.extractor.maxOutputTokens = WIRED_LIMIT;
  api = await createMemoryApi({
    dbPath: ":memory:",
    assetDir: join(dir, "assets"),
    sseTokenFilePath: join(dir, "sse-tokens.json"),
    settingsFilePath: join(dir, "memory-settings.json"),
    llmProvider: "ollama",
    settings,
  });
}, 120_000);

afterAll(() => {
  api.shutdown();
  standIn.stop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  standIn.requests.length = 0;
  standIn.reply = () => ({
    body: {
      model: "test-model",
      message: { role: "assistant", content: "[]" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 10,
    },
  });
});

function chatRequests(): RecordedRequest[] {
  return standIn.requests.filter((r) => r.path === CHAT_PATH);
}

function numPredictOf(req: RecordedRequest): unknown {
  return (req.body as { options?: { num_predict?: unknown } }).options?.num_predict;
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return api.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("세 추출 경로가 같은 출력 한도 설정을 쓴다", () => {
  test("백필 주기: 대역 서버가 받은 options.num_predict 가 설정값이다", async () => {
    settings.llm.extractor.mode = "backfill";
    const res = await post("/memories", { content: memo("백필") });
    expect(res.status).toBe(201);
    expect(chatRequests().length).toBe(0);

    const handle = startBackfillScheduler(api.extractor!, api.store, {
      intervalMs: 60_000,
      batchSize: 5,
      logPrefix: LOG_PREFIX,
      retry: TEST_EXTRACTION_BACKFILL_RETRY,
    });
    try {
      await handle.tickNow();
    } finally {
      await handle.stop();
    }

    const sent = chatRequests();
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) expect(numPredictOf(req)).toBe(WIRED_LIMIT);
  });

  test("저장 직후 추출: mode=immediate 저장이 보낸 options.num_predict 가 설정값이다", async () => {
    settings.llm.extractor.mode = "immediate";
    const res = await post("/memories", { content: memo("즉시") });
    expect(res.status).toBe(201);

    const sent = chatRequests();
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) expect(numPredictOf(req)).toBe(WIRED_LIMIT);
  });

  test("본문 넣어 추출: POST /memories/from-text 가 보낸 options.num_predict 가 설정값이다", async () => {
    settings.llm.extractor.mode = "immediate";
    const res = await post("/memories/from-text", { text: memo("본문"), author: "tester", platform: "test" });
    expect(res.status).toBeLessThan(300);

    const sent = chatRequests();
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) expect(numPredictOf(req)).toBe(WIRED_LIMIT);
  });
});
