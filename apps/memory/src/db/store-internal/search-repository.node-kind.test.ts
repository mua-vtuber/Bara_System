import { test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";
import { unlinkSync } from "node:fs";

const DB_PATH = ":memory:";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

afterEach(() => {
  try { unlinkSync(DB_PATH); } catch { /* 없으면 무시 */ }
});

test("getNodeKind — 종류 분류 없으면 null", async () => {
  const db = openMemoryDatabase(DB_PATH, { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const nodeId = await store.addNode({
    content: "테스트",
    memoryType: "episode",
    sourceType: "user_explicit",
  });
  expect(store.getNodeKind(nodeId)).toBeNull();
  db.close();
});

test("getNodeKind — addClassificationTag 로 종류:일정 연결하면 '일정' 반환", async () => {
  const db = openMemoryDatabase(DB_PATH, { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const nodeId = await store.addNode({
    content: "회의",
    memoryType: "episode",
    sourceType: "user_explicit",
  });
  await store.addClassificationTag(nodeId, "종류", "일정", "user_input", nodeId);
  expect(store.getNodeKind(nodeId)).toBe("일정");
  db.close();
});
