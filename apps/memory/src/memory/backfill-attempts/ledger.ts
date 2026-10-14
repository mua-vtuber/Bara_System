/**
 * memory/backfill-attempts/ledger.ts — 자동 추출·캡션 백필의 실패 기록 표(v50 backfill_attempts) 접근과 재시도 간격
 * (2026-10-14 backfill-retry-ledger spec 4.1·4.4·5장).
 *
 * 표에는 실패 중인 대상만 한 줄 있다. 성공하면 줄을 지운다(완료 상태 없음 — 결과는 노드로 남는다).
 *   - retryable_failure : 센 실패가 상한 전. next_retry_at 이 지나야 다시 후보가 된다.
 *   - terminal_failure  : 같은 지문으로 센 실패가 상한(maxAttempts)에 닿음. 다시 시도 버튼이나 지문 변경 전까지 멈춤.
 * 간격 = min(retryDelayMin x 4^(n-1), retryMaxDelayMin) 분(n = 센 실패 횟수). 배수 4 는 이 모듈의 상수 한 곳이다.
 *
 * 시각 규칙: 시각을 판정에 쓰는 함수(recordCounted)는 시계(nowMs)를 호출자에게서 명시적으로 받는다. 내부에서 Date.now() 를
 * 따로 부르지 않으므로 시험과 주기 코드가 한 시계로 구동한다.
 *
 * 문서 OCR 원장(server-internal/document-ocr/ledger.ts)과 같은 관례: 실제 SQLite 를 raw db 핸들로 쓰고, 시각은 설정 시간대
 * 문자열(nowKst 와 같은 형식 — pastCutoffInZone)이라 next_retry_at 비교가 글자 순서로 맞는다. 읽고 쓰기(recordCounted)가
 * 한 트랜잭션이 아닌 것은 같은 종류의 주기가 겹치지 않기 때문이다(scheduler-core 의 겹침 방지).
 */
import type { Database } from "bun:sqlite";
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import {
  BACKFILL_ATTEMPTS_TABLE,
  BACKFILL_RETRYABLE_STATUS,
  BACKFILL_TERMINAL_STATUS,
  type BackfillAttemptKind,
  type BackfillAttemptStatus,
} from "../../db/store-internal/backfill-attempts-sql.ts";
import type { BackfillAttemptStatusItem, BackfillAttemptsStatusResponse } from "./contract.ts";

/** 센 실패마다 대기 간격을 늘리는 배수(spec 4.4). */
export const BACKFILL_RETRY_BACKOFF_FACTOR = 4;
/** 상태 목록의 기억 앞부분 글자 수(spec 5장). */
export const BACKFILL_STATUS_PREVIEW_CHARS = 60;
/** 상태 목록에 담는 최대 줄 수(spec 5장). 넘으면 truncated=true. */
export const BACKFILL_STATUS_MAX_ITEMS = 200;

const MINUTE_MS = 60_000;

/** 종류별 재시도 규칙 — settings.llm.extractor.backfill / llm.vision.backfill 의 세 칸. */
export interface BackfillRetryPolicy {
  maxAttempts: number;
  retryDelayMin: number;
  retryMaxDelayMin: number;
}

/** n 번째 센 실패 뒤 다음 시도까지의 간격(분). */
export function backfillRetryDelayMinutes(
  attemptCount: number,
  policy: Pick<BackfillRetryPolicy, "retryDelayMin" | "retryMaxDelayMin">,
): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error(`backfillRetryDelayMinutes: attemptCount 는 1 이상 정수여야 한다 (받은 값 ${attemptCount})`);
  }
  return Math.min(policy.retryDelayMin * BACKFILL_RETRY_BACKOFF_FACTOR ** (attemptCount - 1), policy.retryMaxDelayMin);
}

export interface BackfillAttemptRow {
  kind: BackfillAttemptKind;
  targetKey: string;
  nodeId: number;
  inputFingerprint: string;
  status: BackfillAttemptStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string;
  lastAttemptAt: string;
}

export interface CountedFailureInput {
  kind: BackfillAttemptKind;
  targetKey: string;
  nodeId: number;
  fingerprint: string;
  /** 화면에 보일 오류 문장(키 가림을 거친 것). */
  error: string;
  policy: BackfillRetryPolicy;
}

export interface CountedFailureResult {
  status: BackfillAttemptStatus;
  attemptCount: number;
  nextRetryAt: string | null;
}

interface RawRow {
  kind: string;
  target_key: string;
  node_id: number;
  input_fingerprint: string;
  status: string;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string;
  last_attempt_at: string;
}

function toRow(r: RawRow): BackfillAttemptRow {
  return {
    kind: r.kind as BackfillAttemptKind,
    targetKey: r.target_key,
    nodeId: r.node_id,
    inputFingerprint: r.input_fingerprint,
    status: r.status as BackfillAttemptStatus,
    attemptCount: r.attempt_count,
    nextRetryAt: r.next_retry_at,
    lastError: r.last_error,
    lastAttemptAt: r.last_attempt_at,
  };
}

const T = BACKFILL_ATTEMPTS_TABLE;
const SELECT_COLUMNS =
  "kind, target_key, node_id, input_fingerprint, status, attempt_count, next_retry_at, last_error, last_attempt_at";

export class BackfillAttemptsLedger {
  constructor(private readonly db: Database) {}

