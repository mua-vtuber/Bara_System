/**
 * LlmRequestError — 3 LLM 클라이언트가 요청·전송 단계 실패에 던지는 구조화 오류.
 *
 * 데이터 정리 AI 효율 가동(2026-07-11 spec 4.A-2)에서 도입. 그 전까지 Ollama /
 * OpenAI-compatible 은 상태 코드를 메시지 문자열 안에만 담은 generic Error 를 던지고
 * Retry-After 헤더를 버렸다 — 문자열 파싱 분류는 부서지기 쉬웠다. 이 클래스는 상태
 * 코드·오류 코드·Retry-After·timeout 여부를 필드로 보존해, 오류 분류기(error-classifier.ts)가
 * 문자열 파싱 없이 status/timedOut 필드만으로 3분류(transient/deterministic/config)를
 * 낼 수 있게 한다.
 *
 * 대상 = 요청·전송 단계 실패(HTTP 상태 오류·네트워크 단절·timeout)에 한정한다. 응답
 * 형태 오류(본문 파싱 실패·content 부재·json.error)는 결정적 실패 계열이라 각 클라이언트가
 * 기존 generic Error 로 그대로 던진다 — 이 클래스는 전송 계층 전용이다.
 */

import type { LlmProvider } from "./provider-registry.ts";

export class LlmRequestError extends Error {
  /** 어느 provider 호출에서 났는지. */
  readonly provider: LlmProvider;
  /** HTTP 상태 코드. 네트워크 단절·timeout 처럼 응답 자체가 없으면 null. */
  readonly status: number | null;
  /** provider 오류 코드 원문(예: Anthropic "rate_limit_error"). 없으면 null. */
  readonly code: string | null;
  /**
   * Retry-After 헤더를 ms 로 환산한 값. 헤더가 없거나 파싱 불가면 null.
   * 실행층(A-4)의 backoff 재시도가 이 값을 우선한다.
   */
  readonly retryAfterMs: number | null;
  /** 요청 timeout(내부 타임아웃 abort)으로 끊긴 경우 true. */
  readonly timedOut: boolean;
  /**
   * 공급자 오류 본문의 상세 사유(Google API 오류 모델의 google.rpc.ErrorInfo.reason, 예: "API_KEY_INVALID").
   * 주지 않는 공급자는 빈 목록. 사유 낱말만 담고 본문·키는 담지 않는다.
   */
  readonly reasons: readonly string[];

  constructor(opts: {
    provider: LlmProvider;
    message: string;
    status: number | null;
    code: string | null;
    retryAfterMs: number | null;
    timedOut: boolean;
    reasons?: readonly string[];
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LlmRequestError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
    this.timedOut = opts.timedOut;
    this.reasons = opts.reasons ?? [];
  }
}

/**
 * Retry-After 헤더 값을 ms 로 환산한다.
 *
 * HTTP 명세상 Retry-After 는 두 형식을 가진다:
 *   - delta-seconds: 정수 초(예: "120") → 120000ms.
 *   - HTTP-date: RFC 1123 시각(예: "Wed, 21 Oct 2026 07:28:00 GMT") → 그 시각까지 남은 ms.
 *
 * 파싱 불가·과거 시각(음수)·헤더 부재는 null 로 회신한다(재시도 지연 정보 없음의 정직한
 * 표현 — 실행층이 자체 backoff 로 넘어간다). `now` 는 HTTP-date 환산의 기준 시각으로,
 * 테스트가 결정적으로 검증할 수 있게 주입 가능(미지정 시 Date.now()).
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;

  // delta-seconds — 순수 정수만 허용(음수·소수·부가 문자는 date 파싱으로 넘긴다).
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  // HTTP-date — Date.parse 로 환산 후 now 대비 남은 ms.
  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) return null;
  const deltaMs = targetMs - now;
  return deltaMs > 0 ? deltaMs : null;
}

/**
 * fetch 를 끊은 abort 오류인지 판정한다(내부 timeout 또는 외부 signal 취소).
 * AbortController.abort() 로 끊긴 fetch 는 name "AbortError" 로 거부한다.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 오류 메시지 문자열 안전 추출(비 Error 값 방어). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
