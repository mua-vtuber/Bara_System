/** Real SQLite with vector fixtures; historical supersedes authority is preserved. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { ConflictChecker } from "./conflict-checker.ts";
import { readSharedMemory } from "./shared-memory-contract.ts";
let db: Database;
let store: SqliteMemoryStore;
let checker: ConflictChecker;
function vector(sim: number): Float32Array {
  const result = new Float32Array(1024); result[0] = sim; result[1] = Math.sqrt(1 - sim * sim); return result;
}
beforeEach(() => { db = openMemoryDatabase(":memory:"); store = new SqliteMemoryStore(db, new Bgem3Embedder()); checker = new ConflictChecker(store); });
afterEach(() => db.close());

test.each(["source", "target"])("editing the %s endpoint cannot undo an existing supersedes edge", async (endpoint) => {
  const old = await store.addNode({ content: "커피 옛 사실", author: "owner", importance: 0.49, embedding: vector(1) });
  const current = await store.addNode({ content: "커피 새 사실", author: "owner", embedding: vector(0.7) });
  await store.addEdge({ sourceId: current, targetId: old, relation: "supersedes", provenance: "system", sourceNodeId: current, weight: 0.7 });
  const result = await checker.recheckAfterEdit({ nodeId: endpoint === "source" ? current : old,
    content: "등산 이야기", author: "owner", memoryType: "fact", newVector: vector(0) });
  expect(result).toEqual({ removed: 0, added: 0 });
  expect(await store.getSupersededNodeIds([old])).toEqual(new Set([old]));
  expect((await store.getNode(old))!.importance).toBe(0.49);
  expect(await store.getRevisionsForNode(old)).toEqual([]);
});

test("new similarity after an edit only disputes the edited assertion", async () => {
  const old = await store.addNode({ content: "커피 옛 사실", author: "owner", importance: 0.7, embedding: vector(1) });
  const edited = await store.addNode({ content: "커피 변경 사실", author: "owner", embedding: vector(0.7) });
  const result = await checker.recheckAfterEdit({ nodeId: edited, content: "커피", author: "owner", memoryType: "fact", newVector: vector(0.7) });
  expect(result).toEqual({ removed: 0, added: 1 });
  expect(readSharedMemory((await store.getNode(edited))!.metadata).status).toBe("disputed");
  expect(readSharedMemory((await store.getNode(old))!.metadata).status).toBe("active");
  expect((await store.getNode(old))!.importance).toBe(0.7);
  expect(await store.getSupersededNodeIds([old])).toEqual(new Set());
});
