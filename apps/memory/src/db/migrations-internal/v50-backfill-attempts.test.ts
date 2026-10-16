/**
 * v50 백필 실패 기록 표 — 실제 SQLite + 실제 마이그레이션 (2026-10-14 backfill-retry-ledger spec 4.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, openMemoryDatabase, runMigrations } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";

const DIM = 8;
const V50 = BASELINE_VERSION + 3;
let db: Database;
beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: DIM }); });
afterEach(() => db.close());

const hasObject = (target: Database, type: string, name: string) =>
  target.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== null;

function insertNode(target: Database): number {
  return Number(
    target.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES ('글', 'auto_capture', '2026-10-14 09:00:00')").run().lastInsertRowid,
  );
}

function insertAttempt(target: Database, kind: string, status: string, nodeId: number): void {
  target.query(
    `INSERT INTO backfill_attempts (kind, target_key, node_id, input_fingerprint, status, attempt_count, next_retry_at, last_error, last_attempt_at)
     VALUES (?, ?, ?, 'f', ?, 1, NULL, 'e', '2026-10-14 09:00:00')`,
  ).run(kind, String(nodeId), nodeId, status);
}

describe("v50 마이그레이션", () => {
  test("새 DB 에 표와 막힘 색인이 생기고 코드가 아는 최고 버전은 50 이상이다", () => {
    expect(hasObject(db, "table", "backfill_attempts")).toBe(true);
    expect(hasObject(db, "index", "idx_backfill_attempts_block")).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(V50);
  });

  test("기존 v49 DB 도 같은 up() 으로 올라간다", () => {
    const old = new Database(":memory:");
    sqliteVec.load(old);
    old.run("PRAGMA foreign_keys = ON");
    runMigrations(old, MIGRATIONS.filter((m) => m.version < V50), DIM);
    expect(hasObject(old, "table", "backfill_attempts")).toBe(false);
    runMigrations(old, MIGRATIONS, DIM);
    expect(hasObject(old, "table", "backfill_attempts")).toBe(true);
    old.close();
  });

  test("종류·상태 CHECK 는 모르는 값을 거절한다", () => {
    const id = insertNode(db);
    expect(() => insertAttempt(db, "bogus", "retryable_failure", id)).toThrow("CHECK constraint failed");
    expect(() => insertAttempt(db, "extraction", "completed", id)).toThrow("CHECK constraint failed");
    insertAttempt(db, "extraction", "retryable_failure", id);
    insertAttempt(db, "caption", "terminal_failure", id);
  });

  test("노드를 영구 삭제하면 줄도 함께 지워진다(ON DELETE CASCADE)", () => {
    const id = insertNode(db);
    insertAttempt(db, "extraction", "terminal_failure", id);
    db.query("DELETE FROM knowledge_nodes WHERE id = ?").run(id);
    expect(db.query("SELECT COUNT(*) AS n FROM backfill_attempts").get()).toEqual({ n: 0 });
  });
});
