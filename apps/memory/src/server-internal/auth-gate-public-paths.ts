/**
 * 인증 게이트 공개 경로 단일 출처 (P3 G4-c / 계약 단일출처)
 *
 * 권위: docs/decisions/2026-07-03-structure-cleanup-spec.md (G4-c)
 *
 * auth-gate 가 토큰 없이 통과시키는 "공개 경로"를 한 곳에 모은다. 옛 구조는
 * auth-gate.ts 의 isAllowlisted 안에 경로 리터럴(/health·/adapter-enroll*·
 * /·/web/*)이 직접 기재돼 있어, 라우트 등록과 이 목록이 손으로 동기화됐다. 라우트를
 * 새로 열거나 닫을 때 이 목록 갱신을 잊으면:
 *   - 공개여야 할 라우트가 목록에 없으면 → 무토큰 접근이 401 (기능 깨짐).
 *   - 목록에 있는데 라우트가 없으면 → 죽은 항목 (혼동 + 미래 오인 위험).
 * 이 파일이 공개 경로 계약의 단일 출처가 되고, 부팅 시 verifyPublicPathRegistration
 * 이 등록된 라우트와 이 목록을 대조해 손동기화 드리프트를 loud 하게 경고한다.
 *
 * 이 상수는 auth-gate 의 기존 판정 동작과 byte 동일해야 한다(순수 리팩터 — 하드코딩
 * 을 상수 참조로 바꿀 뿐 동작 불변). 정확-일치 경로와 prefix 경로를 나눠, 옛
 * isAllowlisted 의 두 갈래(정확 비교 vs startsWith)를 그대로 표현한다.
 */

/**
 * 정확히 이 경로일 때만 공개(무토큰 통과). 옛 isAllowlisted 의 `path === X` 갈래.
 * "/" 는 대시보드 루트(staticDir index.html), "/health" 는 헬스체크.
 */
export const PUBLIC_EXACT_PATHS = ["/health", "/"] as const;

/**
 * 이 prefix 로 시작하면 공개. 옛 isAllowlisted 의 `path === base || path.startsWith(base + "/")`
 * 및 `path.startsWith("/web/")` 갈래.
 *
 * - base: prefix 의 기준 경로. `base` 정확 일치 또는 `base + "/"` 하위가 공개.
 *   예: "/adapter-enroll" 은 "/adapter-enroll" 자체와 하위 경로를 공개.
 * - "/web/" 는 base="/web" 로 두면 "/web" 정확 + "/web/..." 하위를 공개하는데,
 *   옛 코드는 "/web/" 하위만 공개하고 "/web" 정확은 안 열었다. 그 미묘한 차이를
 *   보존하려 webExactAllowed 로 base 정확 일치 허용 여부를 명시한다.
 */
export interface PublicPrefix {
  /** prefix 기준 경로(끝에 "/" 없이). */
  base: string;
  /**
   * base 정확 일치(`path === base`)도 공개로 볼지. true = base 와 base/* 모두 공개,
   * false = base/* 하위만 공개(base 정확은 보호). 옛 동작 보존용.
   */
  exactAllowed: boolean;
}

export const PUBLIC_PREFIXES: readonly PublicPrefix[] = [
  // /adapter-enroll, /adapter-enroll/* — 옛 동일 갈래.
  { base: "/adapter-enroll", exactAllowed: true },
  // /web/* — 옛 `path.startsWith("/web/")` 뿐이라 "/web" 정확은 안 열었다.
  { base: "/web", exactAllowed: false },
] as const;

/**
 * 경로가 공개(무토큰 통과)인지 판정한다. auth-gate 의 isAllowlisted 가 이 함수를
 * 쓴다. 옛 isAllowlisted 와 판정이 byte 동일해야 한다(순수 리팩터).
 */
