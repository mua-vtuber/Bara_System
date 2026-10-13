/**
 * Federation Proxy Fetch (Phase 5.5.7 / spec section 5.3)
 *
 * 메모리가 어댑터 endpoint 를 서버 측에서 호출할 때 사용하는 fetch helper.
 * 타임아웃 / 에러 분류 세 가지를 제공한다.
 *
 * 에러 분류:
 *   - TimeoutError  : 지정 시간 초과
 *   - NetworkError  : TCP/DNS 수준 연결 실패
 *   - HttpError     : 어댑터가 4xx/5xx 반환 (status + body 포함)
 */

/** 기본 proxy timeout (ms). spec section 5.3 정합. */
export const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// 에러 클래스
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  readonly kind = "timeout" as const;
  constructor(url: string, timeoutMs: number) {
    super(`어댑터 fetch 타임아웃 (${timeoutMs}ms 초과) — ${url}`);
    this.name = "TimeoutError";
  }
}

export class NetworkError extends Error {
  readonly kind = "network" as const;
  readonly originalCause: unknown;
  constructor(url: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`어댑터 연결 실패 (네트워크 오류) — ${url}: ${detail}`);
    this.name = "NetworkError";
    this.originalCause = cause;
  }
}

export class HttpError extends Error {
  readonly kind = "http" as const;
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
  constructor(url: string, status: number, body: string, contentType: string | null) {
    super(`어댑터 HTTP ${status} 응답 — ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.contentType = contentType;
  }
}

export type ProxyFetchError = TimeoutError | NetworkError | HttpError;

// ---------------------------------------------------------------------------
// 옵션 타입
// ---------------------------------------------------------------------------

export interface ProxyFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** fetch 타임아웃 (ms). 기본 = DEFAULT_PROXY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** fetch 구현체 주입 (테스트 전용). 기본 = 전역 fetch. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

export interface ProxyFetchResult {
  status: number;
  contentType: string | null;
  body: string;
}

// ---------------------------------------------------------------------------
// 핵심 함수
// ---------------------------------------------------------------------------

/**
 * 어댑터 URL 에 서버 측 fetch 수행.
 *
 * 성공 시 ProxyFetchResult 반환.
 * 실패 시 TimeoutError / NetworkError / HttpError throw.
 * HttpError 는 어댑터가 4xx/5xx 반환했음을 의미하며, 호출자가 판단해서
 * 브라우저로 그대로 전달하거나 503 으로 래핑할 수 있다.
 */
export async function proxyFetch(
  url: string,
  options: ProxyFetchOptions = {},
): Promise<ProxyFetchResult> {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(url, timeoutMs);
    }
    throw new NetworkError(url, err);
  } finally {
    clearTimeout(timer);
  }

  const responseBody = await response.text();
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    throw new HttpError(url, response.status, responseBody, contentType);
  }

  return {
    status: response.status,
    contentType,
    body: responseBody,
  };
}
