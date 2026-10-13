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

test("getNodeKinds — 종류 심은 글만 Map 에 담는다(없는 글은 키 부재·가짜 0 금지)", async () => {
  const db = openMemoryDatabase(DB_PATH, { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  const withKind = await store.addNode({
    content: "가계부 기록",
    memoryType: "episode",
    sourceType: "user_explicit",
  });
  const withSchedule = await store.addNode({
    content: "일정 메모",
    memoryType: "episode",
    sourceType: "user_explicit",
  });
  const noKind = await store.addNode({
    content: "종류 없는 글",
    memoryType: "episode",
    sourceType: "user_explicit",
  });

  await store.addClassificationTag(withKind, "종류", "가계부", "user_input", withKind);
  await store.addClassificationTag(withSchedule, "종류", "일정", "user_input", withSchedule);

  const map = store.getNodeKinds([withKind, withSchedule, noKind]);

  expect(map.get(withKind)).toBe("가계부");
  expect(map.get(withSchedule)).toBe("일정");
  expect(map.has(noKind)).toBe(false);

  db.close();
});

test("getNodeKinds — 빈 배열이면 빈 Map(쿼리 진입 안 함)", async () => {
  const db = openMemoryDatabase(DB_PATH, { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  expect(store.getNodeKinds([]).size).toBe(0);

  db.close();
});

test("getNodeKinds — getNodeKind 와 같은 종류명을 준다(일관)", async () => {
  const db = openMemoryDatabase(DB_PATH, { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);

  const id = await store.addNode({
    content: "가계부 지출",
    memoryType: "episode",
    sourceType: "user_explicit",
  });
  await store.addClassificationTag(id, "종류", "가계부", "user_input", id);

  const bulk = store.getNodeKinds([id]);
  const single = store.getNodeKind(id);

  // getNodeKind 가 null 을 돌려주면 가계부 연결이 잘못된 것이므로 먼저 단언한다.
  expect(single).not.toBeNull();
  expect(bulk.get(id)).toBe(single as string);

  db.close();
});
