/**
 * mcp/hashtag-warnings.int.test.ts — MCP 저장 5종 응답의 hashtagWarnings 칸 (2026-10-21 spec 12.4, B-T7).
 *
 * 실제 bge-m3 + 실제 SQLite + 실제 SDK 클라이언트 + 실제 인증 게이트(mock 없음). 경고가 있으면 칸이 실리고,
 * 없으면 칸 자체가 없고, 실제 처리 갈래(memory / entity_patch)에 맞는 문구가 실리는지 본다.
 * (tools-memory.int.test.ts 가 이미 700줄 가까워 따로 둔다.)
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
import { HASHTAG_WARNING_MESSAGES } from "../memory/hashtag-chain-messages.ts";
import { HASHTAG_WARNINGS_MAX, hashtagWarningFields, prepareHashtagCheck } from "./hashtag-warning-fields.ts";
import { registerMcpRoutes } from "./server.ts";

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
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-hashtag-"));
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
  client = new Client({ name: "hashtag-warnings", version: "0.0.1" });
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
  return { error: result.isError === true, text, data: JSON.parse(text) };
}

test("store_memory: 쉼표가 빠진 태그 → 글 기억으로 저장되고 BODY_ABSORBED 가 실린다", async () => {
  const res = await call("store_memory", { content: "#일상:건강 오늘 운동함" });
  expect(res.error).toBe(false);
  expect(res.data.type).toBe("memory");
  expect(res.data.hashtagWarnings).toEqual([{
    code: "BODY_ABSORBED",
    tag: "#일상:건강 오늘 운동함",
    readAs: 'key "일상", value "건강 오늘 운동함"',
    message: HASHTAG_WARNING_MESSAGES.BODY_ABSORBED({ savedAs: "memory", reservedKey: false, colon: true }),
  }]);
  expect("hashtagWarningsTruncated" in res.data).toBe(false);
});

test("store_memory: 경고가 없으면 칸 자체가 없다(평범한 메모·정상 사슬·평면 태그)", async () => {
  for (const content of [
    "해시태그 없는 평범한 메모",
    "#AI기록, 이슈 #42 해결 — C# 코드였다",
    "#프로젝트:코딩, #코딩:bara_system, 배포는 deploy:a1 하나로 한다",
  ]) {
    const res = await call("store_memory", { content, force: true });
    expect(res.error).toBe(false);
    for (const field of ["hashtagWarnings", "hashtagWarningsTruncated", "hashtagWarningsError"]) {
      expect(`${content}: ${field in res.data}`).toBe(`${content}: false`);
    }
  }
});

test("store_memory: 본문이 사슬 값에 먹혀 엔티티 전용 입력이 되면 그 갈래의 문구가 실린다", async () => {
  const res = await call("store_memory", { content: "#프로젝트:코딩, #코딩:바라 배포 메모" });
  expect(res.error).toBe(false);
  expect(res.data.type).toBe("entity_patch");
  expect(res.data.hashtagWarnings.map((w: { code: string }) => w.code)).toEqual(["BODY_ABSORBED"]);
  expect(res.data.hashtagWarnings[0].message)
    .toBe(HASHTAG_WARNING_MESSAGES.BODY_ABSORBED({ savedAs: "entity_patch", reservedKey: false, colon: true }));
  expect(Array.isArray(res.data.warnings)).toBe(true); // 기존 엔티티 처리 내부 기록 칸은 그대로.
});

test("store_memory: 애매한 프로젝트 이름 → PROJECT_AMBIGUOUS, 실제로 프로젝트가 붙지 않았다", async () => {
  const a = await store.findOrCreateProject({ name: "알파 프로젝트" });
  const b = await store.findOrCreateProject({ name: "베타 프로젝트" });
  store.entitiesRepo.setKoAliases(a.projectId, ["겹침"]);
  store.entitiesRepo.setKoAliases(b.projectId, ["겹침"]);
  const res = await call("store_memory", { content: "#프로젝트:겹침, 배포 순서를 정리했다" });
  expect(res.data.hashtagWarnings.map((w: { code: string }) => w.code)).toEqual(["PROJECT_AMBIGUOUS"]);
  expect((await store.getNode(res.data.id))!.projectId).toBeNull();
});

test("store_memory: 경고가 상한을 넘으면 앞에서 상한만큼과 hashtagWarningsTruncated", async () => {
  const tags = Array.from({ length: HASHTAG_WARNINGS_MAX + 5 }, (_, i) => `#빈칸${i}:,`).join(" ");
  const res = await call("store_memory", { content: `${tags} 빈 태그를 많이 적은 메모` });
  expect(res.error).toBe(false);
  expect(res.data.hashtagWarnings).toHaveLength(HASHTAG_WARNINGS_MAX);
  expect(res.data.hashtagWarningsTruncated).toBe(true);
});

test("store_memory: 비밀값은 저장과 같은 오류로 끝나고 응답에 원문도 경고도 없다", async () => {
  const fakeAws = "AKIAEXAMPLEEXAMPLE99";
  const res = await call("store_memory", { content: `#일상:배포 키 ${fakeAws}` });
  expect(res.error).toBe(true);
  expect(res.data.code).toBe("SECRET_DETECTED");
  expect(res.text).not.toContain(fakeAws);
  expect(res.text).not.toContain("hashtagWarnings");
  expect((db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n).toBe(0);
});

test("save_decision: 하이픈 키 → HYPHEN_SPLIT, 평범한 결정은 칸 없음", async () => {
  const warned = await call("save_decision", { content: "#bara-system:배포, 배포는 deploy:a1 하나로 하기로 했다" });
  expect(warned.error).toBe(false);
  expect(warned.data.hashtagWarnings.map((w: { code: string }) => w.code)).toEqual(["HYPHEN_SPLIT"]);
  const plain = await call("save_decision", { content: "펫 업데이트는 setup.exe 하나만 올리기로 했다" });
  expect(plain.error).toBe(false);
  expect("hashtagWarnings" in plain.data).toBe(false);
});

test("save_idea: 글 기억이 안 생긴 실패 응답에도 까닭이 된 경고를 details 로 싣는다", async () => {
  const res = await call("save_idea", { content: "#프로젝트:코딩, #코딩:바라 배포 메모" });
  expect(res.error).toBe(true);
  expect(res.data.code).toBe("INTERNAL");
  expect(res.data.details.hashtagWarnings.map((w: { code: string }) => w.code)).toEqual(["BODY_ABSORBED"]);
});

test("분석이 실패하면 저장 결과는 두고 hashtagWarningsError 로 드러낸다(경고 없음으로 꾸미지 않음)", async () => {
  const closedDb = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  const closedStore = new SqliteMemoryStore(closedDb, embedder);
  closedDb.close();
  const pre = await prepareHashtagCheck(closedStore, "#프로젝트:바라, 본문", null);
  const fields = hashtagWarningFields(pre, "memory");
  expect(Object.keys(fields)).toEqual(["hashtagWarningsError"]);
  expect(fields.hashtagWarningsError!.startsWith("Hashtag check failed: ")).toBe(true);
  // 평범한 메모는 store 를 보지 않으므로 같은 조건에서도 실패가 없다.
  expect(hashtagWarningFields(await prepareHashtagCheck(closedStore, "평범한 메모", null), "memory")).toEqual({});
});

test("실제 도구 호출: 프로젝트 조회가 실패해도 저장은 되고 응답에 hashtagWarningsError 가 실린다(spec 20.7 m4)", async () => {
  // 프로젝트 이름 조회(findProjectByNameOrAlias)가 읽는 entities 표를 치워 사전 확인을 실제로 실패시킨다.
  db.run("ALTER TABLE entities RENAME TO entities_hidden_for_test");
  const res = await call("store_memory", { content: "#프로젝트:바라, 배포 순서를 정리했다" });
  expect(res.error).toBe(false);
  expect(res.data.type).toBe("memory");
  expect(typeof res.data.id).toBe("number");
  expect(res.data.hashtagWarningsError.startsWith("Hashtag check failed: ")).toBe(true);
  expect("hashtagWarnings" in res.data).toBe(false);
  db.run("ALTER TABLE entities_hidden_for_test RENAME TO entities");
});
