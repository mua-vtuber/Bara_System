import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEANUP_AI_FAILURE_CODES, CleanupService, cleanupAiFailure } from "../src/service/cleanup.ts";
import { HTTP_STATUS_FAILURE_CODES, MemoryClient, requestJson } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { ServiceError } from "../src/service/errors.ts";
import { FETCH_FAILURE_CODES } from "../src/service/fetch-failure.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { McpClient } from "../src/service/mcp.ts";
import { cleanupFailureReason, cleanupResultText } from "../src/ui/cleanup.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// WP-PFIX-10: a cleanup run lists what each skipped stage met. A request to the cleanup AI's own server that
// got no answer used to read as "TIMEOUT: ..." or "REDIRECT: ...", indistinguishable from the cleanup server;
// and a cleanup tool's own sentence reached the screen as it came. Real loopback listeners and the real
// `CleanupService`/`McpClient`/`ConfigStore` throughout; nothing is replaced by a fake.

const SECRET = "pfix10-authored-tool-secret";
const TIMEOUT_MS = 300;
const windowsOnly = test.skipIf(process.platform !== "win32");
const fresh = () => new AbortController();
const failureOf = async (run: Promise<unknown>): Promise<ServiceError> => {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
};
const TOOLS = [
  { name: "cleanup_list_candidates", inputSchema: { type: "object", properties: { stage: { type: "string", enum: ["regexStrengthen", "personLink", "lensDraft", "entityRegister"] }, limit: {} } } },
  { name: "cleanup_submit_proposal", inputSchema: { type: "object", properties: { kind: {}, payload: {}, candidate: {} } } },
  { name: "cleanup_report_no_finding", inputSchema: { type: "object", properties: { stage: {}, targetKey: {}, inputFingerprint: {}, stageVersion: {} } } },
];
const PERSON = { targetKey: "12", inputFingerprint: "a".repeat(64), stageVersion: 1, content: { nodeId: 12, topKPersonIds: ["p1"] } };

/** A cleanup server speaking the JSON-RPC shape `McpClient` sends; `listCandidates` answers each stage. */
function cleanupServer(listCandidates: (stage: string) => Record<string, unknown>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { id: number; method: string; params?: { name?: string; arguments?: { stage?: string } } };
    const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") return respond({ protocolVersion: "2025-06-18", serverInfo: { name: "bara-memory" } });
    if (body.method === "tools/list") return respond({ tools: TOOLS });
    if (body.params?.name === "cleanup_list_candidates") {
      const outcome = listCandidates(body.params.arguments?.stage ?? "");
      return respond(outcome.isError === true ? outcome : { content: [{ type: "text", text: JSON.stringify(outcome) }] });
    }
    return respond({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

async function cleanupService(baseUrl: string, aiBaseUrl: string): Promise<{ cleanup: CleanupService; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pet-pfix10-cleanup-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token",
    ai: { provider: "ollama", baseUrl: aiBaseUrl, model: "authored-test-model" }, cleanup: { provider: "ollama", model: "authored-test-model" } });
  return { cleanup: new CleanupService(config, new MemoryClient(config, new CredentialRoutes(new LocalServer()))), dir };
}

test("a request to the cleanup AI's own server that got no answer is named as the cleanup AI's failure, in Korean", async () => {
  const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const redirecting = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect("http://127.0.0.1:9/elsewhere", 302) });
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const closedUrl = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  try {
    const cases = [
      { error: await failureOf(requestJson(`http://127.0.0.1:${silent.port}`, null, "POST", "/api/chat", {}, fresh().signal, TIMEOUT_MS)),
        from: FETCH_FAILURE_CODES.timeout, code: CLEANUP_AI_FAILURE_CODES.timeout, text: messages.cleanupService.aiServer.timedOut },
      { error: await failureOf(requestJson(`http://127.0.0.1:${redirecting.port}`, null, "POST", "/api/chat", {}, fresh().signal)),
        from: FETCH_FAILURE_CODES.redirect, code: CLEANUP_AI_FAILURE_CODES.redirect, text: messages.cleanupService.aiServer.redirected },
      { error: await failureOf(requestJson(closedUrl, null, "POST", "/api/chat", {}, fresh().signal, TIMEOUT_MS)),
        from: FETCH_FAILURE_CODES.network, code: CLEANUP_AI_FAILURE_CODES.network, text: messages.cleanupService.aiServer.networkFailed },
    ];
    for (const { error, from, code, text } of cases) {
      expect(error.code).toBe(from);
      const renamed = cleanupAiFailure(error) as ServiceError;
      expect({ code: renamed.code, text: renamed.publicMessage }).toEqual({ code, text });
      const reason = cleanupFailureReason({ stage: "personLink", code: renamed.code, message: renamed.publicMessage });
      expect(reason).toBe(messages.cleanup.failureReasons[code]!);
      expect(reason).toContain("정리 AI");
      for (const bare of ["TIMEOUT", "REDIRECT", "NETWORK", "MCP_"]) expect(reason).not.toContain(bare);
    }
  } finally { silent.stop(true); redirecting.stop(true); }
  // Any other failure of the decision call passes through as it was.
  const other = new ServiceError("AI_RESPONSE", messages.aiService.responseFormat);
  expect(cleanupAiFailure(other)).toBe(other);
  const plain = new Error("plain");
  expect(cleanupAiFailure(plain)).toBe(plain);
}, 30_000);

