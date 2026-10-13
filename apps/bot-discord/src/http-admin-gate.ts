/**
 * 봇 :3100 로컬 관리 토큰 게이트 미들웨어 (D2).
 *
 * 권위: docs/decisions/2026-07-02-adapter-auth-spec.md section 3.1 / 3.2
 *
 * 상태변경·민감읽기 경로는 Authorization: Bearer <localAdminToken> 을 요구한다.
 * 무인증 허용목록(GET /health, GET /settings/schema)만 토큰 없이 통과한다 —
 * 디스커버리가 부팅 시 읽어야 하고 민감 데이터가 없기 때문. GET /settings 는
 * ownerId·memoryApiUrl 을 평문으로 노출하므로 게이트 대상에 포함한다.
 *
 * 코어 auth-gate.ts 의 createAuthGate 팩토리 패턴 답습(의존성 주입 →
 * MiddlewareHandler). Host 게이트(http-host-guard.ts) 다음에 등록한다.
 *
 * 토큰 값은 응답·로그·에러 어디에도 넣지 않는다. 비교는 timingSafeEqual 로
 * 길이·내용 타이밍 누출을 막는다.
 *
 * ## 대시보드 토큰 전달은 P1-B 통합 지점
 *
 * 이 게이트는 토큰을 "검증할 준비가 된" 상태까지만 만든다. 대시보드가 코어를
 * 거쳐 봇 액션을 부를 때 이 토큰을 Bearer 로 싣는 배선(spec § 3.2 의 대시보드
 * 측)은 P1-B(대시보드 인증 배선) 소관이라 여기서 구현하지 않는다. 두 task 가
 * 통합되기 전까지 대시보드發 상태변경 호출은 이 게이트에서 401 이 정상이다.
 */

import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

/**
 * 무인증 허용 경로 판별. GET /health, GET /settings/schema 만 토큰 없이 통과.
 * strict:false 라우터라 trailing slash 도 같은 경로로 본다 — 판정도 정규화한다.
 *
 * P3 G4-b — export 한다. 코어 `needsAdapterAuth`(federation/routes.ts)가 이 판정과
 * 대칭이어야 봇↔코어 인증 규칙이 드리프트하지 않는다(봇이 무인증 허용하는 경로를
 * 코어가 정확히 알아 토큰을 붙이거나 뺀다). 코어 쪽 대칭 테스트가 이 함수를 직접
 * import 해 두 판정이 (method, path) 격자에서 정확히 반대임을 실증한다 — 이 함수
 * 규칙을 바꾸면 코어 needsAdapterAuth 도 함께 바꿔야 그 테스트가 통과한다.
 */
export function isUnauthenticatedPath(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === "/health" || normalized === "/settings/schema";
}

/**
 * 요청에서 Bearer 토큰을 추출한다. Authorization: Bearer <token> 형태만 받는다.
 * 토큰 값은 반환만 하고 응답·로그에 넣지 않는다(보안 요건).
 */
function extractBearer(c: Context): string {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return "";
}

/**
 * 상수시간 문자열 비교. 길이가 다르면 즉시 false(timingSafeEqual 은 같은 길이
 * 버퍼를 요구). 같은 길이면 timingSafeEqual 로 내용 비교.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** createAdminGate 의존 주입 인터페이스. */
export interface AdminGateDeps {
  /**
   * 기대 토큰을 반환하는 함수. 부팅 시 loadOrCreateAdminToken 으로 만든 토큰을
   * 클로저로 넘긴다. 함수로 받는 이유: 토큰 로테이션 등 미래 확장에서 최신 값을
   * 참조할 수 있게 하기 위함(코어 auth-gate 의 의존성 주입 톤).
   */
  expectedToken: () => string;
}

/**
 * 로컬 관리 토큰 게이트 미들웨어를 만든다. Host 게이트 다음에
 * app.use("*", ...) 로 등록한다.
 *
 * 판정:
 *   - 무인증 허용 경로(GET /health, GET /settings/schema) → 통과.
 *   - 그 외(PUT /settings, GET /settings, POST/GET /actions/*) → Bearer 토큰 필수.
 *     토큰 부재/불일치 → 401 { error: "인증이 필요합니다." }. 토큰 값은 응답·로그
 *     에 안 넣는다.
 */
export function createAdminGate(deps: AdminGateDeps): MiddlewareHandler {
  return async (c, next) => {
    if (isUnauthenticatedPath(c.req.method, c.req.path)) {
      await next();
      return;
    }

    const provided = extractBearer(c);
    const expected = deps.expectedToken();
    // 기대 토큰이 비어 있으면(부팅 실패 등) 어떤 요청도 통과시키지 않는다 —
    // silent 통과 금지. 빈 토큰끼리 매칭돼 우회되는 일을 막는다.
    if (
      expected.length === 0 ||
      provided.length === 0 ||
      !safeEqual(provided, expected)
    ) {
      return c.json({ error: "인증이 필요합니다." }, 401);
    }

    await next();
  };
}
