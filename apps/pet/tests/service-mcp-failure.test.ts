import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupService } from "../src/service/cleanup.ts";
import { MemoryClient } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { ServiceError } from "../src/service/errors.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { MCP_FAILURE_CODES, McpClient } from "../src/service/mcp.ts";
import { cleanupFailureReason } from "../src/ui/cleanup.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// WP-PFIX-9: `McpClient.rpc` used to answer every exception of a request with "could not connect to the
// cleanup server", so a 302 (the server did answer), a time limit that ran out, and a header or body the
// Pet itself could not build all looked like a dead connection. Each cause now says what it was. Every case
// runs the real `McpClient` against a real loopback listener or a real closed port; nothing is replaced by a fake.

const TIMEOUT_MS = 300;
const TOKEN = "scoped";
const fresh = () => new AbortController();
const noCheck = async () => {};
const failureOf = async (run: Promise<unknown>): Promise<ServiceError> => {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
};
/** The client under test, pointed at `baseUrl`. `timeoutMs` shortens the time limit a silent server would take. */
const clientFor = (baseUrl: string, signal: AbortSignal, timeoutMs = TIMEOUT_MS, token = TOKEN) =>
  new McpClient(baseUrl, token, signal, noCheck, timeoutMs);

/** A listener that accepts a request and never answers it. */
function silentServer() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}
/** The address of a port nothing listens on any more. */
function closedPortUrl(): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return baseUrl;
}
/** Answers every request with a 302 to a second listener, which counts the requests (and bearers) that arrive there. */
function redirectingServer() {
  let followed = 0, hits = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { followed++; return Response.json({ ok: true }); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    hits++;
    return Response.redirect(new URL("/elsewhere", `http://127.0.0.1:${target.port}`), 302);
  } });
  return { baseUrl: `http://127.0.0.1:${server.port}`, hits: () => hits, followed: () => followed,
    stop: () => { server.stop(true); target.stop(true); } };
}
/** Sends the status line and headers of a 100-byte answer, then one byte of it, and goes quiet: `fetch`
 * resolves, and only the read of the body stalls. */
function stalledBodyServer() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(socket) { socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"); },
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}
/** A cleanup server that answers `initialize` and `tools/list` and records every method it was asked. */
function toolsServer() {
  const methods: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { id: number; method: string };
    methods.push(body.method);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list"
      ? { tools: [{ name: "cleanup_list_candidates", inputSchema: { type: "object" } }] }
      : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "bara-memory", version: "1" } } });
  } });
  return { server, methods, baseUrl: `http://127.0.0.1:${server.port}` };
}

test("a 302 is reported as a redirect the server answered with, and the bearer is never followed to the new address", async () => {
  const redirecting = redirectingServer();
  try {
    const error = await failureOf(clientFor(redirecting.baseUrl, fresh().signal).listTools());
    expect(error.code).toBe(MCP_FAILURE_CODES.redirect);
    expect(error.publicMessage).toBe(messages.cleanupService.mcp.redirected);
    expect(error.publicMessage).not.toBe(messages.cleanupService.mcp.networkFailed);
    expect(redirecting.hits()).toBe(1);
    expect(redirecting.followed()).toBe(0);
  } finally { redirecting.stop(); }
});

test("a server that never answers is reported as a time-out, not as a failed connection", async () => {
  const { server, baseUrl } = silentServer();
  try {
    const error = await failureOf(clientFor(baseUrl, fresh().signal).listTools());
    expect(error.code).toBe(MCP_FAILURE_CODES.timeout);
    expect(error.publicMessage).toBe(messages.cleanupService.mcp.timedOut);
    expect(error.publicMessage).not.toBe(messages.cleanupService.mcp.networkFailed);
  } finally { server.stop(true); }
});

test("a closed port is reported as a failed connection", async () => {
  const error = await failureOf(clientFor(closedPortUrl(), fresh().signal).listTools());
  expect(error.code).toBe(MCP_FAILURE_CODES.network);
  expect(error.publicMessage).toBe(messages.cleanupService.mcp.networkFailed);
});

test("a server that drops the connection before answering is reported as a failed connection", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.terminate(); }, data() {} } });
  try {
    const error = await failureOf(clientFor(`http://127.0.0.1:${server.port}`, fresh().signal, TIMEOUT_MS * 10).listTools());
    expect(error.code).toBe(MCP_FAILURE_CODES.network);
    expect(error.publicMessage).toBe(messages.cleanupService.mcp.networkFailed);
  } finally { server.stop(true); }
});

test("a cancelled request stays a cancellation, whether it was cancelled before or while the server stays silent", async () => {
  const { server, baseUrl } = silentServer();
  try {
    const before = fresh(); before.abort();
    expect((await failureOf(clientFor(baseUrl, before.signal).listTools())).code).toBe("CANCELLED");
    const during = fresh();
    setTimeout(() => during.abort(), TIMEOUT_MS / 3);
    const error = await failureOf(clientFor(baseUrl, during.signal, TIMEOUT_MS * 10).listTools());
    expect(error.code).toBe("CANCELLED");
    expect(error.publicMessage).toBe(messages.cleanupService.cancelled);
  } finally { server.stop(true); }
});

test("a body that stalls after the answer began is a time-out, and a cancellation while it stalls is a cancellation", async () => {
  const { server, baseUrl } = stalledBodyServer();
  try {
    const slow = await failureOf(clientFor(baseUrl, fresh().signal).listTools());
    expect(slow.code).toBe(MCP_FAILURE_CODES.timeout);
    expect(slow.publicMessage).toBe(messages.cleanupService.mcp.timedOut);
    const during = fresh();
    setTimeout(() => during.abort(), TIMEOUT_MS / 3);
    expect((await failureOf(clientFor(baseUrl, during.signal, TIMEOUT_MS * 10).listTools())).code).toBe("CANCELLED");
  } finally { server.stop(true); }
});

