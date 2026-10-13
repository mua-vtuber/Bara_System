/**
 * 제한 토큰 REST 권한 표 — 등록 라우트 대조 (SA-13 수정 — WP-B1-12).
 *
 * 권위: docs/decisions/2026-09-27-audit-fix-plan-memory-core.md WP-B1-12.
 *
 * token-scope.ts 의 SCOPED_HTTP_ROUTES 는 제한 토큰이 쓸 수 있는 REST 경로의
 * 단일 출처지만, 그 표 항목이 실제 등록된 라우트로 뒷받침되는지는 따로 확인해야
 * 한다 — 표에 남은 죽은 항목(라우트를 지웠는데 표를 안 고침)이나, 표에 없는
 * 새 라우트(제한 토큰이 접근 못 하는 걸 몰랐던 채 방치)를 부팅에서 잡는다.
 *
 * 이 파일은 auth-gate-public-paths.ts 의 등록 대조(verifyPublicPathRegistration)
 * 와 같은 정신 — Hono 라우트 문법(`:param`)을 그대로 문자열 비교한다(SCOPED_HTTP_ROUTES
 * 의 path 필드가 이미 그 문법이고, Hono app.routes 도 같은 문법으로 등록 경로를
 * 돌려준다 — 별도 정규식 변환이 필요 없다).
 *
 * verifyAuthPathRegistration 이 공개 경로 대조와 이 대조를 한 함수로 합쳐
 * index.ts 의 부팅 호출 한 곳을 그대로 유지한다(895줄 파일이 늘지 않음).
 */

import { SCOPED_HTTP_ROUTES } from "../federation/token-scope.ts";
import {
  verifyPublicPathRegistration,
  type PublicPathVerification,
  type RegisteredRoute,
} from "./auth-gate-public-paths.ts";

/**
 * 경로의 모든 `:param` 세그먼트를 `:` 단일 자리 표시자로 정규화한다.
 * 파라미터 *이름*(`:adapterId` vs `:id`)은 무시하고 경로 *형태*만 비교한다.
 * 등록 대조에서 "같은 경로 모양은 같은 라우트"로 판정하기 위함.
 */
function normalizePathShape(path: string): string {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":");
}

/**
 * SCOPED_HTTP_ROUTES 표 항목 하나가 등록 라우트로 뒷받침되는지 판정한다.
 * method·경로 형태가 일치 — 파라미터 이름(:adapterId vs :id)은 무시하고
 * 경로 구조(:의 개수·위치)만 비교한다(Hono 정규식 비교는 파라미터 이름과
 * 무관하게 일치하기 때문).
 */
function isScopedRouteRegistered(
  route: { method: string; path: string },
  routes: RegisteredRoute[],
): boolean {
  const routeShape = normalizePathShape(route.path);
  return routes.some((r) => r.method === route.method && normalizePathShape(r.path) === routeShape);
}

/**
 * 부팅 시 SCOPED_HTTP_ROUTES 표와 실제 등록된 라우트를 대조해 손동기화
 * 드리프트를 찾는다. 표 항목이 라우트로 뒷받침되지 않으면(죽은 표 항목) 경고.
 *
 * verifyPublicPathRegistration 과 대칭 — 반환만 하고 로그는 호출부가 찍는다.
 */
export function verifyScopedRouteRegistration(
  routes: RegisteredRoute[],
): { unbackedScopedRoutes: string[]; warnings: string[] } {
  const unbacked: string[] = [];
  for (const route of SCOPED_HTTP_ROUTES) {
    if (!isScopedRouteRegistered(route, routes)) {
      unbacked.push(`${route.method} ${route.path}`);
    }
  }
  const warnings = unbacked.map(
    (entry) =>
      `[auth-gate] 제한 토큰 허용 표 항목 '${entry}' 가 등록된 라우트로 뒷받침되지 않는다 — ` +
      `token-scope.ts 의 SCOPED_HTTP_ROUTES 와 라우트 등록이 손동기화 어긋남. ` +
      `라우트를 옮겼거나 지웠으면 표도 함께 고쳐라.`,
  );
  return { unbackedScopedRoutes: unbacked, warnings };
}

/** verifyAuthPathRegistration 결과 — 공개 경로 + 제한 토큰 표 드리프트를 함께 담는다. */
export interface AuthPathVerification extends PublicPathVerification {
  /** SCOPED_HTTP_ROUTES 표에 있으나 등록 라우트로 뒷받침되지 않는 항목. */
  unbackedScopedRoutes: string[];
}

/**
 * 부팅 시 인증 경로 계약 전체(공개 경로 + 제한 토큰 허용 표)를 실제 등록된
 * 라우트와 대조한다. auth-gate-public-paths.ts 의 verifyPublicPathRegistration
 * 과 이 파일의 verifyScopedRouteRegistration 을 한 호출로 합쳐, index.ts 가
 * 부팅 대조를 위해 부르는 함수를 하나로 유지한다.
 *
 * warnings 는 두 검증의 경고를 이어붙인 것 — 순서는 공개 경로 먼저, 제한 토큰
 * 표 다음(호출부 로그 순서와 일치).
 */
export function verifyAuthPathRegistration(
  routes: RegisteredRoute[],
  opts: { hasStaticDir: boolean },
): AuthPathVerification {
  const publicCheck = verifyPublicPathRegistration(routes, opts);
  const scopedCheck = verifyScopedRouteRegistration(routes);
  return {
    unbackedPublicPaths: publicCheck.unbackedPublicPaths,
    unbackedScopedRoutes: scopedCheck.unbackedScopedRoutes,
    warnings: [...publicCheck.warnings, ...scopedCheck.warnings],
  };
}

export type { RegisteredRoute };
