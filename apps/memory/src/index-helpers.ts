/**
 * index-helpers.ts — index.ts 부팅 단계 순수 헬퍼 모음
 *
 * index.ts 자체는 Bun.serve 를 import 시점에 실행하므로 단위 테스트가 불가하다.
 * 테스트 가능한 순수 로직만 이 파일로 분리한다.
 *
 * 보안 Phase 1 Task 5 권위:
 *   docs/decisions/2026-06-07-security-phase1-input-limits-token-gate-plan.md
 */

/**
 * 주어진 호스트 문자열이 loopback 주소인지 판별한다.
 *
 * 부팅 경고에서 사용 — loopback 이 아닌 바인딩 시 TLS 프록시 없이 토큰이
 * 평문으로 흐를 수 있음을 경고한다.
 *
 * @param host - 바인딩 호스트 문자열 (예: "127.0.0.1", "0.0.0.0")
 * @returns loopback 이면 true, 아니면 false
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Bun.serve 의 idleTimeout(초) — 연결에 아무 바이트도 오가지 않을 때 서버가 끊기까지
 * 기다리는 시간. 지정하지 않으면 Bun 기본값 10초가 적용되는데, /events/stream 은
 * 25초(SSE_PING_INTERVAL_MS)마다, /mcp GET 스트림(@hono/mcp)은 30초마다 연결 유지 줄을
 * 보내므로 조용한 스트림이 10초 만에 끊기고 클라이언트가 재접속을 반복했다
 * (A1 실측: 디스코드 어댑터 SSE 가 약 15초마다 끊김, 시간당 240회).
 * 두 연결 유지 주기보다 넉넉히 길게 잡는다. Bun 이 받는 최대값은 255초.
 */
export const SERVER_IDLE_TIMEOUT_SECONDS = 60;
