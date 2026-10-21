import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
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
import { registerMcpRoutes } from "./server.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerMemoriesRoutes } from "../server-internal/routes/memories.ts";
import { checkMcpConnection } from "../tools/mcp-client-config.ts";

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let clients: Client[];
let tokenStore: SseTokenStore;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bara-shared-memory-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const tokens = new SseTokenStore(join(dir, "tokens.json"));
  tokenStore = tokens;
  const app = new Hono({ strict: false });
  app.use(
    "*",
    createAuthGate({
      sseTokens: tokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  const deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
  registerMcpRoutes(app, deps);
  registerMemoriesRoutes(app, deps);
  server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
  clients = [];
  for (const name of ["ai-a", "ai-b"]) {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.issueToken(name)}` } },
    }));
    clients.push(client);
  }
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(client: number, name: string, args: Record<string, unknown>) {
  const result = await clients[client]!.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { error: result.isError === true, data: JSON.parse(content[0]!.text) };
}

test("AI A의 근거와 주장 종류를 AI B도 읽고, 클라이언트는 사람 엔티티가 되지 않는다", async () => {
  const saved = await call(0, "store_memory", {
    content: "회의는 매주 화요일 오후에 진행한다.",
    evidence: { assertionKind: "user_statement", sourceEventId: "conversation-1:message-8", sessionRef: "conversation-1" },
  });
  expect(saved.error).toBe(false);
  const read = await call(1, "get_memory", { id: saved.data.id });
  expect(read.data.memory.author).toBe("ai-a");
  expect(read.data.memory.metadata.sharedMemory).toMatchObject({
    assertionKind: "user_statement", sourceEventId: "conversation-1:message-8", revision: 0, status: "active",
  });
  expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
});

test("두 AI가 같은 사용자 발언을 재서술해도 독립 선호로 누적하지 않는다", async () => {
  const evidence = { assertionKind: "user_statement", sourceEventId: "message-preference", claimKey: "answer-language" };
  const first = await call(0, "save_preference", { content: "답변은 한국어로 해 주세요", evidence });
  const before = await store.getNode(first.data.id);
  const second = await call(1, "save_preference", { content: "사용자는 한국어 답변을 선호한다", evidence });
  expect(second.data.id).toBe(first.data.id);
  expect((await store.getNode(first.data.id))!.mentionCount).toBe(before!.mentionCount);
});

test("공유 기억 정정·대체·철회와 문맥 조회 도구를 제공한다", async () => {
  const names = (await clients[0]!.listTools()).tools.map((tool) => tool.name);
  for (const name of ["update_memory", "supersede_memory", "retract_memory", "recall_context"]) {
    expect(names).toContain(name);
  }
});

test("동시 정정은 오래된 버전을 거부하고 동일 요청 재전송은 한 번만 반영한다", async () => {
  const { data: saved } = await call(0, "store_memory", { content: "원래 회의는 화요일이다" });
  const edits = await Promise.all([
    call(0, "update_memory", { id: saved.id, content: "회의는 수요일이다", expectedRevision: 0, requestId: "edit-a" }),
    call(1, "update_memory", { id: saved.id, content: "회의는 금요일이다", expectedRevision: 0, requestId: "edit-b" }),
  ]);
  expect(edits.filter((result) => !result.error)).toHaveLength(1);
  expect(edits.find((result) => result.error)!.data.code).toBe("CONFLICT");
  const winner = edits[0]!.error ? 1 : 0;
  const replay = await call(winner, "update_memory", {
    id: saved.id, content: winner === 0 ? "회의는 수요일이다" : "회의는 금요일이다",
    expectedRevision: 0, requestId: winner === 0 ? "edit-a" : "edit-b",
  });
  expect(replay.error).toBe(false);
  expect(replay.data.replayed).toBe(true);
  expect(replay.data.revision).toBe(1);
  const read = await call(1, "get_memory", { id: saved.id });
  expect(read.data.memory.sharedMemory.revision).toBe(1);
});

test("프로젝트와 전역 선호를 공유하되 다른 프로젝트와 철회한 선호는 주입하지 않는다", async () => {
  const global = await call(0, "save_preference", { content: "답변에는 출처를 함께 적는다", facet: "directives" });
  const local = await call(0, "save_preference", { content: "바라 프로젝트에는 Bun을 사용한다", project: "bara", facet: "stack" });
  const other = await call(1, "save_preference", { content: "다른 프로젝트에는 Rust를 사용한다", project: "other", facet: "stack" });
  const recalled = await call(1, "recall_context", { scope: { projectId: "bara" }, budget: 2000 });
  expect(recalled.error).toBe(false);
  expect(recalled.data.memories.map((m: { id: number }) => m.id).sort()).toEqual([global.data.id, local.data.id].sort());
  expect(recalled.data.memoryBlock).not.toContain("Rust");
  expect(recalled.data.tokensUsed).toBeLessThanOrEqual(2000);
  const retracted = await call(1, "retract_memory", { id: local.data.id, expectedRevision: 0, requestId: "retract-local" });
  expect(retracted.error).toBe(false);
  const after = await call(0, "recall_context", { scope: { projectId: "bara" }, budget: 2000 });
  expect(after.data.memories.map((m: { id: number }) => m.id)).toEqual([global.data.id]);
  const history = await call(0, "get_memory", { id: local.data.id });
  expect(history.data.memory.sharedMemory.status).toBe("retracted");
  expect((await store.getNode(other.data.id))!.content).toContain("Rust");
});

test("명시적 대체 후 새 AI의 프로필에는 최신 선호만 들어온다", async () => {
  const old = await call(0, "save_preference", { content: "설명은 길고 자세하게 해 주세요" });
  const fresh = await call(1, "save_preference", { content: "이제 설명은 짧고 간결하게 해 주세요" });
  const replaced = await call(1, "supersede_memory", {
    id: old.data.id, replacementId: fresh.data.id, expectedRevision: 0, requestId: "replace-preference",
  });
  expect(replaced.error).toBe(false);
  const profile = await call(0, "get_profile", {});
  const entries = Object.values(profile.data.facets).flat() as Array<{ id: number }>;
  expect(entries.map((entry) => entry.id)).toEqual([fresh.data.id]);
});

test("읽기 전용 AI는 조회할 수 있지만 저장과 철회는 거부된다", async () => {
  const token = tokenStore.issueToken("reader", undefined, undefined, "read-only");
  const client = new Client({ name: "reader", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  expect((await call(2, "recall_context", {})).error).toBe(false);
  await expect(call(2, "store_memory", { content: "읽기 전용 쓰기 시도" })).rejects.toMatchObject({ code: 403 });
  await expect(call(2, "retract_memory", { id: 1, expectedRevision: 0, requestId: "forbidden" })).rejects.toMatchObject({ code: 403 });
});

test("읽기 전용 연결의 tools/list — 쓰기 도구는 목록에 아예 없다(WP-B1-16 / SA-5)", async () => {
  const token = tokenStore.issueToken("reader-list", undefined, undefined, "read-only");
  const client = new Client({ name: "reader-list", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  expect(names).toEqual([
    "bara_doctor", "cleanup_list_candidates", "cleanup_run_status", "get_memory",
    "get_profile", "list_recent", "recall_context", "search_memory",
  ].sort());
  for (const writeTool of [
    "store_memory", "save_decision", "save_idea", "save_question", "save_preference",
    "update_memory", "supersede_memory", "retract_memory",
    "cleanup_submit_proposal", "cleanup_report_no_finding",
  ]) {
    expect(names).not.toContain(writeTool);
  }
});

test("읽기 전용 연결의 cleanup_list_candidates 문안 — 없는 제출 도구를 권하지 않는다", async () => {
  const token = tokenStore.issueToken("reader-cleanup-desc", undefined, undefined, "read-only");
  const client = new Client({ name: "reader-cleanup-desc", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  const tool = (await client.listTools()).tools.find((t) => t.name === "cleanup_list_candidates");
  expect(tool?.description).toContain("read-only");
  expect(tool?.description).not.toContain("cleanup_submit_proposal");
  expect(tool?.description).not.toContain("payload");
});

test("읽기 전용 연결의 instructions — 쓰기 절 대신 읽기 전용 안내(WP-B1-16 / SA-5)", async () => {
  const token = tokenStore.issueToken("reader-instructions", undefined, undefined, "read-only");
  const client = new Client({ name: "reader-instructions", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  const instructions = client.getInstructions() ?? "";
  expect(instructions).toContain("read-only");
  expect(instructions).not.toContain("\nWRITING\n");
  expect(instructions).not.toContain("\nCORRECTING\n");
});

test("같은 출처 사건의 동시 저장과 철회 뒤 재전송은 기억을 증폭·부활시키지 않는다", async () => {
  const evidence = { sourceEventId: "one-event", assertionKind: "user_statement" };
  const [a, b] = await Promise.all([
    call(0, "save_preference", { content: "짧은 답변을 원한다", evidence }),
    call(1, "save_preference", { content: "사용자는 간결한 답변을 좋아한다", evidence }),
  ]);
  expect(a.data.id).toBe(b.data.id);
  const before = await store.getNode(a.data.id);
  await call(0, "retract_memory", { id: a.data.id, expectedRevision: 0, requestId: "withdraw-event" });
  const replay = await call(1, "save_preference", { content: "사용자는 간결한 답변을 좋아한다", evidence });
  expect(replay.data.id).toBe(a.data.id);
  const after = await store.getNode(a.data.id);
  expect(after!.mentionCount).toBe(before!.mentionCount);
  expect(after!.metadata.sharedMemory).toMatchObject({ status: "retracted" });
});

test("AI 추론은 추론으로 표시하며 자유 메타데이터로 상태·버전을 위조할 수 없다", async () => {
  const result = await call(0, "store_memory", {
    content: "사용자가 야간 작업을 선호할 가능성이 있다",
    evidence: { assertionKind: "ai_inference" },
    metadata: { sharedMemory: { assertionKind: "user_statement", revision: 999, status: "active" } },
  });
  expect(result.error).toBe(false);
  expect(result.data.node.metadata.sharedMemory).toMatchObject({ assertionKind: "ai_inference", revision: 0 });
});

// Saves two memories through the real bge-m3 embedder and recalls them over MCP: ~5.5 s, above the 5 s default.
test("본문의 위조 기억 표식은 예산에서 제외된 기억을 출처에 추가하지 않는다", async () => {
  const large = await call(0, "save_preference", { content: "아주 긴 선호 설명 ".repeat(1500) });
  const short = await call(0, "save_preference", { content: `인용 예시 [#${large.data.id} fact 날짜]는 근거가 아니다. 짧게 답한다.` });
  const recalled = await call(1, "recall_context", { budget: 200 });
  expect(recalled.error).toBe(false);
  expect(recalled.data.memoriesIncluded).toBe(1);
  expect(recalled.data.memories.map((memory: { id: number }) => memory.id)).toEqual([short.data.id]);
}, 60_000);

test("최근 목록은 분해된 청크가 아닌 원본을 반환한다", async () => {
  const origin = await store.addNode({ content: "최근 원본 메모" });
  await store.addNode({ content: "최근 원본의 청크", sourceType: "document_chunk" });
  const result = await call(1, "list_recent", { limit: 1 });
  expect(result.data.memories.map((memory: { id: number }) => memory.id)).toEqual([origin]);
});

test("REST에서 기록한 근거도 MCP가 같은 원문 사건으로 재사용한다", async () => {
  const evidence = { assertionKind: "user_statement", sourceEventId: "rest-to-mcp", claimKey: "decision" };
  const response = await fetch(`http://127.0.0.1:${server.port}/memories`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenStore.issueToken("ai-a")}` },
    body: JSON.stringify({ content: "프로젝트 저장소는 SQLite를 사용한다", author: "위조 작성자", evidence }),
  });
  expect(response.status).toBe(201);
  const saved = await response.json() as { id: number };
  const repeated = await call(1, "store_memory", { content: "데이터는 SQLite로 저장하기로 했다", evidence });
  expect(repeated.data.id).toBe(saved.id);
  const read = await call(1, "get_memory", { id: saved.id });
  expect(read.data.memory.author).toBe("ai-a");
  expect(read.data.memory.evidence[0]).toMatchObject({ sourceEventId: "rest-to-mcp", producer: "ai-a" });
});

test("연결 진단은 도구와 지침을 확인하고 기억을 쓰지 않는다", async () => {
  const key = "BARA_SHARED_MEMORY_TEST_TOKEN";
  const previous = process.env[key];
  process.env[key] = tokenStore.issueToken("diagnostic", undefined, undefined, "read-only");
  try {
    const result = await checkMcpConnection({ client: "codex", url: `http://127.0.0.1:${server.port}/mcp`, tokenEnv: key });
    // read-only 토큰이라 tools/list 에는 쓰기 도구가 빠진 읽기 8종만 실린다(WP-B1-16 /
    // SA-5) — required 4종(search_memory·get_memory·get_profile·recall_context)은
    // 전부 읽기 도구라 missing 은 여전히 없다.
    expect(result).toMatchObject({ ok: true, toolCount: 8, instructions: true, missing: [] });
    expect(db.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get()).toEqual({ n: 0 });
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

// ── WP-B1-10(SL-3 표시) — 열린 충돌 표시를 search_memory·recall_context·get_profile·
// get_memory 네 표면에서 확인한다. 이 테스트 파일은 deps 에 extractor 를 주입하지 않아
// conflict-checker 의 고유사도 판정 자체는 돌지 않는다(그 경로는 conflict-candidates.int.test.ts
// 가 실제 흐름으로 검증한다). 여기서는 A·N·B 세 기억과 N→A·N→B contradicts 엣지를 실제
// SQLite에 직접 구성해, MCP 서버 조립을 통과한 네 표면이 같은 열린 충돌 결과를 노출하는지만
// 확인한다 — 이 WP의 관심사(표시 배선)와 정확히 일치한다.
test("N이 A·B 둘과 contradicts로 이어졌을 때 A를 채택해도 N-B는 네 표면 모두에서 열린 채로 남는다", async () => {
  const a = await call(0, "save_preference", { content: "답변은 한국어로 해 주세요", facet: "communication" });
  const n = await call(1, "save_preference", { content: "답변은 영어로 해 주세요", facet: "communication" });
  await store.db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ facet: "communication", sharedMemory: { status: "disputed", revision: 0, assertionKind: "unknown" } }), n.data.id);
  await store.addEdge({ sourceId: n.data.id, targetId: a.data.id, relation: "contradicts", provenance: "system", sourceNodeId: n.data.id, weight: 0.9 });
  const b = await store.addNode({ content: "또 다른 옛 진술", memoryType: "preference", metadata: { facet: "communication" } });
  await store.addEdge({ sourceId: n.data.id, targetId: b, relation: "contradicts", provenance: "system", sourceNodeId: n.data.id, weight: 0.9 });

  const adopted = await call(0, "supersede_memory", {
    id: a.data.id, replacementId: n.data.id, expectedRevision: 0, requestId: "adopt-n-over-a",
  });
  expect(adopted.error).toBe(false);
  expect(adopted.data.openConflicts).toEqual([b]);

  // search_memory — 표시 노드(N·B)에 상대 id가 붙는다.
  const searched = await call(1, "search_memory", { query: "진술", limit: 20 });
  const byId = new Map((searched.data.results as Array<{ id: number; conflicts: number[] }>).map((r) => [r.id, r.conflicts]));
  expect(byId.get(n.data.id)).toEqual([b]);
  expect(byId.get(b)).toEqual([n.data.id]);
  expect(byId.has(a.data.id)).toBe(false); // A는 superseded라 기본 결과에 없다(기존 계약).

  // get_profile — 같은 facet 조회에 N·B 둘 다 남고 서로의 id를 가리킨다.
  const profile = await call(1, "get_profile", { facet: "communication" });
  const entries = profile.data.facets.communication as Array<{ id: number; conflicts: number[] }>;
  const profileById = new Map(entries.map((e) => [e.id, e.conflicts]));
  expect(profileById.get(n.data.id)).toEqual([b]);
  expect(profileById.get(b)).toEqual([n.data.id]);

  // get_memory — 단건·배치 둘 다.
  const gotN = await call(1, "get_memory", { id: n.data.id });
  expect(gotN.data.memory.conflicts).toEqual([b]);
  const gotBatch = await call(1, "get_memory", { ids: [n.data.id, b] });
  const batchById = new Map((gotBatch.data.memories as Array<{ id: number; conflicts: number[] }>).map((m) => [m.id, m.conflicts]));
  expect(batchById.get(n.data.id)).toEqual([b]);
  expect(batchById.get(b)).toEqual([n.data.id]);

  // recall_context — scope 없는 전역 조회에 N·B 둘 다 잡히고 conflicts가 붙는다.
  const recalled = await call(1, "recall_context", { budget: 2000 });
  const recalledById = new Map((recalled.data.memories as Array<{ id: number; conflicts: number[] }>).map((m) => [m.id, m.conflicts]));
  expect(recalledById.get(n.data.id)).toEqual([b]);
  expect(recalledById.get(b)).toEqual([n.data.id]);
  expect(recalled.data.memoryBlock).toContain(`[충돌 후보 #${b} — 사용자 확인 필요]`);

  // 마지막 충돌(N-B)까지 해소되면 표시가 사라진다. b는 새로 만든 노드라 revision 0.
  const resolved = await call(0, "supersede_memory", {
    id: b, replacementId: n.data.id, expectedRevision: 0, requestId: "adopt-n-over-b",
  });
  expect(resolved.error).toBe(false);
  expect(resolved.data.openConflicts).toEqual([]);
  const afterResolve = await call(1, "get_memory", { id: n.data.id });
  expect(afterResolve.data.memory.conflicts).toEqual([]);
});

// WP-B1-10R — 사용자 결정(2026-09-29, 1안): 원문(auto_capture)은 계속 기본 조회에
// 남기되, 그 원문에서 추출된 자식(merged_into)의 열린 충돌·대체된 주장을 원문 자신에게
// 함께 표시한다. B1-08R "B1-10으로 넘긴 것" 두 번째 항목의 후속 — WP-B1-10이 고정했던
// "표시 없음" 동작을 원하는 동작(표시함)으로 바꾼다.
test("추출 자식이 supersede로 대체되면 원문에 '대체된 주장' 표시가 붙고, 대체 기억이 다시 바뀌면 사라진다", async () => {
  const origin = await store.addNode({ content: "회의는 화요일 오전에 진행한다.", memoryType: "fact" });
  expect((await store.getNode(origin))!.sourceType).toBe("auto_capture");
  // 원문에서 추출된 자식(llm_extract) — merged_into로 원문 계보에 연결.
  const child = await store.addNode({
    content: "회의는 화요일 오전에 진행한다", memoryType: "fact", sourceType: "llm_extract",
    metadata: { sharedMemory: { assertionKind: "ai_inference", revision: 0 } },
  });
  await store.addEdge({ sourceId: child, targetId: origin, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  // 다른 AI가 반대 사실을 저장하고, 그 새 기억이 원문의 자식과 contradicts로 disputed.
  const rival = await call(1, "store_memory", { content: "회의는 목요일 오전에 진행한다.", force: true });
  await store.db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "disputed", revision: 0, assertionKind: "unknown" } }), rival.data.id);
  await store.addEdge({ sourceId: rival.data.id, targetId: child, relation: "contradicts", provenance: "system", sourceNodeId: rival.data.id, weight: 0.9 });

  // 해소 전 — 자식이 아직 disputed 라 원문에 열린 충돌 표시가 붙는다.
  const beforeResolve = await call(1, "get_memory", { id: origin });
  expect(beforeResolve.data.memory.conflicts).toEqual([]); // 원문 자신은 contradicts 당사자가 아니다.
  expect(beforeResolve.data.memory.originMarks.openConflicts).toEqual([rival.data.id]);

  // 자식 대 새 기억의 충돌을 supersede로 채택(원문은 손대지 않는다).
  const resolved = await call(0, "supersede_memory", {
    id: child, replacementId: rival.data.id, expectedRevision: 0, requestId: "resolve-child-conflict",
  });
  expect(resolved.error).toBe(false);
  expect(resolved.data.openConflicts).toEqual([]);

  // 원문 자신은 active로 남아 recall_context 기본 조회에 옛 주장 그대로 나온다(원문을
  // 기본 결과에서 빼지 않는다는 사용자 결정 그대로).
  const originRead = await call(1, "get_memory", { id: origin });
  expect(originRead.data.memory.sharedMemory.status).toBe("active");
  expect(originRead.data.memory.conflicts).toEqual([]); // 원문은 contradicts 당사자가 아니다.
  // 자식이 대체됐으니 원문에 "대체된 주장" 표시가 붙는다 — 열린 충돌은 이제 없다.
  expect(originRead.data.memory.originMarks).toEqual({
    openConflicts: [], supersededClaims: [{ childId: child, replacementId: rival.data.id }],
  });

  const recalled = await call(1, "recall_context", { query: "회의", budget: 4000 });
  const recalledIds = (recalled.data.memories as Array<{ id: number }>).map((m) => m.id);
  expect(recalledIds).toContain(origin); // 옛 주장이 계속 보인다 — 원문을 기본 결과에서 빼지 않는다.
  expect(recalled.data.memoryBlock).toContain(`[대체된 주장 #${child} → #${rival.data.id}]`);

  // search_memory(full·index 둘 다)에도 같은 표시가 실린다.
  const searchedFull = await call(1, "search_memory", { query: "회의", limit: 20 });
  const fullOrigin = (searchedFull.data.results as Array<{ id: number; originMarks?: unknown }>)
    .find((r) => r.id === origin);
  expect(fullOrigin?.originMarks).toEqual({
    openConflicts: [], supersededClaims: [{ childId: child, replacementId: rival.data.id }],
  });
  const searchedIndex = await call(1, "search_memory", { query: "회의", limit: 20, responseMode: "index" });
  const indexOrigin = (searchedIndex.data.results as Array<{ id: number; originMarks?: unknown }>)
    .find((r) => r.id === origin);
  expect(indexOrigin?.originMarks).toEqual({
    openConflicts: [], supersededClaims: [{ childId: child, replacementId: rival.data.id }],
  });

  // 대체 기억(rival)마저 나중에 retract 되면 "대체된 주장"이 더 이상 current 가 아니라 사라진다.
  const rivalRetracted = await call(1, "retract_memory", {
    id: rival.data.id, expectedRevision: 1, requestId: "retract-replacement",
  });
  expect(rivalRetracted.error).toBe(false);
  const afterRetract = await call(1, "get_memory", { id: origin });
  expect(afterRetract.data.memory.originMarks).toBeUndefined();
});

