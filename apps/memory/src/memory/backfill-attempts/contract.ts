/**
 * memory/backfill-attempts/contract.ts — 백필 실패 기록 관리 API 의 경로·요청·응답 형식 (2026-10-14 spec 5장).
 * 서버 라우트(server-internal/routes/backfill-attempts.ts)와 대시보드 패널이 같은 값을 쓰는 단일 출처다.
 * 대시보드 번들이 읽으므로 bun:sqlite·노드 전용 모듈을 import 하지 않는다.
 */
export {
  BACKFILL_ATTEMPT_KINDS,
  isBackfillAttemptKind,
  type BackfillAttemptKind,
  type BackfillAttemptStatus,
} from "../../db/store-internal/backfill-attempts-sql.ts";
import type { BackfillAttemptKind, BackfillAttemptStatus } from "../../db/store-internal/backfill-attempts-sql.ts";

export const BACKFILL_ATTEMPTS_STATUS_PATH = "/api/backfill-attempts/status";
export const BACKFILL_ATTEMPTS_RETRY_PATH = "/api/backfill-attempts/retry";

/** 상태 목록 한 줄. preview 는 노드 본문 앞부분, 시각은 설정 시간대 문자열("YYYY-MM-DD HH:MM:SS"). */
export interface BackfillAttemptStatusItem {
  targetKey: string;
  nodeId: number;
  preview: string;
  attemptCount: number;
  lastError: string;
  lastAttemptAt: string;
  status: BackfillAttemptStatus;
  /** 멈춤이면 null. */
  nextRetryAt: string | null;
}

/** GET 상태 응답. items 는 멈춤 먼저, 각 무리 안은 마지막 시도 최신 순, 최대 개수를 넘으면 truncated=true. */
export interface BackfillAttemptsStatusResponse {
  kind: BackfillAttemptKind;
  waitingRetry: number;
  stopped: number;
  items: BackfillAttemptStatusItem[];
  truncated: boolean;
}

/** POST 다시 시도 본문 — 고른 대상 또는 그 종류 전체. 줄을 지울 뿐 즉시 실행하지 않는다. */
export type BackfillRetryRequest =
  | { kind: BackfillAttemptKind; targetKeys: string[] }
  | { kind: BackfillAttemptKind; all: true };

export interface BackfillRetryResponse {
  cleared: number;
}
