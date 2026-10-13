import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { publicError } from "../protocol.ts";
import { LOCAL_SERVER_READY_TIMEOUT_MS, TUNNEL_READY_TIMEOUT_MS } from "./limits.ts";
import { availableLoopbackPort, interpretHealth, isCoreRunning, reserveFreshOrigin, waitForClient, waitForHealth,
  type ReadyWait } from "./net.ts";

test("fresh origin selection skips a durable reservation for another audience", async () => {
  const visited: string[] = [];
  const ports = [41001, 41002];
  const selected = await reserveFreshOrigin(async (baseUrl) => {
    visited.push(baseUrl);
    if (baseUrl.endsWith(":41001")) throw serviceError("CONNECTION_ORIGIN_RESERVED", "reserved");
  }, async () => ports.shift()!);
  expect(selected).toBe("http://127.0.0.1:41002");
  expect(visited).toEqual(["http://127.0.0.1:41001", "http://127.0.0.1:41002"]);
});

test("fresh origin selection does not hide other reservation failures", async () => {
  await expect(reserveFreshOrigin(async () => { throw serviceError("CONFIG_UNAVAILABLE", "bad file"); },
    async () => 41003)).rejects.toMatchObject({ code: "CONFIG_UNAVAILABLE" });
});

/** Await a rejection on the main event loop. The waits pause with `Bun.sleep`, whose timers Bun's
 * `expect(promise).rejects` did not fire on Windows (see local-server.test.ts). */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

interface Seen { path: string; authorization: string | null }
interface Endpoint { url: string; port: number; seen: Seen[]; stop(): Promise<void> }

/** A real loopback HTTP server recording every request; `answer` gets the 1-based request count. */
function endpoint(answer: (count: number) => Response): Endpoint {
  const seen: Seen[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    return answer(seen.length);
  } });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, seen, stop: () => server.stop(true) };
}

const TOKEN = randomUUID();
const signal = new AbortController().signal;
const READY = { protocolVersion: PROTOCOL_VERSION, version: "test", capabilities: ["capture"] };
/** The real local limit: a wait that ends within two seconds did not run into it. */
const LOCAL: ReadyWait = { timeoutMs: LOCAL_SERVER_READY_TIMEOUT_MS, timeoutCode: "INSTALL_SERVER_TIMEOUT" };
const TUNNEL: ReadyWait = { timeoutMs: TUNNEL_READY_TIMEOUT_MS, timeoutCode: "SSH_SERVER_TIMEOUT" };
const PROMPT_MS = 2_000;

test("an answer that proves the cause ends the wait at once after one bearer request", async () => {
  const cases: Array<[string, () => Response, string]> = [
    ["revoked token", () => new Response("denied", { status: 401 }), "AUTH_REJECTED"],
    ["server before the Pet integration, standard token", () => Response.json({ code: "FORBIDDEN" }, { status: 403 }), "SERVER_UPGRADE_REQUIRED"],
    ["server before the Pet integration, full token", () => new Response("not found", { status: 404 }), "SERVER_UPGRADE_REQUIRED"],
    ["web page", () => new Response("<!doctype html><title>dashboard</title>", { headers: { "content-type": "text/html" } }), "SERVER_INCOMPATIBLE"],
    ["other protocol version", () => Response.json({ ...READY, protocolVersion: PROTOCOL_VERSION + 1 }), "SERVER_INCOMPATIBLE"],
  ];
  for (const [name, answer, code] of cases) {
    const server = endpoint(answer);
    try {
      const started = performance.now();
      const error = await rejection(waitForClient(server.url, TOKEN, signal, LOCAL));
      const elapsed = performance.now() - started;
      expect({ name, code: (error as { code?: string }).code }).toEqual({ name, code });
      expect({ name, prompt: elapsed < PROMPT_MS }).toEqual({ name, prompt: true });
      expect(server.seen).toEqual([{ path: "/client-info", authorization: `Bearer ${TOKEN}` }]);
      expect(publicError(error)).toEqual({ code, message: (error as { publicMessage: string }).publicMessage });
    } finally { await server.stop(); }
  }
});

test("a redirect is an incompatible answer and is never followed with the bearer", async () => {
  const target = endpoint(() => Response.json(READY));
  const redirecting = endpoint(() => new Response(null, { status: 302, headers: { location: `${target.url}/client-info` } }));
  try {
    const started = performance.now();
    const error = await rejection(waitForClient(redirecting.url, TOKEN, signal, LOCAL));
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
    expect(error).toMatchObject({ code: "SERVER_INCOMPATIBLE", publicMessage: messages.connectionErrors.SERVER_INCOMPATIBLE(302) });
    expect(target.seen).toEqual([]);
  } finally { await Promise.all([target.stop(), redirecting.stop()]); }
});

test("a server error is asked again and a later ready answer ends the wait with the server's info", async () => {
  const server = endpoint((count) => count === 1 ? new Response("starting", { status: 500 }) : Response.json(READY));
  try {
    expect(await waitForClient(server.url, TOKEN, signal, LOCAL))
      .toEqual({ protocolVersion: PROTOCOL_VERSION, version: "test", capabilities: ["capture"] });
    expect(server.seen).toHaveLength(2);
  } finally { await server.stop(); }
});

