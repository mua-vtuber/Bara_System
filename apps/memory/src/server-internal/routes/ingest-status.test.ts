import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { registerIngestRoutes } from "./ingest.ts";
import { MCP_ADAPTER_ID_VAR } from "../auth-gate.ts";

let db: ReturnType<typeof openMemoryDatabase>;
let store: SqliteMemoryStore;
let dir: string;
let app: Hono;
const text = "Exact existing fixture with an explicit vector";
const requestId = "ab020f72-b34b-4ba5-8f47-c0a5564b3219";
function createApp(): Hono {
  const result = new Hono();
  result.use("*", async (c, next) => { c.set(MCP_ADAPTER_ID_VAR, c.req.header("X-Test-Caller") ?? "owner"); await next(); });
  registerIngestRoutes(result, {
    store, retriever: new HybridRetriever(store, new Bgem3Embedder()), assembler: new ContextAssembler(),
    assetStore: new AssetStore(dir),
  });
  return result;
}
const post = (content = text) => app.request("/ingest", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ requestId, source: "dashboard:manual", content: { type: "text", data: content } }),
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ingest-receipt-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
  // Real storage with a data fixture vector; no embedder substitute or model download.
  await store.addNode({ content: text, embedding: new Float32Array(1024) });
  app = createApp();
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("saved receipt reconciles a discarded response; reads and repeated UUID do not bump mentions again", async () => {
  const initial = await post();
  expect(initial.status).toBe(201);
  const result = await initial.json() as { originNodeId: number };
  const count = db.query("SELECT mention_count FROM knowledge_nodes WHERE id = ?").get(result.originNodeId);
  const status = await app.request(`/ingest/status/${requestId}`);
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ state: "saved", result });
  expect(await (await post()).json()).toEqual(result);
  expect(db.query("SELECT mention_count FROM knowledge_nodes WHERE id = ?").get(result.originNodeId)).toEqual(count);
});

test("request identity is scoped to caller and rejects a changed input", async () => {
  await post();
  const mismatch = await post("changed content must never reach the unloaded embedder");
  expect(mismatch.status).toBe(409);
  const other = await app.request(`/ingest/status/${requestId}`, { headers: { "X-Test-Caller": "other" } });
  expect(await other.json()).toEqual({ state: "unknown" });
});

test("missing/restarted receipt stays unknown even when the exact content is in SQLite", async () => {
  await post();
  app = createApp();
  expect(await (await app.request(`/ingest/status/${requestId}`)).json()).toEqual({ state: "unknown" });
  expect(await (await app.request("/ingest/status/not-a-uuid")).json()).toHaveProperty("error");
});

test("pre-write validation explicitly permits a corrected retry", async () => {
  const response = await post("");
  expect(response.status).toBe(400);
  expect(response.headers.get("X-Ingest-Retryable")).toBe("true");
});
