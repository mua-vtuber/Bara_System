/**
 * v51 — 자동 등록 기록 표·무시 표의 종류 목록을 넓힌다(2026-10-16 yearless-date-cleanup spec 3.12).
 *   entity_register_records.item_kind 에 'memo_date_filled'(정리 AI 가 메모 날짜를 채움),
 *   entity_register_ignores.kind 에 'memo_date'(메모 날짜 거절·되돌림)를 더한다.
 *
 * SQLite 는 CHECK 목록을 바꾸는 ALTER 가 없어서 두 표를 새로 만들고 행을 그대로 옮긴다(id 포함, 바꾸거나 추측하는 값 없음).
 * 옮기기 전 행 수와 sqlite_sequence 값을 읽어 두고, 옮긴 뒤 행 수가 다르면 이름 붙은 오류로 멈춘다 — 마이그레이션 실행기
 * (migrations.ts runMigrations)의 IMMEDIATE 트랜잭션이 되돌린다. sqlite_sequence 는 옛 값으로 되돌려 다음 기록 id 가 지운
 * 옛 id 와 겹치지 않게 한다.
 *
 * 동결된 마이그레이션이라 CHECK 목록은 글자 그대로 적는다(v48 관례). 값을 다시 바꾸려면 새 마이그레이션이 필요하다.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { runSqlStatements } from "../sql-statements.ts";
import { mainDatabaseFile } from "../schema-version-gate.ts";
import { KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE } from "../migration-stop-guidance.ts";

const SOURCE = "v51-entity-register-memo-date";
const RECORDS_TABLE = "entity_register_records";
const IGNORES_TABLE = "entity_register_ignores";

const RECORD_COLUMNS =
  "id, stage, run_id, proposal_id, source_node_id, item_kind, target_type, target_id, name, decided_by, status, detail_json, created_at, reverted_at";
const IGNORE_COLUMNS = "source_node_id, kind, name_key, reason, created_at";

const SQL = `
CREATE TABLE entity_register_records_v51 (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    stage          TEXT NOT NULL,
    run_id         TEXT,
    proposal_id    TEXT,
    source_node_id INTEGER NOT NULL,
    item_kind      TEXT NOT NULL CHECK (item_kind IN ('entity_created', 'entity_linked', 'schedule_created', 'memo_date_filled')),
    target_type    TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    name           TEXT NOT NULL,
    decided_by     TEXT NOT NULL CHECK (decided_by IN ('auto', 'approved')),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reverted')),
    detail_json    TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    reverted_at    TEXT
);
INSERT INTO entity_register_records_v51 (${RECORD_COLUMNS}) SELECT ${RECORD_COLUMNS} FROM entity_register_records;
DROP TABLE entity_register_records;
ALTER TABLE entity_register_records_v51 RENAME TO entity_register_records;
CREATE INDEX IF NOT EXISTS idx_err_status_created ON entity_register_records(status, decided_by, created_at);
CREATE INDEX IF NOT EXISTS idx_err_source ON entity_register_records(source_node_id, status);
CREATE TABLE entity_register_ignores_v51 (
    source_node_id INTEGER NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('entity', 'schedule', 'memo_date')),
    name_key       TEXT NOT NULL,
    reason         TEXT NOT NULL CHECK (reason IN ('ignored', 'reverted')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (source_node_id, kind, name_key)
);
INSERT INTO entity_register_ignores_v51 (${IGNORE_COLUMNS}) SELECT ${IGNORE_COLUMNS} FROM entity_register_ignores;
DROP TABLE entity_register_ignores;
ALTER TABLE entity_register_ignores_v51 RENAME TO entity_register_ignores;
`;

function countRows(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function readRecordsSequence(db: Database): number | null {
  const row = db.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(RECORDS_TABLE) as { seq: number } | null;
  return row === null ? null : row.seq;
}

/** 옮기기 전·뒤 행 수가 다르면 멈춘다. 오류 문구 검사를 위해 내보낸다(마이그레이션 밖에서 부르지 않는다). */
export function assertSameCount(db: Database, table: string, before: number, after: number): void {
  if (before === after) return;
  throw new Error(
    `${SOURCE}: 두 표(${RECORDS_TABLE}, ${IGNORES_TABLE})를 새로 만들어 옮긴 뒤 ${table} 의 행 수가 다릅니다` +
      `(옮기기 전 ${before}행, 옮긴 뒤 ${after}행) — ` +
      `마이그레이션을 되돌리고 멈춥니다. DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH 가 가리키며, ` +
      `지금 연 파일은 '${mainDatabaseFile(db)}' 입니다. ${KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE}`,
  );
}

function up(db: Database): void {
  const recordsBefore = countRows(db, RECORDS_TABLE);
  const ignoresBefore = countRows(db, IGNORES_TABLE);
  const sequenceBefore = readRecordsSequence(db);

  runSqlStatements(db, SQL, SOURCE);

  if (sequenceBefore !== null) {
    db.query("DELETE FROM sqlite_sequence WHERE name = ?").run(RECORDS_TABLE);
    db.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(RECORDS_TABLE, sequenceBefore);
  }

  assertSameCount(db, RECORDS_TABLE, recordsBefore, countRows(db, RECORDS_TABLE));
  assertSameCount(db, IGNORES_TABLE, ignoresBefore, countRows(db, IGNORES_TABLE));
}

export const v51EntityRegisterMemoDate: Migration = {
  version: BASELINE_VERSION + 4,
  name: "entity-register-memo-date",
  up,
};
