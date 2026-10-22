/**
 * mcp/tools-guide.int.test.ts — get_usage_guide 도구(2026-10-21 spec 12.1·12.3, B-T4).
 *
 * 실제 bge-m3 + 실제 SQLite + 실제 SDK 클라이언트 + 실제 인증 게이트(mock 없음). 사슬 기억을 실제 저장
 * 도구로 저장한 뒤 분류 뿌리·자식, 프로젝트 번호·이름·옛 글자값이 응답에 실리는지 본다. 상한 확인용
 * 개념·위계 줄은 데이터 fixture 로 표에 직접 넣는다(저장 경로를 흉내 내는 가짜 구현이 아니다).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { SseTokenStore, type TokenScope } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { CLASSIFICATION_VOCABULARY_LIMITS, type ClassificationVocabulary } from "../server-internal/classification-vocabulary.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { buildBaraMcpServer, registerMcpRoutes } from "./server.ts";
import { McpUsageRecorder } from "./usage-recorder.ts";
import { buildUsageGuideText } from "./usage-guide.ts";

let embedder: Bgem3Embedder;
let tmpDir: string;
let db: Database;
let store: SqliteMemoryStore;
let server: ReturnType<typeof Bun.serve>;
let tokens: SseTokenStore;
const clients: Client[] = [];

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-guide-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  tokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const app = new Hono({ strict: false });
  app.use("*", createAuthGate({
    sseTokens: tokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  registerMcpRoutes(app, { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  server.stop(true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function connect(scope: TokenScope = "mcp-standard"): Promise<Client> {
  const client = new Client({ name: "guide-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.issueToken(`guide-${scope}`, undefined, undefined, scope)}` } },
  }));
  clients.push(client);
  return client;
}

type GuideResponse = ClassificationVocabulary & { guide: string };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { error: result.isError === true, data: JSON.parse(text) };
}

test("실제 사슬 저장 → 분류 뿌리·자식과 프로젝트 번호·이름·옛 글자값이 실린다", async () => {
  const client = await connect();
  for (const content of [
    "#프로젝트:코딩, #코딩:bara_system, 배포는 deploy:a1 하나로 한다",
    "#일상:건강, 오늘 30분 걸었다",
  ]) expect((await call(client, "store_memory", { content, force: true })).error).toBe(false);
  expect((await call(client, "store_memory", { content: "git push 는 A1 에 영향이 없다", project: "bara_system", force: true })).error).toBe(false);
  expect((await call(client, "store_memory", { content: "옛 글자값으로만 남은 메모", project: "옛값", force: true })).error).toBe(false);

  const res = await call(client, "get_usage_guide");
  expect(res.error).toBe(false);
  const body = res.data as GuideResponse;
  expect(body.guide).toBe(buildUsageGuideText("mcp-standard"));
  expect(body.limits).toEqual({ ...CLASSIFICATION_VOCABULARY_LIMITS });

  const roots = new Map(body.classifications.roots.map((root) => [root.name, root.children.map((c) => c.name)]));
  expect(roots.get("프로젝트")).toContain("코딩");
  expect(roots.get("일상")).toContain("건강");
  expect(roots.has("코딩")).toBe(false); // 다른 분류의 자식은 뿌리가 아니다.
  expect(body.classifications.truncated).toBe(false);

  const project = await store.findProjectByName("bara_system");
  expect(body.projects.values).toContainEqual({
    projectId: project!.projectId, name: "bara_system", aliases: [], legacyValues: ["bara_system"], memories: 2,
  });
  expect(body.projects.values).toContainEqual({ projectId: null, name: "옛값", aliases: [], legacyValues: [], memories: 1 });
  expect(body.projects.truncated).toBe(false);
});

test("빈 DB → 빈 배열(오류 아님)", async () => {
  const body = (await call(await connect(), "get_usage_guide")).data as GuideResponse;
  expect(body.classifications).toEqual({ roots: [], truncated: false });
  expect(body.projects).toEqual({ values: [], truncated: false });
});

test("상한을 넘으면 잘라서 싣고 truncated 를 켠다", async () => {
  const limits = CLASSIFICATION_VOCABULARY_LIMITS;
  const insertConcept = db.query(`INSERT INTO concept_nodes (concept_id, name, is_classification_key, classification_usage_count)
    VALUES (?, ?, ?, ?)`);
  for (let i = 0; i <= limits.roots; i += 1) insertConcept.run(`cpt_root_${i}`, `뿌리${i}`, 1, 100 - i);
  const insertEdge = db.query(`INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance)
    VALUES ('concept', 'cpt_root_0', 'concept', ?, 'parent_of', 'user')`);
  for (let i = 0; i <= limits.childrenPerRoot; i += 1) {
    insertConcept.run(`cpt_child_${i}`, `자식${i}`, 0, 1);
    insertEdge.run(`cpt_child_${i}`);
  }
  for (let i = 0; i <= limits.projects; i += 1) await store.findOrCreateProject({ name: `프로젝트${i}` });

  const body = (await call(await connect(), "get_usage_guide")).data as GuideResponse;
  expect(body.classifications.roots).toHaveLength(limits.roots);
  expect(body.classifications.roots[0]!.name).toBe("뿌리0");
  expect(body.classifications.roots[0]!.children).toHaveLength(limits.childrenPerRoot);
  expect(body.classifications.truncated).toBe(true);
  expect(body.projects.values).toHaveLength(limits.projects);
  expect(body.projects.truncated).toBe(true);
});

test("읽기 전용 토큰도 부를 수 있고 읽기 전용 안내를 받는다", async () => {
  const client = await connect("read-only");
  const listed = (await client.listTools()).tools.map((t) => t.name);
  expect(listed).toContain("get_usage_guide");
  const body = (await call(client, "get_usage_guide")).data as GuideResponse;
  expect(body.guide).toBe(buildUsageGuideText("read-only"));
  expect(Array.isArray(body.projects.values)).toBe(true);
});

test("저장소가 주입되지 않으면 도구 오류 INTERNAL — 빈 목록으로 가리지 않는다", async () => {
  const usage = new McpUsageRecorder(() => db);
  const bare = buildBaraMcpServer({ deps: {} as unknown as MemoryApiDeps, adapterId: "t", scope: "full", usage });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bare.connect(serverTransport);
  const client = new Client({ name: "t", version: "0.0.1" });
  await client.connect(clientTransport);
  clients.push(client);
  const res = await call(client, "get_usage_guide");
  expect(res.error).toBe(true);
  expect(res.data.code).toBe("INTERNAL");
  expect(res.data.message).toContain("deps.store");
});
