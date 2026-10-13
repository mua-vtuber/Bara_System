/**
 * index-helpers.test.ts — isLoopbackHost 단위 테스트
 *
 * 보안 Phase 1 Task 5 권위:
 *   docs/decisions/2026-06-07-security-phase1-input-limits-token-gate-plan.md
 */

import { describe, expect, it } from "bun:test";
import { isLoopbackHost, SERVER_IDLE_TIMEOUT_SECONDS } from "./index-helpers.ts";
import { SSE_PING_INTERVAL_MS } from "./server-internal/routes/events.ts";

describe("isLoopbackHost", () => {
  describe("loopback 주소 — true 반환", () => {
    it("127.0.0.1 은 loopback 이다", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
    });

    it("::1 은 loopback 이다", () => {
      expect(isLoopbackHost("::1")).toBe(true);
    });

    it("localhost 는 loopback 이다", () => {
      expect(isLoopbackHost("localhost")).toBe(true);
    });
  });

  describe("비-loopback 주소 — false 반환", () => {
    it("0.0.0.0 은 loopback 이 아니다", () => {
      expect(isLoopbackHost("0.0.0.0")).toBe(false);
    });

    it("10.0.0.5 (사설 IP) 는 loopback 이 아니다", () => {
      expect(isLoopbackHost("10.0.0.5")).toBe(false);
    });

    it("example.com (도메인) 은 loopback 이 아니다", () => {
      expect(isLoopbackHost("example.com")).toBe(false);
    });
  });
});

describe("SERVER_IDLE_TIMEOUT_SECONDS", () => {
  it("SSE 연결 유지 줄 주기보다 길다 — 조용한 /events/stream 이 그 사이에 끊기지 않는다", () => {
    expect(SERVER_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(SSE_PING_INTERVAL_MS);
  });

  it("Bun.serve 가 받는 범위(1~255초) 안이다", () => {
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
});
