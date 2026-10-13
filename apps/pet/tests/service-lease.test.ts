import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connectionAudience } from "../src/shared/contracts.ts";
import { PetService } from "../src/service/router.ts";
import { openMaintenance } from "../src/service/maintenance/manifest.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

test.skipIf(process.platform !== "win32")("a connection change cannot retarget an active save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-connection-lease-"));
  let reached!: () => void, resume!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  const a = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ingest") { reached(); await released; return Response.json({ ok: true, originNodeId: 1 }); }
    if (path === "/memories/1") return Response.json({ memory: { id: 1, content: "서버 A 기록" } });
    return Response.json({ state: "unknown" });
  } });
  const b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ memory: { id: 1, content: "서버 B 기록" } }) });
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, PET_VERSION));
  const ctx = { signal: new AbortController().signal, progress() {} };
  try {
    const connectionA = { mode: "existing" as const, baseUrl: `http://127.0.0.1:${a.port}` };
    const connectionB = { mode: "existing" as const, baseUrl: `http://127.0.0.1:${b.port}` };
    await service.config.save({ connection: connectionA, token: "authored-A" });
    const audienceA = connectionAudience(connectionA);
    const saving = service.dispatch("memory.save", { content: "저장", requestId: randomUUID(), audience: audienceA, kind: null }, ctx, []);
    await Promise.race([paused, Bun.sleep(10_000).then(() => { throw new Error("save did not reach A"); })]);
    const duringSave = await Promise.race([
      service.dispatch("status", {}, ctx, ["quick-op"]),
      Bun.sleep(2_500).then(() => { throw new Error("status blocked behind active save"); }),
    ]) as { connection: { connected: boolean }; activeOperations: string[] };
    expect(duringSave.connection.connected).toBe(false);
    expect(duringSave.activeOperations).toContain("quick-op");
    await expect(service.dispatch("settings.save", { connection: connectionB, token: "authored-B" }, ctx, [])).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
    resume();
    const saved = await saving as { state: string; memory?: { content: string } };
    expect(saved.state).toBe("saved");
    expect(saved.memory?.content).toBe("서버 A 기록");
    await service.dispatch("settings.save", { connection: connectionB, token: "authored-B" }, ctx, []);
    await expect(service.dispatch("memory.get", { id: 1, audience: audienceA }, ctx, [])).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
  } finally { resume(); a.stop(true); b.stop(true); await service.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
