import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAudience } from "../src/shared/contracts.ts";
import { PetService } from "../src/service/router.ts";
import { openMaintenance } from "../src/service/maintenance/manifest.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

const ctx = { signal: new AbortController().signal, progress() {} };

/** Real HTTP fixture standing in for `/client-info`, counting how many times it is asked. */
function clientInfoFixture(respond: () => Response) {
  const counts = { clientInfo: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== "/client-info") return new Response("", { status: 404 });
    counts.clientInfo++;
    return respond();
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, counts };
}

async function serviceAt(baseUrl: string): Promise<{ service: PetService; dir: string; audience: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pet-dashboard-link-service-"));
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, PET_VERSION));
  const connection = { mode: "existing" as const, baseUrl };
  await service.config.save({ connection, token: "authored-test-token", ownerToken: "authored-owner-token" });
  return { service, dir, audience: connectionAudience(connection) };
}

const PET_INTEGRATION_BODY = JSON.stringify({ protocolVersion: 1, version: "0.9.0",
  captureKinds: ["idea", "decision", "question", "preference", "task"],
  capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"] });

test("a memoryId deep link surfaces the connection failure instead of a silent home link when info() fails", async () => {
  const info = clientInfoFixture(() => new Response("", { status: 401 }));
  const { service, dir, audience } = await serviceAt(info.baseUrl);
  try {
    await expect(service.dispatch("dashboard.link", { memoryId: 7, audience }, ctx, [])).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
  } finally { info.server.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a protocol-ok server missing memory-deeplink still gets a home link, not a dropped request", async () => {
  const body = JSON.stringify({ protocolVersion: 1, capabilities: ["ingest-receipts", "capture"] }); // memory-deeplink missing
  const info = clientInfoFixture(() => new Response(body, { status: 200 }));
  const { service, dir, audience } = await serviceAt(info.baseUrl);
  try {
    const result = await service.dispatch("dashboard.link", { memoryId: 7, audience }, ctx, []) as { url: string };
    expect(new URL(result.url).searchParams.has("memoryId")).toBe(false);
  } finally { info.server.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a pet-integration server with memory-deeplink resolves the memoryId deep link", async () => {
  const info = clientInfoFixture(() => new Response(PET_INTEGRATION_BODY, { status: 200 }));
  const { service, dir, audience } = await serviceAt(info.baseUrl);
  try {
    const result = await service.dispatch("dashboard.link", { memoryId: 7, audience }, ctx, []) as { url: string };
    expect(new URL(result.url).searchParams.get("memoryId")).toBe("7");
  } finally { info.server.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a plain dashboard link (no memoryId) never calls /client-info", async () => {
  const info = clientInfoFixture(() => new Response(PET_INTEGRATION_BODY, { status: 200 }));
  const { service, dir } = await serviceAt(info.baseUrl);
  try {
    const result = await service.dispatch("dashboard.link", {}, ctx, []) as { url: string };
    expect(new URL(result.url).searchParams.has("memoryId")).toBe(false);
    expect(info.counts.clientInfo).toBe(0);
  } finally { info.server.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a review link (no memoryId) also never calls /client-info", async () => {
  const info = clientInfoFixture(() => new Response(PET_INTEGRATION_BODY, { status: 200 }));
  const { service, dir, audience } = await serviceAt(info.baseUrl);
  try {
    const result = await service.dispatch("dashboard.link", { review: true, audience }, ctx, []) as { url: string };
    expect(new URL(result.url).searchParams.get("view")).toBe("proposals");
    expect(info.counts.clientInfo).toBe(0);
  } finally { info.server.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
