import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/service/config.ts";
import { MemoryClient } from "../src/service/client.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import { connectionAudience, type CaptureKind } from "../src/shared/contracts.ts";

const legacyKinds: CaptureKind[] = ["idea", "decision", "question", "preference", "task"];
const ctx = () => ({ signal: new AbortController().signal, progress() {} });

for (const supportsInformation of [false, true]) {
  test(`information saves and edits ${supportsInformation ? "work on an upgraded server" : "require a server upgrade before writing"}`, async () => {
    const writes: string[] = [];
    const memory = { id: 9, content: "작업 컴퓨터의 그래픽카드는 4080S", editableContent: "작업 컴퓨터의 그래픽카드는 4080S", metadata: { capture: { kind: "information", source: "user" }, sharedMemory: { revision: 1 } } };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/client-info") return Response.json({ protocolVersion: 1, capabilities: ["capture"], captureKinds: supportsInformation ? [...legacyKinds, "information"] : legacyKinds });
      if (request.method === "GET" && path === "/memories/9") return Response.json({ memory });
      if (request.method === "POST" && path === "/ingest") { writes.push(path); return Response.json({ ok: true, type: "text", originNodeId: 9 }); }
      if (request.method === "PATCH" && path === "/memories/9") { writes.push(path); return Response.json({ memory }); }
      return new Response("", { status: 404 });
    } });
    const dir = mkdtempSync(join(tmpdir(), "pet-information-"));
    try {
      const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
      const settings = await config.save({ connection: { mode: "existing", baseUrl: `http://127.0.0.1:${server.port}` }, token: "authored-test-token" });
      const audience = connectionAudience(settings.connection);
      const client = new MemoryClient(config, new CredentialRoutes(new LocalServer()));
      expect(await client.allowedCaptureKinds(ctx())).toEqual(supportsInformation ? [...legacyKinds, "information"] : legacyKinds);
      const saved = await client.save({ requestId: crypto.randomUUID(), audience, content: memory.content, kind: "information" }, ctx());
      const update = () => client.update({ id: 9, expectedRevision: 0, capture: { kind: "information", source: "user" } }, ctx());
      if (supportsInformation) {
        expect(saved).toMatchObject({ state: "saved", memory: { metadata: { capture: { kind: "information" } } } });
        expect(await update()).toMatchObject({ metadata: { capture: { kind: "information" } } });
        expect(writes).toEqual(["/ingest", "/memories/9"]);
      } else {
        expect(saved).toMatchObject({ state: "rejected" });
        expect(saved.message).toContain("정보·경험");
        expect(saved.message).toContain("업데이트");
        await expect(update()).rejects.toMatchObject({ code: "SERVER_UPGRADE_REQUIRED" });
        expect(writes).toEqual([]);
      }
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
