/**
 * stats-repository.archive.test.ts — archive 보관·복원 왕복에서 일정 칸 보존 검증.
 *
 * 활용 단계2 ② 발견: ① v23 가 knowledge_nodes 에 event_until 칸만 더하고
 * archive 보관·복원 통로는 안 건드렸다. setEventUntil 쓰기가 생기는 이 시점에
 * event_until 이 보관→복원에서 새지 않도록 막는다(과거 event_at 누락 패턴 재발 차단).
 *
 * Real bun:sqlite + sqlite-vec + real Bgem3Embedder. Mock 없음(테스트 정책 정합) —
 * restoreArchived 가 임베딩을 재생성하므로 실 embedder 가 필요하다.
 */

import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";

/** 복원을 요청한 행위자(WP-B1-20T 설계 5.4 — 되돌릴 출처 행이 없을 때 restore:<actor> 행이 된다). */
const RESTORE_ACTOR = "archive-roundtrip-test";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

test("archive→restore 왕복에서 event_until 보존(유실 0)", async () => {
  const id = await store.addNode({ content: "여행 글" });
  await store.setEventAt(id, "2026-06-01", "direct");
  await store.setEventUntil(id, "2026-06-05", "direct");
  expect((await store.trashNodes([id], "cascade")).movedIds).toEqual([id]);
  const restored = await store.restoreArchived(id, RESTORE_ACTOR);
  expect(restored).not.toBeNull();
  const row = db.query("SELECT event_at, event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_at: string | null; event_until: string | null };
  expect(row.event_at).toBe("2026-06-01");
  expect(row.event_until).toBe("2026-06-05");
});

test("event_until 가 NULL 이어도 왕복이 안전하다(단일 시점 일정)", async () => {
  const id = await store.addNode({ content: "단일 약속 글" });
  await store.setEventAt(id, "2026-06-01", "direct");
  expect((await store.trashNodes([id], "cascade")).movedIds).toEqual([id]);
  const restored = await store.restoreArchived(id, RESTORE_ACTOR);
  expect(restored).not.toBeNull();
  const row = db.query("SELECT event_at, event_until FROM knowledge_nodes WHERE id = ?")
    .get(id) as { event_at: string | null; event_until: string | null };
  expect(row.event_at).toBe("2026-06-01");
  expect(row.event_until).toBeNull();
});
