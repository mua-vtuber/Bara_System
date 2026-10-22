/**
 * mcp/project-scope-regression.int.test.ts — 실운영 관찰 재현 회귀 (2026-10-21 spec 3.3·C-T3).
 *
 * 관찰: recall_context {projectId:"bara_system"} 가 project_id 가 글자 그대로 "bara_system"
 * 인 기억(#83·#85·#86)만 돌려주고, 해시태그 사슬로 저장돼 project_id 가 프로젝트 번호
 * (prj_…)인 기억(#71·#64·#82)을 빠뜨렸다.
 *
 * 같은 상황을 실제 저장 경로(MCP store_memory·save_preference)로 만든다:
 *   (a) "#프로젝트:코딩, #코딩:bara_system, …" 사슬 기억 3개 → project_id = prj_…
 *   (b) project:"bara_system" 인자 기억 3개 → project_id = "bara_system"(옛 글자값)
 *   (c) 전역 기억
 * 그리고 범위를 받는 MCP 읽기 도구 4종이 같은 해석을 쓰는지 본다.
 * 실제 bge-m3 + 실제 SQLite + 실제 SDK 클라이언트 + 실제 인증 게이트(mock 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerMcpRoutes } from "./server.ts";
import { GLOBAL_READ_SCOPE, PROJECT_SCOPE_MESSAGES, SCOPE_NOTE_WHEN_ABSENT } from "../memory/project-scope-resolver.ts";

const PROJECT = "bara_system";
const QUERY = "bara_system 배포 방법";
/** (a) 사슬 기억 본문 — 글자값 기억과 겹치지 않게 서로 다른 배포 사실을 적는다. */
const CHAIN_BODIES = [
  "배포는 저장소 루트에서 bun run deploy:a1 한 가지로 한다",
  "배포 전에 커밋하지 않은 변경이 있으면 deploy:a1 이 거부한다",
  "배포 뒤 bara-pet-memory 서비스가 재시작되고 실패하면 되돌린다",
];
const LEGACY_BODIES = [
  "bara_system 배포 방법: git push 는 A1 에 영향이 없다",
  "bara_system 배포 방법: 디스코드 봇은 --adapter discord 로 따로 올린다",
  "bara_system 배포 방법: 펫 새 버전을 설치하면 서버도 같은 버전으로 오른다",
];

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bara-scope-regression-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  const tokens = new SseTokenStore(join(dir, "tokens.json"));
  const app = new Hono({ strict: false });
  app.use("*", createAuthGate({
    sseTokens: tokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  registerMcpRoutes(app, { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  client = new Client({ name: "scope-regression", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.issueToken("claude-code")}` } },
  }));
});
afterEach(async () => {
  await client.close();
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { error: result.isError === true, data: JSON.parse(content[0]!.text) };
}

async function storeMemory(args: Record<string, unknown>): Promise<number> {
  const saved = await call("store_memory", { force: true, ...args });
  expect(saved.error).toBe(false);
  expect(saved.data.type).toBe("memory");
  return saved.data.id as number;
}

interface Seeded {
  projectId: string;
  chain: number[];
  legacy: number[];
  global: number;
}

/** 실운영과 같은 두 모양의 프로젝트 기억 + 전역 기억을 실제 저장 도구로 만든다. */
async function seed(): Promise<Seeded> {
  const chain: number[] = [];
  for (const body of CHAIN_BODIES) chain.push(await storeMemory({ content: `#프로젝트:코딩, #코딩:${PROJECT}, ${body}` }));
  const legacy: number[] = [];
  for (const body of LEGACY_BODIES) legacy.push(await storeMemory({ content: body, project: PROJECT }));
  const global = await storeMemory({ content: "배포 방법 메모는 날짜와 함께 남긴다(프로젝트 무관 전역 규칙)" });

  const project = await store.findProjectByName(PROJECT);
  expect(project).not.toBeNull();
  // 전제 확인: 사슬 기억은 프로젝트 번호로, 인자 기억은 글자값으로 저장됐다(관찰과 같은 데이터 모양).
  for (const id of chain) expect((await store.getNode(id))!.projectId).toBe(project!.projectId);
  for (const id of legacy) expect((await store.getNode(id))!.projectId).toBe(PROJECT);
  expect((await store.getNode(global))!.projectId).toBeNull();
  return { projectId: project!.projectId, chain, legacy, global };
}

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
const idsOf = (memories: Array<{ id: number }>) => sorted(memories.map((m) => m.id));

test("recall_context — 프로젝트 이름 범위가 사슬 기억과 옛 글자값 기억을 모두 본다", async () => {
  const seeded = await seed();
  const both = sorted([...seeded.chain, ...seeded.legacy]);

  const projectOnly = await call("recall_context", {
    query: QUERY, scope: { projectId: PROJECT, includeGlobal: false }, budget: 8000, limit: 50,
  });
  expect(projectOnly.error).toBe(false);
  expect(idsOf(projectOnly.data.memories)).toEqual(both);
  expect(projectOnly.data.scope).toEqual({
    projectIds: [seeded.projectId, PROJECT], includeGlobal: false,
    requested: PROJECT, resolvedFrom: "project_name", projectName: PROJECT,
  });
  expect("scopeNote" in projectOnly.data).toBe(false);

  // includeGlobal 기본값(true) — 전역 기억이 함께 든다.
  const withGlobal = await call("recall_context", { query: QUERY, scope: { projectId: PROJECT }, budget: 8000, limit: 50 });
  expect(idsOf(withGlobal.data.memories)).toEqual(sorted([...both, seeded.global]));

  // 정확한 prj_ 번호도 같은 여섯 개.
  const byId = await call("recall_context", {
    query: QUERY, scope: { projectId: seeded.projectId, includeGlobal: false }, budget: 8000, limit: 50,
  });
  expect(idsOf(byId.data.memories)).toEqual(both);
  expect(byId.data.scope.resolvedFrom).toBe("project_id");
});

test("recall_context — 범위 없음은 기존대로 전역 기억만 + scopeNote, 오타 이름은 UNKNOWN_PROJECT", async () => {
  const seeded = await seed();
  const unscoped = await call("recall_context", { query: QUERY, budget: 8000, limit: 50 });
  expect(unscoped.error).toBe(false);
  expect(idsOf(unscoped.data.memories)).toEqual([seeded.global]);
  expect(unscoped.data.scope).toEqual(GLOBAL_READ_SCOPE);
  expect(unscoped.data.scopeNote).toBe(SCOPE_NOTE_WHEN_ABSENT);

  const typo = await call("recall_context", { query: QUERY, scope: { projectId: "bara_systm" } });
  expect(typo.error).toBe(true);
  expect(typo.data).toEqual({
    code: "UNKNOWN_PROJECT", message: PROJECT_SCOPE_MESSAGES.UNKNOWN_PROJECT("bara_systm"),
    details: { value: "bara_systm" },
  });
});

test("search_memory·list_recent — 같은 해석(appliedScope·scope), 오타는 오류", async () => {
  const seeded = await seed();
  const both = sorted([...seeded.chain, ...seeded.legacy]);

  const searched = await call("search_memory", {
    query: QUERY, scope: { projectId: PROJECT }, responseMode: "index", limit: 50,
  });
  expect(searched.error).toBe(false);
  expect(searched.data.appliedScope.projectIds).toEqual([seeded.projectId, PROJECT]);
  expect(idsOf(searched.data.results)).toEqual(both);

  // 범위 없는 search_memory 는 기존대로 거르지 않고, appliedScope 칸도 없다.
  const unscoped = await call("search_memory", { query: QUERY, responseMode: "index", limit: 50 });
  expect("appliedScope" in unscoped.data).toBe(false);
  expect(idsOf(unscoped.data.results)).toEqual(sorted([...both, seeded.global]));

  const recent = await call("list_recent", { scope: { projectId: PROJECT }, limit: 50 });
  expect(recent.error).toBe(false);
  expect(idsOf(recent.data.memories)).toEqual(both);
  expect(recent.data.scope.resolvedFrom).toBe("project_name");

  for (const [tool, args] of [
    ["search_memory", { query: QUERY, scope: { projectId: "bara_systm" } }],
    ["list_recent", { scope: { projectId: "bara_systm" } }],
  ] as const) {
    const failed = await call(tool, args);
    expect(failed.error).toBe(true);
    expect(failed.data.code).toBe("UNKNOWN_PROJECT");
    expect(failed.data.details).toEqual({ value: "bara_systm" });
  }
});

test("get_profile — 이름 범위가 사슬·글자값 선호를 모두 보고, 범위 없음은 전역 + scopeNote", async () => {
  const chainPref = await call("save_preference", {
    content: `#프로젝트:코딩, #코딩:${PROJECT}, 이 프로젝트 코드는 TypeScript 로만 쓴다`, facet: "stack",
  });
  const legacyPref = await call("save_preference", { content: "이 프로젝트 테스트는 bun test 로 돌린다", project: PROJECT, facet: "workflow" });
  const globalPref = await call("save_preference", { content: "설명은 쉬운 한국어로 한다", facet: "communication" });
  for (const saved of [chainPref, legacyPref, globalPref]) expect(saved.error).toBe(false);
  const project = await store.findProjectByName(PROJECT);
  expect((await store.getNode(chainPref.data.id))!.projectId).toBe(project!.projectId);

  const entryIds = (data: { facets: Record<string, Array<{ id: number }>> }) =>
    sorted(Object.values(data.facets).flat().map((entry) => entry.id));

  const scoped = await call("get_profile", { scope: { projectId: PROJECT } });
  expect(scoped.error).toBe(false);
  expect(entryIds(scoped.data)).toEqual(sorted([chainPref.data.id, legacyPref.data.id, globalPref.data.id]));
  expect(scoped.data.scope.projectIds).toEqual([project!.projectId, PROJECT]);
  expect("scopeNote" in scoped.data).toBe(false);

  const unscoped = await call("get_profile", {});
  expect(entryIds(unscoped.data)).toEqual([globalPref.data.id]);
  expect(unscoped.data.scopeNote).toBe(SCOPE_NOTE_WHEN_ABSENT);

  const typo = await call("get_profile", { scope: { projectId: "bara_systm" } });
  expect(typo.error).toBe(true);
  expect(typo.data.code).toBe("UNKNOWN_PROJECT");
});

test("애매한 별칭은 네 도구 모두 AMBIGUOUS_PROJECT(후보 포함)", async () => {
  const a = await store.findOrCreateProject({ name: "알파" });
  const b = await store.findOrCreateProject({ name: "베타" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  const scope = { projectId: "겹침" };
  for (const [tool, args] of [
    ["recall_context", { scope }], ["search_memory", { query: QUERY, scope }],
    ["list_recent", { scope }], ["get_profile", { scope }],
  ] as const) {
    const failed = await call(tool, args);
    expect(failed.error).toBe(true);
    expect(failed.data.code).toBe("AMBIGUOUS_PROJECT");
    expect(failed.data.details.value).toBe("겹침");
    expect(failed.data.details.candidates.map((c: { projectId: string }) => c.projectId).sort())
      .toEqual([a.projectId, b.projectId].sort());
  }
});
