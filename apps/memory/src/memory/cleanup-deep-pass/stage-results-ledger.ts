/**
 * stage-results-ledger.ts — 깊은 패스 결과 원장 접근·상태 전이 헬퍼 (spec 4.A-3).
 *
 * cleanup_stage_results 는 각 단계(stage)의 각 대상(target_key)에 대한 마지막 처리
 * 결과를 한 행으로 담는다. 유료 강모델이 같은 대상에 영구 재과금하지 않도록, 이 모듈이
 * "이 대상은 이미 처리됐나 / 재시도 시각이 됐나 / attempt 가 상한에 닿았나"를 원장으로
 * 판정한다. 실 SQLite 를 직접 쓴다 — 이 프로젝트의 store 계층은 raw db 핸들을 넘겨
 * 모듈이 SQL 을 직접 부르는 관례라(candidate-query.ts 선례), 별 ORM·mock 을 두지 않는다.
 *
 * 상태 네 값(spec 4.A-3):
 *   - completed        : 산출 있음(제안/요약/연결). attempt 리셋(성공은 실패 누적을 지운다).
 *   - completed_noop   : 정상 회신인데 산출 0(빈 배열·하네스 전건 탈락·채울 것 없음).
 *                        무산출 재과금을 끊는 정직한 "없음" 기록. attempt 리셋.
 *   - retryable_failure: 일시 오류(429/5xx/네트워크/timeout). next_retry_at 후 재시도.
 *                        대상별 terminal 승격 절대 없음.
 *   - terminal_failure : 결정적 실패(파싱·ID·max_tokens 잘림) attempt 소진 or input_over_cap.
 *
 * 재처리 조건(spec 4.A-3):
 *   행이 있고 input_fingerprint·stage_version 이 같으면
 *     completed / completed_noop / terminal_failure → 후보 제외.
 *     retryable_failure → next_retry_at 경과 시에만 후보 포함.
 *   fingerprint 가 바뀌거나 stage_version 이 오르면 → 재평가(후보 포함). completed·
 *   completed_noop 행은 지우지 않는다(재처리는 오직 이 두 신호 변화로만).
 */

import type { Database } from "bun:sqlite";
import { nowKst } from "../../db/store-internal/helpers.ts";
import type { CleanupStage } from "./stage-fingerprint.ts";

/** 원장 상태 네 값. */
export type StageResultStatus =
  | "completed"
  | "completed_noop"
  | "retryable_failure"
  | "terminal_failure";

