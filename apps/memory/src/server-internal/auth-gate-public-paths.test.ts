/**
 * 공개 경로 계약 단일 출처 테스트 (P3 G4-c)
 *
 * 두 축을 검증한다:
 *   1) isPublicPath 가 옛 auth-gate.ts isAllowlisted 리터럴 판정과 byte 동일 —
 *      상수화가 순수 리팩터(동작 불변)임을 못박는다. 옛 판정을 이 파일 안에
 *      독립 재구현한 legacyIsAllowlisted 와 격자 대조한다.
 *   2) verifyPublicPathRegistration 이 등록 라우트와 공개 목록을 대조해 드리프트를
 *      잡는다 — 정상은 경고 0, 라우트 누락은 loud 경고, staticDir 조건부 스킵.
 *
 * 데이터 fixture 만 사용(mock 객체 0) — 순수 함수에 값을 넣어 출력을 검증한다.
 */

import { describe, expect, test } from "bun:test";
import {
  isPublicPath,
  verifyPublicPathRegistration,
  type RegisteredRoute,
} from "./auth-gate-public-paths.ts";

/**
 * 옛 auth-gate.ts isAllowlisted 의 리터럴 판정을 독립 재구현한 것. 상수화된
 * isPublicPath 가 이것과 정확히 같은 판정을 내는지 대조하는 회귀 기준이다. 이
 * 함수를 바꾸면(옛 규칙을 임의로 바꾸면) 대조가 깨져 회귀를 잡는다.
 */
function legacyIsAllowlisted(path: string): boolean {
  if (path === "/health") return true;
  if (path === "/adapter-enroll" || path.startsWith("/adapter-enroll/")) return true;
  if (path === "/" || path.startsWith("/web/")) return true;
  return false;
}

describe("isPublicPath — 옛 isAllowlisted 와 byte 동일 (G4-c 회귀 0)", () => {
  // 공개·보호 경계를 가르는 대표 경로 격자. 옛 판정과 새 판정이 전부 일치해야 한다.
  const paths = [
    // 공개(정확)
    "/health",
    "/",
    // 공개(prefix)
    "/adapter-enroll",
    "/adapter-enroll/",
    "/adapter-enroll/req/token",
    "/web/dashboard",
    "/web/dashboard/settings.js",
    // 경계 함정 — /web 정확은 옛 코드가 안 열었다(/web/ 하위만).
    "/web",
    // 보호(공개 아님)
    "/memories",
    "/settings",
    "/graph/overview",
    "/healthz", // /health 접두 함정 — 정확 일치가 아니라 보호.
    "/wizard", // 웹 첫 실행마법사는 제거됨 — 공개 경로가 아니다.
    "/wizard/step1",
    "/adapter-enrollment", // 접두 함정.
    "/thumbs/abc",
    "/events/stream",
    "/api/entity-types",
  ];

  for (const path of paths) {
    test(`'${path}' 판정 일치`, () => {
      expect(isPublicPath(path)).toBe(legacyIsAllowlisted(path));
    });
  }

  test("경계 함정 명시 — /web 정확은 보호, /web/ 하위는 공개", () => {
    expect(isPublicPath("/web")).toBe(false);
    expect(isPublicPath("/web/")).toBe(true);
    expect(isPublicPath("/web/x")).toBe(true);
  });

  test("웹 첫 실행마법사 제거 — /wizard 정확·하위 모두 보호", () => {
    expect(isPublicPath("/wizard")).toBe(false);
    expect(isPublicPath("/wizard/x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyPublicPathRegistration — 부팅 정합 검증
// ---------------------------------------------------------------------------

/** 운영에서 실제 등록되는 공개 경로 라우트 집합(staticDir 있음)의 최소 fixture. */
function routesWithStatic(): RegisteredRoute[] {
  return [
    { method: "GET", path: "/health" },
    { method: "GET", path: "/" },
    { method: "GET", path: "/web/*" },
    { method: "POST", path: "/adapter-enroll" },
    { method: "GET", path: "/adapter-enroll/:requestId/token" },
    // 보호 라우트 몇 개 섞음 — 검증에 영향 없어야.
    { method: "GET", path: "/memories" },
    { method: "POST", path: "/search" },
  ];
}

describe("verifyPublicPathRegistration — 정상 등록 시 드리프트 0", () => {
  test("staticDir 있음 + 모든 공개 경로 등록 → 경고 0", () => {
    const result = verifyPublicPathRegistration(routesWithStatic(), {
      hasStaticDir: true,
    });
    expect(result.warnings).toEqual([]);
    expect(result.unbackedPublicPaths).toEqual([]);
  });

  test("staticDir 없음 + / 와 /web 라우트 부재 → 여전히 경고 0 (조건부 스킵)", () => {
    // staticDir 없으면 stats.ts 가 "/"·"/web/*" 를 등록 안 한다 — 그게 정상.
    const routes: RegisteredRoute[] = [
      { method: "GET", path: "/health" },
      { method: "POST", path: "/adapter-enroll" },
      { method: "GET", path: "/adapter-enroll/:requestId/token" },
    ];
    const result = verifyPublicPathRegistration(routes, {
      hasStaticDir: false,
    });
    expect(result.warnings).toEqual([]);
  });
});

describe("verifyPublicPathRegistration — 드리프트 loud 검출", () => {
  test("공개 목록에 있는 /adapter-enroll 라우트를 지우면 → 경고 (죽은 allowlist)", () => {
    const routes = routesWithStatic().filter(
      (r) => !r.path.startsWith("/adapter-enroll"),
    );
    const result = verifyPublicPathRegistration(routes, {
      hasStaticDir: true,
    });
    expect(result.unbackedPublicPaths).toContain("/adapter-enroll/*");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("/adapter-enroll");
    expect(result.warnings[0]).toContain("손동기화");
  });

  test("/health 라우트를 지우면 → 경고 (정확 경로 미등록)", () => {
    const routes = routesWithStatic().filter((r) => r.path !== "/health");
    const result = verifyPublicPathRegistration(routes, {
      hasStaticDir: true,
    });
    expect(result.unbackedPublicPaths).toContain("/health");
  });

  test("staticDir 있는데 / 와 /web 라우트가 없으면 → 두 경고 (조건부 아님)", () => {
    // staticDir=true 인데 정적 라우트가 없다 = 진짜 드리프트라 경고해야 한다.
    const routes: RegisteredRoute[] = [
      { method: "GET", path: "/health" },
      { method: "POST", path: "/adapter-enroll" },
      { method: "GET", path: "/adapter-enroll/:requestId/token" },
    ];
    const result = verifyPublicPathRegistration(routes, {
      hasStaticDir: true,
    });
    expect(result.unbackedPublicPaths).toContain("/");
    expect(result.unbackedPublicPaths).toContain("/web/*");
  });
});