export function isPublicPath(path: string): boolean {
  for (const exact of PUBLIC_EXACT_PATHS) {
    if (path === exact) return true;
  }
  for (const { base, exactAllowed } of PUBLIC_PREFIXES) {
    if (exactAllowed && path === base) return true;
    if (path.startsWith(`${base}/`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 부팅 시 등록-계약 정합 검증 (P3 G4-c)
// ---------------------------------------------------------------------------

/** 등록된 라우트 한 항목 — Hono app.routes 의 { method, path } 부분집합. */
export interface RegisteredRoute {
  method: string;
  path: string;
}

/**
 * 한 공개 경로가 등록 라우트 중 하나로 뒷받침되는지 판정한다.
 *
 * Hono 등록 경로는 파라미터(`:id`)·와일드카드(`*`)를 포함할 수 있어 문자열 정확
 * 비교로는 안 맞는다. 공개 base 를 다음 규칙으로 라우트와 대조한다:
 *   - 등록 경로가 공개 경로와 정확히 같으면 매치("/health" === "/health").
 *   - 등록 경로가 `<publicBase>/*` 와일드카드면 매치("/web/*" 가 base "/web" 커버).
 *   - 등록 경로가 `<publicBase>/...` 하위면 매치("/adapter-enroll/token" 이 base
 *     "/adapter-enroll" 하위 라우트로 그 prefix 를 뒷받침).
 */
function isCoveredByRoute(publicPath: string, routes: RegisteredRoute[]): boolean {
  for (const { path } of routes) {
    if (path === publicPath) return true;
    // "/web/*" 와일드카드가 공개 base 를 커버.
    if (path === `${publicPath}/*`) return true;
    if (path.startsWith(`${publicPath}/`)) return true;
  }
  return false;
}

/** verifyPublicPathRegistration 결과 — 발견된 드리프트 경고 목록. */
export interface PublicPathVerification {
  /** 공개 경로 계약에 있으나 등록 라우트로 뒷받침되지 않는 항목(죽은 allowlist). */
  unbackedPublicPaths: string[];
  /** 사람이 읽을 경고 문자열(각 드리프트 한 줄). 없으면 빈 배열. */
  warnings: string[];
}

/**
 * 부팅 시 공개 경로 계약(이 파일 상수)과 실제 등록된 라우트를 대조해 손동기화
 * 드리프트를 찾는다. 라우트를 지웠는데 공개 목록에 남으면(죽은 allowlist) 또는
 * 라우트를 옮겼는데 목록을 안 고치면 여기서 잡힌다.
 *
 * `hasStaticDir` — "/" 와 "/web" 공개 경로는 staticDir 이 있을 때만 라우트가
 * 등록된다(stats.ts). staticDir 미설정 부팅에서 이 둘을 "미등록 드리프트"로
 * 오탐하지 않도록, staticDir 이 없으면 그 둘의 검증을 건너뛴다(정직한 조건부 —
 * 없는 게 정상인 상황을 경고로 위장하지 않는다).
 *
 * 반환만 하고 로그는 호출부(index.ts)가 찍는다 — 순수 함수로 테스트 가능하게.
 * silent 통과가 아니라 "발견한 드리프트를 그대로 돌려줌"이다.
 */
export function verifyPublicPathRegistration(
  routes: RegisteredRoute[],
  opts: { hasStaticDir: boolean },
): PublicPathVerification {
  const unbacked: string[] = [];

  // staticDir 조건부 공개 경로 — 없으면 라우트도 없는 게 정상이라 검증 스킵.
  const staticConditionalExact = new Set<string>(["/"]);
  const staticConditionalPrefixBase = new Set<string>(["/web"]);

  for (const exact of PUBLIC_EXACT_PATHS) {
    if (!opts.hasStaticDir && staticConditionalExact.has(exact)) continue;
    if (!isCoveredByRoute(exact, routes)) {
      // 정확 경로는 하위 라우트가 아니라 정확 등록만 뒷받침으로 본다.
      const exactRegistered = routes.some((r) => r.path === exact);
      if (!exactRegistered) unbacked.push(exact);
    }
  }

  for (const { base } of PUBLIC_PREFIXES) {
    if (!opts.hasStaticDir && staticConditionalPrefixBase.has(base)) continue;
    if (!isCoveredByRoute(base, routes)) {
      unbacked.push(`${base}/*`);
    }
  }

  const warnings = unbacked.map(
    (p) =>
      `[auth-gate] 공개 경로 '${p}' 가 등록된 라우트로 뒷받침되지 않는다 — ` +
      `auth-gate-public-paths.ts 의 공개 목록과 라우트 등록이 손동기화 어긋남. ` +
      `라우트를 옮겼거나 지웠으면 공개 목록도 함께 고쳐라.`,
  );

  return { unbackedPublicPaths: unbacked, warnings };
}
