/**
 * v49 — 문서 OCR 서버 자동 처리(2026-10-11 document-ocr-api-providers spec D12)의 쪽 단위 결과 원장·하루 사용량 표.
 * 기준 스키마(db/schema/*.sql)는 동결이라 이 마이그레이션으로 더한다. 두 표 모두 새로 만드는 표라 기존 행을 바꾸지 않는다.
 *
 * document_ocr_page_results — 문서의 쪽마다 마지막 처리 결과 한 행(정리 깊은 패스 cleanup_stage_results 와 같은 규칙).
 *   completed_blank = 공급자가 정상 종료했는데 글이 없는 빈 쪽(실패가 아님, 사용자 결정 H3).
 *   문서가 영구 삭제되면 ON DELETE CASCADE 로 함께 지워진다. 성공한 쪽 글(markdown)은 문서 적용 뒤 그 문서 행과 함께 지운다.
 *   사용량(input/output_tokens)은 공급자가 준 경우만 적고, 없으면 NULL 로 둔다(0 으로 꾸미지 않음).
 * document_ocr_daily_usage — 설정 시간대 날짜별 실제 공급자 호출 수(실패한 호출 포함 — 실패도 과금될 수 있음).
 */
import type { Migration } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { runSqlStatements } from "../sql-statements.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS document_ocr_page_results (
    document_id       TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    page_index        INTEGER NOT NULL,
    page_count        INTEGER NOT NULL,
    input_fingerprint TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('completed', 'completed_blank', 'retryable_failure', 'terminal_failure')),
    markdown          TEXT,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    next_retry_at     TEXT,
    last_error        TEXT,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (document_id, page_index)
);
CREATE INDEX IF NOT EXISTS idx_document_ocr_page_results_retry ON document_ocr_page_results(status, next_retry_at);
CREATE TABLE IF NOT EXISTS document_ocr_daily_usage (
    day        TEXT PRIMARY KEY,
    page_calls INTEGER NOT NULL
);
`;

export const v49DocumentOcrLedger: Migration = {
  version: BASELINE_VERSION + 2,
  name: "document-ocr-ledger",
  up: (db) => runSqlStatements(db, SQL, "v49-document-ocr-ledger"),
};
