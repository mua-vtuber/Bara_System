/**
 * provider-http.ts — 공급자 HTTP 호출 한 번의 공통 처리 (2026-10-11 llm-api-providers spec D7).
 *
 * OpenAI 형식 공통 본체(LM Studio·OpenAI), Gemini 클라이언트, 이미지 캡션, 모델 목록 조회가 모두
 * 같은 규칙으로 실패를 알리도록 한 함수에 모은다.
 *
 *   - 내부 시간 한도로 끊기면 LlmRequestError{timedOut:true, status:null}.
 *   - 바깥 signal 로 취소되면 취소 오류를 그대로 던진다(실패가 아니라 명시 중단이라 뜻을 지킨다).
 *   - 연결 자체가 안 되면 LlmRequestError{status:null}.
 *   - 2xx 가 아니면 LlmRequestError{status, code, retryAfterMs} — 정리 실행층의 3분류(일시/결정/설정)가
 *     상태 코드만 보고 판단한다.
 *   - 응답 본문이 JSON 이 아니면 일반 Error(결정적 실패 계열 — 전송 계층 오류가 아님).
 *
 * 오류 문장에 공급자 응답 본문 앞부분을 붙이되, 보낸 키 문자열과 정확히 같은 부분은 먼저 가린다
 * (OpenAI 401 본문 등이 키를 되돌려 주는 경우). 자르기 전에 가려서 잘린 키 조각이 남지 않게 한다.
 */

import type { LlmProvider } from "./provider-registry.ts";
import { errorMessage, isAbortError, LlmRequestError, parseRetryAfterMs } from "./errors.ts";
import { BUN_FETCH_NO_DEFAULT_TIMEOUT } from "./bun-fetch.ts";

/** 오류 문장에 실을 공급자 응답 본문 최대 글자 수. */
export const PROVIDER_ERROR_BODY_MAX_CHARS = 300;

/** 가린 자리에 넣는 표시(정리 run 기록의 redactSecrets 표시와 같은 글자). */
export const SECRET_MASK = "[가림]";

export interface ProviderRequest {
  /** LlmRequestError.provider 에 실을 값. */
  provider: LlmProvider;
  /** 오류 문장 머리말 — 예: "OpenAI /chat/completions". */
  label: string;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** POST 본문(JSON 으로 보냄). GET 이면 없음. */
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 오류 문장에서 정확히 일치하면 가릴 문자열(보낸 키). 빈 문자열은 무시. */
  secrets?: readonly string[];
  /** 2xx 가 아닐 때 응답 본문에서 공급자 오류 코드를 꺼낸다. 없으면 code=null. */
  errorCode?: (bodyText: string) => string | null;
  /** 2xx 가 아닐 때 응답 본문에서 상세 사유 낱말(ErrorInfo.reason 등)을 꺼낸다. 없으면 빈 목록. */
  errorReasons?: (bodyText: string) => string[];
}

/** 주소 끝 "/" 를 떼고 앞뒤 공백을 지운다. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** text 안에서 secrets 와 정확히 같은 부분을 SECRET_MASK 로 바꾼다. */
export function maskExactSecrets(text: string, secrets: readonly string[] | undefined): string {
  if (!secrets) return text;
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

/** 오류 응답 본문을 읽다가 실패했을 때 문장에 넣는 표시(본문 내용은 없음). */
export const UNREADABLE_BODY_MARK = "(응답 본문을 읽지 못함)";

/** 공급자가 돌려준 문장을 오류에 실을 때: 보낸 키를 가리고 길이를 자른다(자르기 전에 가림). */
export function maskProviderText(text: string, secrets: readonly string[] | undefined): string {
  return maskExactSecrets(text, secrets).slice(0, PROVIDER_ERROR_BODY_MAX_CHARS);
}

/** 공급자 호출 한 번의 요청 옵션 — Bun 기본 300초 제한을 끄고 내부 제한 타이머(signal)만 쓴다(bun-fetch.ts). */
export function buildProviderFetchInit(
  req: ProviderRequest,
  signal: AbortSignal,
): RequestInit & typeof BUN_FETCH_NO_DEFAULT_TIMEOUT {
  return {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    signal,
    ...BUN_FETCH_NO_DEFAULT_TIMEOUT,
  };
}

/** 공급자 HTTP 호출 한 번 → 파싱한 JSON 본문. 실패 규칙은 파일 머리말 참고. */
export async function requestProviderJson(req: ProviderRequest): Promise<unknown> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, req.timeoutMs);
  const externalAbort = (): void => timeoutController.abort();
  if (req.signal) {
    if (req.signal.aborted) timeoutController.abort();
    else req.signal.addEventListener("abort", externalAbort, { once: true });
  }

  try {
    let res: Response;
    try {
      res = await fetch(req.url, buildProviderFetchInit(req, timeoutController.signal));
    } catch (error) {
      if (isAbortError(error)) {
        if (timedOut) {
          throw new LlmRequestError({
            provider: req.provider,
            message: `${req.label} timeout (${req.timeoutMs}ms 초과)`,
            status: null,
            code: null,
            retryAfterMs: null,
            timedOut: true,
            cause: error,
          });
        }
        throw error;
      }
      throw new LlmRequestError({
        provider: req.provider,
        message: `${req.label} 네트워크 실패: ${maskExactSecrets(errorMessage(error), req.secrets)}`,
        status: null,
        code: null,
        retryAfterMs: null,
        timedOut: false,
        cause: error,
      });
    }

    if (!res.ok) {
      // 본문을 못 읽어도 실패 자체는 그대로 알리되, 빈 문장으로 넘기지 않고 못 읽었다는 표시를 남긴다.
      const rawText = await res.text().catch(() => null);
      const text = rawText === null ? UNREADABLE_BODY_MARK : maskProviderText(rawText, req.secrets);
      throw new LlmRequestError({
        provider: req.provider,
        message: `${req.label} ${res.status}: ${text}`,
        status: res.status,
        code: req.errorCode && rawText !== null ? req.errorCode(rawText) : null,
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
        timedOut: false,
        reasons: req.errorReasons && rawText !== null ? req.errorReasons(rawText) : [],
      });
    }

    const bodyText = await res.text();
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new Error(
        `${req.label} 응답이 JSON 이 아님: ${maskProviderText(bodyText, req.secrets)}`,
      );
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (req.signal) req.signal.removeEventListener("abort", externalAbort);
  }
}
