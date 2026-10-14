/**
 * store-internal/backfill-attempts-sql.ts — 백필 실패 기록 표(v50)의 이름·종류·상태와 "막힘" SQL 조각 단일 출처
 * (2026-10-14 backfill-retry-ledger spec 4.1·4.5).
 *
 * "막힌 대상" = 멈춤(terminal_failure)이거나 다시 시도 시각(next_retry_at)이 아직 오지 않은 대상. 백필 스케줄러의 후보
 * 조회가 이 조각을 NOT 으로 붙여 LIMIT 전에 빼므로, 막힌 대상 때문에 한 주기 몫(batchSize)이 줄지 않는다.
 * 이 파일은 bun:sqlite·노드 전용 모듈을 import 하지 않는다 — 대시보드 번들이 종류 목록을 함께 쓴다(contract.ts 경유).
 */

export const BACKFILL_ATTEMPTS_TABLE = "backfill_attempts";

/** 기록 종류 — v50 CHECK 와 같은 목록. */
export const BACKFILL_ATTEMPT_KINDS = ["extraction", "caption"] as const;
export type BackfillAttemptKind = (typeof BACKFILL_ATTEMPT_KINDS)[number];

/** 기록 상태 — v50 CHECK 와 같은 목록. 성공은 줄을 지우므로 상태가 없다. */
export const BACKFILL_ATTEMPT_STATUSES = ["retryable_failure", "terminal_failure"] as const;
export type BackfillAttemptStatus = (typeof BACKFILL_ATTEMPT_STATUSES)[number];

/** 상태 목록에서 이름으로 가리키는 값 — 위 목록에서 꺼내므로 글자를 따로 적지 않는다. */
export const BACKFILL_RETRYABLE_STATUS: BackfillAttemptStatus = BACKFILL_ATTEMPT_STATUSES[0];
export const BACKFILL_TERMINAL_STATUS: BackfillAttemptStatus = BACKFILL_ATTEMPT_STATUSES[1];

export function isBackfillAttemptKind(value: unknown): value is BackfillAttemptKind {
  return typeof value === "string" && (BACKFILL_ATTEMPT_KINDS as readonly string[]).includes(value);
}

/** 추출 대상 열쇠 — 노드 id 의 10진 문자열. SQL 쪽 CAST(id AS TEXT) 와 같은 글자다. */
export function extractionTargetKey(nodeId: number): string {
  return String(nodeId);
}

/**
 * 대상이 막혔다(EXISTS 식). 자리표시자(?) 하나에 지금 시각(설정 시간대 문자열)을 넘긴다.
 * kind·상태는 위 목록의 값만 받으므로 SQL 글자로 넣어도 안전하다.
 * @param targetKeyExpr 후보 행의 대상 열쇠 SQL 식 — 예: CAST(candidate.id AS TEXT), json_extract(kn.metadata_json, '$.asset_sha256').
 */
export function backfillBlockedSql(kind: BackfillAttemptKind, targetKeyExpr: string): string {
  return `EXISTS (SELECT 1 FROM ${BACKFILL_ATTEMPTS_TABLE} blocked_attempt`
    + ` WHERE blocked_attempt.kind = '${kind}' AND blocked_attempt.target_key = ${targetKeyExpr}`
    + ` AND (blocked_attempt.status = '${BACKFILL_TERMINAL_STATUS}' OR blocked_attempt.next_retry_at > ?))`;
}
