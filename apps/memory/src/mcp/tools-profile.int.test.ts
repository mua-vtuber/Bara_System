/**
 * mcp/tools-profile.int.test.ts — get_profile 도구 통합 검증 (T25 / spec H).
 *
 * 실 bge-m3 + 실 SqliteMemoryStore + Bun.serve + SDK StreamableHTTPClientTransport
 * (tools-doctor.int.test.ts harness 재사용). facet 분류 로직 자체는
 * server-internal/profile.test.ts 권위 — 여기서는 도구 표면(등록·인자 스키마·
 * isError·결과 JSON 형태)과 REST GET /profile 과의 parity, save_preference 의
 * facet 저장 → get_profile 조회 왕복에 초점을 둔다.
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
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import type { ProfileResponse } from "../server-internal/profile.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerProfileRoutes } from "../server-internal/routes/profile.ts";
import { registerMcpRoutes } from "./server.ts";
import { GLOBAL_READ_SCOPE, SCOPE_NOTE_WHEN_ABSENT } from "../memory/project-scope-resolver.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let tmpDir: string;
let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-profile-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  deps = {
    store,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
  };
});

afterEach(async () => {
  await client.close();
  server.stop(true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function connectClient(inner: Hono): Promise<void> {
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
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });

  const mcpUrl = new URL(`http://127.0.0.1:${server.port}/mcp`);
  client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
}

function toolResultJson(res: Awaited<ReturnType<Client["callTool"]>>): ProfileResponse {
  const content = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as ProfileResponse;
}

test("get_profile — 선호 0건이면 isError 없이 { facets: {}, note } 회신", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const res = await client.callTool({ name: "get_profile", arguments: {} });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(body).toEqual({
    facets: {}, note: "no preferences stored yet",
    // 범위 없이 부르면 프로젝트 없는 기억만 본다는 사실과 적용 범위를 함께 싣는다(2026-10-21 spec 10.4).
    scope: GLOBAL_READ_SCOPE, scopeNote: SCOPE_NOTE_WHEN_ABSENT,
  });
});

test("get_profile — 유효하지 않은 facet 값은 스키마 자체가 거부(SDK 입력 검증 에러, isError true)", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const res = await client.callTool({ name: "get_profile", arguments: { facet: "존재하지않는facet" } });
  expect(res.isError).toBe(true);
  const content = res.content as Array<{ type: string; text: string }>;
  expect(content[0]!.text).toContain("Invalid arguments for tool get_profile");
});

test("save_preference(facet) → get_profile(facet) 왕복 — 저장한 facet 아래 그대로 조회됨", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const saveRes = await client.callTool({
    name: "save_preference",
    arguments: { content: "코드 리뷰는 항상 한글로 작성한다", facet: "communication" },
  });
  expect(saveRes.isError).not.toBe(true);

  const profileRes = await client.callTool({ name: "get_profile", arguments: { facet: "communication" } });
  const body = toolResultJson(profileRes);
  expect(body.facets.communication).toHaveLength(1);
  expect(body.facets.communication![0]!.content).toBe("코드 리뷰는 항상 한글로 작성한다");
});

test("save_preference — facet 미지정 저장분은 get_profile 에서 unclassified 로 조회됨", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  await client.callTool({
    name: "save_preference",
    arguments: { content: "facet 없이 저장한 선호" },
  });

  const profileRes = await client.callTool({ name: "get_profile", arguments: {} });
  const body = toolResultJson(profileRes);
  expect(body.facets.unclassified).toHaveLength(1);
  expect(body.facets.unclassified![0]!.content).toBe("facet 없이 저장한 선호");
});

test("save_decision 등 나머지 3종은 facet 입력 칸 자체가 스키마에 없음(거짓 손잡이 방지)", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const { tools } = await client.listTools();
  const saveDecision = tools.find((t) => t.name === "save_decision");
  expect(saveDecision).toBeDefined();
  const props = (saveDecision!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  expect("facet" in props).toBe(false);

  const savePreference = tools.find((t) => t.name === "save_preference");
  const prefProps = (savePreference!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  expect("facet" in prefProps).toBe(true);
});

test("REST GET /profile 와 MCP get_profile — 같은 deps 에서 동일 facets 구성", async () => {
  await store.addNode({
    content: "테스트 실패 시 즉시 원인부터 파악한다",
    memoryType: "preference",
    metadata: { facet: "workflow" },
  });

  // REST — registerProfileRoutes 를 직접 마운트(인증 게이트 없이 내부 함수 표면만 확인).
  const restApp = new Hono({ strict: false });
  registerProfileRoutes(restApp, deps);
  const restRes = await restApp.request("/profile");
  const restBody = (await restRes.json()) as ProfileResponse;

  // MCP — 같은 deps 로 도구 호출.
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);
  const mcpRes = await client.callTool({ name: "get_profile", arguments: {} });
  const mcpBody = toolResultJson(mcpRes);

  expect(mcpBody).toEqual(restBody);
});

test("get_profile — tools/list 에 readOnlyHint/idempotentHint true 로 노출", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "get_profile");
  expect(tool).toBeDefined();
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  expect(tool?.annotations?.idempotentHint).toBe(true);
});