windowsOnly("a cleanup run whose AI server redirects records the cleanup AI's failure and never follows it", async () => {
  let followed = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { followed++; return Response.json({}); } });
  const ai = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/elsewhere`, 302) });
  const fixture = cleanupServer((stage) => ({ stage, candidates: stage === "personLink" ? [PERSON] : [] }));
  const { cleanup, dir } = await cleanupService(fixture.baseUrl, `http://127.0.0.1:${ai.port}`);
  try {
    const result = await cleanup.run({ limit: 5 }, { signal: fresh().signal, progress() {} });
    expect(result).toMatchObject({ submitted: 0, noFinding: 0, skipped: 1 });
    expect(result.failures).toEqual([{ stage: "personLink", code: CLEANUP_AI_FAILURE_CODES.redirect, message: messages.cleanupService.aiServer.redirected }]);
    const text = cleanupResultText(result);
    expect(text).toContain(messages.cleanup.failureReasons.CLEANUP_AI_REDIRECT!);
    expect(text).not.toContain("REDIRECT");
    expect(followed).toBe(0);
  } finally { fixture.server.stop(true); ai.stop(true); target.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

windowsOnly("a cleanup tool failure whose sentence holds an address reaches the screen without its query, fragment or user information", async () => {
  const address = `http://toolUser:toolPass@127.0.0.1:41031/mcp/cleanup?token=${SECRET}#${SECRET}`;
  const fixture = cleanupServer((stage) => stage === "lensDraft"
    ? { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "INTERNAL", message: `upstream failed at ${address} (retry later)` }) }] }
    : { stage, candidates: [] });
  const ai = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: 404 }) });
  const { cleanup, dir } = await cleanupService(fixture.baseUrl, `http://127.0.0.1:${ai.port}`);
  try {
    const result = await cleanup.run({ limit: 5 }, { signal: fresh().signal, progress() {} });
    expect(result.failures).toEqual([{ stage: "lensDraft", code: "INTERNAL", message: "upstream failed at http://127.0.0.1:41031/mcp/cleanup (retry later)" }]);
    const shown = cleanupResultText(result);
    for (const hidden of [SECRET, "toolUser", "toolPass"]) {
      expect(JSON.stringify(result)).not.toContain(hidden);
      expect(shown).not.toContain(hidden);
    }
  } finally { fixture.server.stop(true); ai.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// WP-PFIX-11 (Minor): the code a cleanup tool failure names is the server's word and is shown on the screen
// next to its sentence, so a code that is not shaped like a service code is not shown at all.
const toolFailureText = (payload: unknown): string => typeof payload === "string" ? payload : JSON.stringify(payload);
/** The failure `McpClient.call` throws when a real cleanup server answers with this tool failure text. */
async function toolFailureFor(payload: unknown): Promise<ServiceError> {
  const fixture = cleanupServer(() => ({ isError: true, content: [{ type: "text", text: toolFailureText(payload) }] }));
  try { return await failureOf(new McpClient(fixture.baseUrl, "authored-test-token", fresh().signal, async () => {}).call("cleanup_list_candidates", { stage: "personLink", limit: 1 })); }
  finally { fixture.server.stop(true); }
}

test("a cleanup tool failure keeps its code only when it is shaped like a service code, and its sentence goes through the cause check", async () => {
  expect(await toolFailureFor({ code: "INTERNAL", message: "제안 등록 실패: database is locked" }))
    .toMatchObject({ code: "INTERNAL", publicMessage: "제안 등록 실패: database is locked" });
  expect(await toolFailureFor({ code: "A".repeat(64), message: "longest" })).toMatchObject({ code: "A".repeat(64) });
  const unusable: unknown[] = [`see http://h/?pickupSecret=${SECRET} bara-token=${SECRET}`, "lower_case", "A", "A".repeat(65), "", " INTERNAL", "INTERNAL\n",
    "TWO WORDS", "KO_가나", 42, null, true, ["INTERNAL"], { nested: "INTERNAL" }];
  for (const code of unusable) {
    const error = await toolFailureFor({ code, message: `failed at http://u:p@h/x?k=${SECRET}` });
    expect({ code: error.code, text: error.publicMessage }).toEqual({ code: "MCP_TOOL_ERROR", text: "failed at http://h/x" });
    const reason = cleanupFailureReason({ stage: "personLink", code: error.code, message: error.publicMessage });
    expect(reason).toBe(messages.cleanup.failureWithCause("MCP_TOOL_ERROR", "failed at http://h/x"));
    expect(JSON.stringify(error)).not.toContain(SECRET);
  }
  // No JSON envelope at all, or one without a sentence: the text itself is the cause, checked the same way.
  expect(await toolFailureFor("plain failure at http://h/x?k=1")).toMatchObject({ code: "MCP_TOOL_ERROR", publicMessage: "plain failure at http://h/x" });
  expect(await toolFailureFor({ code: "INTERNAL" })).toMatchObject({ code: "INTERNAL", publicMessage: JSON.stringify({ code: "INTERNAL" }) });
  expect(await toolFailureFor([1, 2])).toMatchObject({ code: "MCP_TOOL_ERROR", publicMessage: "[1,2]" });
}, 30_000);

// WP-PFIX-13 (M4): a tool sentence of nothing but spaces or characters that show nothing comes out of the cause
// check empty, and the cleanup screen showed its code followed by nothing. It now says the sentence was empty.
test("a cleanup tool sentence that shows nothing reads on the screen as an empty cause sentence", async () => {
  for (const sentence of ["", "   ", "\u200b\ufeff\u00ad", "\u202e\n\t"]) {
    const error = await toolFailureFor({ code: "INTERNAL", message: sentence });
    expect({ sentence, code: error.code, text: error.publicMessage }).toEqual({ sentence, code: "INTERNAL", text: "" });
    expect(cleanupFailureReason({ stage: "lensDraft", code: error.code, message: error.publicMessage }))
      .toBe(`INTERNAL: ${messages.serverClient.causeEmpty}`);
  }
}, 30_000);

windowsOnly("a cleanup run that meets a tool failure with an unusable code lists it as MCP_TOOL_ERROR, never the server's text as its code", async () => {
  const code = `see http://h/?pickupSecret=${SECRET}`;
  const fixture = cleanupServer((stage) => stage === "regexStrengthen"
    ? { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message: "m" }) }] } : { stage, candidates: [] });
  const ai = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: 404 }) });
  const { cleanup, dir } = await cleanupService(fixture.baseUrl, `http://127.0.0.1:${ai.port}`);
  try {
    const result = await cleanup.run({ limit: 5 }, { signal: fresh().signal, progress() {} });
    expect(result.failures).toEqual([{ stage: "regexStrengthen", code: "MCP_TOOL_ERROR", message: "m" }]);
    expect(cleanupResultText(result)).not.toContain(SECRET);
    expect(cleanupResultText(result)).not.toContain("see http");
  } finally { fixture.server.stop(true); ai.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// WP-PFIX-11 (Minor): a 401 from the cleanup AI's server (a wrong AI key) used to read "AUTH_REQUIRED: server
// authentication needed", as if the memory server had refused; the other failures of that request kept the
// memory server's wording too. Every failure of the request is the cleanup AI's, from real answers.
const SSH_BANNER = "SSH-2.0-OpenSSH_9.6\r\n";
const statusServer = (status: number) => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}", { status }) });
const sshListener = () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.write(SSH_BANNER); socket.end(); } } });

