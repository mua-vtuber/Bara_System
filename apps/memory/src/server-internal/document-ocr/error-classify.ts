/**
 * document-ocr/error-classify.ts — 서버 OCR 오류를 3분류하고 키를 가린다 (2026-10-11 spec D9·D13).
 *
 * 분류(정리 깊은 패스 classifyLlmError 위에 문서 OCR 만의 규칙을 얹음 — 정리 깊은 패스 분류는 그대로):
 *   - LlmRequestError·파일 업로드 HttpFileOcrError·Anthropic SDK APIError → 상태 코드/시간 초과로 classifyLlmError
 *     (timeout·응답 없음·429·5xx = 일시, 401/403 = 설정, 그 밖 = 결정적)
 *   - 문서 OCR 만: 400(Gemini INVALID_ARGUMENT 포함) = 그 쪽의 결정적 실패(사용자 결정 M1 — 그림·쪽 내용 탓일 수 있어
 *     시도 상한까지 세고 다음 문서로). 설정 탓이라면 모든 문서가 400 을 받으므로 연속 실패 차단기가 사이클을 멈춘다.
 *     404(모델 없음) = 설정(사이클 중단).
 *   - 단 인증·권한 문제는 400 이어도 설정이다: Gemini 는 잘못된 키를 HTTP 400 INVALID_ARGUMENT +
 *     google.rpc.ErrorInfo.reason=API_KEY_INVALID 로 돌려준다(AIP-193 https://google.aip.dev/193,
 *     google/api/error_reason.proto). 그 사유가 있거나 상태·사유가 PERMISSION_DENIED 면 쪽 실패가 아니라 설정 문제로
 *     사이클을 멈춘다 — 키를 고치면 문서가 멈춤 없이 다시 처리된다.
 *   - Anthropic SDK APIError → 그 status, SDK 연결·시간 초과 오류 → 일시
 *   - DocumentOcrConfigError → 설정
 *   - 그 밖(잘림·비정상 종료·빈 글·응답 형식 오류·쪽 그림 실패) → 결정적
 *
 * 가림: 문서 상태·원장·화면에 남는 문장이라 고른 공급자 키와 정확히 같은 부분을 먼저 가리고, 키·토큰 모양을
 * 한 번 더 가린다(redactSecrets).
 */

import { APIConnectionError, APIError } from "@anthropic-ai/sdk/error";
import { LlmRequestError, errorMessage, parseRetryAfterMs } from "../../llm/errors.ts";
import { maskExactSecrets } from "../../llm/provider-http.ts";
import { classifyLlmError } from "../../memory/cleanup-deep-pass/error-classifier.ts";
import { redactSecrets } from "../../memory/cleanup-deep-pass/redact-secrets.ts";
import { HttpFileOcrError } from "../routes/documents-ocr-api.ts";
import { DocumentOcrConfigError, OcrPageError, type OcrErrorClass } from "./types.ts";

/** 오류 문장의 키 가림 — 정확 일치 먼저, 그다음 키 모양. */
export function maskOcrErrorText(text: string, secrets: readonly string[]): string {
  return redactSecrets(maskExactSecrets(text, secrets.filter((s) => s.length > 0)));
}

/** 인증·권한 문제를 뜻하는 상세 사유·상태 낱말 — 400 이어도 설정 문제로 본다. */
const AUTH_REASONS: ReadonlySet<string> = new Set(["API_KEY_INVALID", "PERMISSION_DENIED"]);

function isAuthProblem(code: string | null, reasons: readonly string[]): boolean {
  return code === "PERMISSION_DENIED" || reasons.some((reason) => AUTH_REASONS.has(reason));
}

/** HTTP 상태 → 문서 OCR 분류. 400 은 쪽 실패, 404 는 설정(모델 없음), 그 밖은 정리 깊은 패스 규칙 그대로. */
function classifyOcrStatus(status: number | null, timedOut: boolean, authProblem = false): OcrErrorClass {
  if (!timedOut && authProblem) return "config";
  if (!timedOut && status === 400) return "deterministic";
  if (!timedOut && status === 404) return "config";
  return classifyLlmError({ status, timedOut });
}

interface Classified {
  klass: OcrErrorClass;
  retryAfterMs: number | null;
  httpStatus: number | null;
}

function classOf(err: unknown): Classified {
  if (err instanceof OcrPageError) return { klass: err.klass, retryAfterMs: err.retryAfterMs, httpStatus: err.httpStatus };
  if (err instanceof DocumentOcrConfigError) return { klass: "config", retryAfterMs: null, httpStatus: null };
  if (err instanceof LlmRequestError) {
    return {
      klass: classifyOcrStatus(err.status, err.timedOut, isAuthProblem(err.code, err.reasons)),
      retryAfterMs: err.retryAfterMs,
      httpStatus: err.status,
    };
  }
  if (err instanceof HttpFileOcrError) {
    return { klass: classifyOcrStatus(err.status, err.timedOut), retryAfterMs: err.retryAfterMs, httpStatus: err.status };
  }
  // SDK 연결 오류(시간 초과 포함)는 응답이 없어 일시. APIError 의 하위라 먼저 본다.
  if (err instanceof APIConnectionError) return { klass: "transient", retryAfterMs: null, httpStatus: null };
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    const retryAfterMs = err.headers instanceof Headers ? parseRetryAfterMs(err.headers.get("retry-after")) : null;
    return { klass: classifyOcrStatus(status, false), retryAfterMs, httpStatus: status };
  }
  // fetch 의 시간 초과·끊김(AbortError/TimeoutError) — 응답이 없으니 일시.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { klass: "transient", retryAfterMs: null, httpStatus: null };
  }
  return { klass: "deterministic", retryAfterMs: null, httpStatus: null };
}

/** 어떤 오류든 분류를 마친 OcrPageError 로 바꾼다(문장은 키 가림을 거침). */
export function classifyOcrError(err: unknown, secrets: readonly string[]): OcrPageError {
  const { klass, retryAfterMs, httpStatus } = classOf(err);
  return new OcrPageError(maskOcrErrorText(errorMessage(err), secrets), klass, retryAfterMs, httpStatus);
}

/** 연속 실패 차단기가 세는 실패인지 — 일시 실패와, 설정 탓일 수도 있는 400 쪽 실패. */
export function countsTowardCircuitBreaker(failure: OcrPageError): boolean {
  return failure.klass === "transient" || failure.httpStatus === 400;
}
