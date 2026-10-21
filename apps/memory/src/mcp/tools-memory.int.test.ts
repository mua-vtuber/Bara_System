/**
 * mcp/tools-memory.int.test.ts — 기본 도구 4종 통합 검증 (MCP plan T4).
 *
 * 실 bge-m3 + 실 SqliteMemoryStore + Bun.serve + SDK StreamableHTTPClientTransport
 * (server.test.ts T3 harness + api-client.test.ts 실 store 조립 양식 재사용). outer
 * Hono(createAuthGate) 로 인증 게이트를 실제로 태워 adapterId 전파(spec 7.3)까지
 * 검증한다.
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
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { createBodyLimit } from "../server-internal/body-limit.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { EventRepository, type EventRecord } from "../db/store-internal/event-repository.ts";
import { EVENT_TYPES, EventBus } from "../server-internal/event-bus.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import {
  startAutoCleanupTrigger,
  type DataChangeReason,
} from "../memory/auto-cleanup-trigger.ts";
import { registerMcpRoutes } from "./server.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let tmpDir: string;
let db: Database;
let store: SqliteMemoryStore;
let eventBus: EventBus;
let receivedEvents: EventRecord[];
let server: ReturnType<typeof Bun.serve>;
let client: Client;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-tools-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  // 실 EventBus + 실 EventRepository — mock 클래스 금지 원칙(GRAPH_CHANGED emit 관측용, review Fix 1).
  eventBus = new EventBus(new EventRepository(db));
  receivedEvents = [];
  eventBus.subscribe("test-observer", (record) => receivedEvents.push(record));
  const deps: MemoryApiDeps = { store, retriever, assembler, eventBus };

  const sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const token = sseTokens.issueToken("claude-code");

  const outer = new Hono({ strict: false });
  outer.use(
    "*",
    createAuthGate({
      sseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  // D-1 실측 — 운영 순서 재현(auth-gate 뒤). 한도는 schema default 단일 출처를 참조.
  outer.use(
    "*",
    createBodyLimit(() => ({
      maxTextBytes: MEMORY_DEFAULTS.security.maxTextBytes,
      maxAssetBytes: MEMORY_DEFAULTS.security.maxAssetBytes,
    })),
  );
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  outer.route("/", inner);
  // idleTimeout 60s — D-1 실측((g) 케이스)이 큰 content 청킹+임베딩 누적 지연으로
  // Bun 기본 idleTimeout(10s) 을 넘어서기 때문. 다른 케이스는 짧게 끝나 영향 없다.
  server = Bun.serve({ port: 0, fetch: outer.fetch, idleTimeout: 60 });

  const mcpUrl = new URL(`http://127.0.0.1:${server.port}/mcp`);
  client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  server.stop(true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function toolResultJson(res: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

test("(a) tools/list 에 4종 이름 포함", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain("search_memory");
  expect(names).toContain("get_memory");
  expect(names).toContain("list_recent");
  expect(names).toContain("store_memory");
});

test("(b) store_memory → REST 성공 응답과 동형({type,id,originNodeId,cacheHit,node}) + author adapterId 전파", async () => {
  const res = await client.callTool({
    name: "store_memory",
    arguments: { content: "MCP 통합 테스트 글" },
  });
  const payload = toolResultJson(res);
  expect(payload.type).toBe("memory");
  expect(Number.isInteger(payload.id)).toBe(true);
  expect(Number.isInteger(payload.originNodeId)).toBe(true);
  expect(payload.cacheHit).toBe(false);
  expect(payload.node).toBeDefined();
  expect(payload.node.content).toBe("MCP 통합 테스트 글");

  const node = await store.getNode(payload.id);
  expect(node).not.toBeNull();
  expect(node!.author).toBe("claude-code");
});

test("(b-2) store_memory 성공 시 REST 와 같은 조건으로 GRAPH_CHANGED 를 emit 한다 (review Fix 1)", async () => {
  await client.callTool({
    name: "store_memory",
    arguments: { content: "GRAPH_CHANGED emit 검증용 글" },
  });

  const graphChangedEvents = receivedEvents.filter(
    (e) => e.type === EVENT_TYPES.GRAPH_CHANGED,
  );
  expect(graphChangedEvents.length).toBeGreaterThanOrEqual(1);
  expect(graphChangedEvents[0]!.payload).toEqual({ reason: "memory-added" });
});

test("(b-3) store_memory entity_patch 갈래도 REST 와 같은 조건으로 autoCleanupTrigger 를 emit 한다 (review Fix 2)", async () => {
  // 실 startAutoCleanupTrigger(진짜 구현) 를 조립하되 enabled:false 로 두어 무거운
  // runAutoCleanup 사이클은 절대 가동하지 않는다 — emit 호출 자체(reason 인자 포함)만
  // 관측한다. store 는 이 harness 의 실 SqliteMemoryStore(AutoCleanupStore 표면의
  // 실제 구현체) 를 그대로 넘긴다 — mock 클래스 0.
  const emittedReasons: DataChangeReason[] = [];
  const realTrigger = startAutoCleanupTrigger({
    throttleMs: 60_000,
    store,
    enabled: () => false,
  });
  const observedTrigger = {
    emit: (reason: DataChangeReason) => {
      emittedReasons.push(reason);
      realTrigger.emit(reason);
    },
    stop: () => realTrigger.stop(),
    lastSummary: () => realTrigger.lastSummary(),
  };

  // 이 harness 전용 retriever/assembler/인증 토큰 — beforeEach 지역 변수는 이 테스트
  // 스코프에 안 닿는다((h) 케이스의 별도 harness 조립 양식 재사용).
  const patchRetriever = new HybridRetriever(store, embedder);
  const patchAssembler = new ContextAssembler();
  const patchSseTokens = new SseTokenStore(join(tmpDir, "tokens-patch.json"));
  const patchToken = patchSseTokens.issueToken("claude-code-patch");

  const patchDeps: MemoryApiDeps = {
    store,
    retriever: patchRetriever,
    assembler: patchAssembler,
    eventBus,
    autoCleanupTrigger: observedTrigger,
  };
  const patchInner = new Hono({ strict: false });
  registerMcpRoutes(patchInner, patchDeps);
  const patchOuter = new Hono({ strict: false });
  patchOuter.use(
    "*",
    createAuthGate({
      sseTokens: patchSseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  patchOuter.route("/", patchInner);
  const patchServer = Bun.serve({ port: 0, fetch: patchOuter.fetch });

  try {
    const patchUrl = new URL(`http://127.0.0.1:${patchServer.port}/mcp`);
    const patchClient = new Client({ name: "test-client-patch", version: "0.0.1" });
    const patchTransport = new StreamableHTTPClientTransport(patchUrl, {
      requestInit: { headers: { authorization: `Bearer ${patchToken}` } },
    });
    await patchClient.connect(patchTransport);

    // entity_patch 트리거 입력 — 본문 없이 콜론 해시태그만(entity-input-plan.ts
    // planEntityInput 이 entity_patch 로 분류하는 형태, save-input-entity-patch.test.ts
    // 기존 fixture 문법 재사용).
    const res = await patchClient.callTool({
      name: "store_memory",
      arguments: { content: "#작품:데못죽 #장르:판타지 #별명:데못죽" },
    });
    const payload = toolResultJson(res);
    expect(payload.type).toBe("entity_patch");

    await patchClient.close();
  } finally {
    patchServer.stop(true);
  }

  expect(emittedReasons).toContain("external-sdk-write");
});

test("(c) get_memory → content 일치, 없는 id → isError + not found", async () => {
  const stored = await client.callTool({
    name: "store_memory",
    arguments: { content: "get_memory 조회 대상" },
  });
  const storedPayload = toolResultJson(stored);

  const res = await client.callTool({
    name: "get_memory",
    arguments: { id: storedPayload.id },
  });
  const payload = toolResultJson(res);
  expect(payload.memory.content).toBe("get_memory 조회 대상");

  const missing = await client.callTool({
    name: "get_memory",
    arguments: { id: 999999 },
  });
  expect(missing.isError).toBe(true);
  const missingBody = toolResultJson(missing) as { code: string; message: string };
  expect(missingBody.code).toBe("NOT_FOUND");
  expect(missingBody.message).toContain("not found");
});

// WP-B1-08R (Minor 4) — get_memory 가 손상된 원장 행을 evidenceOmitted 로 정직하게 드러내는지
// MCP 도구 호출로 직접 확인한다(listMemoryEvidence 단위 테스트는 shared-memory-write.test.ts 에
// 이미 있으나, get_memory 도구 응답 표면까지 이어지는지는 별도 확인이 없었다).
test("(c5) get_memory → 손상된 memory_source_events 행이 있으면 evidenceOmitted 로 개수만 드러난다", async () => {
  const stored = toolResultJson(
    await client.callTool({ name: "store_memory", arguments: { content: "손상된 원장 확인 대상" } }),
  );
  const insert = db.query(
    "INSERT INTO memory_source_events(event_key,node_id,evidence_json,created_at) VALUES (?,?,?,?)",
  );
  insert.run("malformed-fixture", stored.id, "not-json", "2026-09-20 00:00:00");
  insert.run(
    "credential-fixture",
    stored.id,
    JSON.stringify({ sourceEventId: "ghp_" + "x".repeat(40), producer: "ai-a" }),
    "2026-09-20 00:00:00",
  );

  const res = await client.callTool({ name: "get_memory", arguments: { id: stored.id } });
  expect(res.isError).not.toBe(true);
  const payload = toolResultJson(res) as {
    memory: { evidence: unknown[]; evidenceOmitted?: { malformed: number; unsafe: number } };
  };
  expect(payload.memory.evidence).toEqual([]);
  expect(payload.memory.evidenceOmitted).toEqual({ malformed: 1, unsafe: 1 });
  expect(JSON.stringify(payload)).not.toContain("ghp_");
});

// ── T22(spec C) — get_memory(ids) 복수 조회 ──────────────────────────────

test("(c2) get_memory ids → 요청 순서 보존 + notFound 정직 + REST batch-get 과 동형", async () => {
  const a = toolResultJson(
    await client.callTool({ name: "store_memory", arguments: { content: "복수조회 A" } }),
  );
  const b = toolResultJson(
    await client.callTool({ name: "store_memory", arguments: { content: "복수조회 B" } }),
  );

  const res = await client.callTool({
    name: "get_memory",
    arguments: { ids: [b.id, a.id, 999999] },
  });
  expect(res.isError).not.toBe(true);
  const payload = toolResultJson(res) as {
    memories: Array<{ id: number; content: string; imageAttachments: unknown[] }>;
    notFound: number[];
  };
  expect(payload.memories.map((m) => m.id)).toEqual([b.id, a.id]);
  expect(payload.memories.map((m) => m.content)).toEqual(["복수조회 B", "복수조회 A"]);
  expect(payload.memories.every((m) => Array.isArray(m.imageAttachments))).toBe(true);
  expect(payload.notFound).toEqual([999999]);
});

test("(c3) get_memory 에 id 와 ids 둘 다 지정 → INVALID_INPUT", async () => {
  const a = toolResultJson(
    await client.callTool({ name: "store_memory", arguments: { content: "상호배타 확인" } }),
  );
  const res = await client.callTool({
    name: "get_memory",
    arguments: { id: a.id, ids: [a.id] },
  });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string };
  expect(body.code).toBe("INVALID_INPUT");
});

test("(c4) get_memory 에 id 도 ids 도 없으면 → INVALID_INPUT", async () => {
  const res = await client.callTool({ name: "get_memory", arguments: {} });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string };
  expect(body.code).toBe("INVALID_INPUT");
});

test("(d) list_recent → count ≥ 1 + memories[0].id 존재", async () => {
  await client.callTool({
    name: "store_memory",
    arguments: { content: "list_recent 대상 글" },
  });
  const res = await client.callTool({ name: "list_recent", arguments: {} });
  const payload = toolResultJson(res);
  expect(payload.count).toBeGreaterThanOrEqual(1);
  expect(payload.memories[0].id).toBeDefined();
});

test("(e) search_memory 전 칸 방어 파싱 + contextBudget + limit", async () => {
  await client.callTool({
    name: "store_memory",
    arguments: { content: "통합 테스트 검색 대상 글입니다" },
  });

  const basic = await client.callTool({
    name: "search_memory",
    arguments: { query: "통합 테스트" },
  });
  const basicPayload = toolResultJson(basic);
  expect(basicPayload.count).toBeDefined();
  expect(basicPayload.results).toBeDefined();
  expect(basicPayload.searchMode).toBeDefined();
  expect(basicPayload.relaxed).toBeDefined();
  expect(basicPayload.strictCount).toBeDefined();
  expect(basicPayload.removedFilters).toBeDefined();
  // T10 — processing_info·appliedFilters 는 REST/MCP 양쪽 항상-존재 칸(spec B).
  // search_memory 가 runSearchPipeline 을 그대로 공유하므로 REST 전용 필드가 아님을 확인.
  expect(basicPayload.processing_info).toBeDefined();
  expect(typeof basicPayload.processing_info.totalFound).toBe("number");
  expect(typeof basicPayload.processing_info.afterFiltering).toBe("number");
  expect(typeof basicPayload.processing_info.returned).toBe("number");
  expect(typeof basicPayload.processing_info.trimmedByBudget).toBe("number");
  expect(basicPayload.processing_info.returned).toBe(basicPayload.results.length);
  expect(basicPayload.appliedFilters).toBeDefined();

  const withContext = await client.callTool({
    name: "search_memory",
    arguments: { query: "통합 테스트", contextBudget: 200 },
  });
  const withContextPayload = toolResultJson(withContext);
  expect(withContextPayload.context.memoryBlock).toBeDefined();

  const limited = await client.callTool({
    name: "search_memory",
    arguments: { query: "통합 테스트", limit: 1 },
  });
  const limitedPayload = toolResultJson(limited);
  expect(limitedPayload.results.length).toBeLessThanOrEqual(1);

  const memoryTypeFiltered = await client.callTool({
    name: "search_memory",
    arguments: { query: "통합 테스트", memoryType: "fact" },
  });
  expect(memoryTypeFiltered.isError).not.toBe(true);

  // polarity 는 enum 이라 오타가 호출 시점에 거절된다(조용히 필터 미적용 금지).
  const bogus = await client.callTool({
    name: "search_memory",
    arguments: { query: "통합 테스트", polarity: "bogus" },
  });
  expect(bogus.isError).toBe(true);

  // 숫자 칸 limit 0 은 REST 공유 방어 파싱이 기본값으로 처리한다.
  const zeroLimit = await client.callTool({
    name: "search_memory",
    arguments: { query: "통합 테스트", polarity: "neutral", limit: 0 },
  });
  expect(zeroLimit.isError).not.toBe(true);
});

test("(e2) search_memory query 빈 문자열 → INVALID_INPUT + SearchInputError 문구 그대로(T8)", async () => {
  const res = await client.callTool({
    name: "search_memory",
    arguments: { query: "" },
  });
  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as { code: string; message: string };
  expect(body.code).toBe("INVALID_INPUT");
  expect(body.message).toBe("query must be a non-empty string");
});

test("(f) search_memory 검색 0건 → count 0 + results [] (정직한 빈 결과)", async () => {
  const res = await client.callTool({
    name: "search_memory",
    arguments: { query: "존재하지-않는-검색어-zzzqqq" },
  });
  expect(res.isError).not.toBe(true);
  const payload = toolResultJson(res);
  expect(payload.count).toBe(0);
  expect(payload.results).toEqual([]);
});

test("(f2) search_memory 는 AI 경로라 결과 하한선이 걸린다 — 무관 질의 0건 + totalFound>0 (T20/D-B)", async () => {
  // 위 (f) 는 DB 가 비어 0건이라 하한선 없이도 통과한다. 여기서는 기억을 실제로
  // 저장한 뒤, *저장된 기억과 무관한* 질의가 0건을 받는지 본다 — 하한선이 없으면
  // top-k 가 무관한 글로 채워져 이 시험이 깨진다.
  for (const content of [
    "지난 주말에 친구들과 한강에서 자전거를 탔다",
    "냉장고에 우유가 떨어져서 마트에 들러야 한다",
    "회사 회의에서 다음 분기 예산안을 논의했다",
  ]) {
    await client.callTool({ name: "store_memory", arguments: { content } });
  }

  const unrelated = await client.callTool({
    name: "search_memory",
    arguments: { query: "심해 열수구에 사는 관벌레의 화학합성 대사", limit: 20 },
  });
  expect(unrelated.isError).not.toBe(true);
  const unrelatedPayload = toolResultJson(unrelated);
  expect(unrelatedPayload.count).toBe(0);
  expect(unrelatedPayload.results).toEqual([]);
  // "기억이 아예 없음"이 아니라 "있었지만 관련 있는 게 없음"을 AI 가 구분해 읽는다.
  expect(unrelatedPayload.processing_info.totalFound).toBeGreaterThan(0);
  expect(unrelatedPayload.processing_info.afterFiltering).toBe(0);

  // 관련 있는 질의는 정답을 그대로 받는다(회수 회귀 0 — 하한선이 다 막는 게 아님).
  const related = await client.callTool({
    name: "search_memory",
    arguments: { query: "자전거", limit: 20 },
  });
  const relatedPayload = toolResultJson(related);
  expect(relatedPayload.count).toBeGreaterThan(0);
  expect(
    (relatedPayload.results as Array<{ content: string }>).some((r) =>
      r.content.includes("자전거"),
    ),
  ).toBe(true);
});

// --- D-1 실측: /mcp 경로 body-limit 판정 (spec 4.3 / plan Task 5) -----------------
//
// 미들웨어 순서상 bodyLimit 이 /mcp JSON-RPC POST 에도 걸린다. 정상 규모 호출이
// 8 MiB default 한도 안에서 잘리지 않는지, 초과 시 MCP 층 도달 전 413 으로
// 정직하게 실패하는지 실측한다. 판정 결과는 plan 문서 D-1 칸에 기록한다.
//
// content 크기는 brief 예시(1 MiB)가 아니라 30 KiB 로 실측했다 — saveTextInput
// 청킹 파이프라인이 tokenCap(2000) 초과 글을 다수 청크로 쪼개 청크마다 bge-m3
// embed() 를 순차 호출하는 것을 별도로 확인했고(1 MiB 는 청크 수가 많아 저장에
// 70초 이상 소요, embed 1회 약 7초 x 청크 수), 이 지연은 body-limit 실측과
// 무관한 저장 파이프라인의 정상 특성이다. 30 KiB 는 (1) 정상 단발 호출(수백
// byte~수 KiB)보다 명백히 크고 (2) 8 MiB 한도 대비 압도적으로 작아 "한도 안에서
// 안 잘림"을 검증하는 목적에 충분하다. body-limit 미들웨어 자체는 크기와 무관하게
// byte 만 검사하며, 3 MiB 페이로드가 25ms 안에 통과함을 별도 프로브로 확인했다.

test(
  "(g) D-1 실측 (a) 통과 측 — content 30KiB(정상 도구 호출 규모 상회)가 8MiB 기본 한도 안에서 저장 성공",
  async () => {
    // 크기 선정 근거는 위 파일 헤더 주석 참조.
    const bigContent = "가".repeat(Math.floor((30 * 1024) / 3)); // 약 30 KiB(문자 3byte 가정)
    const res = await client.callTool(
      { name: "store_memory", arguments: { content: bigContent } },
      undefined,
      { timeout: 45_000 }, // 청킹+임베딩 누적 지연이 SDK 기본 60s 이내지만 여유를 둔다
    );
    const payload = toolResultJson(res);
    expect(payload.type).toBe("memory");
    expect(Number.isInteger(payload.id)).toBe(true);

    const node = await store.getNode(payload.id);
    expect(node).not.toBeNull();
    expect(node!.content).toBe(bigContent);
  },
  45_000,
);

test("(h) D-1 실측 (b) 차단 측 — maxTextBytes 1024 byte 로 좁힌 별도 harness에서 같은 호출이 413 으로 MCP 층 도달 전 차단", async () => {
  const narrowTmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-tools-narrow-"));
  const narrowSseTokens = new SseTokenStore(join(narrowTmpDir, "tokens.json"));
  const narrowToken = narrowSseTokens.issueToken("claude-code-narrow");

  const narrowOuter = new Hono({ strict: false });
  narrowOuter.use(
    "*",
    createAuthGate({
      sseTokens: narrowSseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  narrowOuter.use(
    "*",
    createBodyLimit(() => ({ maxTextBytes: 1024, maxAssetBytes: 1024 })),
  );
  const narrowInner = new Hono({ strict: false });
  const deps: MemoryApiDeps = {
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    eventBus,
  };
  registerMcpRoutes(narrowInner, deps);
  narrowOuter.route("/", narrowInner);
  const narrowServer = Bun.serve({ port: 0, fetch: narrowOuter.fetch });

  try {
    const narrowUrl = new URL(`http://127.0.0.1:${narrowServer.port}/mcp`);
    const narrowClient = new Client({ name: "test-client-narrow", version: "0.0.1" });
    const narrowTransport = new StreamableHTTPClientTransport(narrowUrl, {
      requestInit: { headers: { authorization: `Bearer ${narrowToken}` } },
    });

    const bigContent = "가".repeat(Math.floor((30 * 1024) / 3)); // 통과 측과 동일 규모(~30 KiB) — 1024 byte 한도라 도달 즉시 차단되므로 크기 자체는 결과에 영향 없음
    let threw = false;
    try {
      await narrowClient.connect(narrowTransport);
      await narrowClient.callTool({
        name: "store_memory",
        arguments: { content: bigContent },
      });
    } catch {
      // 413 은 SDK 클라이언트 관점에서 프로토콜/네트워크 오류로 표면화된다 —
      // connect 단계(initialize POST 도 body-limit 대상)나 callTool 단계 어느
      // 쪽에서 실패해도 "MCP 층 도달 전 차단" 판정에는 동일하게 부합한다.
      threw = true;
    }
    expect(threw).toBe(true);

    await narrowClient.close().catch(() => {});
  } finally {
    narrowServer.stop(true);
    rmSync(narrowTmpDir, { recursive: true, force: true });
  }
});

// ── T15 저장 관문 — store_memory 도 비밀값을 거부한다 ────────────────────────
// 테스트 값 관례: 비밀값은 명백한 가짜(EXAMPLE 채움) — 저장소 스캐너 오경보 방지.

test("(i) store_memory 에 비밀값 → SECRET_DETECTED + 값 비노출 + 저장 0", async () => {
  const fakeAws = "AKIAEXAMPLEEXAMPLE99";
  const before = (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;

  const res = await client.callTool({
    name: "store_memory",
    arguments: { content: `배포 키 ${fakeAws} 를 기록해둔다` },
  });

  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as {
    code: string;
    details: { patternName: string; matchLength: number };
  };
  expect(body.code).toBe("SECRET_DETECTED");
  expect(body.details.patternName).toBe("aws-access-key-id");
  expect(JSON.stringify(body)).not.toContain(fakeAws);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n,
  ).toBe(before);
});

// ── T16 유사-중복 차단 — store_memory (결정 D-A) ─────────────────────────────

const T16_ORIGINAL = "배포는 매주 화요일 오후 3시에 하기로 정했다.";
const T16_NEAR = "배포는 매주 화요일 오후 3시에 진행하기로 했다.";

test("(j) store_memory 유사-중복 → DUPLICATE + 기존 기억 id·발췌 + 저장 0", async () => {
  const first = await client.callTool({
    name: "store_memory",
    arguments: { content: T16_ORIGINAL },
  });
  const firstId = toolResultJson(first).id as number;
  const before = (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;

  const res = await client.callTool({
    name: "store_memory",
    arguments: { content: T16_NEAR },
  });

  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as {
    code: string;
    message: string;
    details: {
      existingId: number;
      similarity: number;
      excerpt: string;
      existingCreatedAt: string;
    };
  };
  expect(body.code).toBe("DUPLICATE");
  expect(body.details.existingId).toBe(firstId);
  expect(body.details.similarity).toBeGreaterThanOrEqual(0.89);
  expect(body.details.excerpt).toContain("화요일");
  expect(body.details.existingCreatedAt.length).toBeGreaterThan(0);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n,
  ).toBe(before);
});

test("(j-2) store_memory force:true → 유사-중복이어도 저장된다", async () => {
  await client.callTool({ name: "store_memory", arguments: { content: T16_ORIGINAL } });
  const res = await client.callTool({
    name: "store_memory",
    arguments: { content: T16_NEAR, force: true },
  });
  expect(res.isError).not.toBe(true);
  expect(Number.isInteger(toolResultJson(res).id)).toBe(true);
});

test("(j-3) store_memory 정확 재입력은 DUPLICATE 가 아니라 흡수(cacheHit) — 게이트 순서", async () => {
  const first = await client.callTool({
    name: "store_memory",
    arguments: { content: T16_ORIGINAL },
  });
  const firstId = toolResultJson(first).id as number;

  const res = await client.callTool({
    name: "store_memory",
    arguments: { content: T16_ORIGINAL },
  });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(body.cacheHit).toBe(true);
  expect(body.id).toBe(firstId);
});

// ── T25 folded-in — search_memory(responseMode:"index") → get_memory(ids) MCP 표면 왕복 ──
//
// T21(spec C)의 2단계 검색은 지금까지 REST 층(search-index-mode.test.ts)과 각 도구
// 단위(search_memory 단독·get_memory 단독)로만 검증돼 있었다 — 두 MCP 도구를 실제로
// 이어 부르는 왕복 자체는 한 번도 확인된 적이 없다. index 회신의 id 가 get_memory 에
// 그대로 먹히지 않으면(치환 규칙 어긋남 등) 이 왕복이 조용히 깨질 수 있어 회귀 검증으로
// 남긴다.
test("(k) search_memory(responseMode:index) → get_memory(ids) MCP 표면 왕복 — 같은 기억이 순서·oneLine 접두 그대로 되돌아옴", async () => {
  // 유사-중복 검사(T16)에 걸리지 않도록 서로 뚜렷이 다른 두 문장을 쓴다 —
  // 왕복 계약 자체를 보는 테스트라 저장 성공이 전제 조건이다.
  const contents = [
    "색인왕복검증표식 커피는 하루 두 잔까지만 마신다",
    "색인왕복검증표식 화요일마다 자전거로 출근한다",
  ];
  for (const content of contents) {
    const stored = await client.callTool({ name: "store_memory", arguments: { content } });
    expect(stored.isError).not.toBe(true);
  }

  const searchRes = await client.callTool({
    name: "search_memory",
    arguments: { query: "색인왕복검증표식", responseMode: "index" },
  });
  expect(searchRes.isError).not.toBe(true);
  const searchBody = toolResultJson(searchRes) as {
    responseMode: string;
    results: Array<{ id: number; oneLine: string }>;
  };
  expect(searchBody.responseMode).toBe("index");
  expect(searchBody.results.length).toBeGreaterThanOrEqual(2);

  const ids = searchBody.results.map((r) => r.id);
  const getRes = await client.callTool({ name: "get_memory", arguments: { ids } });
  expect(getRes.isError).not.toBe(true);
  const getBody = toolResultJson(getRes) as {
    memories: Array<{ id: number; content: string }>;
    notFound: number[];
  };

  // 순서 보존 — index 결과 순서 그대로 get_memory 가 되돌린다.
  expect(getBody.memories.map((m) => m.id)).toEqual(ids);
  // notFound 정직 — index 가 내놓은 id 는 전부 조회 가능해야 한다(약속 위반 0건).
  expect(getBody.notFound).toEqual([]);
  // oneLine 은 본문의 절단분이다 — get_memory 로 받은 실제 본문이 그 접두를 포함해야
  // index 회신이 거짓 미리보기를 주지 않았다는 근거가 된다(TRUNCATION_SUFFIX 제거 후 대조).
  for (let i = 0; i < searchBody.results.length; i++) {
    const oneLine = searchBody.results[i]!.oneLine;
    const fullContent = getBody.memories[i]!.content;
    const oneLineCore = oneLine.endsWith("…") ? oneLine.slice(0, -1) : oneLine;
    expect(fullContent.startsWith(oneLineCore)).toBe(true);
  }
});
