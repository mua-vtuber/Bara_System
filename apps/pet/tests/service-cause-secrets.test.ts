import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiClient } from "../src/service/ai.ts";
import { MemoryClient, requestJson } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { ServiceError } from "../src/service/errors.ts";
import { causeOf, classifyFetchFailure } from "../src/service/fetch-failure.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { McpClient } from "../src/service/mcp.ts";
import { publicError } from "../src/service/protocol.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// WP-PFIX-10: Bun puts the whole request address into the sentence of some request failures. The pickup
// check sends the enrollment's `pickupSecret` in that address's query string, so an answer that was not HTTP
// carried the secret through `causeOf` into the settings screen. Every case runs real requests against real
// loopback listeners and the real service objects; nothing is replaced by a fake.

const SECRET = "pfix10-authored-pickup-secret";
const SSH_BANNER = "SSH-2.0-OpenSSH_9.6\r\n";
const windowsOnly = test.skipIf(process.platform !== "win32");
const fresh = () => new AbortController();
const failureOf = async (run: Promise<unknown>): Promise<ServiceError> => {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
};
/** Every place the error's text can travel: the thrown error itself, its public text, and the RPC error
 * frame `main.ts` sends to the screen (`publicError`). */
const textsOf = (error: ServiceError): string[] =>
  [String(error), error.message, error.publicMessage, error.stack ?? "", JSON.stringify(error), JSON.stringify(publicError(error))];

/** A raw TCP listener that answers each connection's first bytes with `answer` (a program that is not an
 * HTTP server, or one that breaks HTTP), so the request reaches a real socket. */
function rawListener(answer: (socket: Bun.Socket<undefined>) => void) {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { answer(socket); } } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}
const writeAndClose = (bytes: string) => (socket: Bun.Socket<undefined>) => { socket.write(bytes); socket.end(); };
const writeThenLater = (first: string, later: string) => (socket: Bun.Socket<undefined>) => {
  socket.write(first);
  setTimeout(() => { socket.write(later); socket.end(); }, 50);
};

/** Answers that Bun 1.3.6 reports as a broken HTTP answer or an undecodable body, each reproduced on this
 * runtime with the code it gives: before the response resolves, and while its body streams in. */