test("every failure of the request to the cleanup AI's server is renamed to the cleanup AI's and says so in Korean", async () => {
  const servers = new Map([401, 403, 400, 404, 409, 500, 503].map((status) => [status, statusServer(status)] as const));
  const ssh = sshListener();
  try {
    const fixed = [[401, "AUTH_REQUIRED", CLEANUP_AI_FAILURE_CODES.authRequired, messages.cleanupService.aiServer.authRejected],
      [403, "FORBIDDEN", CLEANUP_AI_FAILURE_CODES.forbidden, messages.cleanupService.aiServer.forbidden],
      ...[400, 404, 409, 500, 503].map((status) => [status, status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "SERVER_ERROR",
        CLEANUP_AI_FAILURE_CODES.httpFailed, messages.cleanupService.aiServer.httpFailed] as const)] as const;
    for (const [status, from, code, text] of fixed) {
      const error = await failureOf(requestJson(`http://127.0.0.1:${servers.get(status)!.port}`, "authored-ai-key", "POST", "/v1/chat/completions", {}, fresh().signal));
      expect({ status, code: error.code }).toEqual({ status, code: from });
      const renamed = cleanupAiFailure(error) as ServiceError;
      expect({ status, code: renamed.code, text: renamed.publicMessage }).toEqual({ status, code, text });
      const reason = cleanupFailureReason({ stage: "personLink", code: renamed.code, message: renamed.publicMessage });
      expect(reason).toBe(messages.cleanup.failureReasons[code]!);
      expect(reason).toContain("정리 AI");
      for (const memoryServerWording of [from, messages.serverClient.http.authRequired, messages.serverClient.http.forbidden, messages.serverClient.http.notFound]) expect(reason).not.toContain(memoryServerWording);
    }
    // An answer that is not HTTP, and an exception no code names: the cause sentence stays, said as the cleanup AI's.
    const notHttp = await failureOf(requestJson(`http://127.0.0.1:${ssh.port}`, null, "POST", "/api/chat", {}, fresh().signal));
    const unexpected = await failureOf(requestJson(`http://127.0.0.1:${servers.get(500)!.port}`, null, "POST", "/api/chat", { unserializable: 1n }, fresh().signal));
    expect({ from: notHttp.code, unexpected: unexpected.code }).toEqual({ from: "SERVER_RESPONSE", unexpected: FETCH_FAILURE_CODES.unexpected });
    for (const [error, code] of [[notHttp, CLEANUP_AI_FAILURE_CODES.response], [unexpected, CLEANUP_AI_FAILURE_CODES.unexpected]] as const) {
      const renamed = cleanupAiFailure(error) as ServiceError;
      expect({ code: renamed.code, text: renamed.publicMessage }).toEqual({ code, text: messages.cleanupService.aiServer.failedWith(error.publicMessage) });
      const reason = cleanupFailureReason({ stage: "personLink", code: renamed.code, message: renamed.publicMessage });
      expect(reason).toBe(messages.cleanup.failureWithCause(code, renamed.publicMessage));
      expect(reason).toContain("정리 AI 서버");
    }
    expect(unexpected.publicMessage).toContain("BigInt");
    // Not the cleanup AI's server's doing: left as it was.
    for (const other of [new ServiceError("CANCELLED", messages.cleanupService.cancelled), new ServiceError("AI_NOT_CONFIGURED", messages.aiService.modelNeeded), new ServiceError("AI_RESPONSE", messages.aiService.responseFormat)])
      expect(cleanupAiFailure(other)).toBe(other);
  } finally { for (const server of servers.values()) server.stop(true); ssh.stop(true); }
}, 30_000);