test("running out of time reports the caller's code with what the server last answered", async () => {
  const failing = endpoint(() => new Response("broken", { status: 500 }));
  const closedPort = await availableLoopbackPort();
  try {
    const local = await rejection(waitForClient(failing.url, TOKEN, signal, { timeoutMs: 300, timeoutCode: "INSTALL_SERVER_TIMEOUT" }));
    expect(local).toMatchObject({ code: "INSTALL_SERVER_TIMEOUT",
      publicMessage: messages.connectionErrors.INSTALL_SERVER_TIMEOUT(1, messages.connectionWait.lastStatus(500)) });
    const ssh = await rejection(waitForHealth(`http://127.0.0.1:${closedPort}`, signal, { timeoutMs: 300, timeoutCode: "SSH_SERVER_TIMEOUT" }));
    expect(ssh).toMatchObject({ code: "SSH_SERVER_TIMEOUT",
      publicMessage: messages.connectionErrors.SSH_SERVER_TIMEOUT(1, messages.connectionWait.noAnswer) });
    expect(publicError(ssh)).toEqual({ code: "SSH_SERVER_TIMEOUT", message: (ssh as { publicMessage: string }).publicMessage });
  } finally { await failing.stop(); }
});

test("the check before each request runs every time, and its failure ends the wait before anything is sent", async () => {
  const server = endpoint((count) => count === 1 ? new Response("", { status: 500 }) : Response.json(READY));
  const guarded = endpoint(() => Response.json(READY));
  try {
    let checks = 0;
    await waitForClient(server.url, TOKEN, signal, { ...LOCAL, beforeRequest: async () => { checks++; } });
    expect({ checks, requests: server.seen.length }).toEqual({ checks: 2, requests: 2 });
    const error = await rejection(waitForClient(guarded.url, TOKEN, signal,
      { ...LOCAL, beforeRequest: async () => { throw serviceError("INSTALL_PORT_TAKEN", "taken"); } }));
    expect(error).toMatchObject({ code: "INSTALL_PORT_TAKEN" });
    expect(guarded.seen).toEqual([]);
  } finally { await Promise.all([server.stop(), guarded.stop()]); }
});

test("cancelling a wait ends it promptly", async () => {
  const server = endpoint(() => new Response("", { status: 503 }));
  const controller = new AbortController();
  try {
    const pending = waitForClient(server.url, TOKEN, controller.signal, LOCAL);
    const deadline = Date.now() + 5_000;
    while (server.seen.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(server.seen.length).toBeGreaterThan(0);
    controller.abort();
    const started = performance.now();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
  } finally { await server.stop(); }
});

test("a health wait sends no credential, retries a server error, and fails at once on a foreign answer", async () => {
  const starting = endpoint((count) => count === 1 ? new Response("", { status: 502 }) : Response.json({ ok: true }));
  try {
    await waitForHealth(starting.url, signal, TUNNEL);
    expect(starting.seen).toEqual([{ path: "/health", authorization: null }, { path: "/health", authorization: null }]);
  } finally { await starting.stop(); }
  const foreign: Array<() => Response> = [() => new Response("not found", { status: 404 }), () => Response.json({ status: "ok" }),
    () => new Response("denied", { status: 401 }), () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })];
  for (const answer of foreign) {
    const server = endpoint(answer);
    try {
      const started = performance.now();
      expect(await rejection(waitForHealth(server.url, signal, TUNNEL))).toMatchObject({ code: "SERVER_INCOMPATIBLE" });
      expect(performance.now() - started).toBeLessThan(PROMPT_MS);
      expect(server.seen).toHaveLength(1);
    } finally { await server.stop(); }
  }
});

test("health answers are judged by status and body", () => {
  expect(interpretHealth(200, JSON.stringify({ ok: true }))).toEqual({ kind: "ready" });
  expect(interpretHealth(503, "")).toEqual({ kind: "retry", status: 503 });
  for (const [status, body] of [[200, JSON.stringify({ ok: false })], [200, "ok"], [200, "null"], [204, ""], [301, ""], [404, "{\"ok\":true}"]] as const)
    expect(interpretHealth(status, body)).toEqual({ kind: "failed", code: "SERVER_INCOMPATIBLE", status });
});

test("an existing core is recognized only by its unauthenticated health answer", async () => {
  const core = endpoint(() => Response.json({ ok: true }));
  try {
    expect(await isCoreRunning(core.port, signal)).toBe(true);
    expect(core.seen).toEqual([{ path: "/health", authorization: null }]);
  } finally { await core.stop(); }
  const others: Array<() => Response> = [() => new Response("not found", { status: 404 }), () => Response.json({ status: "ok" }),
    () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }), () => new Response("", { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/health" } })];
  for (const answer of others) {
    const server = endpoint(answer);
    try { expect(await isCoreRunning(server.port, signal)).toBe(false); }
    finally { await server.stop(); }
  }
  expect(await isCoreRunning(await availableLoopbackPort(), signal)).toBe(false);
  expect(await rejection(isCoreRunning(0, signal))).toBeInstanceOf(RangeError);
});
