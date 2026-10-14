/**
 * v50 — 자동 추출·캡션 백필의 실패 기록 표 (2026-10-14 backfill-retry-ledger spec 4.1).
 * 기준 스키마(db/schema/*.sql)는 동결이라 이 마이그레이션으로 더한다. 새 표라 기존 행을 바꾸지 않는다.
 *
 * backfill_attempts — 실패 중인 대상만 한 줄. 성공하면 지운다(완료 상태 없음 — 결과는 노드로 남는다).
 *   kind=extraction: target_key = 노드 id(10진 문자열), node_id = 그 노드.
 *   kind=caption   : target_key = asset_sha256,       node_id = 부모 이미지 노드(화면 표시·정리용).
 *   노드가 영구 삭제되면 ON DELETE CASCADE 로 함께 지워진다. 시각은 설정 시간대 문자열(nowKst 형식)이라 글자 순서로 비교한다.
 *   idx_backfill_attempts_block — 종류별 막힘(멈춤·재시도 시각) 판정과 세기용.
 *
 * 동결된 마이그레이션이라 CHECK 목록은 글자 그대로 적는다(store-internal/backfill-attempts-sql.ts 의 목록과 같은 값).
 */
import type { Migration } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { runSqlStatements } from "../sql-statements.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS backfill_attempts (
    kind              TEXT NOT NULL CHECK (kind IN ('extraction', 'caption')),
    target_key        TEXT NOT NULL,
    node_id           INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    input_fingerprint TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('retryable_failure', 'terminal_failure')),
    attempt_count     INTEGER NOT NULL,
    next_retry_at     TEXT,
    last_error        TEXT NOT NULL,
    last_attempt_at   TEXT NOT NULL,
    PRIMARY KEY (kind, target_key)
);
CREATE INDEX IF NOT EXISTS idx_backfill_attempts_block ON backfill_attempts(kind, status, next_retry_at);
`;

export const v50BackfillAttempts: Migration = {
  version: BASELINE_VERSION + 3,
  name: "backfill-attempts",
  up: (db) => runSqlStatements(db, SQL, "v50-backfill-attempts"),
};
