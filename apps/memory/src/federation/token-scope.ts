/**
 * 제한 토큰 REST 권한 단일 출처 (SA-13, SA-12 수정 — WP-B1-12).
 *
 * 권위: docs/decisions/2026-09-27-audit-fix-plan-memory-core.md WP-B1-12.
 *
 * 옛 auth-gate.ts 의 canUseHttp(auth-gate.ts:138-160, 리팩터 전)는 보호 REST 경로
 * 리터럴·정규식을 함수 본문에 직접 두었다. 공개 경로(auth-gate-public-paths.ts +
 * verifyPublicPathRegistration)는 등록 라우트와 대조되는 반면, 이 제한-토큰 허용
 * 표는 그 대조가 없어 표 항목과 실제 라우트가 손동기화로 어긋날 수 있었다(SA-13).
 *
 * 이 파일이 그 표의 단일 출처다: SCOPED_HTTP_ROUTES 데이터 + canUseScopedHttp
 * 판정 함수. auth-gate-scoped-routes.ts 가 부팅 시 이 표와 실제 등록 라우트를
 * 대조해 드리프트를 잡는다(verifyAuthPathRegistration, auth-gate-public-paths.ts
 * 의 등록 대조와 한 함수로 합쳐진다).
 *
 * 의존성 없음 — federation·server-internal 어느 쪽에도 의존하지 않아 순환
 * import 위험이 없다. sse-tokens.ts 는 TokenScope·isTokenScope·TOKEN_SCOPES 를
 * 여기서 다시 내보내기만 한다(하위 호환 — 기존 모든 임포터가 그대로 동작).
 */

/** 어댑터 토큰이 가질 수 있는 권한 단계. 표시 순서는 약함 → full. */
export type TokenScope = "read-only" | "mcp-standard" | "full";

/** 모든 TokenScope 값. 순회·검증에 쓴다(예: 테스트가 모든 scope 를 loop). */
export const TOKEN_SCOPES: readonly TokenScope[] = ["read-only", "mcp-standard", "full"] as const;

export function isTokenScope(value: unknown): value is TokenScope {
  return value === "read-only" || value === "mcp-standard" || value === "full";
}

/**
 * scope 간 강도 순서. full 이 가장 강하고 read-only 가 가장 약하다.
 * canUseScopedHttp 가 "이 경로는 최소 mcp-standard 필요" 판정에 쓴다.
 */
const SCOPE_RANK: Record<TokenScope, number> = {
  "read-only": 0,
  "mcp-standard": 1,
  full: 2,
};

/**
 * 경로의 파라미터 구간이 받아들이는 양식. 옛 canUseHttp 의 정규식이 구분하던
 * 세 가지 폭을 그대로 표현한다 — 폭을 넓히면 회귀이므로 표에서 명시한다.
 *
 * - "numeric": 숫자만(`\d+`) — /memories/:id 계열.
 * - "uuid": RFC 4122 표준 UUID 소문자/대문자 무관 — /ingest/status/:requestId.
 * - "segment": 슬래시 없는 임의 문자열(`[^/]+`) — /cleanup-proposals/:id,
 *   /api/cleanup-runs/:id (id 가 숫자가 아닐 수 있는 기존 계약, 넓히지 않고 보존).
 * - "sha256": 소문자 hex 64자 — /thumbs/:sha, /assets/:sha(이미지 자산 경로,
 *   http-helpers.ts 의 SHA256_HEX_RE 와 같은 양식).
 */
type ScopedRouteParamKind = "numeric" | "uuid" | "segment" | "sha256";

const PARAM_KIND_SOURCE: Record<ScopedRouteParamKind, string> = {
  numeric: "\\d+",
  uuid: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
  segment: "[^/]+",
  sha256: "[a-f0-9]{64}",
};

