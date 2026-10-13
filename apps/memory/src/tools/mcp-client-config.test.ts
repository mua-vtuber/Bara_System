import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { createBodyLimit } from "../server-internal/body-limit.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import { registerMcpRoutes } from "../mcp/server.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { buildMcpClientConfig, checkMcpConnection } from "./mcp-client-config.ts";

// checkMcpConnection 통합 테스트(아래)가 실 Bara MCP 서버의 recall_context 도구를
// 실제로 호출하므로(read.isError 판정까지 거침), tools-memory.int.test.ts 와 같이
// 실 bge-m3 임베더가 필요하다 — 파일 전체에서 1회만 로드해 공유한다.
let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

test("Codex 설정은 실제 토큰 대신 환경 변수 이름만 포함한다", () => {
  const result = buildMcpClientConfig({ client: "codex", url: "http://127.0.0.1:3000/mcp", tokenEnv: "BARA_CODEX_TOKEN" });
  expect(result).toContain('[mcp_servers.bara]');
  expect(result).toContain('bearer_token_env_var = "BARA_CODEX_TOKEN"');
});
test("Claude Code 설정의 토큰은 환경 변수 참조로 남는다", () => {
  const result = JSON.parse(buildMcpClientConfig({ client: "claude-code", url: "https://memory.example/mcp", tokenEnv: "BARA_CLAUDE_TOKEN" }));
  expect(result.mcpServers.bara).toEqual({ type: "http", url: "https://memory.example/mcp", headers: { Authorization: "Bearer ${BARA_CLAUDE_TOKEN}" } });
});
test("URL에 포함된 자격증명과 설정 주입을 거부한다", () => {
  for (const url of ["https://user:secret@example.com/mcp", "https://example.com/mcp?token=secret", "file:///tmp/mcp"]) {
    expect(() => buildMcpClientConfig({ client: "codex", url })).toThrow();
  }
  expect(() => buildMcpClientConfig({ client: "codex", url: "http://localhost/mcp", tokenEnv: 'TOKEN"\nmalicious = true' })).toThrow();
});

// ── checkMcpConnection — 실 서버 대상 통합 테스트(SA-9) ───────────────────────
//
// mock 클래스 없음: 두 케이스 모두 실 Bara MCP 서버(전자)와 실 SDK McpServer(후자)를
// loopback Bun.serve 로 띄우고, 실 SDK Client + StreamableHTTPClientTransport 로
// checkMcpConnection 을 그대로 부른다. src/mcp/server.test.ts 의 하네스 방식을 따른다.

const TOKEN_ENV = "BARA_MCP_CONNECTION_CHECK_TEST_TOKEN";

/**
 * 실 Bara MCP 서버(outer authGate + registerMcpRoutes) — instructions 있음.
 *
 * checkMcpConnection 은 실패가 없을 때 recall_context 도구를 실제로 호출해
 * read.isError 까지 판정한다({} cast deps 로는 store 접근에서 예외가 나 ok:false
 * 로 위장된다) — tools-memory.int.test.ts 와 같은 실 store·실 embedder 조립이
 * 필요하다.
 */
function startBaraMcpServer() {
  const tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-check-"));
  const db: Database = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const deps: MemoryApiDeps = { store, retriever, assembler };

  const sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  const token = sseTokens.issueToken("connection-check-client");
  const outer = new Hono({ strict: false });
  outer.use(
    "*",
    createAuthGate({
      sseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  outer.use(
    "*",
    createBodyLimit(() => ({
      maxTextBytes: MEMORY_DEFAULTS.security.maxTextBytes,
      maxAssetBytes: MEMORY_DEFAULTS.security.maxAssetBytes,
    })),
  );
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, deps);
  outer.route("/", inner);
  const server = Bun.serve({ port: 0, fetch: outer.fetch });
  return {
    token,
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => { server.stop(true); db.close(); rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

/**
 * 공식 SDK로 만든 실 MCP 서버 — instructions 를 전혀 넘기지 않는다(getInstructions()
 * 가 undefined). checkMcpConnection 의 4개 필수 도구는 등록해 missing_tools 가
 * instructions_missing 을 가리지 않게 한다. 인증은 없음 — 이 테스트가 검증하는 것은
 * instructions 판정이지 인증이 아니다.
 */
function startNoInstructionsMcpServer() {
  const app = new Hono({ strict: false });
  app.all("/mcp", async (c) => {
    const server = new McpServer({ name: "no-instructions-test-server", version: "0.0.1" });
    for (const name of ["search_memory", "get_memory", "get_profile", "recall_context"]) {
      server.registerTool(name, {
        description: `${name} — instructions 없는 테스트 서버의 자리표시 도구`,
        inputSchema: { query: z.string().optional() },
      }, async () => ({ content: [{ type: "text" as const, text: "{}" }] }));
    }
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
}

test("checkMcpConnection — instructions 있는 실 Bara MCP 서버 → ok:true, instructions:true", async () => {
  const bara = startBaraMcpServer();
  process.env[TOKEN_ENV] = bara.token;
  try {
    const result = await checkMcpConnection({ client: "codex", url: bara.url, tokenEnv: TOKEN_ENV });
    expect(result.ok).toBe(true);
    expect(result.instructions).toBe(true);
  } finally {
    delete process.env[TOKEN_ENV];
    bara.stop();
  }
});

test("checkMcpConnection — instructions 없는 실 SDK 서버 → ok:false, failures에 instructions_missing", async () => {
  const bare = startNoInstructionsMcpServer();
  process.env[TOKEN_ENV] = "irrelevant-token-bare-server-has-no-auth";
  try {
    const result = await checkMcpConnection({ client: "codex", url: bare.url, tokenEnv: TOKEN_ENV });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("instructions_missing");
  } finally {
    delete process.env[TOKEN_ENV];
    bare.stop();
  }
});

// ── CLI --check 경로 — 실 자식 프로세스로 종료 코드 검증 ─────────────────────────

test("CLI --check 는 instructions 없는 서버를 대상으로 종료 코드 1을 반환한다", async () => {
  const bare = startNoInstructionsMcpServer();
  try {
    const child = Bun.spawn([
      process.execPath, "run",
      resolve(import.meta.dir, "./mcp-client-config.ts"),
      "--client", "codex", "--url", bare.url, "--token-env", TOKEN_ENV, "--check",
    ], {
      env: { ...process.env, [TOKEN_ENV]: "irrelevant-token-bare-server-has-no-auth" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toContain("instructions_missing");
  } finally {
    bare.stop();
  }
});
