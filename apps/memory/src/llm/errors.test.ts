/**
 * errors.test.ts — LlmRequestError 필드 보존 + Retry-After ms 환산 순수 함수 검증 (A-2).
 *
 * parseRetryAfterMs 는 순수 함수라 데이터 fixture 로 검증(Mock 0). HTTP-date 환산은
 * now 를 주입해 결정적으로 검증한다.
 */

import { describe, expect, test } from "bun:test";
import { LlmRequestError, parseRetryAfterMs } from "./errors.ts";

describe("parseRetryAfterMs — delta-seconds 형식", () => {
  test("정수 초 → ms (120 → 120000)", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  test("0 초 → 0ms", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("공백 패딩 허용 (' 30 ' → 30000)", () => {
    expect(parseRetryAfterMs("  30  ")).toBe(30_000);
  });
});

describe("parseRetryAfterMs — HTTP-date 형식", () => {
  test("미래 시각 → now 대비 남은 ms", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    const header = "Wed, 21 Oct 2026 07:28:05 GMT";
    expect(parseRetryAfterMs(header, now)).toBe(5_000);
  });

  test("과거 시각 → null (음수 지연은 정보 없음으로 처리)", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:10 GMT");
    const header = "Wed, 21 Oct 2026 07:28:00 GMT";
    expect(parseRetryAfterMs(header, now)).toBeNull();
  });
});

describe("parseRetryAfterMs — 부재·불가 입력", () => {
  test("null → null", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  test("undefined → null", () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });

  test("빈 문자열 → null", () => {
    expect(parseRetryAfterMs("   ")).toBeNull();
  });

  test("파싱 불가 문자열 → null", () => {
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});

describe("LlmRequestError — 필드 보존", () => {
  test("생성자가 provider·status·code·retryAfterMs·timedOut 을 보존한다", () => {
    const err = new LlmRequestError({
      provider: "ollama",
      message: "Ollama /api/chat 429",
      status: 429,
      code: null,
      retryAfterMs: 2000,
      timedOut: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect(err.name).toBe("LlmRequestError");
    expect(err.provider).toBe("ollama");
    expect(err.status).toBe(429);
    expect(err.code).toBeNull();
    expect(err.retryAfterMs).toBe(2000);
    expect(err.timedOut).toBe(false);
  });

  test("cause 전달 시 보존 (원본 오류 래핑)", () => {
    const original = new Error("socket hang up");
    const err = new LlmRequestError({
      provider: "anthropic",
      message: "네트워크 단절",
      status: null,
      code: null,
      retryAfterMs: null,
      timedOut: false,
      cause: original,
    });
    expect(err.cause).toBe(original);
    expect(err.status).toBeNull();
  });
});
