import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { registerArchiveRoutes } from "./archive.ts";
import type { ArchivePage } from "../../db/store-internal/archive-page.ts";

let db: Database;
let app: Hono;
beforeEach(async () => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  // 조회 테스트는 모델을 호출하지 않지만 store에는 실제 구현을 주입한다.
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(db, embedder);
  app = new Hono();
  registerArchiveRoutes(app, { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler() });
  const insert = db.prepare("INSERT INTO knowledge_nodes (content, memory_type, created_at) VALUES (?, 'note', '2026-09-24 10:00:00')");
  const ids: number[] = [];
  for (let i = 1; i <= 205; i++) ids.push(Number(insert.run("기억 " + i).lastInsertRowid));
  await store.trashNodes(ids, "cascade");
});
afterEach(() => db.close());

test("같은 삭제 시각의 205개를 누락·중복 없이 끝까지 조회한다", async () => {
  const ids: number[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const res = await app.request("/archive?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    expect(res.status).toBe(200);
    const body = await res.json() as ArchivePage;
    expect(body.total).toBe(205);
    ids.push(...body.archive.map((node: {id: number}) => node.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  expect(ids).toHaveLength(205);
  expect(new Set(ids).size).toBe(205);
  expect(ids[0]).toBe(205);
  expect(ids.at(-1)).toBe(1);
});

test("먼저 읽은 항목이 복구돼 목록이 줄어도 다음 페이지가 건너뛰지 않는다", async () => {
  const first = await (await app.request("/archive?limit=50")).json() as ArchivePage;
  expect(typeof first.nextCursor).toBe("string");
  // 실제 DB 데이터 fixture 변경: 복구가 만드는 archive 행 제거 상태.
  db.run("DELETE FROM knowledge_nodes_archive WHERE id IN (205,204,180,156)");
  const second = await (await app.request("/archive?limit=50&cursor=" + encodeURIComponent(first.nextCursor!))).json() as ArchivePage;
  expect(second.total).toBe(201);
  expect(second.archive.map((node: {id: number}) => node.id)).toEqual(Array.from({length: 50}, (_, i) => 155 - i));
});

test("잘못된 커서는 빈 목록으로 위장하지 않고 거부한다", async () => {
  expect((await app.request("/archive?cursor=not-a-cursor")).status).toBe(400);
  const invalid = Buffer.from(JSON.stringify({at: "2026-09-24", id: -1})).toString("base64url");
  expect((await app.request("/archive?cursor=" + invalid)).status).toBe(400);
});

test("기존 archive 배열과 since 필터 계약은 유지된다", async () => {
  const old = await (await app.request("/archive?limit=3")).json() as ArchivePage;
  expect(old.archive).toHaveLength(3);
  const empty = await (await app.request("/archive?since=2999-01-01")).json() as ArchivePage;
  expect(empty.archive).toEqual([]);
  expect(empty.total).toBe(0);
  expect(empty.nextCursor).toBeNull();
});
