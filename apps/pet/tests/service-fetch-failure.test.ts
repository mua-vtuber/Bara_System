import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiClient, describeProbeFailure } from "../src/service/ai.ts";
import { MemoryClient, requestJson, requestRaw } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { ServiceError } from "../src/service/errors.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// WP-PFIX-8: `fetchGuarded` used to answer every exception of a request with "could not connect to the
// server", so a 302 (the server did answer), a time limit that ran out, and a header or body the Pet itself
// could not build all looked like a dead connection. Each cause now says what it was. Every case below runs
// against a real loopback listener or a real closed port; nothing is replaced by a fake.

const TIMEOUT_MS = 300;
const windowsOnly = test.skipIf(process.platform !== "win32");
const fresh = () => new AbortController();
const failureOf = async (run: Promise<unknown>): Promise<ServiceError> => {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
};

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
/** Answers every request with a 302 to a second listener, which counts the requests that arrive there. */
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

test("a 302 is reported as a redirect the server answered with, and is never followed", async () => {
  const redirecting = redirectingServer();
  try {
    const error = await failureOf(requestJson(redirecting.baseUrl, "secret", "GET", "/x", undefined, fresh().signal));
    expect(error.code).toBe("REDIRECT");
    expect(error.publicMessage).toBe(messages.serverClient.redirected);
    expect(error.publicMessage).not.toBe(messages.serverClient.networkFailed);
    expect(redirecting.hits()).toBe(1);
    expect(redirecting.followed()).toBe(0);
  } finally { redirecting.stop(); }
});

test("a server that never answers is reported as a time-out, not as a failed connection", async () => {
  const { server, baseUrl } = silentServer();
  try {
    const error = await failureOf(requestJson(baseUrl, "secret", "GET", "/x", undefined, fresh().signal, TIMEOUT_MS));
    expect(error.code).toBe("TIMEOUT");
    expect(error.publicMessage).toBe(messages.serverClient.timedOut);
    expect(error.publicMessage).not.toBe(messages.serverClient.networkFailed);
  } finally { server.stop(true); }
});

test("a closed port is reported as a failed connection", async () => {
  const error = await failureOf(requestJson(closedPortUrl(), "secret", "GET", "/x", undefined, fresh().signal, TIMEOUT_MS));
  expect(error.code).toBe("NETWORK");
  expect(error.publicMessage).toBe(messages.serverClient.networkFailed);
});

test("a server that drops the connection before answering is reported as a failed connection", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.terminate(); }, data() {} } });
  try {
    const error = await failureOf(requestJson(`http://127.0.0.1:${server.port}`, "secret", "GET", "/x", undefined, fresh().signal, TIMEOUT_MS * 10));
    expect(error.code).toBe("NETWORK");
    expect(error.publicMessage).toBe(messages.serverClient.networkFailed);
  } finally { server.stop(true); }
});

test("a cancelled request stays a cancellation, whether it was cancelled before or while the server stays silent", async () => {
  const { server, baseUrl } = silentServer();
  try {
    const before = fresh(); before.abort();
    expect((await failureOf(requestJson(baseUrl, "secret", "GET", "/x", undefined, before.signal))).code).toBe("CANCELLED");
    const during = fresh();
    setTimeout(() => during.abort(), TIMEOUT_MS / 3);
    const error = await failureOf(requestJson(baseUrl, "secret", "GET", "/x", undefined, during.signal, TIMEOUT_MS * 10));
    expect(error.code).toBe("CANCELLED");
    expect(error.publicMessage).toBe(messages.serverClient.requestCancelled);
  } finally { server.stop(true); }
});

test("a body that stalls after the answer began is a time-out, and a cancellation while it stalls is a cancellation", async () => {
  const { server, baseUrl } = stalledBodyServer();
  try {
    const slow = await failureOf(requestJson(baseUrl, "secret", "GET", "/x", undefined, fresh().signal, TIMEOUT_MS));
    expect(slow.code).toBe("TIMEOUT");
    expect(slow.publicMessage).toBe(messages.serverClient.timedOut);
    const during = fresh();
    setTimeout(() => during.abort(), TIMEOUT_MS / 3);
    const cancelled = await failureOf(requestJson(baseUrl, "secret", "GET", "/x", undefined, during.signal, TIMEOUT_MS * 10));
    expect(cancelled.code).toBe("CANCELLED");
  } finally { server.stop(true); }
});

