import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience, INSTALL_RUNNING_CODE, type AppStatus, type RequestContext } from "../src/shared/contracts.ts";
import { PetService } from "../src/service/router.ts";
import { openMaintenance } from "../src/service/maintenance/manifest.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

/** The install lock (`AppStatus.installing`, `INSTALL_RUNNING`) on the real service. An install is held in the connection
 * queue behind a `connection.test` whose `/client-info` answer a real HTTP server keeps back until the test lets it go,
 * so the install is under way for as long as the test needs; it then ends by failing (this temporary folder has no
 * server payload, and the saved connection blocks a remote install) or by its cancel. */
const PET_INTEGRATION_BODY = JSON.stringify({ protocolVersion: 1, version: "0.9.0",
  captureKinds: ["idea", "decision", "question", "preference", "task"],
  capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"] });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function context(signal = new AbortController().signal): RequestContext {
  return { signal, progress() {} };
}

async function heldService() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/client-info") return new Response("", { status: 404 });
    await held;
    return new Response(PET_INTEGRATION_BODY, { status: 200 });
  } });
  const dir = mkdtempSync(join(tmpdir(), "pet-install-lock-"));
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, PET_VERSION));
  const connection = { mode: "existing" as const, baseUrl: `http://127.0.0.1:${server.port}` };
  await service.config.save({ connection, token: "authored-test-token", ownerToken: "authored-owner-token" });
  cleanups.push(async () => { release(); server.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  // Holds the connection queue until `release`.
  const holding = service.dispatch("connection.test", {}, context(), []);
  return { service, release, holding, audience: connectionAudience(connection) };
}

const status = async (service: PetService) => await service.dispatch("status", {}, context(), []) as AppStatus;

/** Everything a running install refuses, checked while one runs. */
async function expectLocked(service: PetService, audience: string): Promise<void> {
  expect((await status(service)).installing).toBe(true);
  await expect(service.dispatch("dashboard.link", {}, context(), []))
    .rejects.toMatchObject({ code: INSTALL_RUNNING_CODE, publicMessage: messages.installLock.refused["dashboard.link"] });
  await expect(service.dispatch("assistant.ask", { question: "어제 뭐 했지?", audience }, context(), []))
    .rejects.toMatchObject({ code: INSTALL_RUNNING_CODE, publicMessage: messages.installLock.refused["assistant.ask"] });
  expect(await service.dispatch("memory.save", { content: "메모", requestId: "save-1", audience }, context(), []))
    .toEqual({ state: "rejected", requestId: "save-1", audience, message: messages.installLock.saveRefused });
}

test("nothing is installing before an install starts", async () => {
  const { service, release, holding } = await heldService();
  release(); await holding;
  expect((await status(service)).installing).toBe(false);
});

// How each install fails here: this folder has no bundled runtime, and a remote install refuses the saved connection.
const INSTALLS = [
  { method: "install.local", params: {}, failure: "PAYLOAD_INVALID" },
  { method: "install.remote", params: { ssh: { host: "127.0.0.1", port: 22, user: "pet", keyPath: "key" }, acceptedFingerprint: "SHA256:x" },
    failure: "INSTALL_EXISTING_CONNECTION" },
] as const;
for (const { method, params, failure } of INSTALLS) {
  test(`${method}: installing while it runs, refused requests meanwhile, and over after it failed`, async () => {
    const { service, release, holding, audience } = await heldService();
    const install = service.dispatch(method, params, context(), []);
    install.catch(() => {});
    await expectLocked(service, audience);
    release(); await holding;
    await expect(install).rejects.toMatchObject({ code: failure });
    expect((await status(service)).installing).toBe(false);
    // The dashboard opens again once the install is over.
    expect(await service.dispatch("dashboard.link", {}, context(), [])).toMatchObject({ url: expect.any(String) });
  });

  test(`${method}: over after its cancel`, async () => {
    const { service, release, holding, audience } = await heldService();
    const controller = new AbortController();
    const install = service.dispatch(method, params, context(controller.signal), []);
    install.catch(() => {});
    await expectLocked(service, audience);
    controller.abort();
    release(); await holding;
    await expect(install).rejects.toMatchObject({ name: "AbortError" });
    expect((await status(service)).installing).toBe(false);
  });
}

test("an install with nothing ahead of it in the queue is over once it failed", async () => {
  const { service, release, holding } = await heldService();
  release(); await holding;
  await expect(service.dispatch("install.local", {}, context(), [])).rejects.toMatchObject({ code: "PAYLOAD_INVALID" });
  expect((await status(service)).installing).toBe(false);
});
