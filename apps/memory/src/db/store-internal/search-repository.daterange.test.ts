// src/db/store-internal/search-repository.daterange.test.ts
// 구간 겹침 검증 — event_at/event_until/created_at 을 직접 심어 SQL 판정만 본다.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SearchRepository } from "./search-repository.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let repo: SearchRepository;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  repo = new SearchRepository(db, embedder);
});
afterEach(() => {
  db.close();
});

/** event_at·event_until 을 심은 노드 하나 만들고 id 반환. */
function insertNode(eventAt: string | null, eventUntil: string | null): number {
  db.prepare("INSERT INTO knowledge_nodes (content, event_at, event_until) VALUES (?, ?, ?)")
    .run("일정 글", eventAt, eventUntil);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

test("순간 일정(event_until NULL): 그 하루 검색에만 걸린다 — 한 점과 동일", () => {
  const id = insertNode("2026-06-01", null);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-01", "2026-06-01").has(id)).toBe(true);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-03", "2026-06-03").has(id)).toBe(false);
});

test("구간 일정: 시작·끝 사이 중간 날짜 검색에 새로 걸린다(회상 구멍 닫힘)", () => {
  const id = insertNode("2026-06-01", "2026-06-05");
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-03", "2026-06-03").has(id)).toBe(true);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-01", "2026-06-01").has(id)).toBe(true);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-05", "2026-06-05").has(id)).toBe(true);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-06", "2026-06-06").has(id)).toBe(false);
});

test("검색 구간과 저장 구간이 부분만 겹쳐도 걸린다", () => {
  const id = insertNode("2026-06-01", "2026-06-05");
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-04", "2026-06-10").has(id)).toBe(true);
  expect(repo.filterNodeIdsByDateRange([id], "2026-05-20", "2026-06-02").has(id)).toBe(true);
});

test("시각 포함 event_at 도 날짜로 절삭해 걸린다(date() 비교)", () => {
  const id = insertNode("2026-06-25T14:00", null);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-25", "2026-06-25").has(id)).toBe(true);
});

test("event_at·event_until 둘 다 NULL 이면 created_at 으로 거른다", () => {
  const id = insertNode(null, null);
  db.prepare("UPDATE knowledge_nodes SET created_at = ? WHERE id = ?").run("2026-06-02 09:00:00", id);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-02", "2026-06-02").has(id)).toBe(true);
  expect(repo.filterNodeIdsByDateRange([id], "2026-06-09", "2026-06-09").has(id)).toBe(false);
});

test("후보 0개·범위 일치 0개면 빈 Set(에러 아님)", () => {
  expect(repo.filterNodeIdsByDateRange([], "2026-06-01", "2026-06-01").size).toBe(0);
  const id = insertNode("2026-06-01", null);
  expect(repo.filterNodeIdsByDateRange([id], "2026-12-01", "2026-12-31").size).toBe(0);
});