/**
 * 제한 토큰 REST 허용 표 한 항목.
 *
 * - method: HTTP 메서드. "GET"은 auth-gate 의 기존 관례(canUseHttp readMethod)를
 *   따라 HEAD 도 함께 허용한다(canUseScopedHttp 안에서 처리).
 * - path: Hono 라우트 문법(`:param`). 등록 라우트 대조(auth-gate-scoped-routes.ts)
 *   와 요청 경로 판정(canUseScopedHttp) 양쪽에 이 한 필드를 쓴다.
 * - paramKind: path 에 `:param` 이 있을 때 그 구간이 받아들이는 양식. path 에
 *   파라미터가 없으면(정확 경로) 생략.
 * - minScope: 이 경로를 쓰는 데 필요한 최소 권한. read-only 면 read-only 이상
 *   전부 허용, mcp-standard 면 mcp-standard·full 만 허용.
 * - selfAdapterOnly: true 면 경로의 :adapterId 파라미터가 호출자 자신의
 *   adapterId 와 같을 때만 허용(예: /federation/apps/:adapterId/settings).
 */
export interface ScopedHttpRoute {
  method: "GET" | "POST" | "PATCH";
  path: string;
  paramKind?: ScopedRouteParamKind;
  minScope: TokenScope;
  selfAdapterOnly?: boolean;
}

/**
 * 제한 토큰(read-only·mcp-standard) REST 허용 표 — 단일 출처.
 *
 * full 토큰은 이 표를 거치지 않고 항상 허용(canUseScopedHttp 최상단 단락).
 * 표에 없는 (method, path) 조합은 제한 토큰에 거부 — 기존 canUseHttp 의
 * "표에 없으면 기본 거부" 동작을 그대로 유지한다(SA-13 완료 기준).
 *
 * 각 항목 뒤 주석은 옛 canUseHttp(auth-gate.ts, 리팩터 전 138~160행)의 어느
 * 갈래를 옮긴 것인지 표시해 동등성 검토를 쉽게 한다.
 */
export const SCOPED_HTTP_ROUTES: readonly ScopedHttpRoute[] = [
  // ---- read-only 이상 (읽기 GET/HEAD) ----------------------------------
  { method: "GET", path: "/memories", minScope: "read-only" },
  { method: "GET", path: "/profile", minScope: "read-only" },
  { method: "GET", path: "/doctor", minScope: "read-only" },
  { method: "GET", path: "/client-info", minScope: "read-only" },
  { method: "GET", path: "/cleanup-proposals", minScope: "read-only" },
  { method: "GET", path: "/api/cleanup-candidates", minScope: "read-only" },
  { method: "GET", path: "/ingest/status/:requestId", paramKind: "uuid", minScope: "read-only" },
  { method: "GET", path: "/memories/:id", paramKind: "numeric", minScope: "read-only" },
  { method: "GET", path: "/memories/:id/revisions", paramKind: "numeric", minScope: "read-only" },
  { method: "GET", path: "/cleanup-proposals/:id", paramKind: "segment", minScope: "read-only" },
  { method: "GET", path: "/api/cleanup-runs/availability", minScope: "read-only" },
  { method: "GET", path: "/api/cleanup-runs/:id", paramKind: "segment", minScope: "read-only" },
  { method: "GET", path: "/api/entity-register/records", minScope: "read-only" },

  // ---- read-only 이상 (쓰기 POST — 조회성 연산) -------------------------
  { method: "POST", path: "/search", minScope: "read-only" },
  { method: "POST", path: "/memories/batch-get", minScope: "read-only" },
  { method: "POST", path: "/compute", minScope: "read-only" },

  // ---- mcp-standard 이상 (읽기 GET/HEAD) --------------------------------
  { method: "GET", path: "/events/stream", minScope: "mcp-standard" },
  { method: "GET", path: "/settings", minScope: "mcp-standard" },
  { method: "GET", path: "/settings/schema", minScope: "mcp-standard" },
  {
    method: "GET",
    path: "/federation/apps/:adapterId/settings",
    paramKind: "segment",
    minScope: "mcp-standard",
    selfAdapterOnly: true,
  },
  { method: "GET", path: "/thumbs/:sha", paramKind: "sha256", minScope: "mcp-standard" },
  { method: "GET", path: "/assets/:sha", paramKind: "sha256", minScope: "mcp-standard" },

  // ---- mcp-standard 이상 (쓰기 POST) -------------------------------------
  { method: "POST", path: "/memories", minScope: "mcp-standard" },
  { method: "POST", path: "/ingest", minScope: "mcp-standard" },
  { method: "POST", path: "/memories/from-text", minScope: "mcp-standard" },
  { method: "POST", path: "/cleanup-proposals", minScope: "mcp-standard" },
  { method: "POST", path: "/api/cleanup-candidates/no-finding", minScope: "mcp-standard" },
  { method: "POST", path: "/memories/:id/append", paramKind: "numeric", minScope: "mcp-standard" },
  { method: "POST", path: "/memories/:id/tags", paramKind: "numeric", minScope: "mcp-standard" },

  // ---- mcp-standard 이상 (쓰기 PATCH) ------------------------------------
  { method: "PATCH", path: "/memories/by-source", minScope: "mcp-standard" },
  { method: "PATCH", path: "/memories/:id", paramKind: "numeric", minScope: "mcp-standard" },
] as const;

