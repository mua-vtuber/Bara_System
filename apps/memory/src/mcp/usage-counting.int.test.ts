/**
 * mcp/usage-counting — 실제 SDK 클라이언트 + 실제 인증 문 + 실제 SQLite 로 도구 호출·연결 시작 세기를 검증한다
 * (2026-10-21 mcp-usage-and-guidance spec 8.2, A-T3). 실 bge-m3 + Bun.serve (tools-capture.int.test.ts 와 같은 harness).
 *
 * 무상태 서버(요청마다 새 McpServer)에서 oninitialized 가 연결 1회에 정확히 한 번 세지는지도 여기서 확인한다.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { SseTokenStore, type TokenScope } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerMcpRoutes } from "./server.ts";
import type { McpUsageRecorder } from "./usage-recorder.ts";

const CLIENT_ID = "claude-code";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let tmpDir: string;
let db: Database;
let server: ReturnType<typeof Bun.serve>;
let usage: McpUsageRecorder;
let sseTokens: SseTokenStore;
let opened: Client[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-usage-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const deps: MemoryApiDeps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() };
  sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const outer = new Hono({ strict: false });
  outer.use("*", createAuthGate({
    sseTokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  const inner = new Hono({ strict: false });
  usage = registerMcpRoutes(inner, deps);
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });
  opened = [];
});

afterEach(async () => {
  for (const client of opened) await client.close();
  server.stop(true);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function connect(adapterId: string, scope?: TokenScope): Promise<Client> {
  const token = sseTokens.issueToken(adapterId, undefined, undefined, scope);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  opened.push(client);
  return client;
}

interface Row { client: string; kind: string; name: string; outcome: string; calls: number }
const rows = (): Row[] =>
  db.query("SELECT client, kind, name, outcome, calls FROM mcp_tool_usage_daily ORDER BY client, kind, name, outcome").all() as Row[];
const callsOf = (kind: string, name: string, outcome: string, client = CLIENT_ID): number =>
  rows().find((r) => r.client === client && r.kind === kind && r.name === name && r.outcome === outcome)?.calls ?? 0;

describe("MCP 사용 횟수 세기", () => {
  test("연결 1회 = handshake 1 (무상태 서버에서도 한 번만 센다)", async () => {
    await connect(CLIENT_ID);
    // initialized 알림은 202 응답이 먼저 나간 뒤 처리될 수 있어 잠깐 기다린다.
    for (let i = 0; i < 50 && callsOf("handshake", "initialize", "ok") === 0; i++) await Bun.sleep(20);
    await Bun.sleep(100);
    expect(rows()).toEqual([{ client: CLIENT_ID, kind: "handshake", name: "initialize", outcome: "ok", calls: 1 }]);
  });

  test("두 번째 연결은 두 번째 handshake 이고 도구 호출은 handshake 를 더하지 않는다", async () => {
    const first = await connect(CLIENT_ID);
    await first.listTools();
    await first.callTool({ name: "list_recent", arguments: {} });
    await first.callTool({ name: "list_recent", arguments: {} });
    await connect(CLIENT_ID);
    for (let i = 0; i < 50 && callsOf("handshake", "initialize", "ok") < 2; i++) await Bun.sleep(20);
    await Bun.sleep(100);
    expect(callsOf("handshake", "initialize", "ok")).toBe(2);
    expect(callsOf("tool", "list_recent", "ok")).toBe(2);
  });

  test("search_memory 성공 → ok 1, 없는 id 의 get_memory → error 1, 결과 본문은 그대로", async () => {
    const client = await connect(CLIENT_ID);
    const search = await client.callTool({ name: "search_memory", arguments: { query: "배포 방법" } });
    expect(search.isError).not.toBe(true);
    expect(callsOf("tool", "search_memory", "ok")).toBe(1);

    const missing = await client.callTool({ name: "get_memory", arguments: { id: 999999 } });
    expect(missing.isError).toBe(true);
    const body = JSON.parse((missing.content as Array<{ text: string }>)[0]!.text) as { code: string };
    expect(body.code).toBe("NOT_FOUND"); // 기록이 오류 봉투를 바꾸지 않았다.
    expect(callsOf("tool", "get_memory", "error")).toBe(1);
    expect(callsOf("tool", "get_memory", "ok")).toBe(0);
  });

  test("여러 id 를 찾는 get_memory 는 일부가 없어도 성공(ok)으로 센다", async () => {
    const client = await connect(CLIENT_ID);
    const res = await client.callTool({ name: "get_memory", arguments: { ids: [999999] } });
    expect(res.isError).not.toBe(true);
    expect(callsOf("tool", "get_memory", "ok")).toBe(1);
    expect(callsOf("tool", "get_memory", "error")).toBe(0);
  });

  test("인자 검사에서 SDK 가 거절한 호출은 세지 않는다(notCounted)", async () => {
    const client = await connect(CLIENT_ID);
    const res = await client.callTool({ name: "get_memory", arguments: { id: "not-a-number" } }).catch((e: unknown) => e);
    const rejected = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(rejected).toBe(true);
    expect(rows().filter((r) => r.kind === "tool" && r.name === "get_memory")).toEqual([]);
  });

  test("읽기 전용 토큰으로 꺼진 쓰기 도구를 부르면 세지 않는다", async () => {
    const client = await connect("viewer", "read-only");
    await expect(client.callTool({ name: "store_memory", arguments: { content: "x" } })).rejects.toThrow();
    expect(rows().filter((r) => r.kind === "tool" && r.name === "store_memory")).toEqual([]);
    await client.callTool({ name: "list_recent", arguments: {} });
    expect(callsOf("tool", "list_recent", "ok", "viewer")).toBe(1);
  });

  test("기록이 실패해도(표 없음) 도구 결과는 그대로이고 실패가 health 에 드러난다", async () => {
    const client = await connect(CLIENT_ID);
    const before = await client.callTool({ name: "list_recent", arguments: {} });
    db.run("DROP TABLE mcp_tool_usage_daily");
    const log = spyOn(console, "error").mockImplementation(() => {});
    const after = await client.callTool({ name: "list_recent", arguments: {} });
    expect(after.isError).toBe(before.isError);
    expect((after.content as Array<{ text: string }>)[0]!.text).toBe((before.content as Array<{ text: string }>)[0]!.text);
    expect(usage.health().writeFailures).toBeGreaterThanOrEqual(1);
    expect(usage.health().lastError).toContain("mcp_tool_usage_daily");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