const NOT_HTTP_ANSWERS: Record<string, (socket: Bun.Socket<undefined>) => void> = {
  "an SSH banner (Malformed_HTTP_Response)": writeAndClose(SSH_BANNER),
  "a status line without a status (Malformed_HTTP_Response)": writeAndClose("HTTP/1.1 abc OK\r\n\r\n"),
  "broken chunk framing (InvalidHTTPResponse)": writeAndClose("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\nabc\r\n"),
  "broken chunk framing after the first chunk (InvalidHTTPResponse, body)": writeThenLater(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabcde\r\n", "ZZ\r\nxx\r\n"),
  "a gzip body that is not gzip (ZlibError)": writeAndClose("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 10\r\n\r\n0123456789"),
  "a gzip body that turns out not to be gzip (ZlibError, body)": writeThenLater(
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n", "a\r\n0123456789\r\n0\r\n\r\n"),
  "a brotli body that is not brotli (BrotliDecompressionError)": writeAndClose("HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 10\r\n\r\n0123456789"),
  "a zstd body that is not zstd (ZstdDecompressionError)": writeAndClose("HTTP/1.1 200 OK\r\nContent-Encoding: zstd\r\nContent-Length: 10\r\n\r\n0123456789"),
};

windowsOnly("a pickup check answered by a program that is not an HTTP server is a server-response error that never carries the pickup secret", async () => {
  const listener = rawListener(writeAndClose(SSH_BANNER));
  const dir = mkdtempSync(join(tmpdir(), "pet-pfix10-pickup-"));
  try {
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl: listener.baseUrl } });
    const { settings } = await config.snapshot();
    await config.setEnrollment(JSON.stringify({ requestId: "req-1", pickupSecret: SECRET, baseUrl: listener.baseUrl }), settings.connection);
    const client = new MemoryClient(config, new CredentialRoutes(new LocalServer()));
    const error = await failureOf(client.enrollmentPoll({ signal: fresh().signal, progress() {} }));
    expect(error.code).toBe("SERVER_RESPONSE");
    expect(error.publicMessage).toBe(messages.serverClient.responseMalformed);
    expect(publicError(error)).toEqual({ code: "SERVER_RESPONSE", message: messages.serverClient.responseMalformed });
    for (const text of textsOf(error)) expect(text).not.toContain(SECRET);
    // The enrollment survives: the server never answered, so the user can check again once it does.
    expect(await config.getEnrollment()).toContain(SECRET);
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("every Bun answer that is not HTTP, or whose body cannot be decoded, is a server-response error without the address", async () => {
  for (const [name, answer] of Object.entries(NOT_HTTP_ANSWERS)) {
    const listener = rawListener(answer);
    try {
      const raw = await fetch(`${listener.baseUrl}/probe?pickupSecret=${SECRET}`, { redirect: "error" })
        .then((response) => response.text()).then(() => null, (error: unknown) => error);
      expect({ name, kind: classifyFetchFailure(raw, fresh().signal) }).toEqual({ name, kind: "malformed" });
      const memory = await failureOf(requestJson(listener.baseUrl, null, "GET", `/adapter-enroll/req-1/token?pickupSecret=${SECRET}`, undefined, fresh().signal));
      expect({ name, code: memory.code, text: memory.publicMessage }).toEqual({ name, code: "SERVER_RESPONSE", text: messages.serverClient.responseMalformed });
      for (const text of textsOf(memory)) expect(text).not.toContain(SECRET);
      const mcp = await failureOf(new McpClient(listener.baseUrl, SECRET, fresh().signal, async () => {}).listTools());
      expect({ name, code: mcp.code, text: mcp.publicMessage }).toEqual({ name, code: "MCP_RESPONSE", text: messages.cleanupService.mcp.responseMalformed });
      for (const text of textsOf(mcp)) expect(text).not.toContain(SECRET);
    } finally { listener.server.stop(true); }
  }
}, 30_000);

test("a cause sentence keeps each address's host and path and drops its query string, fragment and user information", async () => {
  const listener = rawListener(writeAndClose(SSH_BANNER));
  try {
    const address = new URL(`http://pfix10user:pfix10password@127.0.0.1:${listener.server.port}/adapter-enroll/req-1/token?pickupSecret=${SECRET}#pfix10fragment`);
    const raw = await fetch(address, { redirect: "error" }).then(() => null, (error: unknown) => error);
    expect(String(raw)).toContain(address.href); // Bun's own sentence holds the whole address
    const cause = causeOf(raw);
    expect(cause).toBe(String(raw).replace(address.href, `http://127.0.0.1:${listener.server.port}/adapter-enroll/req-1/token`));
    for (const hidden of [SECRET, "pfix10user", "pfix10password", "pfix10fragment", "?", "#"]) expect(cause).not.toContain(hidden);
  } finally { listener.server.stop(true); }
  // Every address of a sentence, whatever its scheme, case or position; an address without such parts stays whole.
  expect(causeOf(new Error(`two http://a:b@h1:1/p?k=${SECRET} and HTTPS://h2/q#${SECRET} and ws://h3?x=${SECRET}, done`)))
    .toBe("Error: two http://h1:1/p and HTTPS://h2/q and ws://h3 done");
  expect(causeOf(new Error("refused http://127.0.0.1:41031/client-info"))).toBe("Error: refused http://127.0.0.1:41031/client-info");
  // Text shaped like a credential outside an address is still withheld as a whole.
  expect(causeOf(new Error("header Bearer abc"))).toBe(messages.serverClient.causeWithheld);
  expect(causeOf(new Error("cookie bara-token=abc"))).toBe(messages.serverClient.causeWithheld);
});

test("a body the connection drops partway names its cause, and a body over the size limit says it is too large", async () => {
  const dropped = rawListener(writeAndClose(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"a":1}`));
  try {
    const raw = await fetch(`${dropped.baseUrl}/x`).then((response) => response.text()).then(() => null, (error: unknown) => error);
    expect(classifyFetchFailure(raw, fresh().signal)).toBe("network");
    const memory = await failureOf(requestJson(dropped.baseUrl, null, "GET", `/x?pickupSecret=${SECRET}`, undefined, fresh().signal));
    expect(memory.code).toBe("SERVER_RESPONSE");
    expect(memory.publicMessage).toBe(messages.serverClient.responseReadFailed(causeOf(raw)));
    expect(memory.publicMessage).toContain("socket connection was closed");
    const mcp = await failureOf(new McpClient(dropped.baseUrl, "scoped", fresh().signal, async () => {}).listTools());
    expect(mcp.code).toBe("MCP_RESPONSE");
    expect(mcp.publicMessage).toBe(messages.cleanupService.mcp.responseReadFailed(causeOf(raw)));
  } finally { dropped.server.stop(true); }
  // A streamed body states no length up front, so only the read itself can find it too large.
  const oversized = "x".repeat(2_000_001);
  const streaming = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); controller.close(); },
  }), { headers: { "content-type": "application/json" } }) });
  try {
    const memory = await failureOf(requestJson(`http://127.0.0.1:${streaming.port}`, null, "GET", "/x", undefined, fresh().signal));
    expect({ code: memory.code, text: memory.publicMessage }).toEqual({ code: "SERVER_RESPONSE", text: messages.serverClient.responseTooLarge });
    const mcp = await failureOf(new McpClient(`http://127.0.0.1:${streaming.port}`, "scoped", fresh().signal, async () => {}).listTools());
    expect({ code: mcp.code, text: mcp.publicMessage }).toEqual({ code: "MCP_RESPONSE", text: messages.cleanupService.mcp.responseTooLarge });
  } finally { streaming.stop(true); }
}, 30_000);

windowsOnly("the AI check names an answer that is not HTTP as not being a model list, without the request address", async () => {
  const listener = rawListener(writeAndClose(SSH_BANNER));
  const dir = mkdtempSync(join(tmpdir(), "pet-pfix10-ai-"));
  try {
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl: listener.baseUrl }, ai: { provider: "ollama", baseUrl: listener.baseUrl, model: "pfix10-model" } });
    const result = await new AiClient(config).probe("answer", { signal: fresh().signal, progress() {} });
    expect(result).toEqual({ available: false, models: [], reason: "connection-failed", message: messages.aiService.probe.notModelList(messages.serverClient.responseMalformed) });
    expect(result.message).not.toContain("127.0.0.1");
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

/** A listener that answers the enrollment request as a Bara server would and every later request with an
 * SSH banner: the pickup check then meets a port that another program took over. */
function enrollThenSshListener() {
  const received = new Map<Bun.Socket<undefined>, string>();
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(socket, data) {
      const text = (received.get(socket) ?? "") + Buffer.from(data).toString("latin1");
      received.set(socket, text);
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(text.slice(0, headerEnd))?.[1] ?? 0);
      if (text.length < headerEnd + 4 + length) return;
      if (!text.startsWith("POST /adapter-enroll ")) { socket.write(SSH_BANNER); socket.end(); return; }
      const body = JSON.stringify({ requestId: "req-1", pickupSecret: SECRET, status: "pending" });
      socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      socket.end();
    },
    close(socket) { received.delete(socket); },
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

interface RpcFrame { id: string; result?: unknown; error?: { code: string; message: string } }

/** The real `src/service/main.ts` process, driven over stdin/stdout as the native host drives it. The host
 * side of the vault protocol keeps values in a map, as `main.test.ts` does. Only frames answering a request
 * (`id`) go on to the screen; host frames stay on the private pipe and are kept apart. */
function startService(dataDir: string) {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "service", "main.ts")], {
    cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { ...process.env, BARA_PET_DATA_DIR: dataDir, BARA_PET_RESOURCES: dataDir },
  });
  const vault = new Map<string, string>();
  const screenFrames: string[] = [];
  const waiters = new Map<string, (frame: RpcFrame) => void>();
  const send = (frame: unknown) => { child.stdin.write(`${JSON.stringify(frame)}\n`); };
  const handle = (line: string) => {
    if (!line) return;
    const frame = JSON.parse(line);
    if (frame.host) {
      const { id, method, params } = frame.host;
      if (method === "vault.set") vault.set(params.key, params.value);
      if (method === "vault.delete") vault.delete(params.key);
      send({ hostReply: { id, result: method === "vault.get" ? vault.get(params.key) ?? null : null } });
      return;
    }
    if (frame.event) return;
    screenFrames.push(line);
    waiters.get(frame.id)?.(frame);
    waiters.delete(frame.id);
  };
  void (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += Buffer.from(value).toString("utf8");
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) { handle(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    }
  })();
  const call = (id: string, method: string, params: Record<string, unknown>) =>
    new Promise<RpcFrame>((resolve) => { waiters.set(id, resolve); send({ id, method, params }); });
  return { call, screenFrames, vault, stop: () => child.kill() };
}

test("the error frame the service process sends to the screen for that pickup check carries no secret", async () => {
  const listener = enrollThenSshListener();
  const dataDir = mkdtempSync(join(tmpdir(), "pet-pfix10-frame-"));
  const service = startService(dataDir);
  try {
    expect((await service.call("save", "settings.save", { connection: { mode: "existing", baseUrl: listener.baseUrl } })).error).toBeUndefined();
    expect((await service.call("start", "enrollment.start", {})).result).toMatchObject({ state: "pending", requestId: "req-1" });
    expect([...service.vault.values()].some((value) => value.includes(SECRET))).toBe(true); // the secret did reach the private store
    const polled = await service.call("poll", "enrollment.poll", {});
    expect(polled).toEqual({ id: "poll", error: { code: "SERVER_RESPONSE", message: messages.serverClient.responseMalformed } });
    expect(service.screenFrames.length).toBe(3);
    for (const frame of service.screenFrames) expect(frame).not.toContain(SECRET);
  } finally { service.stop(); listener.server.stop(true); rmSync(dataDir, { recursive: true, force: true }); }
}, 30_000);
