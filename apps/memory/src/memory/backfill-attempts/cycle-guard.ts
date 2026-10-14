/**
 * memory/backfill-attempts/cycle-guard.ts — 백필 한 주기의 실패 기록 규칙 한 곳 (2026-10-14 backfill-retry-ledger spec 4.3~4.5).
 *
 * 추출(scheduler.ts)과 캡션(vision-backfill.ts) 주기가 같은 순서로 쓴다.
 *   1. reconcile — 주기 시작 때 이 종류의 기록 줄 가운데 더 이상 후보 구조가 아닌 대상(이미 추출·캡션됨, 철회 등)의
 *      줄을 지우고, 지금 지문(공급자·모델·본문/지시문)이 기록 때와 다른 줄도 지운다(멈춤이 풀려 처음부터 다시 센다).
 *      spec 은 "막힌 줄"의 지문만 다시 보라고 하지만 막히지 않은 줄을 함께 봐도 결과가 같다 — 그 줄은 이번 주기에
 *      후보가 되어, 실패하면 지문이 다를 때 1 부터 세고(ledger.recordCounted) 성공하면 지워진다. 실패 중인 대상만
 *      줄이 있으므로 매 주기 전부 봐도 부담이 작다.
 *   2. now — 후보 SQL 의 막힘 판정 기준 시각(생성 때 한 번 읽은 주기 시작 시각을 설정 시간대 문자열로 바꾼 값).
 *   3. recordSuccess — 호출부가 성공 저장과 같은 쓰기 잠금 안에서 부른다.
 *   4. recordFailure — classifyBackfillFailure 로 나눈다. counted 는 기록(상한이면 멈춤 + 한 줄 로그), terminal(출력 한도에
 *      잘림)은 첫 번에 멈춤으로 기록(+ 한 줄 로그)하고 다음 대상으로 넘어간다, uncounted 는 기록 안 함, stop_cycle 은 기록 없이 "stop" 을 돌려 호출부가 남은 대상을 건드리지 않고 주기를 끝낸다.
 *      기록 표 쓰기 자체가 실패하면(예: SQLITE_BUSY) 삼키지도 던지지도 않고 원래 실패와 쓰기 오류를 함께 로그에 남기고
 *      "ledger_write_failed" 로 주기를 멈춘다.
 *   5. summary — 주기 요약 줄에 붙일 대기·멈춤 수와 주기 중단 사유.
 * 시각 판단: 막힘 기준 시각은 주기 시작(생성 때 clock() 한 번)에 고정하고, 마지막 시도·다음 시도는 실패 순간의 clock() 으로 계산한다
 * (한 주기가 길어도 spec 4.4 의 "n 번째 센 실패 뒤 간격"이 실패 시점부터 흐른다).
 * 오류 문장은 설정 화면 실패 목록에 보이므로 키·토큰 모양을 가린 뒤 남긴다(redactSecrets).
 */
import { pastCutoffInZone } from "../../db/store-internal/helpers.ts";
import type { BackfillAttemptKind } from "../../db/store-internal/backfill-attempts-sql.ts";
import { errorMessage } from "../../llm/errors.ts";
import { redactSecrets } from "../cleanup-deep-pass/redact-secrets.ts";
import { classifyBackfillFailure, type BackfillStopReason } from "./classify.ts";
import type { BackfillAttemptRow, BackfillAttemptsLedger, BackfillRetryPolicy } from "./ledger.ts";

/** 기록 표 쓰기 실패로 주기를 끝낸 사유 — 분류(BackfillStopReason)와 별도로 가드가 붙인다. */
export const BACKFILL_LEDGER_WRITE_FAILED = "ledger_write_failed";

/** 주기를 중간에 끝낸 사유 — 분류 결과 세 가지 + 기록 표 쓰기 실패. */
export type BackfillCycleStopReason = BackfillStopReason | typeof BACKFILL_LEDGER_WRITE_FAILED;

/** 기록할 대상 하나. label 은 로그에 쓰는 이름(예: "node 70", "node 12 (asset ab…)"). */
export interface BackfillTargetRef {
  targetKey: string;
  nodeId: number;
  fingerprint: string;
  label: string;
}

export interface BackfillRetrySummary {
  /** 다시 시도를 기다리는 줄 수(이 종류). */
  retryWait: number;
  /** 멈춘 줄 수(이 종류). */
  stopped: number;
  /** 이번 주기를 중간에 끝낸 사유. 끝까지 돌았으면 null. */
  cycleStopped: BackfillCycleStopReason | null;
}

export type BackfillFailureOutcome = "continue" | "stop";

export interface BackfillCycleGuardArgs {
  ledger: BackfillAttemptsLedger;
  kind: BackfillAttemptKind;
  policy: BackfillRetryPolicy;
  logPrefix: string;
  /** 시계(epoch ms를 돌려주는 함수). 막힘 기준 시각(now)은 생성 때 한 번 읽은 값으로 고정하고, 센 실패의 다음 시도 시각은 실패 순간의 값으로 계산한다. */
  clock: () => number;
}

/** 로그 머리 — 추출은 spec 4.5 예시 그대로 "backfill", 캡션은 "caption backfill". */
const KIND_LOG_NAME: Readonly<Record<BackfillAttemptKind, string>> = {
  extraction: "backfill",
  caption: "caption backfill",
};