// WP-B1-10R — 계보 무효화(B1-06 편집 재추출)로 철회된 자식은 사용자·AI 가 직접 supersede한
// 것이 아니므로 "대체된 주장" 표시를 만들지 않는다(스펙 명시 요구사항).
// WP-B1-10S(Minor) — 이 상태를 metadata 직접 SQL 조작이 아니라 실제 편집 경로(update_memory)로
// 만든다. 원문 본문을 고치면 shared-memory-mutations.ts 가 invalidateSharedMemoryDerivatives 를
// 불러 merged_into 로 이어진 자식을 계보 무효화(invalidatedBy 있는 retracted)로 거둔다 — 이
// 테스트가 실제로 확인하려는 서버 동작 그 자체를 통해 상태를 만든다.
test("계보 무효화로 철회된 자식은 원문에 '대체된 주장' 표시를 남기지 않는다", async () => {
  const origin = await store.addNode({ content: "회의는 화요일 오전에 진행한다.", memoryType: "fact" });
  const child = await store.addNode({
    content: "회의는 화요일 오전에 진행한다", memoryType: "fact", sourceType: "llm_extract",
    metadata: { sharedMemory: { assertionKind: "ai_inference", revision: 0 } },
  });
  await store.addEdge({ sourceId: child, targetId: origin, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });

  // 원문 본문을 실제로 편집 — 계보 무효화가 merged_into 자식을 거둔다(사용자·AI 가 직접
  // supersede/retract 한 것이 아니라 서버가 계보로 거둔 것).
  const edited = await call(0, "update_memory", {
    id: origin, content: "회의는 수요일 오전에 진행한다.", expectedRevision: 0, requestId: "invalidate-child",
  });
  expect(edited.error).toBe(false);
  const childRead = await call(1, "get_memory", { id: child });
  expect(childRead.data.memory.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: origin });

  const originRead = await call(1, "get_memory", { id: origin });
  expect(originRead.data.memory.originMarks).toBeUndefined();
});