test("a body the Pet cannot serialize reports its own cause, sends nothing and is marked as not written", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json({}); } });
  let engineCause = "";
  try { JSON.stringify({ value: 1n }); } catch (thrown) { engineCause = String(thrown); }
  expect(engineCause).toContain("TypeError");
  try {
    const error = await failureOf(requestJson(`http://127.0.0.1:${server.port}`, "secret", "POST", "/ingest", { value: 1n }, fresh().signal));
    expect(error.code).toBe("REQUEST_UNEXPECTED");
    expect(error.publicMessage).toBe(messages.serverClient.requestUnexpected(engineCause));
    expect(error.publicMessage).not.toBe(messages.serverClient.networkFailed);
    expect(error.writeNotStarted).toBe(true);
    expect(hits).toBe(0);
  } finally { server.stop(true); }
});

test("a token that cannot be a header value reports a defect, without showing the token, and sends nothing", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json({}); } });
  try {
    const error = await failureOf(requestJson(`http://127.0.0.1:${server.port}`, "line\nbreak-token", "GET", "/x", undefined, fresh().signal));
    expect(error.code).toBe("REQUEST_UNEXPECTED");
    // The engine's own sentence quotes the header value, so it is withheld and says it was.
    expect(error.publicMessage).toBe(messages.serverClient.requestUnexpected(messages.serverClient.causeWithheld));
    expect(error.publicMessage).not.toContain("break-token");
    expect(error.writeNotStarted).toBe(true);
    expect(hits).toBe(0);
  } finally { server.stop(true); }
});

test("requestRaw, which `/client-info` uses, tells the same causes apart", async () => {
  const redirecting = redirectingServer();
  const silent = silentServer();
  try {
    expect((await failureOf(requestRaw(redirecting.baseUrl, "secret", "/x", fresh().signal))).code).toBe("REDIRECT");
    expect((await failureOf(requestRaw(silent.baseUrl, "secret", "/x", fresh().signal, TIMEOUT_MS))).code).toBe("TIMEOUT");
    expect((await failureOf(requestRaw(closedPortUrl(), "secret", "/x", fresh().signal, TIMEOUT_MS))).code).toBe("NETWORK");
  } finally { redirecting.stop(); silent.server.stop(true); }
});

// The connection check (`MemoryClient.info`) and the AI check (`AiClient.probe`) both go through the same
// request path; their answers must carry each cause too.

async function withConfig<T>(baseUrl: string, run: (config: ConfigStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pet-fetch-failure-"));
  try {
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token", ai: { provider: "ollama", baseUrl, model: "qwen-test" } });
    return await run(config);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

windowsOnly("the connection check reports a redirect answer and a closed port with their own texts", async () => {
  const redirecting = redirectingServer();
  try {
    expect(await withConfig(redirecting.baseUrl, (config) => new MemoryClient(config, new CredentialRoutes(new LocalServer())).info()))
      .toEqual({ connected: false, message: messages.serverClient.redirected });
    expect(redirecting.followed()).toBe(0);
  } finally { redirecting.stop(); }
  expect(await withConfig(closedPortUrl(), (config) => new MemoryClient(config, new CredentialRoutes(new LocalServer())).info()))
    .toEqual({ connected: false, message: messages.serverClient.networkFailed });
}, 30_000);

windowsOnly("the AI check reports an address that only redirects as not being an AI server, with the redirect as its cause", async () => {
  const redirecting = redirectingServer();
  try {
    const result = await withConfig(redirecting.baseUrl, (config) => new AiClient(config).probe("answer", { signal: fresh().signal, progress() {} }));
    expect(result.available).toBe(false);
    expect(result.message).toBe(messages.aiService.probe.notModelList(messages.serverClient.redirected));
    expect(result.message).not.toBe(messages.aiService.probe.networkFailed);
  } finally { redirecting.stop(); }
}, 30_000);

test("the AI check names a time-out, a closed port and a request the Pet could not build, each by its own cause", async () => {
  const { server, baseUrl } = silentServer();
  try {
    const timedOut = await failureOf(requestJson(baseUrl, null, "GET", "/api/tags", undefined, fresh().signal, TIMEOUT_MS));
    expect(describeProbeFailure(timedOut)).toBe(messages.aiService.probe.timedOut);
  } finally { server.stop(true); }
  const refused = await failureOf(requestJson(closedPortUrl(), null, "GET", "/api/tags", undefined, fresh().signal, TIMEOUT_MS));
  expect(describeProbeFailure(refused)).toBe(messages.aiService.probe.networkFailed);
  const unbuildable = await failureOf(requestJson(closedPortUrl(), "line\nbreak", "GET", "/api/tags", undefined, fresh().signal, TIMEOUT_MS));
  expect(describeProbeFailure(unbuildable)).toBe(unbuildable.publicMessage);
  expect(describeProbeFailure(unbuildable)).toContain(messages.serverClient.causeWithheld);
  expect(describeProbeFailure(unbuildable)).not.toContain("모델 목록");
});
