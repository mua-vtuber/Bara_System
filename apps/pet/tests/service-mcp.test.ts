import { expect, test } from "bun:test";
import { McpClient, parseMcpResponse } from "../src/service/mcp.ts";

test("MCP parses both JSON and event-stream tool results", () => {
  const payload = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"candidates":[]}' }] } };
  expect(parseMcpResponse(JSON.stringify(payload), "application/json", 2)).toEqual(payload.result);
  expect(parseMcpResponse(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, "text/event-stream", 2)).toEqual(payload.result);
});

test("MCP performs real HTTP initialize and tools/list with bearer", async () => {
  const methods: string[] = [];
  let checks = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer scoped") return new Response("", { status: 401 });
    const body = await request.json() as { id: number; method: string };
    methods.push(body.method);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [{ name: "cleanup_list_candidates", inputSchema: { type: "object" } }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "bara-memory", version: "1" } } });
  } });
  try {
    const client = new McpClient(`http://127.0.0.1:${server.port}`, "scoped", new AbortController().signal, async () => { checks++; });
    const tools = await client.listTools();
    expect(tools[0]?.name).toBe("cleanup_list_candidates");
    expect(methods).toEqual(["initialize", "tools/list"]);
    expect(checks).toBe(2); // one check before each of the two requests
  } finally { server.stop(true); }
});

// WP-PFIX-5: `beforeRequest` is the credential-route check and is required. Its refusal must stop the
// request before the bearer leaves, and its error is the one the caller sees.
test("a refusal from beforeRequest stops the request before any bearer is sent", async () => {
  let received = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { received++; return new Response("", { status: 500 }); } });
  try {
    const refused = Object.assign(new Error("route not verified"), { code: "SSH_TUNNEL_UNVERIFIED" });
    const client = new McpClient(`http://127.0.0.1:${server.port}`, "scoped", new AbortController().signal, async () => { throw refused; });
    await expect(client.listTools()).rejects.toBe(refused);
    expect(received).toBe(0);
  } finally { server.stop(true); }
});
