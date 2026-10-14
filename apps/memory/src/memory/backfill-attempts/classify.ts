/**
 * memory/backfill-attempts/classify.ts — 자동 추출·캡션 백필 전용 실패 분류 (2026-10-14 backfill-retry-ledger spec 4.3).
 *
 * 정리 AI·문서 OCR 의 classifyLlmError 는 시간 초과를 "일시 장애"로 봐 세지 않는다. 백필만 다음 규칙을 따른다(사용자 결정):
 *   counted    — 횟수 +1. 시간 초과, 400 과 그 밖의 상태, 응답 형식 오류·빈 캡션·자산 없음 같은 일반 예외.
 *   uncounted  — 기록 안 함, 다음 주기 재시도. 429·5xx.
 *   stop_cycle — 그 주기 즉시 중단, 기록 안 함. 응답 없음(연결 거부·끊김) = connection, 401·403·404 = config,
 *                외부 취소 = aborted.
 *   terminal   — 출력 한도에 잘린 추출(ExtractionOutputTruncatedError). 다시 보내도 또 잘리므로 첫 번에 멈춤으로 기록한다
 *                (횟수 상한과 무관, 2026-10-14 speed-step1 spec 4.2). 응답 형식 오류(ExtractionMalformedResponseError)는 counted.
 * 오류 문장은 파싱하지 않는다 — LlmRequestError 의 status·timedOut 과, 캡션 Anthropic 공급자가 그대로 던지는 SDK 오류
 * 클래스(APIUserAbortError·APIConnectionTimeoutError·APIConnectionError·APIError.status)만 본다.
 * 재청크 실패는 BackfillRechunkError 로 감싸 던지고, 여기서 그 cause 만 풀어 같은 규칙으로 나눈다(cause 가 없으면 counted).
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk/error";
import { isAbortError, LlmRequestError } from "../../llm/errors.ts";
import { ExtractionOutputTruncatedError } from "../extractor-internal/response-errors.ts";

export type BackfillStopReason = "connection" | "config" | "aborted";

/** 출력 한도에 잘려 즉시 멈춘 실패의 사유 이름(로그에 쓴다). */
export const BACKFILL_TERMINAL_REASON_OUTPUT_TRUNCATED = "output_truncated";

export type BackfillFailureVerdict =
  | { klass: "counted"; status: number | null }
  | { klass: "terminal"; status: null; reason: typeof BACKFILL_TERMINAL_REASON_OUTPUT_TRUNCATED }
  | { klass: "uncounted"; status: number }
  | { klass: "stop_cycle"; reason: BackfillStopReason; status: number | null };

/** 일시 장애로 보는 상태 — 429 와 5xx. */
const RATE_LIMIT_STATUS = 429;
const SERVER_ERROR_MIN_STATUS = 500;
/** 설정 문제(인증·권한·모델 없음)로 보는 상태. */
const CONFIG_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** 긴 원문 재청크 실패 — 백필이 cause 를 풀어 분류한다(backfill-extraction.ts 가 던진다). */
export class BackfillRechunkError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "BackfillRechunkError";
  }
}

function byStatus(status: number | null, timedOut: boolean): BackfillFailureVerdict {
  if (timedOut) return { klass: "counted", status: null };
  if (status === null) return { klass: "stop_cycle", reason: "connection", status: null };
  if (status === RATE_LIMIT_STATUS || status >= SERVER_ERROR_MIN_STATUS) return { klass: "uncounted", status };
  if (CONFIG_STATUSES.has(status)) return { klass: "stop_cycle", reason: "config", status };
  return { klass: "counted", status };
}

export function classifyBackfillFailure(error: unknown): BackfillFailureVerdict {
  if (error instanceof BackfillRechunkError) {
    return error.cause === undefined ? { klass: "counted", status: null } : classifyBackfillFailure(error.cause);
  }
  if (error instanceof ExtractionOutputTruncatedError) {
    return { klass: "terminal", status: null, reason: BACKFILL_TERMINAL_REASON_OUTPUT_TRUNCATED };
  }
  if (error instanceof LlmRequestError) return byStatus(error.status, error.timedOut);
  // SDK 오류 — 하위 클래스를 먼저 본다(APIUserAbortError·APIConnectionError 는 APIError 의 하위다).
  if (error instanceof APIUserAbortError) return { klass: "stop_cycle", reason: "aborted", status: null };
  if (error instanceof APIConnectionTimeoutError) return byStatus(null, true);
  if (error instanceof APIConnectionError) return byStatus(null, false);
  if (error instanceof APIError) return byStatus(typeof error.status === "number" ? error.status : null, false);
  if (isAbortError(error)) return { klass: "stop_cycle", reason: "aborted", status: null };
  return { klass: "counted", status: null };
}
