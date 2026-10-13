/**
 * v48 — 항목·일정 자동 등록(2026-10-10 spec 5장)의 자동 등록 기록·무시 기록 표.
 * 기준 스키마(db/schema/*.sql)는 동결이라 이 마이그레이션으로 더한다(2026-10-02 압축 설계 4절).
 * 두 표 모두 새로 만드는 표라 기존 행을 바꾸지 않는다. source_node_id 는 FK 를 두지 않는다 —
 * 메모가 휴지통에 갔다 돌아와도 무시 기록이 유지돼야 하기 때문이다.
 */
import type { Migration } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { runSqlStatements } from "../sql-statements.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS entity_register_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    stage          TEXT NOT NULL,
    run_id         TEXT,
    proposal_id    TEXT,
    source_node_id INTEGER NOT NULL,
    item_kind      TEXT NOT NULL CHECK (item_kind IN ('entity_created', 'entity_linked', 'schedule_created')),
    target_type    TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    name           TEXT NOT NULL,
    decided_by     TEXT NOT NULL CHECK (decided_by IN ('auto', 'approved')),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reverted')),
    detail_json    TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    reverted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_err_status_created ON entity_register_records(status, decided_by, created_at);
CREATE INDEX IF NOT EXISTS idx_err_source ON entity_register_records(source_node_id, status);
CREATE TABLE IF NOT EXISTS entity_register_ignores (
    source_node_id INTEGER NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('entity', 'schedule')),
    name_key       TEXT NOT NULL,
    reason         TEXT NOT NULL CHECK (reason IN ('ignored', 'reverted')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (source_node_id, kind, name_key)
);
`;

export const v48EntityRegister: Migration = {
  version: BASELINE_VERSION + 1,
  name: "entity-register-records",
  up: (db) => runSqlStatements(db, SQL, "v48-entity-register"),
};
