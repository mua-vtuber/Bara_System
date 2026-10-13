/**
 * mcp/tools-doctor.int.test.ts — bara_doctor 도구 통합 검증 (T23 / spec E).
 *
 * 실 bge-m3 + 실 SqliteMemoryStore + Bun.serve + SDK StreamableHTTPClientTransport
 * (tools-cleanup.int.test.ts harness 재사용). 단계별 진단 로직 자체는
 * server-internal/doctor.test.ts 권위 — 여기서는 도구 표면(등록·인자 0개·isError 0·
 * 결과 JSON 형태)과 REST GET /doctor 와의 parity 에 초점을 둔다.
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
import type { DoctorReport } from "../server-internal/doctor.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerDoctorRoutes } from "../server-internal/routes/doctor.ts";
import { registerMcpRoutes } from "./server.ts";

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
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-doctor-"));
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

function toolResultJson(res: Awaited<ReturnType<Client["callTool"]>>): DoctorReport {
  const content = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as DoctorReport;
}

test("bara_doctor — 인자 0개 호출, isError 없음, 8단계 응답", async () => {
  await store.addNode({ content: "진단용 글", sourceType: "user_explicit" });
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const res = await client.callTool({ name: "bara_doctor", arguments: {} });
  expect(res.isError).not.toBe(true);
  const body = toolResultJson(res);
  expect(body.stages.length).toBe(8);
  expect(body.stages.map((s) => s.name)).toEqual([
    "db",
    "embedder",
    "vecConsistency",
    "ftsConsistency",
    "imageVecConsistency",
    "cleanup",
    "backup",
    "disk",
  ]);
  expect(body.firstBlockingCause).toBeNull();
  expect(body.counters.knowledgeNodes).toBe(1);
});

test("bara_doctor — tools/list 에 readOnlyHint/idempotentHint true 로 노출", async () => {
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "bara_doctor");
  expect(tool).toBeDefined();
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  expect(tool?.annotations?.idempotentHint).toBe(true);
});

test("REST GET /doctor 와 MCP bara_doctor — 같은 deps 에서 동일 stages 이름·순서·firstBlockingCause", async () => {
  await store.addNode({ content: "정합 확인용 글", sourceType: "user_explicit" });

  // REST — registerDoctorRoutes 를 직접 마운트(인증 게이트 없이 내부 함수 표면만 확인).
  const restApp = new Hono({ strict: false });
  registerDoctorRoutes(restApp, deps);
  const restRes = await restApp.request("/doctor");
  const restBody = (await restRes.json()) as DoctorReport;

  // MCP — 같은 deps 로 도구 호출.
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  await connectClient(inner);
  const mcpRes = await client.callTool({ name: "bara_doctor", arguments: {} });
  const mcpBody = toolResultJson(mcpRes);

  expect(mcpBody.stages.map((s) => s.name)).toEqual(restBody.stages.map((s) => s.name));
  expect(mcpBody.stages.map((s) => s.healthy)).toEqual(restBody.stages.map((s) => s.healthy));
  expect(mcpBody.firstBlockingCause).toEqual(restBody.firstBlockingCause);
  expect(mcpBody.counters).toEqual(restBody.counters);
});