test("a token that cannot be a header value reports a defect, without showing the token, and sends nothing", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json({}); } });
  try {
    const error = await failureOf(clientFor(`http://127.0.0.1:${server.port}`, fresh().signal, TIMEOUT_MS, "line\nbreak-token").listTools());
    expect(error.code).toBe(MCP_FAILURE_CODES.unexpected);
    // The engine's own sentence quotes the header value, so it is withheld and says it was.
    expect(error.publicMessage).toBe(messages.cleanupService.mcp.requestUnexpected(messages.serverClient.causeWithheld));
    expect(error.publicMessage).not.toContain("break-token");
    expect(error.publicMessage).not.toBe(messages.cleanupService.mcp.networkFailed);
    expect(hits).toBe(0);
  } finally { server.stop(true); }
});

test("arguments the Pet cannot serialize report their own cause and send no tool call", async () => {
  const { server, methods, baseUrl } = toolsServer();
  let engineCause = "";
  try { JSON.stringify({ value: 1n }); } catch (thrown) { engineCause = String(thrown); }
  expect(engineCause).toContain("TypeError");
  try {
    const error = await failureOf(clientFor(baseUrl, fresh().signal).call("cleanup_list_candidates", { value: 1n }));
    expect(error.code).toBe(MCP_FAILURE_CODES.unexpected);
    expect(error.publicMessage).toBe(messages.cleanupService.mcp.requestUnexpected(engineCause));
    expect(error.publicMessage).not.toBe(messages.cleanupService.mcp.networkFailed);
    expect(methods).toEqual(["initialize", "tools/list"]);
  } finally { server.stop(true); }
});

test("the credential-route check still runs first and its refusal is not reclassified", async () => {
  const redirecting = redirectingServer();
  try {
    const refused = Object.assign(new Error("route not verified"), { code: "SSH_TUNNEL_UNVERIFIED" });
    const client = new McpClient(redirecting.baseUrl, TOKEN, fresh().signal, async () => { throw refused; }, TIMEOUT_MS);
    await expect(client.listTools()).rejects.toBe(refused);
    expect(redirecting.hits()).toBe(0);
  } finally { redirecting.stop(); }
});

// The screen shows the failure list of a run through `cleanupFailureReason`: each of these codes has to read
// as Korean text, or (for the one that carries a cause of its own) as the code with that cause.
test("every code an unanswered request gets reads in Korean on the cleanup screen", () => {
  expect(Object.keys(MCP_FAILURE_CODES).sort()).toEqual(["network", "redirect", "timeout", "unexpected"]);
  for (const [kind, code] of Object.entries(MCP_FAILURE_CODES)) {
    const text = cleanupFailureReason({ stage: "personLink", code, message: "cause sentence" });
    if (kind === "unexpected") {
      expect(text).toBe(messages.cleanup.failureWithCause(code, "cause sentence"));
    } else {
      expect(text).toBe(messages.cleanup.failureReasons[code]!);
      expect(text).not.toContain(code);
    }
  }
});

// The same causes through a whole cleanup run: the stage that met the redirect is skipped with its own
// code and sentence, and the other stages still run.
const windowsOnly = test.skipIf(process.platform !== "win32");

windowsOnly("a cleanup run records a redirect on one stage as that stage's failure and reads it in Korean", async () => {
  let followed = 0, aiHits = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { followed++; return Response.json({ ok: true }); } });
  const ai = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { aiHits++; return new Response("", { status: 404 }); } });
  const tools = ["cleanup_list_candidates", "cleanup_submit_proposal", "cleanup_report_no_finding"];
  const fields: Record<string, string[]> = { cleanup_list_candidates: ["stage", "limit"], cleanup_submit_proposal: ["kind", "payload", "candidate"],
    cleanup_report_no_finding: ["stage", "targetKey", "inputFingerprint", "stageVersion"] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { id: number; method: string; params?: { arguments?: { stage?: string } } };
    const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") return respond({ protocolVersion: "2025-06-18", serverInfo: { name: "bara-memory" } });
    if (body.method === "tools/list") return respond({ tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: Object.fromEntries(fields[name]!.map((field) => [field, field === "stage" ? { type: "string", enum: ["regexStrengthen", "personLink", "lensDraft", "entityRegister"] } : {}])) } })) });
    const stage = body.params?.arguments?.stage;
    if (stage === "personLink") return Response.redirect(new URL("/elsewhere", `http://127.0.0.1:${target.port}`), 302);
    return respond({ content: [{ type: "text", text: JSON.stringify({ stage, candidates: [] }) }] });
  } });
  const dir = mkdtempSync(join(tmpdir(), "pet-mcp-failure-"));
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const aiBaseUrl = `http://127.0.0.1:${ai.port}`;
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token",
      ai: { provider: "ollama", baseUrl: aiBaseUrl, model: "authored-test-model" }, cleanup: { provider: "ollama", model: "authored-test-model" } });
    const cleanup = new CleanupService(config, new MemoryClient(config, new CredentialRoutes(new LocalServer())));
    const result = await cleanup.run({ limit: 5 }, { signal: fresh().signal, progress() {} });
    expect(result).toMatchObject({ submitted: 0, noFinding: 0, skipped: 1 });
    expect(result.failures).toEqual([{ stage: "personLink", code: MCP_FAILURE_CODES.redirect, message: messages.cleanupService.mcp.redirected }]);
    expect(cleanupFailureReason(result.failures![0]!)).toBe(messages.cleanup.failureReasons.MCP_REDIRECT!);
    expect(followed).toBe(0);
    expect(aiHits).toBe(0);
  } finally { server.stop(true); target.stop(true); ai.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