  rows(kind: BackfillAttemptKind): BackfillAttemptRow[] {
    const rows = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM ${T} WHERE kind = ? ORDER BY last_attempt_at, target_key`)
      .all(kind) as RawRow[];
    return rows.map(toRow);
  }

  get(kind: BackfillAttemptKind, targetKey: string): BackfillAttemptRow | null {
    const row = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM ${T} WHERE kind = ? AND target_key = ?`)
      .get(kind, targetKey) as RawRow | null;
    return row === null ? null : toRow(row);
  }

  /**
   * 센 실패 — 같은 지문이면 횟수 +1, 바뀌었으면 1. 상한에 닿으면 terminal_failure(재시도 시각 없음),
   * 아니면 retryable_failure(간격 뒤 다시). nowMs 는 호출자의 시계(epoch ms)이며 이 함수가 따로 시각을 읽지 않는다.
   */
  recordCounted(input: CountedFailureInput, nowMs: number): CountedFailureResult {
    const existing = this.get(input.kind, input.targetKey);
    const prior = existing !== null && existing.inputFingerprint === input.fingerprint ? existing.attemptCount : 0;
    const attemptCount = prior + 1;
    const terminal = attemptCount >= input.policy.maxAttempts;
    const status = terminal ? BACKFILL_TERMINAL_STATUS : BACKFILL_RETRYABLE_STATUS;
    const nextRetryAt = terminal
      ? null
      : pastCutoffInZone(nowMs + backfillRetryDelayMinutes(attemptCount, input.policy) * MINUTE_MS);
    this.db
      .query(
        `INSERT INTO ${T} (${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, target_key) DO UPDATE SET
           node_id = excluded.node_id, input_fingerprint = excluded.input_fingerprint, status = excluded.status,
           attempt_count = excluded.attempt_count, next_retry_at = excluded.next_retry_at,
           last_error = excluded.last_error, last_attempt_at = excluded.last_attempt_at`,
      )
      .run(
        input.kind, input.targetKey, input.nodeId, input.fingerprint, status, attemptCount, nextRetryAt,
        input.error, pastCutoffInZone(nowMs),
      );
    return { status, attemptCount, nextRetryAt };
  }

  /** 한 줄을 지운다(성공·정리). @returns 지웠는지. */
  clear(kind: BackfillAttemptKind, targetKey: string): boolean {
    return this.db.query(`DELETE FROM ${T} WHERE kind = ? AND target_key = ?`).run(kind, targetKey).changes > 0;
  }

  /** 고른 줄을 지운다(다시 시도). @returns 지운 줄 수. */
  clearTargets(kind: BackfillAttemptKind, targetKeys: readonly string[]): number {
    return this.db.transaction(() => {
      let cleared = 0;
      for (const key of targetKeys) if (this.clear(kind, key)) cleared += 1;
      return cleared;
    })();
  }

  /** 그 종류의 줄을 모두 지운다(모두 다시 시도). @returns 지운 줄 수. */
  clearKind(kind: BackfillAttemptKind): number {
    return Number(this.db.query(`DELETE FROM ${T} WHERE kind = ?`).run(kind).changes);
  }

  counts(kind: BackfillAttemptKind): { waitingRetry: number; stopped: number } {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(status = ?), 0) AS waiting,
                COALESCE(SUM(status = ?), 0) AS stopped
           FROM ${T} WHERE kind = ?`,
      )
      .get(BACKFILL_RETRYABLE_STATUS, BACKFILL_TERMINAL_STATUS, kind) as { waiting: number; stopped: number };
    return { waitingRetry: row.waiting, stopped: row.stopped };
  }

  /** 관리 API 상태 응답 — 멈춤 먼저, 각 무리 안은 마지막 시도 최신 순, 최대 BACKFILL_STATUS_MAX_ITEMS 줄. */
  status(kind: BackfillAttemptKind): BackfillAttemptsStatusResponse {
    const { waitingRetry, stopped } = this.counts(kind);
    const raw = this.db
      .query(
        `SELECT a.target_key, a.node_id, substr(n.content, 1, ?) AS preview, a.attempt_count, a.last_error,
                a.last_attempt_at, a.status, a.next_retry_at
           FROM ${T} a JOIN knowledge_nodes n ON n.id = a.node_id
          WHERE a.kind = ?
          ORDER BY CASE a.status WHEN ? THEN 0 ELSE 1 END, a.last_attempt_at DESC, a.target_key
          LIMIT ?`,
      )
      .all(BACKFILL_STATUS_PREVIEW_CHARS, kind, BACKFILL_TERMINAL_STATUS, BACKFILL_STATUS_MAX_ITEMS + 1) as Array<{
      target_key: string;
      node_id: number;
      preview: string;
      attempt_count: number;
      last_error: string;
      last_attempt_at: string;
      status: string;
      next_retry_at: string | null;
    }>;
    const items: BackfillAttemptStatusItem[] = raw.slice(0, BACKFILL_STATUS_MAX_ITEMS).map((r) => ({
      targetKey: r.target_key,
      nodeId: r.node_id,
      preview: r.preview,
      attemptCount: r.attempt_count,
      lastError: r.last_error,
      lastAttemptAt: r.last_attempt_at,
      status: r.status as BackfillAttemptStatus,
      nextRetryAt: r.next_retry_at,
    }));
    return { kind, waitingRetry, stopped, items, truncated: raw.length > BACKFILL_STATUS_MAX_ITEMS };
  }
}
