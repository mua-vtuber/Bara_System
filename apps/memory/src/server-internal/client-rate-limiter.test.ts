/**
 * ClientRateLimiter — 접속 주소별 고정 창 빈도 상한.
 * 실제 구현체에 시각 함수만 넘겨 창 경계를 검증한다(mock 객체 없음).
 */

import { describe, expect, test } from "bun:test";
import { ClientRateLimiter } from "./client-rate-limiter.ts";

const limits = { maxRequestsPerWindow: 3, windowMs: 10_000, maxTrackedClients: 2 };

describe("ClientRateLimiter", () => {
  test("창 안에서 상한까지 허용하고 그 다음부터 남은 시간과 함께 거절한다", () => {
    let now = 0;
    const limiter = new ClientRateLimiter(limits, () => now);
    expect(limiter.consume("a")).toEqual({ allowed: true });
    now = 1000;
    expect(limiter.consume("a")).toEqual({ allowed: true });
    expect(limiter.consume("a")).toEqual({ allowed: true });
    now = 4000;
    expect(limiter.consume("a")).toEqual({ allowed: false, retryAfterMs: 6000 });
  });

  test("창이 끝나면 다시 허용한다", () => {
    let now = 0;
    const limiter = new ClientRateLimiter(limits, () => now);
    for (let i = 0; i < 4; i++) limiter.consume("a");
    now = 10_000;
    expect(limiter.consume("a")).toEqual({ allowed: true });
  });

  test("주소마다 따로 센다", () => {
    const limiter = new ClientRateLimiter(limits, () => 0);
    for (let i = 0; i < 3; i++) limiter.consume("a");
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  test("추적 공간이 가득 차면 만료 기록을 먼저 지우고, 그래도 가득 차면 새 주소를 거절한다", () => {
    let now = 0;
    const limiter = new ClientRateLimiter(limits, () => now);
    limiter.consume("a");
    now = 5000;
    limiter.consume("b");
    expect(limiter.consume("c")).toEqual({ allowed: false, retryAfterMs: 5000 });
    now = 10_000;
    // a 의 창이 끝나 자리가 생긴다.
    expect(limiter.consume("c")).toEqual({ allowed: true });
    expect(limiter.consume("b").allowed).toBe(true);
  });

  test("잘못된 상한 설정은 만들 때 던진다", () => {
    expect(() => new ClientRateLimiter({ ...limits, maxRequestsPerWindow: 0 })).toThrow(/maxRequestsPerWindow/);
    expect(() => new ClientRateLimiter({ ...limits, windowMs: 0 })).toThrow(/windowMs/);
  });
});
