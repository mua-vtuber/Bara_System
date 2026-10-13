import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { isPublicPath } from "../auth-gate-public-paths.ts";
import { registerDocumentRoutes } from "./documents.ts";

let db: Database;
let store: SqliteMemoryStore;
let app: Hono;
let id: string;
interface StatusBody {
  document: { documentId: string; parse: { status: string }; nodeId: number;
    extraction: { totalChunks: number; completedChunks: number }; leaseActive: boolean };
}
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const embedder = new Bgem3Embedder();
  store = new SqliteMemoryStore(db, embedder);
  app = new Hono();
  registerDocumentRoutes(app, { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  db.query("INSERT INTO asset_files (sha256,asset_type,asset_path,byte_size,first_imported_at) VALUES ('a','text','a.md',1,'2026-09-24 12:00:00')").run();
  id = store.createDocument({ assetSha256: "a", title: "회의록", documentType: "free", sourceMetadata: {
    parse: { status: "text_succeeded", method: "tier1", originalAssetSha256: "a" },
  } });
  db.query("INSERT INTO knowledge_nodes(content,source_type,metadata_json) VALUES ('본문','document',?)").run(JSON.stringify({ documentId: id }));
  for (const metadata of [{ parentId: id }, { parentId: id, extracted: 1 }, { parentId: id, extractedTo: [] }]) {
    db.query("INSERT INTO knowledge_nodes(content,source_type,metadata_json) VALUES ('청크','document_chunk',?)").run(JSON.stringify(metadata));
  }
});
afterEach(() => db.close());

test("exact status returns parsed documents with actual extraction progress and is read only", async () => {
  const before = db.query("SELECT total_changes() AS n").get();
  const response = await app.request(`/api/documents/${id}/status`);
  expect(response.status).toBe(200);
  const result = await response.json() as StatusBody;
  expect(result.document.documentId).toBe(id);
  expect(result.document.parse.status).toBe("text_succeeded");
  expect(result.document.nodeId).toBe(1);
  expect(result.document.extraction).toEqual({ totalChunks: 3, completedChunks: 2 });
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
  expect(isPublicPath(`/api/documents/${id}/status`)).toBe(false);
});
test("unknown document is 404, retained metadata without the deleted document node is 410", async () => {
  expect((await app.request("/api/documents/missing/status")).status).toBe(404);
  db.query("DELETE FROM knowledge_nodes WHERE source_type='document'").run();
  expect((await app.request(`/api/documents/${id}/status`)).status).toBe(410);
});
test("expired OCR leases are reported inactive and legacy extraction edges count as processed", async () => {
  store.updateDocumentSourceMetadata({ documentId: id, sourceMetadata: { parse: {
    status: "needs_ocr", method: "tier1", originalAssetSha256: "a",
    lease: { workerId: "old-worker", claimedAt: "2020-01-01 00:00:00", leaseUntil: "2020-01-01 00:30:00" },
  } } });
  db.query("INSERT INTO knowledge_edges(source_id,target_id,relation,weight,provenance) VALUES (3,2,'merged_into',1,'system')").run();
  const response = await app.request(`/api/documents/${id}/status`);
  const result = await response.json() as StatusBody;
  expect(result.document.leaseActive).toBe(false);
  expect(result.document.extraction.completedChunks).toBe(3);
});

test("lineage-invalidated (withdrawn) chunks drop out of both totalChunks and completedChunks, read-only", async () => {
  // 편집으로 철회된 청크(sharedMemory.status=retracted + invalidatedBy) 하나를 추가.
  // 이 청크는 추출 완료 표시가 있어도 active 가 아니므로 totalChunks·completedChunks 모두 제외된다.
  db.query(
    "INSERT INTO knowledge_nodes(content,source_type,metadata_json) VALUES ('철회된 청크','document_chunk',?)",
  ).run(JSON.stringify({
    parentId: id,
    extracted: 1,
    sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown", invalidatedBy: 1 },
  }));
  const before = db.query("SELECT total_changes() AS n").get();
  const response = await app.request(`/api/documents/${id}/status`);
  expect(response.status).toBe(200);
  const result = await response.json() as StatusBody;
  // beforeEach 의 active 청크 3개(1 미완료 + 2 완료)만 집계되고, 철회된 청크는 빠진다.
  expect(result.document.extraction).toEqual({ totalChunks: 3, completedChunks: 2 });
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
});
