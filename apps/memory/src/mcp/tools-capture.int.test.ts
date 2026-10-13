/**
 * mcp/tools-capture.int.test.ts — 능동 저장 4종 통합 검증 (MCP plan T6).
 *
 * 실 bge-m3 + 실 SqliteMemoryStore + Bun.serve + SDK StreamableHTTPClientTransport
 * (tools-memory.int.test.ts T4 harness 재사용). outer Hono(createAuthGate) 로
 * 인증 게이트를 실제로 태워 adapterId 전파(spec 7.3)까지 검증한다.
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
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { EventRepository, type EventRecord } from "../db/store-internal/event-repository.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { EVENT_TYPES, EventBus } from "../server-internal/event-bus.ts";
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
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-capture-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
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
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });

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

test("(a) tools/list 에 능동 저장 4종 이름 포함", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain("save_decision");
  expect(names).toContain("save_idea");
  expect(names).toContain("save_question");
  expect(names).toContain("save_preference");
});

test("(b) save_decision → { id, tag: '결정' } + author adapterId + memoryType fact", async () => {
  const res = await client.callTool({
    name: "save_decision",
    arguments: { content: "구독 CLI AI 로 정리한다" },
  });
  const payload = toolResultJson(res);
  expect(Number.isInteger(payload.id)).toBe(true);
  expect(payload.tag).toBe("결정");

  const node = await store.getNode(payload.id);
  expect(node).not.toBeNull();
  expect(node!.metadata?.tags).toContain("결정");
  expect(node!.author).toBe("claude-code");
  expect(node!.memoryType).toBe("fact");
});

test("(b-2) save_decision 성공 시 REST 와 같은 조건으로 GRAPH_CHANGED 를 emit 한다", async () => {
  await client.callTool({
    name: "save_decision",
    arguments: { content: "GRAPH_CHANGED emit 검증용 결정" },
  });

  const graphChangedEvents = receivedEvents.filter(
    (e) => e.type === EVENT_TYPES.GRAPH_CHANGED,
  );
  expect(graphChangedEvents.length).toBeGreaterThanOrEqual(1);
  expect(graphChangedEvents[0]!.payload).toEqual({ reason: "memory-added" });
});

test("(c) save_idea → tag 아이디어 + memoryType insight", async () => {
  const res = await client.callTool({
    name: "save_idea",
    arguments: { content: "대시보드에 태그 필터를 추가하면 좋겠다" },
  });
  const payload = toolResultJson(res);
  expect(payload.tag).toBe("아이디어");

  const node = await store.getNode(payload.id);
  expect(node!.metadata?.tags).toContain("아이디어");
  expect(node!.memoryType).toBe("insight");
});

test("(c-2) save_preference → tag 선호 + memoryType preference", async () => {
  const res = await client.callTool({
    name: "save_preference",
    arguments: { content: "커밋 메시지는 한글로 작성해달라" },
  });
  const payload = toolResultJson(res);
  expect(payload.tag).toBe("선호");

  const node = await store.getNode(payload.id);
  expect(node!.metadata?.tags).toContain("선호");
  expect(node!.memoryType).toBe("preference");
});

test("(c-3) save_question → tag 질문 + memoryType 저장 기본값(도구가 memoryType 인자 미전달)", async () => {
  const plain = await client.callTool({
    name: "store_memory",
    arguments: { content: "질문 기본값 비교용 store_memory 글" },
  });
  const plainPayload = toolResultJson(plain);
  const plainNode = await store.getNode(plainPayload.id);

  const res = await client.callTool({
    name: "save_question",
    arguments: { content: "다음 배포는 언제 하는 게 좋을까" },
  });
  const payload = toolResultJson(res);
  expect(payload.tag).toBe("질문");

  const node = await store.getNode(payload.id);
  expect(node!.metadata?.tags).toContain("질문");
  // memoryType 인자를 넘기지 않았으므로 store_memory(무인자)와 같은 저장 기본값이어야 한다.
  expect(node!.memoryType).toBe(plainNode!.memoryType);
});

test("(d) project 인자 전달 시 노드 projectId 반영", async () => {
  const res = await client.callTool({
    name: "save_decision",
    arguments: { content: "프로젝트 스코프 결정 테스트", project: "bara" },
  });
  const payload = toolResultJson(res);
  const node = await store.getNode(payload.id);
  expect(node!.projectId).toBe("bara");
});

// ── T15 저장 관문 — 능동 저장 4종도 도구별 면제 없이 같은 관문을 지난다 ──────
// 테스트 값 관례: 비밀값은 명백한 가짜(x 반복 채움) — 저장소 스캐너 오경보 방지.

test("(e) save_preference 에 비밀값 → SECRET_DETECTED + 값 비노출 + 저장 0", async () => {
  const fakeToken = `ghp_${"x".repeat(36)}`;
  const before = (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;

  const res = await client.callTool({
    name: "save_preference",
    arguments: { content: `내 배포 토큰은 ${fakeToken} 으로 쓴다` },
  });

  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as {
    code: string;
    message: string;
    details: { patternName: string; matchLength: number };
  };
  expect(body.code).toBe("SECRET_DETECTED");
  expect(body.details.patternName).toBe("github-token");
  expect(body.details.matchLength).toBe(fakeToken.length);
  // 회신 어디에도 값 자체가 없다.
  expect(JSON.stringify(body)).not.toContain(fakeToken);
  // 저장은 한 건도 일어나지 않았다.
  expect(
    (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n,
  ).toBe(before);
});

test("(f) 비밀값 없는 save_preference 는 그대로 저장된다(오탐 0)", async () => {
  const res = await client.callTool({
    name: "save_preference",
    arguments: { content: "API key 는 설정 파일이 아니라 환경변수로 두는 걸 선호한다" },
  });
  expect(res.isError).not.toBe(true);
  expect(Number.isInteger(toolResultJson(res).id)).toBe(true);
});

// ── (g) T16 유사-중복 차단 (결정 D-A) ────────────────────────────────────────
//
// 문장 쌍은 T14 실측 갈래를 따른다 — "진짜 중복(verbatim 변형)"은 0.89 위,
// "관련-비중복"은 아래. 실측 여유가 커 q8 수치 흔들림에 흔들리지 않는다.
const DUP_ORIGINAL = "배포는 매주 화요일 오후 3시에 하기로 정했다.";
const DUP_NEAR = "배포는 매주 화요일 오후 3시에 진행하기로 했다.";

test("(g1) save_decision 유사-중복 → isError + DUPLICATE + 기존 기억 정보", async () => {
  const first = await client.callTool({
    name: "save_decision",
    arguments: { content: DUP_ORIGINAL },
  });
  const firstId = toolResultJson(first).id as number;
  const before = (
    db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
  ).n;

  const res = await client.callTool({
    name: "save_decision",
    arguments: { content: DUP_NEAR },
  });

  expect(res.isError).toBe(true);
  const body = toolResultJson(res) as {
    code: string;
    details: { existingId: number; similarity: number; excerpt: string };
  };
  expect(body.code).toBe("DUPLICATE");
  expect(body.details.existingId).toBe(firstId);
  expect(body.details.similarity).toBeGreaterThanOrEqual(0.89);
  expect(body.details.excerpt).toContain("화요일");
  // 저장은 일어나지 않았다.
  expect(
    (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n,
  ).toBe(before);
});

test("(g2) save_decision force:true → 닮았어도 저장된다", async () => {
  await client.callTool({ name: "save_decision", arguments: { content: DUP_ORIGINAL } });
  const res = await client.callTool({
    name: "save_decision",
    arguments: { content: DUP_NEAR, force: true },
  });
  expect(res.isError).not.toBe(true);
  expect(Number.isInteger(toolResultJson(res).id)).toBe(true);
});

test("(g3) save_preference 는 검사 제외 — 닮은 선호도 그대로 저장된다(반복이 신호)", async () => {
  const first = await client.callTool({
    name: "save_preference",
    arguments: { content: DUP_ORIGINAL },
  });
  const firstId = toolResultJson(first).id as number;

  // 같은 쌍이 save_decision 에서는 (g1) 처럼 막히지만, 선호는 막히지 않는다.
  const res = await client.callTool({
    name: "save_preference",
    arguments: { content: DUP_NEAR },
  });
  expect(res.isError).not.toBe(true);
  const secondId = toolResultJson(res).id as number;
  expect(secondId).not.toBe(firstId);
});

test("(g4) save_preference 입력 스키마에 force 칸이 없다(검사를 안 도니 우회할 것도 없음)", async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const pref = byName.get("save_preference")!;
  const decision = byName.get("save_decision")!;
  const prefProps = (pref.inputSchema as { properties?: Record<string, unknown> })
    .properties ?? {};
  const decisionProps = (decision.inputSchema as { properties?: Record<string, unknown> })
    .properties ?? {};
  expect(Object.keys(prefProps)).not.toContain("force");
  expect(Object.keys(decisionProps)).toContain("force");
});