// WP-PFIX-12 (Minor): the codes `requestJson` gives an HTTP status are one list (`HTTP_STATUS_FAILURE_CODES`,
// beside its status table), which `cleanupAiFailure` reads; it used to keep a second list by hand, so a code
// added to the table alone reached the cleanup screen as the memory server's.
test("every code requestJson gives an HTTP status is renamed to the cleanup AI's, read from the one list", () => {
  for (const code of Object.values(HTTP_STATUS_FAILURE_CODES)) {
    const renamed = cleanupAiFailure(new ServiceError(code, messages.serverClient.http.failed(500))) as ServiceError;
    expect({ code, renamedTo: renamed.code, isCleanupAi: (Object.values(CLEANUP_AI_FAILURE_CODES) as string[]).includes(renamed.code) })
      .toEqual({ code, renamedTo: renamed.code, isCleanupAi: true });
    expect(cleanupFailureReason({ stage: "personLink", code: renamed.code, message: renamed.publicMessage })).toContain("정리 AI");
  }
});

windowsOnly("a cleanup run whose AI server refuses the key, or is not an HTTP server, lists the cleanup AI's failure", async () => {
  const refusing = statusServer(401);
  const ssh = sshListener();
  const fixture = cleanupServer((stage) => ({ stage, candidates: stage === "personLink" ? [PERSON] : [] }));
  try {
    for (const [aiBaseUrl, failure] of [
      [`http://127.0.0.1:${refusing.port}`, { code: CLEANUP_AI_FAILURE_CODES.authRequired, message: messages.cleanupService.aiServer.authRejected }],
      [`http://127.0.0.1:${ssh.port}`, { code: CLEANUP_AI_FAILURE_CODES.response, message: messages.cleanupService.aiServer.failedWith(messages.serverClient.responseMalformed) }],
    ] as const) {
      const { cleanup, dir } = await cleanupService(fixture.baseUrl, aiBaseUrl);
      try {
        const result = await cleanup.run({ limit: 5 }, { signal: fresh().signal, progress() {} });
        expect(result).toMatchObject({ submitted: 0, noFinding: 0, skipped: 1 });
        expect(result.failures).toEqual([{ stage: "personLink", ...failure }]);
        const shown = cleanupResultText(result);
        expect(shown).toContain("정리 AI");
        expect(shown).not.toContain(messages.serverClient.http.authRequired);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  } finally { refusing.stop(true); ssh.stop(true); fixture.server.stop(true); }
}, 30_000);
