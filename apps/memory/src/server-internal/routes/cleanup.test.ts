/**
 * cleanup.test.ts — POST /cleanup 의 태그 wiring 중복 누적 0 검증 (메인 결정 1).
 *
 * /cleanup 은 backfill 형제 경로다(raw auto_capture 노드를 extractor 에 던져 세분화).
 * candidate 는 입력 시점에 이미 wireHashtagConcepts 를 받았으니, /cleanup 의
 * extractAndStore 호출은 skipHashtagWiring=true 로 태그 wiring 을 하지 않는다(scheduler
 * 와 정합 — 옛 22~24회 누적 bug 차단).
 *
 * 핵심 불변식: candidate 를 saveTextInput 으로 입력(태그 wiring 1회) 후 /cleanup 을
 * 여러 번 가동해도 tagged_with 가 안 늚. 이 불변식은 LLM 가용과 무관하게 성립한다 —
 * Ollama 미가동이면 /cleanup 이 추출을 failures 로 집계하지만, 태그 wiring 은 어차피
 * 추출 경로에서 skipHashtagWiring=true 로 안 도므로 tagged_with 가 늘지 않는다. Ollama
 * 가동 시엔 실제 추출이 돌아도 태그가 안 늘어야 한다(이게 핵심 — 추출 사이클과 무관).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 MemoryExtractor(OllamaClient). mock 0
 * (CLAUDE.md "테스트 정책" — LlmClient 는 진짜 HTTP 통로, 가짜 인터페이스 구현 아님).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { saveTextInput } from "../save-input.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/** backfill mode 슬롯 — saveTextInput 이 plain 갈래(입력 시점 wiring)로 가게. */
function backfillSlot(): MemorySettings["llm"]["extractor"] {
  return {
    enabled: true,
    provider: "ollama",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "exaone3.5:32b",
    anthropicApiKey: "",
    anthropicModel: "",
    openaiBaseUrl: "http://127.0.0.1:1234/v1",
    openaiModel: "qwen3:4b-instruct",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    mode: "backfill",
    minImportance: 0.3,
    forceJsonFormat: false,
    timeoutMs: 900000,
    backfill: { intervalMin: 30, batchSize: 10, minImportance: 0, maxAttempts: 5, retryDelayMin: 30, retryMaxDelayMin: 1440 },
  };
}

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

describe("POST /cleanup — 태그 wiring 중복 누적 0 (메인 결정 1)", () => {
  let h: Harness;

  function makeHarness(): Harness {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store = new SqliteMemoryStore(db, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const assembler = new ContextAssembler();
    const llm = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "exaone3.5:32b",
    });
    const extractor = new MemoryExtractor(llm, store, embedder);
    const app = buildMemoryApi({
      store,
      retriever,
      assembler,
      extractor,
    });
    return { app, db, store };
  }

  afterEach(() => {
    if (h) h.db.close();
  });

  async function postCleanup(app: Hono): Promise<Response> {
    return app.request("/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 50 }),
    });
  }

  test("#태그 candidate 입력(wiring 1회) 후 /cleanup 3회 → tagged_with 증가 0", async () => {
    h = makeHarness();

    // candidate 입력 — backfill mode plain 갈래(입력 시점 wiring 1회).
    const saved = await saveTextInput(h.store, {
      content: "#만화 본문 메모",
      source: "dashboard:manual",
      chunking: { tokenCap: 2000 },
      extractorSettings: backfillSlot(),
    });

    const before = await h.store.listNodeConceptEdges({
      nodeId: saved.originNodeId!,
      role: "tag",
    });
    expect(before).toHaveLength(1);

    // /cleanup 3회 강제 — 추출 경로는 skipHashtagWiring=true 라 태그 wiring 을 안 한다.
    // Ollama 미가동이면 failures 로 집계되지만 어느 경우든 태그 엣지는 안 늚.
    await postCleanup(h.app);
    await postCleanup(h.app);
    await postCleanup(h.app);

    const after = await h.store.listNodeConceptEdges({
      nodeId: saved.originNodeId!,
      role: "tag",
    });
    expect(after).toHaveLength(1); // 증가 0.

    // 전체 tagged_with 엣지도 정확히 1개(다른 노드에 새 태그 엣지가 안 생김).
    const allTagEdges = await h.store.listNodeConceptEdges({ role: "tag" });
    expect(allTagEdges).toHaveLength(1);
  }, 120_000);

  test("dryRun /cleanup → 태그 개념·엣지 안 만든다(저장 안 함 + wiring 안 함)", async () => {
    h = makeHarness();

    // candidate 입력 — 입력 시점 wiring 1회.
    const saved = await saveTextInput(h.store, {
      content: "#주술회전 줄거리 메모",
      source: "dashboard:manual",
      chunking: { tokenCap: 2000 },
      extractorSettings: backfillSlot(),
    });
    const before = await h.store.listNodeConceptEdges({
      nodeId: saved.originNodeId!,
      role: "tag",
    });
    expect(before).toHaveLength(1);

    // dryRun — 추출만(저장 안 함), 태그 wiring 도 안 함.
    const res = await h.app.request("/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 50, dryRun: true }),
    });
    expect(res.status).toBe(200);

    const after = await h.store.listNodeConceptEdges({
      nodeId: saved.originNodeId!,
      role: "tag",
    });
    expect(after).toHaveLength(1); // 증가 0.
  }, 120_000);
});
