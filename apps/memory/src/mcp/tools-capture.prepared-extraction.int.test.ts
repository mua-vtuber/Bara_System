/**
 * mcp/tools-capture.prepared-extraction.int.test.ts — 능동 저장 도구가 잠금 밖에서 준비한 즉시 추출
 * 결과를 쓸 수 없게 된 요청을 CONFLICT 도구 오류로 알리는지(WP-B1-08).
 *
 * 실 bge-m3 + 실 SqliteMemoryStore + Bun.serve + SDK StreamableHTTPClientTransport + 인증 게이트
 * (tools-capture.int.test.ts 와 같은 조립). 추출기는 실제 OllamaClient 가 테스트 안 Bun.serve
 * (Ollama /api/chat 형식)를 부른다 — 이 경우에는 부르지 않아야 한다. mock 0.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import { registerMcpRoutes } from "./server.ts";

/** 여러 절이 있는 글 — 짧은 단일 의미 입력은 추출기가 LLM 을 건너뛴다(shouldSkipExtraction). */
const CAPTURE_TEXT =
  "나는 매일 아침 커피를 마신다. 나는 주말마다 북한산에 오른다. 나는 저녁마다 추리소설을 읽는다.";
/**
 * 잠금을 쥔 동안 도구 호출의 잠금 밖 준비(입력 검사·같은 본문 원본 조회 — DB 읽기 몇 번)가 끝나기를
 * 기다리는 시간. 이 안에 끝나지 않으면 LLM 호출 수 단언이 실패로 드러낸다.
 */
const PREPARE_SETTLE_MS = 1_000;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let tmpDir: string;
let db: Database;
let store: SqliteMemoryStore;
let llm: DelayedOllamaChatServer;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-prepared-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  llm = startDelayedOllamaChatServer({
    delayMs: 0,
    content: JSON.stringify([{ content: "나는 매일 아침 커피를 마신다", memoryType: "fact", importance: 0.6 }]),
  });
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, {
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    extractor: new MemoryExtractor(new OllamaClient({ baseUrl: llm.url, model: "test-model" }), store, embedder),
    getSettings: () => settings,
  });
  const sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const outer = new Hono({ strict: false });
  outer.use("*", createAuthGate({
    sseTokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${sseTokens.issueToken("claude-code")}` } },
  }));
});

afterEach(async () => {
  await client.close();
  server.stop(true);
  llm.stop();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("save_preference — 준비 때 있던 같은 본문 기억이 잠금 전에 지워지면 CONFLICT 도구 오류, LLM 0회, 저장 0건", async () => {
  // 같은 본문 원본이 있으면 준비는 LLM 을 부르지 않고 "같은 본문 원본 있음"으로 끝난다.
  const sameBody = await store.addNode({ content: CAPTURE_TEXT, sourceType: "auto_capture" });

  // 잠금을 쥔 채 도구를 부르고, 준비가 끝나 잠금 줄에 선 뒤 잠금 안에서 같은 본문 원본을 지운다.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withMemoryMutationLock(store, async () => {
    await gate;
    await store.deleteNode(sameBody);
  });
  const call = client.callTool({
    name: "save_preference",
    arguments: { content: CAPTURE_TEXT, evidence: { assertionKind: "user_statement", sourceEventId: "prepared-vanish" } },
  });
  await Bun.sleep(PREPARE_SETTLE_MS);
  release();
  await holder;

  const res = await call;
  expect(res.isError).toBe(true);
  const payload = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text) as {
    code: string;
    message: string;
  };
  expect(payload.code).toBe("CONFLICT");
  expect(payload.message).toContain("다시 보내 주세요");
  expect(llm.requestCount()).toBe(0);
  expect(db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM memory_source_events").get()).toEqual({ n: 0 });
}, 30_000);
