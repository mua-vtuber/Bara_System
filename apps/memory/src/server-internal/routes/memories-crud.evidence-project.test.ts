/**
 * memories-crud.evidence-project.test.ts — REST POST /memories + evidence 의 근거 기억 프로젝트 검사
 * (2026-10-21 spec 20, E-T7). MCP 와 같은 검사(checkSharedMemoryInput)를 지나는지 실제 HTTP 로 확인한다.
 * 구성: Bun.serve + createAuthGate + buildMemoryApi + 실제 SQLite + 실제 bge-m3(mock 없음).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../../embedding/factory.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { buildMemoryApi } from "../../server.ts";
import { createAuthGate } from "../auth-gate.ts";

let embedder: Bgem3Embedder;
let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let server: ReturnType<typeof Bun.serve>;
let token: string;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-rest-evidence-project-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  const inner = buildMemoryApi({ store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  const sseTokens = new SseTokenStore(join(dir, "tokens.json"));
  token = sseTokens.issueToken("rest-writer", undefined, undefined, "full");
  const outer = new Hono({ strict: false });
  outer.use("*", createAuthGate({
    sseTokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });
});
afterEach(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function postMemory(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/memories`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ force: true, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

test("사슬 아이디어를 같은 사슬 결정의 근거로 → 201", async () => {
  const idea = await postMemory({ content: "#프로젝트:코딩, #코딩:bara_system, 아이디어", evidence: { assertionKind: "user_statement" } });
  expect(idea.status).toBe(201);
  const decision = await postMemory({
    content: "#프로젝트:코딩, #코딩:bara_system, 결정", evidence: { evidenceRefs: [idea.body.id] },
  });
  expect(decision.status).toBe(201);
  const project = await store.findProjectByName("bara_system");
  expect((await store.getNode(decision.body.id))!.projectId).toBe(project!.projectId);
});

test("다른 프로젝트 근거 → 400, 문구와 details 에 두 프로젝트", async () => {
  const idea = await postMemory({ content: "#프로젝트:코딩, #코딩:알파, 아이디어", evidence: { assertionKind: "user_statement" } });
  expect(idea.status).toBe(201);
  const res = await postMemory({ content: "#프로젝트:코딩, #코딩:베타, 결정", evidence: { evidenceRefs: [idea.body.id] } });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("INVALID_INPUT");
  expect(res.body.error).toContain('is in project "알파"');
  expect(res.body.error).toContain('saved in project "베타" (new project, from the #프로젝트 chain)');
  expect(res.body.details).toMatchObject({
    evidenceId: idea.body.id,
    evidenceProject: { projectId: (await store.findProjectByName("알파"))!.projectId, name: "알파" },
    memoryProject: { projectId: null, name: "베타", source: "chain" },
  });
});
