/**
 * document-ocr/ledger.ts — 문서 OCR 서버 자동 처리의 쪽 단위 결과 원장·하루 사용량 (2026-10-11 spec D12·D13).
 *
 * 같은 쪽을 영구히 다시 부르지 않게(재과금 방지) 쪽마다 마지막 결과 한 행을 남긴다. 규칙은 정리 깊은 패스
 * 결과 원장(stage-results-ledger.ts)과 같다:
 *   - completed          : 그 쪽 글이 있음. 시도 수 0 으로 되돌림. 지문이 같으면 다시 부르지 않음(reuse_completed).
 *   - retryable_failure  : 일시 실패(시도 수 그대로, terminal 로 올리지 않음) 또는 상한 전 결정적 실패.
 *                          next_retry_at 이 지나야 다시 부른다.
 *   - terminal_failure   : 같은 지문으로 결정적 실패가 상한에 닿음. 지문이 바뀌거나 수동 다시 읽기 전까지 안 부름.
 * 지문(입력 지문)이 바뀌면 completed·terminal 행도 다시 평가한다(공급자·모델·한도·쪽 그림 크기·지시문 변경 신호).
 *
 * 실제 SQLite 를 raw db 핸들로 직접 쓴다(stage-results-ledger.ts 관례). 시각은 설정 시간대 문자열(nowKst)이라
 * next_retry_at 비교가 글자 순서로 맞는다.
 */

import type { Database } from "bun:sqlite";
import { nowKst } from "../../db/store-internal/helpers.ts";

/** completed_blank = 정상 종료했지만 글이 없는 빈 쪽(실패 아님 — 재사용하며 적용 때 빈 쪽 수로 센다). */
export type OcrPageStatus = "completed" | "completed_blank" | "retryable_failure" | "terminal_failure";

export interface OcrPageRow {
  documentId: string;
  pageIndex: number;
  pageCount: number;
  inputFingerprint: string;
  status: OcrPageStatus;
  markdown: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  updatedAt: string;
}

/** 공급자가 알려 준 사용량. 모르면 null(0 으로 꾸미지 않음). */
export type OcrPageUsage = { inputTokens?: number; outputTokens?: number } | null;

interface RawRow {
  document_id: string;
  page_index: number;
  page_count: number;
  input_fingerprint: string;
  status: string;
  markdown: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  updated_at: string;
}