/** Hono 라우트 문법(`:param`)의 파라미터 구간을 paramKind 양식 정규식으로 바꾼 뒤 앵커. */
function toPathMatcher(route: ScopedHttpRoute): RegExp {
  if (!route.path.includes(":")) {
    // 파라미터 없는 정확 경로 — 리터럴 그대로 앵커(정규식 특수문자 없음, 경로는
    // 모두 `/`·영숫자·`-` 로만 구성돼 이스케이프가 필요 없다).
    return new RegExp(`^${route.path}$`);
  }
  const kind = route.paramKind;
  if (!kind) {
    throw new Error(
      `ScopedHttpRoute '${route.method} ${route.path}' 에 파라미터가 있으나 paramKind 가 없다.`,
    );
  }
  const pattern = route.path.replace(/:[A-Za-z_]+/g, PARAM_KIND_SOURCE[kind]);
  return new RegExp(`^${pattern}$`);
}

/** 위 toPathMatcher 결과를 표 항목별로 1회만 계산해 재사용(요청마다 재컴파일 방지). */
const ROUTE_MATCHERS: readonly { route: ScopedHttpRoute; matcher: RegExp }[] =
  SCOPED_HTTP_ROUTES.map((route) => ({ route, matcher: toPathMatcher(route) }));

/**
 * selfAdapterOnly 표 항목에서 :adapterId 파라미터가 차지하는 구간을 실제 요청
 * 경로에서 뽑아 호출자 adapterId 와 비교한다. path 는 이미 toPathMatcher 로
 * 매치가 확인된 뒤에만 호출된다.
 */
function selfAdapterMatches(route: ScopedHttpRoute, path: string, adapterId: string): boolean {
  const paramNameMatch = /:([A-Za-z_]+)/.exec(route.path);
  if (!paramNameMatch) return false;
  const [prefix, suffix] = route.path.split(paramNameMatch[0]!) as [string, string];
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  const captured = path.slice(prefix.length, path.length - suffix.length);
  return captured === adapterId;
}

/**
 * 제한 토큰(read-only·mcp-standard)이 이 REST 요청을 쓸 수 있는지 판정한다.
 * full 은 항상 true(표를 거치지 않는다 — 기존 동작 유지).
 *
 * GET 요청은 HEAD 로도 같은 판정을 받는다(canUseHttp 의 기존 readMethod 관례).
 *
 * 표에 없는 (method, path) 조합은 거부(기본 거부 유지, SA-13 완료 기준).
 */
export function canUseScopedHttp(
  scope: TokenScope,
  method: string,
  path: string,
  adapterId: string,
): boolean {
  if (scope === "full") return true;
  const effectiveMethod = method === "HEAD" ? "GET" : method;
  for (const { route, matcher } of ROUTE_MATCHERS) {
    if (route.method !== effectiveMethod) continue;
    if (!matcher.test(path)) continue;
    if (SCOPE_RANK[scope] < SCOPE_RANK[route.minScope]) return false;
    if (route.selfAdapterOnly && !selfAdapterMatches(route, path, adapterId)) return false;
    return true;
  }
  return false;
}
