/**
 * mcp/evidence-project.int.test.ts — 근거 기억(evidenceRefs)의 프로젝트 검사 (2026-10-21 spec 20, E-T1~E-T6).
 *
 * QA H1 재현: 안내가 말한 대로 사슬로 저장한 아이디어의 id 를 결정의 evidence.evidenceRefs 에 넣으면
 * "belongs to a different project" 로 실패했다. 검사가 project 인자만 보고, 사슬이 붙일 프로젝트와 묶음 C 의
 * "같은 프로젝트"(번호 + 같은 글자 옛 값)를 몰랐기 때문이다. 실제 bge-m3 + SQLite + SDK 클라이언트 + 인증 게이트.
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
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerMcpRoutes } from "./server.ts";

const CHAIN = "#프로젝트:코딩, #코딩:bara_system";

let embedder: Bgem3Embedder;
let tmpDir: string;
let db: Database;
let store: SqliteMemoryStore;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-evidence-project-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  const sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const app = new Hono({ strict: false });
  app.use("*", createAuthGate({
    sseTokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  registerMcpRoutes(app, { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  client = new Client({ name: "evidence-project", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${sseTokens.issueToken("claude-code")}` } },
  }));
});
afterEach(async () => {
  await client.close();
  server.stop(true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { error: result.isError === true, data: JSON.parse(text) };
}

async function saved(name: string, args: Record<string, unknown>): Promise<{ id: number; data: any }> {
  const res = await call(name, { force: true, ...args });
  expect(`${name}: ${res.error ? JSON.stringify(res.data) : "ok"}`).toBe(`${name}: ok`);
  return { id: res.data.id as number, data: res.data };
}

async function projectOf(id: number): Promise<string | null> {
  return (await store.getNode(id))!.projectId;
}

const codes = (data: { hashtagWarnings?: Array<{ code: string }> }) => (data.hashtagWarnings ?? []).map((w) => w.code);

test("E-T1 QA 재현: 사슬로 저장한 아이디어를 같은 사슬 결정의 근거로 → 성공, 둘 다 같은 prj_", async () => {
  const idea = await saved("save_idea", { content: `${CHAIN}, 배포를 한 명령으로 묶자는 아이디어` });
  const decision = await saved("save_decision", {
    content: `${CHAIN}, 배포는 deploy:a1 하나로 하기로 했다`, evidence: { evidenceRefs: [idea.id] },
  });
  const project = await store.findProjectByName("bara_system");
  expect(await projectOf(idea.id)).toBe(project!.projectId);
  expect(await projectOf(decision.id)).toBe(project!.projectId);
});

test("E-T2 같은 사슬 + project 인자(이름 또는 번호) → 성공, 덮어씀 경고 없음", async () => {
  const idea = await saved("save_idea", { content: `${CHAIN}, 아이디어 하나` });
  const project = await store.findProjectByName("bara_system");
  for (const argument of ["bara_system", project!.projectId]) {
    const decision = await saved("save_decision", {
      content: `${CHAIN}, 결정 (${argument})`, project: argument, evidence: { evidenceRefs: [idea.id] },
    });
    expect(codes(decision.data)).toEqual([]);
    expect(await projectOf(decision.id)).toBe(project!.projectId);
  }
});

test("E-T3 옛 글자값 근거: 기존 프로젝트로 붙는 사슬, 새로 만들어질 사슬 둘 다 성공", async () => {
  await store.findOrCreateProject({ name: "bara_system" });
  const legacy = await saved("store_memory", { content: "옛 방식으로 남긴 배포 메모", project: "bara_system" });
  expect(await projectOf(legacy.id)).toBe("bara_system");
  await saved("save_decision", { content: `${CHAIN}, 옛 메모를 근거로 한 결정`, evidence: { evidenceRefs: [legacy.id] } });

  const orphan = await saved("store_memory", { content: "아직 프로젝트 실체가 없는 메모", project: "새프로젝트" });
  expect(await store.findProjectByName("새프로젝트")).toBeNull();
  const decision = await saved("save_decision", {
    content: "#프로젝트:코딩, #코딩:새프로젝트, 새 프로젝트의 첫 결정", evidence: { evidenceRefs: [orphan.id] },
  });
  expect(await projectOf(decision.id)).toBe((await store.findProjectByName("새프로젝트"))!.projectId);
});

test("E-T4 진짜 다른 프로젝트 → INVALID_INPUT, 문구와 details 에 두 프로젝트 이름·번호", async () => {
  const idea = await saved("save_idea", { content: "#프로젝트:코딩, #코딩:알파, 알파 아이디어" });
  const beta = await saved("save_idea", { content: "#프로젝트:코딩, #코딩:베타, 베타 시작" });
  const alpha = (await store.findProjectByName("알파"))!.projectId;
  const betaId = (await store.findProjectByName("베타"))!.projectId;
  expect(await projectOf(beta.id)).toBe(betaId);
  const res = await call("save_decision", {
    content: "#프로젝트:코딩, #코딩:베타, 베타 결정", force: true, evidence: { evidenceRefs: [idea.id] },
  });
  expect(res.error).toBe(true);
  expect(res.data.code).toBe("INVALID_INPUT");
  expect(res.data.message).toBe(
    `evidence memory ${idea.id} is in project "알파" (${alpha}); this memory will be saved in project "베타" (${betaId}, from the #프로젝트 chain)`,
  );
  expect(res.data.details).toEqual({
    evidenceId: idea.id,
    evidenceProject: { projectId: alpha, name: "알파" },
    memoryProject: { projectId: betaId, name: "베타", source: "chain" },
  });
  // 양쪽이 같은 프로젝트로 적힌 오류는 묶음 판정 결함이다.
  expect(res.data.details.evidenceProject).not.toEqual({ projectId: betaId, name: "베타" });
});

test("E-T5 덮어씀: 기존 A 인자 + 사슬 B → B 로 저장 + PROJECT_ARGUMENT_OVERRIDDEN, A 근거는 실패", async () => {
  const projectA = await store.findOrCreateProject({ name: "에이" });
  const projectB = await store.findOrCreateProject({ name: "비" });
  const saving = await saved("store_memory", { content: "#프로젝트:코딩, #코딩:비, 인자는 에이", project: "에이" });
  expect(await projectOf(saving.id)).toBe(projectB.projectId);
  expect(codes(saving.data)).toEqual(["PROJECT_ARGUMENT_OVERRIDDEN"]);
  expect(saving.data.hashtagWarnings[0].readAs).toBe('project argument "에이" replaced by chain project "비"');

  const evidenceInA = await saved("store_memory", { content: "에이 프로젝트 메모", project: projectA.projectId });
  const res = await call("store_memory", {
    content: "#프로젝트:코딩, #코딩:비, 에이 근거 결정", project: "에이", force: true, evidence: { evidenceRefs: [evidenceInA.id] },
  });
  expect(res.error).toBe(true);
  expect(res.data.message).toContain("from the #프로젝트 chain");
  expect(res.data.details.memoryProject).toEqual({ projectId: projectB.projectId, name: "비", source: "chain" });
});

test("E-T6 전역 규칙 불변 + 사슬이 안 붙으면 project 인자 기준", async () => {
  const globalMemory = await saved("store_memory", { content: "프로젝트 무관 전역 규칙" });
  await saved("save_decision", { content: `${CHAIN}, 전역 근거 결정`, evidence: { evidenceRefs: [globalMemory.id] } });

  const projectMemory = await saved("save_idea", { content: `${CHAIN}, 프로젝트 아이디어` });
  const toGlobal = await call("save_decision", { content: "전역 결정", force: true, evidence: { evidenceRefs: [projectMemory.id] } });
  expect(toGlobal.error).toBe(true);
  expect(toGlobal.data.message).toContain("this memory will be saved with no project");
  expect(toGlobal.data.details.memoryProject).toEqual({ projectId: null, name: null, source: "none" });

  // 폴더에서 끝나는 사슬은 붙지 않으므로 project 인자로 판정한다.
  await saved("save_decision", {
    content: "#프로젝트:코딩, 폴더에서 끝난 사슬", project: "bara_system", evidence: { evidenceRefs: [projectMemory.id] },
  });
  const wrongArgument = await call("save_decision", {
    content: "#프로젝트:코딩, 폴더에서 끝난 사슬 2", project: "다른것", force: true, evidence: { evidenceRefs: [projectMemory.id] },
  });
  expect(wrongArgument.error).toBe(true);
  expect(wrongArgument.data.details.memoryProject.source).toBe("argument");

  // 애매한 이름도 붙지 않으므로 인자 기준.
  const a = await store.findOrCreateProject({ name: "알파2" });
  const b = await store.findOrCreateProject({ name: "베타2" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  await saved("save_decision", {
    content: "#프로젝트:겹침, 애매한 사슬", project: "bara_system", evidence: { evidenceRefs: [projectMemory.id] },
  });
});