export class BackfillCycleGuard {
  readonly now: string;
  private stopReason: BackfillCycleStopReason | null = null;

  constructor(private readonly args: BackfillCycleGuardArgs) {
    this.now = pastCutoffInZone(args.clock());
  }

  async reconcile(
    inspect: (row: BackfillAttemptRow) => Promise<string | null>,
  ): Promise<{ pruned: number; fingerprintCleared: number }> {
    const { ledger, kind } = this.args;
    let pruned = 0;
    let fingerprintCleared = 0;
    for (const row of ledger.rows(kind)) {
      const current = await inspect(row);
      if (current === null) {
        if (ledger.clear(kind, row.targetKey)) pruned += 1;
      } else if (current !== row.inputFingerprint) {
        if (ledger.clear(kind, row.targetKey)) fingerprintCleared += 1;
      }
    }
    return { pruned, fingerprintCleared };
  }

  /** 주기를 중간에 끝낸 상태인가(분류상 중단 또는 기록 표 쓰기 실패). 호출부가 루프를 끝낼 때 본다. */
  get isStopped(): boolean {
    return this.stopReason !== null;
  }

  /**
   * 성공한 대상의 지난 실패 줄을 지운다. 호출부가 성공 저장과 같은 쓰기 잠금 안에서 부르지만 저장은 이미 커밋된 뒤라
   * 이 지우기는 저장과 한 트랜잭션이 아니다. 지우기가 실패해도 성공한 대상을 실패로 세지 않도록 던지지 않고,
   * 대상 이름과 오류를 크게 남긴 뒤 기록 표 쓰기 실패(B3)와 같게 주기를 "ledger_write_failed" 로 멈춘다.
   * 남은 옛 줄은 다음 주기 reconcile(이미 추출·캡션됨 -> 후보 아님)이 지운다.
   */
  recordSuccess(targetKey: string, label: string): void {
    const { ledger, kind, logPrefix } = this.args;
    try {
      ledger.clear(kind, targetKey);
    } catch (clearError) {
      this.stopReason = BACKFILL_LEDGER_WRITE_FAILED;
      console.error(
        `${logPrefix} ${KIND_LOG_NAME[kind]} cycle stopped (${BACKFILL_LEDGER_WRITE_FAILED}) at ${label}:`
          + ` 저장은 성공했지만 지난 실패 기록을 지우지 못했다(성공으로 처리, 실패로 세지 않음) — 기록 지우기 오류: ${redactSecrets(errorMessage(clearError))}`,
      );
    }
  }

  recordFailure(target: BackfillTargetRef, error: unknown): BackfillFailureOutcome {
    const { ledger, kind, policy, logPrefix, clock } = this.args;
    const verdict = classifyBackfillFailure(error);
    const message = redactSecrets(errorMessage(error));
    if (verdict.klass === "uncounted") return "continue";
    if (verdict.klass === "stop_cycle") {
      this.stopReason = verdict.reason;
      const configNote = verdict.reason === "config" ? ` — 설정 문제(HTTP ${verdict.status})` : "";
      console.error(
        `${logPrefix} ${KIND_LOG_NAME[kind]} cycle stopped (${verdict.reason}) at ${target.label}${configNote}: ${message}`,
      );
      return "stop";
    }
    let result;
    try {
      const entry = { kind, targetKey: target.targetKey, nodeId: target.nodeId, fingerprint: target.fingerprint, error: message };
      result =
        verdict.klass === "terminal"
          ? ledger.recordTerminal(entry, clock())
          : ledger.recordCounted({ ...entry, policy }, clock());
    } catch (writeError) {
      this.stopReason = BACKFILL_LEDGER_WRITE_FAILED;
      console.error(
        `${logPrefix} ${KIND_LOG_NAME[kind]} cycle stopped (${BACKFILL_LEDGER_WRITE_FAILED}) at ${target.label}:`
          + ` 실패 기록을 표에 쓰지 못했다 — 원래 실패: ${message} / 기록 쓰기 오류: ${redactSecrets(errorMessage(writeError))}`,
      );
      return "stop";
    }
    if (verdict.klass === "terminal") {
      console.error(
        `${logPrefix} ${KIND_LOG_NAME[kind]} stopped immediately for ${target.label} (${verdict.reason}): ${message}`,
      );
    } else if (result.status === "terminal_failure") {
      console.error(
        `${logPrefix} ${KIND_LOG_NAME[kind]} stopped for ${target.label} after ${result.attemptCount} attempts: ${message}`,
      );
    }
    return "continue";
  }

  summary(): BackfillRetrySummary {
    const counts = this.args.ledger.counts(this.args.kind);
    return { retryWait: counts.waitingRetry, stopped: counts.stopped, cycleStopped: this.stopReason };
  }
}

/** 주기 요약 줄에 덧붙이는 글(spec 4.5 5단계). */
export function formatRetrySummary(summary: BackfillRetrySummary): string {
  const base = `retry-wait ${summary.retryWait}, stopped ${summary.stopped}`;
  return summary.cycleStopped === null ? base : `${base}, cycle-stopped(${summary.cycleStopped})`;
}
