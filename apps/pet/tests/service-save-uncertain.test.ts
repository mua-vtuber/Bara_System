import { expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience, type RequestContext } from "../src/shared/contracts.ts";
import { MemoryClient } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { PetService } from "../src/service/router.ts";
import { openMaintenance } from "../src/service/maintenance/manifest.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// A save whose answer was lost, unreadable or refused must never be sent a second time: the Pet asks
// the server's receipt once ("GET /ingest/status/<requestId>") and otherwise reports "unknown" so the
// user decides. Each test puts a real HTTP server on loopback and compares the exact list of requests
// it received, so a second "POST /ingest" from any code path (client, assistant, router) fails the test.

const windowsOnly = test.skipIf(process.platform !== "win32");
const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });

type Answer = (request: IncomingMessage, response: ServerResponse) => void;
interface Routes { ingest: Answer; status: Answer; memory?: Answer }
interface Fixture { baseUrl: string; requests: string[]; stop(): Promise<void> }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Answer => (_request, response) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};
const rawText = (text: string): Answer => (_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(text); };
/** The server received the whole request, then closes the connection without writing any answer. */
const closeWithoutAnswer: Answer = (request) => { request.resume(); request.once("end", () => request.socket.destroy()); };

async function startFixture(routes: Routes): Promise<Fixture> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${pathname}`);
    if (request.method === "POST" && pathname === "/ingest") return routes.ingest(request, response);
    if (request.method === "GET" && pathname.startsWith("/ingest/status/")) return routes.status(request, response);
    if (request.method === "GET" && pathname.startsWith("/memories/") && routes.memory) return routes.memory(request, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    async stop() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function withFixture(routes: Routes, run: (fixture: Fixture, dir: string) => Promise<void>): Promise<void> {
  const fixture = await startFixture(routes);
  const dir = mkdtempSync(join(tmpdir(), "pet-save-uncertain-"));
  try { await run(fixture, dir); }
  finally { await fixture.stop(); rmSync(dir, { recursive: true, force: true }); }
}

/** Real ConfigStore (real DPAPI) and the same credential-route check the product uses; an "existing" server needs no tunnel. */
async function connect(baseUrl: string, dir: string): Promise<{ client: MemoryClient; audience: string }> {
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const settings = await config.save({ connection: { mode: "existing", baseUrl }, token: "authored-test-token" });
  return { client: new MemoryClient(config, new CredentialRoutes(new LocalServer())), audience: connectionAudience(settings.connection) };
}

const receiptUnknown = json(200, { state: "unknown" });
const unknownCases: Array<[string, Answer, Answer]> = [
  ["the write answered with a server error after it was dispatched", json(500, { error: "response lost after dispatch" }), receiptUnknown],
  ["the server closed the connection before answering the write", closeWithoutAnswer, receiptUnknown],
  ["the write was answered with a body that is not readable JSON", rawText("not json"), receiptUnknown],
  ["the connection closed before the answer and the receipt check failed too", closeWithoutAnswer, closeWithoutAnswer],
  ["the connection closed before the answer and the receipt check returned a server error", closeWithoutAnswer, json(503, {})],
];

for (const [name, ingest, status] of unknownCases) {
  windowsOnly(`${name}: the save is unknown, the receipt is asked once, and the write is never sent again`, async () => {
    await withFixture({ ingest, status }, async (fixture, dir) => {
      const { client, audience } = await connect(fixture.baseUrl, dir);
      const requestId = randomUUID();
      const result = await client.save({ requestId, audience, content: "응답이 유실돼도 재전송하지 않는 테스트 문장", kind: null }, ctx());
      expect(result).toMatchObject({ state: "unknown", requestId });
      expect(result.memory).toBeUndefined();
      expect(fixture.requests).toEqual(["POST /ingest", `GET /ingest/status/${requestId}`]);
    });
  }, 30_000);
}

windowsOnly("a dropped write whose receipt shows it saved is reported saved from the receipt, without a second write", async () => {
  await withFixture({
    ingest: closeWithoutAnswer,
    status: json(200, { state: "saved", result: { ok: true, type: "text", originNodeId: 42 } }),
    memory: json(200, { memory: { id: 42, content: "응답은 유실됐지만 저장된 내용" } }),
  }, async (fixture, dir) => {
    const { client, audience } = await connect(fixture.baseUrl, dir);
    const requestId = randomUUID();
    const result = await client.save({ requestId, audience, content: "응답은 유실됐지만 저장된 내용", kind: null }, ctx());
    expect(result).toMatchObject({ state: "saved", requestId, resultType: "memory" });
    expect(result.memory).toMatchObject({ id: 42, content: "응답은 유실됐지만 저장된 내용" });
    expect(fixture.requests).toEqual(["POST /ingest", `GET /ingest/status/${requestId}`, "GET /memories/42"]);
  });
}, 30_000);

windowsOnly("a write refused before it started is rejected without a receipt check and without a second write", async () => {
  await withFixture({ ingest: json(503, { error: "not started" }, { "X-Ingest-Retryable": "true" }), status: receiptUnknown }, async (fixture, dir) => {
    const { client, audience } = await connect(fixture.baseUrl, dir);
    const result = await client.save({ requestId: randomUUID(), audience, content: "서버가 시작 전에 거절한 테스트 문장", kind: null }, ctx());
    expect(result.state).toBe("rejected");
    expect(fixture.requests).toEqual(["POST /ingest"]);
  });
}, 30_000);

windowsOnly("the router's memory.save path sends one write when the server closes the connection before answering", async () => {
  await withFixture({ ingest: closeWithoutAnswer, status: receiptUnknown }, async (fixture, dir) => {
    const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
    const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, PET_VERSION));
    try {
      const connection = { mode: "existing" as const, baseUrl: fixture.baseUrl };
      await service.config.save({ connection, token: "authored-test-token" });
      const requestId = randomUUID();
      const result = await service.dispatch("memory.save", { requestId, audience: connectionAudience(connection), content: "라우터를 거쳐도 재전송하지 않는 테스트 문장", kind: null }, ctx(), []);
      expect(result).toMatchObject({ state: "unknown", requestId });
      expect(fixture.requests).toEqual(["POST /ingest", `GET /ingest/status/${requestId}`]);
    } finally { await service.close(); }
  });
}, 30_000);
