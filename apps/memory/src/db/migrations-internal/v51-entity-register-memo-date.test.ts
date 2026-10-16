/**
 * v51 자동 등록 기록 표·무시 표 다시 만들기 — 실제 SQLite + 실제 마이그레이션
 * (2026-10-16 yearless-date-cleanup spec 3.12, 10장 T3).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, openMemoryDatabase, runMigrations } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { removeTempDir } from "../migration-safety.test-helpers.ts";
import { assertSameCount } from "./v51-entity-register-memo-date.ts";

const DIM = 8;
const V51 = BASELINE_VERSION + 4;
const CHECK_FAILED = "CHECK constraint failed";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

function openV50(file = ":memory:"): Database {
  const db = new Database(file);
  sqliteVec.load(db);
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, MIGRATIONS.filter((m) => m.version < V51), DIM);
  return db;
}

function insertRecord(db: Database, id: number | null, itemKind: string, status: string): number {
  return Number(
    db
      .query(
        `INSERT INTO entity_register_records
           (id, stage, run_id, proposal_id, source_node_id, item_kind, target_type, target_id, name, decided_by, status, detail_json, created_at, reverted_at)
         VALUES (?, 'entity_register', 'run-1', NULL, 3, ?, 'person', '12', '민수', 'auto', ?, '{"a":1}', '2026-10-10 09:00:00', ?)`,
      )
      .run(id, itemKind, status, status === "reverted" ? "2026-10-11 09:00:00" : null).lastInsertRowid,
  );
}

function insertIgnore(db: Database, nodeId: number, kind: string, nameKey: string, reason: string): void {
  db.query(
    "INSERT INTO entity_register_ignores (source_node_id, kind, name_key, reason, created_at) VALUES (?, ?, ?, ?, '2026-10-10 09:00:00')",
  ).run(nodeId, kind, nameKey, reason);
}

const allRecords = (db: Database) => db.query("SELECT * FROM entity_register_records ORDER BY id").all();
const allIgnores = (db: Database) => db.query("SELECT * FROM entity_register_ignores ORDER BY source_node_id, kind, name_key").all();
const indexNames = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entity_register_records' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const tableNames = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'entity_register_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("v51 마이그레이션", () => {
  test("v50 DB 의 행을 열 값 그대로 옮기고, 다음 기록 id 는 옛 sqlite_sequence 다음이다", () => {
    const db = openV50();
    insertRecord(db, 1, "entity_created", "active");
    insertRecord(db, 2, "schedule_created", "reverted");
    insertRecord(db, 5, "entity_linked", "active");
    db.query("UPDATE sqlite_sequence SET seq = 7 WHERE name = 'entity_register_records'").run();
    insertIgnore(db, 3, "entity", "민수", "ignored");
    insertIgnore(db, 4, "schedule", "", "reverted");
    const recordsBefore = allRecords(db);
    const ignoresBefore = allIgnores(db);

    runMigrations(db, MIGRATIONS, DIM);

    expect(allRecords(db)).toEqual(recordsBefore);
    expect(allIgnores(db)).toEqual(ignoresBefore);
    expect(insertRecord(db, null, "entity_created", "active")).toBe(8);
    expect(tableNames(db)).toEqual(["entity_register_ignores", "entity_register_records"]);
    expect(indexNames(db)).toEqual(["idx_err_source", "idx_err_status_created"]);
    db.close();
  });

  test("마이그레이션 뒤 새 종류 값은 들어가고 모르는 값은 CHECK 가 거절한다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(V51);
      insertRecord(db, null, "memo_date_filled", "active");
      insertIgnore(db, 9, "memo_date", "", "ignored");
      expect(() => insertRecord(db, null, "bogus", "active")).toThrow(CHECK_FAILED);
      expect(() => insertIgnore(db, 9, "bogus", "x", "ignored")).toThrow(CHECK_FAILED);
      expect(() => insertIgnore(db, 9, "entity", "y", "bogus")).toThrow(CHECK_FAILED);
    } finally {
      db.close();
    }
  });

  test("빈 DB(새 설치)도 같은 길로 성공하고 두 색인이 있다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      expect(tableNames(db)).toEqual(["entity_register_ignores", "entity_register_records"]);
      expect(indexNames(db)).toEqual(["idx_err_source", "idx_err_status_created"]);
      expect(allRecords(db)).toEqual([]);
      expect(insertRecord(db, null, "entity_created", "active")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("행 수가 다르면 두 표 이름·옛/새 행 수·DB 설정 키를 담은 오류로 멈춘다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      expect(() => assertSameCount(db, "entity_register_ignores", 2, 1)).toThrow(
        /entity_register_records.*entity_register_ignores.*entity_register_ignores 의 행 수가 다릅니다\(옮기기 전 2행, 옮긴 뒤 1행\).*db\.path.*MEMORY_DB_PATH/,
      );
      expect(() => assertSameCount(db, "entity_register_records", 3, 3)).not.toThrow();
    } finally {
      db.close();
    }
  });

  test("파일 DB 를 다시 열면 아무것도 바꾸지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "bara-v51-"));
    tempDirs.push(dir);
    const file = join(dir, "bara.sqlite");
    const old = openV50(file);
    insertRecord(old, 4, "entity_created", "active");
    insertIgnore(old, 3, "schedule", "", "ignored");
    old.close();

    const first = openMemoryDatabase(file, { embeddingDim: DIM });
    const schema = first.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const rows = allRecords(first);
    const versions = first.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
    first.close();

    const again = openMemoryDatabase(file, { embeddingDim: DIM });
    try {
      expect(again.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schema);
      expect(allRecords(again)).toEqual(rows);
      expect(again.query("SELECT version, applied_at FROM schema_version ORDER BY version").all()).toEqual(versions);
      expect(rows).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});