/** 원장 한 행. next_retry_at·last_error 는 상태에 따라 null 가능. */
export interface StageResultRow {
  stage: CleanupStage;
  targetKey: string;
  status: StageResultStatus;
  inputFingerprint: string;
  stageVersion: number;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface RawRow {
  stage: string;
  target_key: string;
  status: string;
  input_fingerprint: string;
  stage_version: number;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function toRow(r: RawRow): StageResultRow {
  return {
    stage: r.stage as CleanupStage,
    targetKey: r.target_key,
    status: r.status as StageResultStatus,
    inputFingerprint: r.input_fingerprint,
    stageVersion: r.stage_version,
    attemptCount: r.attempt_count,
    nextRetryAt: r.next_retry_at,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

/** 한 대상의 원장 행을 읽는다(없으면 null). */
export function getStageResult(
  db: Database,
  stage: CleanupStage,
  targetKey: string,
): StageResultRow | null {
  const row = db
    .prepare(
      `SELECT stage, target_key, status, input_fingerprint, stage_version,
              attempt_count, next_retry_at, last_error, updated_at
       FROM cleanup_stage_results
       WHERE stage = ? AND target_key = ?`,
    )
    .get(stage, targetKey) as RawRow | null;
  return row ? toRow(row) : null;
}

/** 성공(산출 있음/없음) 기록 인자. */
export interface RecordSuccessInput {
  stage: CleanupStage;
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
  /** 산출이 있으면 'completed', 정상 회신인데 산출 0 이면 'completed_noop'. */
  noop: boolean;
}

/**
 * 성공(completed) 또는 무산출 성공(completed_noop)을 기록한다. 멱등 upsert —
 * 같은 (stage, target_key)에 다시 부르면 덮어쓴다. 성공은 attempt 를 0 으로 리셋하고
 * next_retry_at·last_error 를 비운다(이전 일시/결정 실패 흔적을 성공이 지운다).
 */
export function recordStageSuccess(db: Database, input: RecordSuccessInput): void {
  const status: StageResultStatus = input.noop ? "completed_noop" : "completed";
  db.prepare(
    `INSERT INTO cleanup_stage_results
       (stage, target_key, status, input_fingerprint, stage_version,
        attempt_count, next_retry_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)
     ON CONFLICT(stage, target_key) DO UPDATE SET
       status = excluded.status,
       input_fingerprint = excluded.input_fingerprint,
       stage_version = excluded.stage_version,
       attempt_count = 0,
       next_retry_at = NULL,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    input.stage,
    input.targetKey,
    status,
    input.inputFingerprint,
    input.stageVersion,
    nowKst(),
  );
}

/** 일시 실패(retryable_failure) 기록 인자. */
export interface RecordRetryableInput {
  stage: CleanupStage;
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
  /** 다음 재시도 허용 시각(설정 시간대 "YYYY-MM-DD HH:MM:SS"). 이 시각 전엔 후보 제외. */
  nextRetryAt: string;
  /** 마지막 실패 사유(분류 + 상태/사유 원문). */
  lastError: string;
  /**
   * 이번 기록 후 attempt 를 호출부가 정할 때 준다(같은 종류 실패만 연속으로 세는 호출부 — entity_register
   * 반영 오류). 주지 않으면 아래 규칙(같은 fingerprint 면 +1, 바뀌면 1)을 따른다.
   */
  attemptCount?: number;
}

/**
 * 일시 오류를 retryable_failure 로 기록한다. 대상별 terminal 승격은 절대 없다 —
 * 외부 장애로 특정 문서가 영구 제외되는 것은 부당(spec 4.A-2). next_retry_at 경과
 * 시 후보로 재등장한다. 멱등 upsert.
 *
 * fingerprint 가 이전 행과 같으면 attempt 를 잇고(같은 대상 반복 일시 실패의 누적
 * 관측), 바뀌면 1 로 시작한다(대상 내용이 바뀌었으니 새 시도).
 */
export function recordStageRetryable(db: Database, input: RecordRetryableInput): void {
  db.prepare(
    `INSERT INTO cleanup_stage_results
       (stage, target_key, status, input_fingerprint, stage_version,
        attempt_count, next_retry_at, last_error, updated_at)
     VALUES (?, ?, 'retryable_failure', ?, ?, COALESCE(?, 1), ?, ?, ?)
     ON CONFLICT(stage, target_key) DO UPDATE SET
       status = 'retryable_failure',
       stage_version = excluded.stage_version,
       attempt_count = COALESCE(?, CASE
         WHEN cleanup_stage_results.input_fingerprint = excluded.input_fingerprint
           THEN cleanup_stage_results.attempt_count + 1
         ELSE 1
       END),
       input_fingerprint = excluded.input_fingerprint,
       next_retry_at = excluded.next_retry_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    input.stage,
    input.targetKey,
    input.inputFingerprint,
    input.stageVersion,
    input.attemptCount ?? null,
    input.nextRetryAt,
    input.lastError,
    nowKst(),
    input.attemptCount ?? null,
  );
}

/** 결정적 실패 기록 인자. */
export interface RecordDeterministicInput {
  stage: CleanupStage;
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
  /** 결정적 실패 attempt 상한(reliability.maxAttemptsPerTarget). 도달 시 terminal_failure. */
  maxAttemptsPerTarget: number;
  /** 마지막 실패 사유(파싱·ID·max_tokens 잘림 등). */
  lastError: string;
}

/**
 * 결정적 실패(JSON 파싱·ID 탈락·max_tokens 잘림)를 fingerprint 단위로 누적한다.
 * 같은 fingerprint 로 다시 실패하면 attempt 를 올리고, 상한(maxAttemptsPerTarget)에
 * 닿으면 terminal_failure 로 굳힌다 — 같은 입력이면 같은 실패가 재발하므로 무한 재과금을
 * 끊는다. fingerprint 가 바뀌면 attempt 를 1 로 재시작한다(입력이 달라졌으니 새 시도).
 *
 * @returns 이번 기록 후 상태와 attempt — 호출부가 terminal 여부를 알 수 있게.
 */
export function recordStageDeterministicFailure(
  db: Database,
  input: RecordDeterministicInput,
): { status: StageResultStatus; attemptCount: number } {
  const existing = getStageResult(db, input.stage, input.targetKey);
  const priorAttempts =
    existing && existing.inputFingerprint === input.inputFingerprint
      ? existing.attemptCount
      : 0;
  const attemptCount = priorAttempts + 1;
  const status: StageResultStatus =
    attemptCount >= input.maxAttemptsPerTarget ? "terminal_failure" : "retryable_failure";

  db.prepare(
    `INSERT INTO cleanup_stage_results
       (stage, target_key, status, input_fingerprint, stage_version,
        attempt_count, next_retry_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(stage, target_key) DO UPDATE SET
       status = excluded.status,
       input_fingerprint = excluded.input_fingerprint,
       stage_version = excluded.stage_version,
       attempt_count = excluded.attempt_count,
       next_retry_at = NULL,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    input.stage,
    input.targetKey,
    status,
    input.inputFingerprint,
    input.stageVersion,
    attemptCount,
    input.lastError,
    nowKst(),
  );
  return { status, attemptCount };
}

/** input_over_cap 등, attempt 누적 없이 즉시 terminal 로 굳히는 결정적 실패 기록. */
export interface RecordTerminalInput {
  stage: CleanupStage;
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
  lastError: string;
}

/**
 * attempt 누적 없이 곧장 terminal_failure 로 기록한다(spec 실패표 input_over_cap —
 * 호출 없이 terminal). 재시도가 무의미한 확정 실패에 쓴다. 멱등 upsert.
 */
export function recordStageTerminal(db: Database, input: RecordTerminalInput): void {
  db.prepare(
    `INSERT INTO cleanup_stage_results
       (stage, target_key, status, input_fingerprint, stage_version,
        attempt_count, next_retry_at, last_error, updated_at)
     VALUES (?, ?, 'terminal_failure', ?, ?, 1, NULL, ?, ?)
     ON CONFLICT(stage, target_key) DO UPDATE SET
       status = 'terminal_failure',
       input_fingerprint = excluded.input_fingerprint,
       stage_version = excluded.stage_version,
       next_retry_at = NULL,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    input.stage,
    input.targetKey,
    input.inputFingerprint,
    input.stageVersion,
    input.lastError,
    nowKst(),
  );
}

/** 후보 대조 입력 — 한 대상의 현재 지문·버전. */
export interface CandidateProbe {
  targetKey: string;
  inputFingerprint: string;
  stageVersion: number;
}

/**
 * 원장 대조 — 이 후보를 이번 사이클에서 *제외*해야 하는지 판정한다(spec 4.A-3 후보 검출).
 *
 * 제외 규칙(행이 있고 fingerprint·stage_version 이 probe 와 같을 때만 적용):
 *   - completed / completed_noop / terminal_failure → 제외(true).
 *   - retryable_failure → next_retry_at 이 지금 이후면 제외(true), 경과했으면 포함(false).
 * 행이 없거나 fingerprint 가 다르거나 stage_version 이 다르면 → 재평가 대상이라 포함(false).
 *
 * @param now 현재 시각("YYYY-MM-DD HH:MM:SS"). 미지정 시 nowKst(). 테스트가 결정적으로
 *            next_retry_at 경계를 넘기려고 주입할 수 있다.
 */
export function isCandidateExcluded(
  db: Database,
  stage: CleanupStage,
  probe: CandidateProbe,
  now: string = nowKst(),
): boolean {
  const existing = getStageResult(db, stage, probe.targetKey);
  if (!existing) return false;
  // fingerprint 변화 OR stage_version 상승 = 재평가 대상(제외 안 함).
  if (existing.inputFingerprint !== probe.inputFingerprint) return false;
  if (existing.stageVersion !== probe.stageVersion) return false;

  switch (existing.status) {
    case "completed":
    case "completed_noop":
    case "terminal_failure":
      return true;
    case "retryable_failure":
      // next_retry_at 이 없으면(방어적) 포함. 있으면 아직 안 지났을 때만 제외.
      if (existing.nextRetryAt === null) return false;
      return existing.nextRetryAt > now;
    default:
      return false;
  }
}

/**
 * 후보 목록에서 원장이 제외하라는 것을 걸러 낸다(포함할 것만 회신). 각 단계 후보 쿼리가
 * SQL 1차 거름 뒤 이 함수로 원장 2차 거름을 건다 — 기존 성공 행 검사(chunk_summaries
 * 존재 등)와 이중 안전벨트(spec 4.A-3).
 */
export function filterCandidatesByLedger<T extends CandidateProbe>(
  db: Database,
  stage: CleanupStage,
  candidates: readonly T[],
  now: string = nowKst(),
): T[] {
  return candidates.filter((c) => !isCandidateExcluded(db, stage, c, now));
}