function toRow(r: RawRow): OcrPageRow {
  return {
    documentId: r.document_id,
    pageIndex: r.page_index,
    pageCount: r.page_count,
    inputFingerprint: r.input_fingerprint,
    status: r.status as OcrPageStatus,
    markdown: r.markdown,
    attemptCount: r.attempt_count,
    nextRetryAt: r.next_retry_at,
    lastError: r.last_error,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLUMNS = `document_id, page_index, page_count, input_fingerprint, status, markdown, attempt_count,
  next_retry_at, last_error, input_tokens, output_tokens, updated_at`;

/** 원장 기준 문서별 대기 상황 — 상태 화면용. */
export interface OcrLedgerQueueSummary {
  /** retryable 쪽이 있는(terminal 쪽은 없는) 문서 수. */
  waitingRetry: number;
  /** terminal 쪽이 있는 문서 수. */
  terminal: number;
  /** 성공한 쪽이 있는 문서별 진행 — 쪽 수 합계. */
  inProgress: Array<{ documentId: string; completedPages: number; pageCount: number }>;
}

export class DocumentOcrLedger {
  constructor(private readonly db: Database) {}

  rowsForDocument(documentId: string): OcrPageRow[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM document_ocr_page_results WHERE document_id = ? ORDER BY page_index`)
      .all(documentId) as RawRow[];
    return rows.map(toRow);
  }

  /** 쪽 성공 — 글·사용량을 남기고 시도 수·재시도 시각·오류를 지운다. blank 면 빈 쪽(completed_blank). */
  recordCompleted(
    documentId: string,
    pageIndex: number,
    pageCount: number,
    fingerprint: string,
    markdown: string,
    usage: OcrPageUsage,
    blank = false,
  ): void {
    const status: OcrPageStatus = blank ? "completed_blank" : "completed";
    this.db
      .prepare(
        `INSERT INTO document_ocr_page_results
           (document_id, page_index, page_count, input_fingerprint, status, markdown, attempt_count,
            next_retry_at, last_error, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)
         ON CONFLICT(document_id, page_index) DO UPDATE SET
           page_count = excluded.page_count, input_fingerprint = excluded.input_fingerprint,
           status = excluded.status, markdown = excluded.markdown, attempt_count = 0, next_retry_at = NULL,
           last_error = NULL, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           updated_at = excluded.updated_at`,
      )
      .run(
        documentId, pageIndex, pageCount, fingerprint, status, markdown,
        usage?.inputTokens ?? null, usage?.outputTokens ?? null, nowKst(),
      );
  }

  /** 시도 누적 없이 곧장 terminal 로 굳힌다(모든 쪽이 빈 쪽인 문서 — 다시 읽기 전까지 다시 부르지 않음). */
  recordTerminal(documentId: string, pageIndex: number, pageCount: number, fingerprint: string, error: string): void {
    this.db
      .prepare(
        `INSERT INTO document_ocr_page_results
           (document_id, page_index, page_count, input_fingerprint, status, markdown, attempt_count,
            next_retry_at, last_error, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, ?, ?, 'terminal_failure', NULL, 0, NULL, ?, NULL, NULL, ?)
         ON CONFLICT(document_id, page_index) DO UPDATE SET
           page_count = excluded.page_count, input_fingerprint = excluded.input_fingerprint,
           status = 'terminal_failure', markdown = NULL, next_retry_at = NULL, last_error = excluded.last_error,
           input_tokens = NULL, output_tokens = NULL, updated_at = excluded.updated_at`,
      )
      .run(documentId, pageIndex, pageCount, fingerprint, error, nowKst());
  }

  /**
   * 일시 실패 — retryable_failure. 시도 수는 같은 지문이면 그대로, 지문이 바뀌었으면 0(결정적 시도만 센다).
   * terminal 로 올리지 않는다(바깥 장애로 문서가 영구 제외되면 부당).
   */
  recordTransient(
    documentId: string,
    pageIndex: number,
    pageCount: number,
    fingerprint: string,
    error: string,
    nextRetryAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO document_ocr_page_results
           (document_id, page_index, page_count, input_fingerprint, status, markdown, attempt_count,
            next_retry_at, last_error, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, ?, ?, 'retryable_failure', NULL, 0, ?, ?, NULL, NULL, ?)
         ON CONFLICT(document_id, page_index) DO UPDATE SET
           attempt_count = CASE WHEN document_ocr_page_results.input_fingerprint = excluded.input_fingerprint
                                THEN document_ocr_page_results.attempt_count ELSE 0 END,
           page_count = excluded.page_count, input_fingerprint = excluded.input_fingerprint,
           status = 'retryable_failure', markdown = NULL, next_retry_at = excluded.next_retry_at,
           last_error = excluded.last_error, input_tokens = NULL, output_tokens = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(documentId, pageIndex, pageCount, fingerprint, nextRetryAt, error, nowKst());
  }

  /**
   * 결정적 실패 — 같은 지문이면 시도 수 +1, 바뀌었으면 1. 상한에 닿으면 terminal_failure(재시도 시각 없음),
   * 아니면 retryable_failure(nextRetryAt 뒤 다시).
   * @returns 기록 뒤 상태와 시도 수.
   */
  recordDeterministic(
    documentId: string,
    pageIndex: number,
    pageCount: number,
    fingerprint: string,
    error: string,
    maxAttempts: number,
    nextRetryAt: string,
  ): { status: OcrPageStatus; attemptCount: number } {
    const existing = this.rowsForDocument(documentId).find((r) => r.pageIndex === pageIndex);
    const prior = existing && existing.inputFingerprint === fingerprint ? existing.attemptCount : 0;
    const attemptCount = prior + 1;
    const status: OcrPageStatus = attemptCount >= maxAttempts ? "terminal_failure" : "retryable_failure";
    this.db
      .prepare(
        `INSERT INTO document_ocr_page_results
           (document_id, page_index, page_count, input_fingerprint, status, markdown, attempt_count,
            next_retry_at, last_error, input_tokens, output_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(document_id, page_index) DO UPDATE SET
           page_count = excluded.page_count, input_fingerprint = excluded.input_fingerprint,
           status = excluded.status, markdown = NULL, attempt_count = excluded.attempt_count,
           next_retry_at = excluded.next_retry_at, last_error = excluded.last_error,
           input_tokens = NULL, output_tokens = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        documentId, pageIndex, pageCount, fingerprint, status, attemptCount,
        status === "terminal_failure" ? null : nextRetryAt, error, nowKst(),
      );
    return { status, attemptCount };
  }

  /**
   * 수동 다시 읽기 — 실패한 쪽 행만 지운다(멈춘 쪽 해제). 이미 성공한 쪽은 남겨, 지문이 같으면 다시 부르지 않는다
   * (지문이 바뀐 성공 쪽은 원래대로 다시 평가된다). @returns 지운 행 수.
   */
  clearFailures(documentId: string): number {
    const result = this.db
      .prepare("DELETE FROM document_ocr_page_results WHERE document_id = ? AND status IN ('retryable_failure', 'terminal_failure')")
      .run(documentId);
    return Number(result.changes);
  }

  /** 문서 적용 성공 때 그 문서의 행을 지운다. */
  clearDocument(documentId: string): void {
    this.db.prepare("DELETE FROM document_ocr_page_results WHERE document_id = ?").run(documentId);
  }

  /**
   * 더 이상 OCR 후보가 아닌 문서(다른 경로로 결과가 붙었거나 글 추출에 성공)의 행을 지운다.
   * @param candidateStatuses 자동 처리 후보 상태 목록 — 이 밖의 상태인 문서 행이 지워진다.
   * @returns 지운 행 수.
   */
  pruneNonCandidateDocuments(candidateStatuses: readonly string[]): number {
    const placeholders = candidateStatuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `DELETE FROM document_ocr_page_results WHERE document_id IN (
           SELECT d.document_id FROM documents d
           WHERE COALESCE(json_extract(d.source_metadata, '$.parse.status'), '') NOT IN (${placeholders})
         )`,
      )
      .run(...candidateStatuses);
    return Number(result.changes);
  }

  /** 하루 호출 수를 원자적으로 1 올리고 새 값을 돌려준다. */
  incrementDailyCalls(day: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO document_ocr_daily_usage (day, page_calls) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET page_calls = page_calls + 1
         RETURNING page_calls`,
      )
      .get(day) as { page_calls: number };
    return row.page_calls;
  }

  dailyCalls(day: string): number {
    const row = this.db
      .prepare("SELECT page_calls FROM document_ocr_daily_usage WHERE day = ?")
      .get(day) as { page_calls: number } | null;
    return row ? row.page_calls : 0;
  }

  /** 문서별 대기 상황(상태 화면). 휴지통 문서 거르기는 호출부가 한다. */
  queueSummary(): OcrLedgerQueueSummary {
    const perDoc = this.db
      .prepare(
        `SELECT document_id,
                MAX(page_count) AS page_count,
                SUM(CASE WHEN status IN ('completed', 'completed_blank') THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'retryable_failure' THEN 1 ELSE 0 END) AS retryable,
                SUM(CASE WHEN status = 'terminal_failure' THEN 1 ELSE 0 END) AS terminal
         FROM document_ocr_page_results GROUP BY document_id ORDER BY document_id`,
      )
      .all() as Array<{ document_id: string; page_count: number; completed: number; retryable: number; terminal: number }>;
    let waitingRetry = 0;
    let terminal = 0;
    const inProgress: OcrLedgerQueueSummary["inProgress"] = [];
    for (const row of perDoc) {
      if (row.terminal > 0) terminal += 1;
      else if (row.retryable > 0) waitingRetry += 1;
      if (row.completed > 0) {
        inProgress.push({ documentId: row.document_id, completedPages: row.completed, pageCount: row.page_count });
      }
    }
    return { waitingRetry, terminal, inProgress };
  }
}

/** 쪽을 지금 처리해도 되는지 — 정리 깊은 패스 isCandidateExcluded 와 같은 규칙. now 는 nowKst 형식. */
export function pageDecision(
  row: OcrPageRow | null,
  fingerprint: string,
  now: string,
): "process" | "reuse_completed" | "wait_retry" | "terminal" {
  if (!row || row.inputFingerprint !== fingerprint) return "process";
  if (row.status === "completed" || row.status === "completed_blank") return "reuse_completed";
  if (row.status === "terminal_failure") return "terminal";
  if (row.nextRetryAt !== null && row.nextRetryAt > now) return "wait_retry";
  return "process";
}
