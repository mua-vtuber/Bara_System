import { beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import { saveTextInput } from "../save-input.ts";
import { saveSharedMemoryInput } from "../shared-memory-write.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerCleanupRoutes } from "./cleanup.ts";
import { registerIngestRoutes } from "./ingest.ts";

// Real cached bge-m3, SQLite, store, extractor and Ollama HTTP client. The loopback
// response fixture only controls when the LLM response arrives; no live server data.
const embedder = new Bgem3Embedder();
beforeAll(async () => { await embedder.load(); });

test("ingest post-save classification retains its reset protection until the response", async () => {
  const db = openMemoryDatabase(":memory:");
  const store = new SqliteMemoryStore(db, embedder);
  const dir = mkdtempSync(join(tmpdir(), "bara-reset-ingest-"));
  const app = new Hono();
  const deps = { store, assetStore: new AssetStore(dir) } as unknown as MemoryApiDeps;
  registerCleanupRoutes(app, deps);
  registerIngestRoutes(app, deps);
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const addKind = store.addNodeKindValue.bind(store);
  // Pause at the real post-save method boundary, then delegate to its actual implementation.
  store.addNodeKindValue = async (...args) => { started(); await gate; return addKind(...args); };
  const saving = Promise.resolve(app.request("/ingest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "dashboard:manual", content: { type: "text", data: "#일정:치과, 예약 메모" } }),
  }));
  const reset = () => app.request("/admin/reset-memory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
  });
  try {
    await Promise.race([ready, saving.then(async (response) => { throw new Error(`post-save stage not reached: ${response.status} ${await response.clone().text()}`); })]);
    expect((await store.getAllNodes()).length).toBeGreaterThan(0);
    expect((await reset()).status).toBe(409);
    release();
    const response = await saving;
    expect(response.status).toBe(201);
    const result = await response.json() as { originNodeId: number };
    expect(await store.getNode(result.originNodeId)).not.toBeNull();
    expect((await reset()).status).toBe(200);
    expect(await store.getAllNodes()).toEqual([]);
  } finally {
    release();
    await saving.catch(() => {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, save] of [["REST text", saveTextInput], ["MCP evidence text", saveSharedMemoryInput]] as const) {
  test(`${name}: reject reset during immediate extraction, retain input, then allow reset`, async () => {
    const db = openMemoryDatabase(":memory:");
    const store = new SqliteMemoryStore(db, embedder);
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      started();
      await gate;
      return Response.json({ model: "fixture", message: { role: "assistant", content: "[]" }, done: true });
    } });
    const extractor = new MemoryExtractor(new OllamaClient({ baseUrl: `http://127.0.0.1:${server.port}`, model: "fixture" }), store, embedder);
    const app = new Hono();
    registerCleanupRoutes(app, { store, extractor } as unknown as MemoryApiDeps);
    const reset = () => app.request("/admin/reset-memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET ALL MEMORY" }),
    });
    const content = "배포 창구는 금요일 오후로 정했다. 롤백 담당은 운영팀이 맡는다.";
    const saving = save(store, {
      content, source: "fixture", extractor,
      extractorSettings: { ...MEMORY_DEFAULTS.llm.extractor, enabled: true, mode: "immediate" },
    });
    try {
      await ready;
      expect((await reset()).status).toBe(409);
      release();
      const result = await saving;
      expect(result.originNodeId).not.toBeNull();
      expect((await store.getNode(result.originNodeId!))?.content).toBe(content);
      expect((await reset()).status).toBe(200);
      expect(await store.getAllNodes()).toEqual([]);
    } finally {
      release();
      await saving.catch(() => {});
      server.stop(true);
      db.close();
    }
  });
}
