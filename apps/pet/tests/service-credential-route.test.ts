import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience, type ConnectionSettings, type RequestContext } from "../src/shared/contracts.ts";
import { CleanupService } from "../src/service/cleanup.ts";
import { PetService } from "../src/service/router.ts";
import { openMaintenance } from "../src/service/maintenance/manifest.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// WP-PFIX-4: every request that carries the memory token or the owner token passes the credential
// route check (`CredentialRoutes.assertServes`) right before it is sent. These tests put a plain
// program (a Bun.serve owned by the test, not a tunnel and not a Pet-started server) on the saved
// port, as after a restart where another program took the old tunnel port, and count what it receives.

const windowsOnly = test.skipIf(process.platform !== "win32");
const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });

/** The program now holding the saved port. Records every request and whether it carried a credential. */
function portHolder() {
  const seen = { total: 0, authorized: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.total++;
    if (request.headers.has("authorization")) seen.authorized++;
    return Response.json({ protocolVersion: 1, version: "holder", captureKinds: [], capabilities: [], proposals: [], results: [] });
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, seen };
}

async function serviceWith(connection: ConnectionSettings, aiBaseUrl: string): Promise<{ service: PetService; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pet-credential-route-"));
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, PET_VERSION));
  await service.config.save({ connection, token: "authored-client-token", ownerToken: "authored-owner-token",
    ai: { provider: "ollama", baseUrl: aiBaseUrl, model: "authored-test-model" }, cleanup: { provider: "ollama", model: "authored-test-model" } });
  // A pending enrollment, so the enrollment poll path has something to ask about.
  await service.config.setEnrollment(JSON.stringify({ requestId: "authored-request", pickupSecret: "authored-pickup", baseUrl: connection.baseUrl }), connection);
  return { service, dir };
}

/** Every MemoryClient, cleanup and dashboard-link path, called directly so none of them relies on the
 * router having run `ensureConnection` first. Each must refuse with `code` and send nothing. */
async function everyDirectPath(service: PetService, audience: string, code: string): Promise<void> {
  const client = service.client;
  const cleanup = new CleanupService(service.config, client);
  const refused = { code };
  expect(await client.info(ctx().signal)).toEqual({ connected: false, message: (messages.connectionErrors as Record<string, unknown>)[code] as string });
  await expect(client.search("터널 확인", ctx(), audience)).rejects.toMatchObject(refused);
  await expect(client.get(1, ctx(), audience)).rejects.toMatchObject(refused);
  await expect(client.status(randomUUID(), ctx(), audience)).rejects.toMatchObject(refused);
  await expect(client.update({ id: 1, audience, content: "수정", expectedRevision: 0 }, ctx())).rejects.toMatchObject(refused);
  await expect(client.allowedCaptureKinds(ctx(), audience)).rejects.toMatchObject(refused);
  // A save that could not be sent is never reported as saved; its draft is kept for a later check.
  expect((await client.save({ requestId: randomUUID(), audience, content: "보내지 않을 기록", kind: null }, ctx())).state).toBe("unknown");
  await expect(client.enrollmentStart(ctx())).rejects.toMatchObject(refused);
  await expect(client.enrollmentPoll(ctx())).rejects.toMatchObject(refused);
  await expect(cleanup.list(ctx())).rejects.toMatchObject(refused);
  await expect(cleanup.run({ limit: 1 }, ctx())).rejects.toMatchObject(refused);
  await expect(service.config.dashboardLink((connection) => client.assertSendable(connection), undefined, true, audience)).rejects.toMatchObject(refused);
}

windowsOnly("after a restart, status and every direct request send no token to the program holding the saved SSH tunnel port", async () => {
  const holder = portHolder();
  const ai = portHolder();
  const connection: ConnectionSettings = { mode: "remote", baseUrl: holder.baseUrl,
    ssh: { host: "a.example.org", port: 22, user: "ubuntu", keyPath: "C:\\authored-test-key", fingerprint: `SHA256:${"A".repeat(43)}`, serverPort: 3001 } };
  // A fresh service is a restarted Pet: the saved address names the old tunnel port and no tunnel runs yet.
  const { service, dir } = await serviceWith(connection, ai.baseUrl);
  try {
    // The "저장 확인" screen asks `status` first (recovery.ts); it opens nothing and sends nothing.
    const status = await service.dispatch("status", {}, ctx(), []) as { connection: { connected: boolean; message: string } };
    expect(status.connection).toEqual({ connected: false, message: messages.connectionErrors.SSH_TUNNEL_UNVERIFIED });
    await everyDirectPath(service, connectionAudience(connection), "SSH_TUNNEL_UNVERIFIED");
    expect(holder.seen).toEqual({ total: 0, authorized: 0 });
    expect(ai.seen.total).toBe(0);
  } finally { await service.close(); holder.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

windowsOnly("a local connection sends no token to a port the Pet-started server does not verifiably own", async () => {
  const holder = portHolder();
  const ai = portHolder();
  const connection: ConnectionSettings = { mode: "local", baseUrl: holder.baseUrl };
  // No install record: `ensureConnection` starts no server, so nothing verified owns the port.
  const { service, dir } = await serviceWith(connection, ai.baseUrl);
  const audience = connectionAudience(connection);
  try {
    const refused = { code: "LOCAL_SERVER_UNVERIFIED" };
    const status = await service.dispatch("status", {}, ctx(), []) as { connection: { connected: boolean; message: string } };
    expect(status.connection).toEqual({ connected: false, message: messages.connectionErrors.LOCAL_SERVER_UNVERIFIED });
    // Through the router, including the methods that run `ensureConnection` first.
    const connectionTest = await service.dispatch("connection.test", {}, ctx(), []) as { connected: boolean; message: string };
    expect(connectionTest).toEqual({ connected: false, message: messages.connectionErrors.LOCAL_SERVER_UNVERIFIED });
    for (const [method, params] of [
      ["enrollment.start", {}], ["enrollment.poll", {}], ["memory.status", { requestId: randomUUID(), audience }],
      ["memory.search", { query: "터널 확인" }], ["memory.get", { id: 1, audience }],
      ["memory.update", { id: 1, audience, content: "수정", expectedRevision: 0 }], ["assistant.ask", { question: "확인", audience }],
      ["cleanup.list", {}], ["cleanup.run", { limit: 1 }], ["dashboard.link", { review: true, audience }],
    ] as const) await expect(service.dispatch(method, params, ctx(), [])).rejects.toMatchObject(refused);
    const saved = await service.dispatch("memory.save", { requestId: randomUUID(), audience, content: "보내지 않을 기록", kind: null }, ctx(), []) as { state: string };
    expect(saved.state).toBe("unknown");
    await everyDirectPath(service, audience, "LOCAL_SERVER_UNVERIFIED");
    expect(holder.seen).toEqual({ total: 0, authorized: 0 });
    expect(ai.seen.total).toBe(0);
  } finally { await service.close(); holder.server.stop(true); ai.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
