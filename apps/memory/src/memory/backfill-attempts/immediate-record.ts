/**
 * memory/backfill-attempts/immediate-record.ts — 저장 직후 추출이 출력 한도에 잘렸을 때 그 원문을 기록 표에
 * 멈춤(terminal_failure)으로 쓴다 (2026-10-14 speed-step1 spec 4.2).
 *
 * 즉시 추출이 잘린 뒤 원문만 저장하면 그 원문이 백필 후보가 되어 백필이 한 번 더 보내 또 잘린다. 그래서 백필 주기의
 * terminal 갈래(cycle-guard.recordFailure)와 같은 줄을 여기서 미리 쓴다: 같은 targetKey(extractionTargetKey), 같은
 * 지문(extractionFingerprint), 같은 오류 문장 처리(redactSecrets) — 다음 주기 reconcile 이 이 줄을 지우지 않는다.
 * 쓰기 실패는 던진다. 원문 저장을 지킬지는 호출부(save-input-immediate)가 정한다.
 */
import { extractionTargetKey } from "../../db/store-internal/backfill-attempts-sql.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { errorMessage } from "../../llm/errors.ts";
import { redactSecrets } from "../cleanup-deep-pass/redact-secrets.ts";
import type { ExtractionAttemptIdentity } from "../extractor-internal/contract.ts";
import { toNfc } from "../nfc.ts";
import { extractionFingerprint } from "./fingerprint.ts";
import { BackfillAttemptsLedger } from "./ledger.ts";

export interface ImmediateTruncationRecord {
  nodeId: number;
  /** 방금 저장된 원문 본문. 저장소가 NFC 로 정규화해 저장하므로 지문은 여기서 NFC 로 맞춰 계산한다(백필은 저장된 node.content 로 계산). */
  nodeContent: string;
  /** 추출기의 시도 조건(모델 + 출력 한도) — MemoryExtractor.attemptIdentity. */
  identity: ExtractionAttemptIdentity;
  error: unknown;
}

export function recordImmediateTruncation(
  store: SqliteMemoryStore,
  record: ImmediateTruncationRecord,
  nowMs: number,
): void {
  new BackfillAttemptsLedger(store.getRawDb()).recordTerminal(
    {
      kind: "extraction",
      targetKey: extractionTargetKey(record.nodeId),
      nodeId: record.nodeId,
      fingerprint: extractionFingerprint(record.identity, toNfc(record.nodeContent)),
      error: redactSecrets(errorMessage(record.error)),
    },
    nowMs,
  );
}

/**
 * recordImmediateTruncation 을 부르되 쓰기 실패가 원문 저장을 되돌리지 않게 한다: 던지지 않고 원래 오류와 쓰기 오류를 함께
 * console.error 로 남긴다. 원문은 추출 표시가 없어 백필 후보로 남고, 백필이 다시 잘리면 그때 멈춘다.
 */
export function recordImmediateTruncationKeepingOrigin(
  store: SqliteMemoryStore,
  record: ImmediateTruncationRecord,
  nowMs: number,
): void {
  try {
    recordImmediateTruncation(store, record, nowMs);
  } catch (writeError) {
    console.error(
      `[saveTextInput] mode='immediate' 잘림 실패를 기록 표에 쓰지 못했다(원문 ${record.nodeId} 는 보존, 백필 후보로 남음)`
        + ` — 원래 오류: ${redactSecrets(errorMessage(record.error))} / 기록 쓰기 오류: ${redactSecrets(errorMessage(writeError))}`,
    );
  }
}
