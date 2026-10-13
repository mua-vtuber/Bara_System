import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore, type TokenScope } from "../federation/sse-tokens.ts";
import { createAuthGate, MCP_ADAPTER_ID_VAR, MCP_TOKEN_SCOPE_VAR } from "./auth-gate.ts";

let dir: string;
let tokens: SseTokenStore;
let app: Hono;
let mcpLimit: number;
const issued = {} as Record<TokenScope, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auth-scopes-"));
  tokens = new SseTokenStore(join(dir, "tokens.json"));
  mcpLimit = 8 * 1024 * 1024;
  app = new Hono({ strict: false });
  app.use("*", createAuthGate({ sseTokens: tokens, remoteAddrOf: () => "127.0.0.1", getMcpBodyLimit: () => mcpLimit }));
  app.all("*", async (c) => c.json({
    scope: c.get(MCP_TOKEN_SCOPE_VAR), adapterId: c.get(MCP_ADAPTER_ID_VAR),
    ...(c.req.method === "POST" && c.req.path.startsWith("/mcp") ? { body: await c.req.json() } : {}),
  }));
  for (const scope of ["read-only", "mcp-standard", "full"] as const) {
    issued[scope] = tokens.issueToken(scope, undefined, undefined, scope);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function request(scope: TokenScope, path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${issued[scope]}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("restricted HTTP permissions", () => {
  test("client info and ingest receipts are readable by every authenticated scope", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    for (const scope of ["read-only", "mcp-standard", "full"] as const) {
      expect((await request(scope, "/client-info")).status).toBe(200);
      expect((await request(scope, `/ingest/status/${id}`)).status).toBe(200);
    }
    expect((await request("mcp-standard", "/ingest/status/not-a-uuid")).status).toBe(403);
  });
  test.each([["GET", "/memories"], ["GET", "/memories/12"], ["GET", "/profile"], ["GET", "/doctor"], ["POST", "/search"], ["POST", "/memories/batch-get"], ["GET", "/api/cleanup-candidates"], ["GET", "/api/cleanup-runs/run-1"]])("read-only permits %s %s", async (method, path) => {
    expect((await request("read-only", path, method)).status).toBe(200);
  });
  test.each([["POST", "/memories"], ["POST", "/ingest"], ["PATCH", "/memories/12"], ["POST", "/cleanup-proposals"]])("read-only denies %s %s while standard permits", async (method, path) => {
    expect((await request("read-only", path, method)).status).toBe(403);
    expect((await request("mcp-standard", path, method)).status).toBe(200);
  });
  test.each([["DELETE", "/memories/12"], ["POST", "/cleanup-proposals/12/approve"], ["PUT", "/settings"], ["GET", "/backup/download"], ["POST", "/admin/reset-memory/"], ["GET", "/adapter-tokens"], ["GET", "/future-route"], ["PATCH", "/search"], ["GET", "/dashboard/sse-token/"]])("restricted token cannot bypass via %s %s", async (method, path) => {
    expect((await request("read-only", path, method)).status).toBe(403);
    expect((await request("mcp-standard", path, method)).status).toBe(403);
    expect((await request("full", path, method)).status).toBe(200);
  });
  test.each([["GET", "/events/stream"], ["GET", "/settings"], ["GET", "/settings/schema"], ["GET", "/federation/apps/mcp-standard/settings"], ["PATCH", "/memories/by-source"], ["POST", "/memories/12/append"]])("standard adapter compatibility: %s %s", async (method, path) => {
    expect((await request("mcp-standard", path, method)).status).toBe(200);
    expect((await request("read-only", path, method)).status).toBe(403);
  });
  test("standard adapter cannot inspect another adapter's settings", async () => {
    expect((await request("mcp-standard", "/federation/apps/another/settings")).status).toBe(403);
  });
  test("trailing slash shares permission rules and authenticated identity", async () => {
    expect((await request("read-only", "/memories/", "POST")).status).toBe(403);
    const res = await request("read-only", "/mcp/", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scope: "read-only", adapterId: "read-only", body: { method: "tools/list" } });
  });
  test.each(["/memories%2fby-source", "/memories//12", "/memories/%252e%252e/admin/reset-memory"])("ambiguous restricted path denied: %s", async (path) => {
    expect((await request("mcp-standard", path, "POST")).status).toBe(403);
  });
});

describe("MCP transport permission boundary", () => {
  test("RPC permission inspection enforces byte limits before JSON parsing", async () => {
    mcpLimit = 128;
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_memory", arguments: { text: "x".repeat(256) } } };
    expect((await request("read-only", "/mcp", "POST", body)).status).toBe(413);
  });
  test.each(["initialize", "ping", "tools/list", "notifications/initialized"])("read-only protocol %s remains usable", async (method) => {
    expect((await request("read-only", "/mcp", "POST", { jsonrpc: "2.0", id: 1, method })).status).toBe(200);
  });
  test.each(["store_memory", "update_memory", "supersede_memory", "retract_memory"])("read-only cannot call %s over HTTP", async (name) => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } };
    expect((await request("read-only", "/mcp/", "POST", body)).status).toBe(403);
    expect((await request("mcp-standard", "/mcp/", "POST", body)).status).toBe(200);
  });
  test("one denied call denies the entire JSON-RPC batch", async () => {
    const body = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_memory" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "store_memory" } },
    ];
    expect((await request("read-only", "/mcp", "POST", body)).status).toBe(403);
  });
  test("unknown RPC methods and tools are denied for restricted scopes", async () => {
    expect((await request("mcp-standard", "/mcp", "POST", { method: "admin/reset" })).status).toBe(403);
    expect((await request("mcp-standard", "/mcp", "POST", { method: "tools/call", params: { name: "future_tool" } })).status).toBe(403);
  });
});
