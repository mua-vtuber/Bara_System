import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, openMemoryDatabase, runMigrations } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { removeTempDir } from "../migration-safety.test-helpers.ts";

const DIM = 8;
const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'entity_register_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const versions = (db: Database) =>
  (db.query("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[]).map((r) => r.version);
const schemaObjects = (db: Database) => db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
const CHECK_FAILED = "CHECK constraint failed";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

test("a new database gets both tables and version 48", () => {
  const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
  expect(tables(db)).toEqual(["entity_register_ignores", "entity_register_records"]);
  expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(BASELINE_VERSION + 1);
  db.close();
});

test("an existing v47 database is upgraded by the same up()", () => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, [], DIM);
  expect(tables(db)).toEqual([]);
  runMigrations(db, MIGRATIONS, DIM);
  expect(tables(db)).toEqual(["entity_register_ignores", "entity_register_records"]);
  db.close();
});

test("CHECK constraints refuse unknown item kinds, deciders, statuses, ignore kinds and reasons", () => {
  const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
  const insertRecord = (itemKind: string, decidedBy: string, status: string) =>
    db.run(
      `INSERT INTO entity_register_records (stage, source_node_id, item_kind, target_type, target_id, name, decided_by, status, detail_json)
       VALUES ('entity_register', 1, ?, 'person', 'p', 'n', ?, ?, '{}')`,
      [itemKind, decidedBy, status],
    );
  const insertIgnore = (kind: string, reason: string) =>
    db.run("INSERT INTO entity_register_ignores (source_node_id, kind, name_key, reason) VALUES (1, ?, 'a', ?)", [kind, reason]);
  try {
    expect(() => insertRecord("bogus", "auto", "active")).toThrow(CHECK_FAILED);
    expect(() => insertRecord("entity_created", "bogus", "active")).toThrow(CHECK_FAILED);
    expect(() => insertRecord("entity_created", "auto", "bogus")).toThrow(CHECK_FAILED);
    expect(() => insertIgnore("bogus", "ignored")).toThrow(CHECK_FAILED);
    expect(() => insertIgnore("entity", "bogus")).toThrow(CHECK_FAILED);
    // 올바른 값은 들어간다 — 위 실패가 다른 칸 때문이 아님을 보인다.
    insertRecord("entity_created", "auto", "active");
    insertIgnore("entity", "ignored");
  } finally {
    db.close();
  }
});

test("detail_json has no default — a record without it is refused", () => {
  const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
  try {
    expect(() =>
      db.run(`INSERT INTO entity_register_records (stage, source_node_id, item_kind, target_type, target_id, name, decided_by)
              VALUES ('entity_register', 1, 'entity_created', 'person', 'p', 'n', 'auto')`),
    ).toThrow("NOT NULL constraint failed: entity_register_records.detail_json");
  } finally {
    db.close();
  }
});

test("deploy path: a v47 file DB with a memory is upgraded on open, snapshotted first, and reopening changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-v48-deploy-"));
  tempDirs.push(dir);
  const file = join(dir, "bara.sqlite");
  const backupDir = join(dir, "backups");

  // 배포 전 운영 DB 재현: 기준 스키마(v47)만 있고 기억 한 줄이 들어 있다.
  const old = new Database(file);
  sqliteVec.load(old);
  old.run("PRAGMA foreign_keys = ON");
  runMigrations(old, [], DIM);
  old.query("INSERT INTO knowledge_nodes (content) VALUES (?)").run("배포 전 기억");
  expect(versions(old)).toEqual([BASELINE_VERSION]);
  old.close();

  // 운영과 같은 길: openMemoryDatabase + 사전 스냅샷 옵션(server.ts 와 같은 모양).
  const options = { embeddingDim: DIM, preMigrationSnapshot: { dir: backupDir, appVersion: "0.0.0-test" } };
  const db = openMemoryDatabase(file, options);
  let objects: unknown[];
  let versionRows: unknown[];
  try {
    expect(versions(db)).toEqual(MIGRATIONS.reduce((acc, m) => [...acc, m.version], [BASELINE_VERSION]));
    expect(tables(db)).toEqual(["entity_register_ignores", "entity_register_records"]);
    expect(db.query("SELECT content FROM knowledge_nodes").all()).toEqual([{ content: "배포 전 기억" }]);
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    objects = schemaObjects(db);
    versionRows = db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
  } finally {
    db.close();
  }
  const snapshots = readdirSync(join(backupDir, "pre-migration"));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]!).toContain(`pre-v${BASELINE_VERSION}-`);

  // 다시 열면 할 일이 없다 — 버전 행·스키마·기억 그대로, 스냅샷도 더 안 뜬다.
  const again = openMemoryDatabase(file, options);
  try {
    expect(again.query("SELECT version, applied_at FROM schema_version ORDER BY version").all()).toEqual(versionRows);
    expect(schemaObjects(again)).toEqual(objects);
    expect(again.query("SELECT content FROM knowledge_nodes").all()).toEqual([{ content: "배포 전 기억" }]);
  } finally {
    again.close();
  }
  expect(existsSync(join(backupDir, "pre-migration"))).toBe(true);
  expect(readdirSync(join(backupDir, "pre-migration"))).toHaveLength(1);
});
