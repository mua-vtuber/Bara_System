/**
 * 인증 게이트 미들웨어 (보안 Phase 1 Task 4)
 *
 * 권위: docs/decisions/2026-06-07-security-input-limits-core-auth-spec.md
 *       docs/decisions/2026-06-07-security-phase1-input-limits-token-gate-plan.md (Task 4)
 *
 * 모든 요청은 아래 로직을 통과한다.
 * 1. 공개 부트스트랩 경로(/adapter-enroll/*) → 토큰 없이 통과. 실제 발급은 대시보드 승인 뒤 pickup 으로만 된다.
 * 2. 대시보드 SSE 토큰 발급 경로(/dashboard/sse-token) → full 토큰 + loopback 주소만 허용.
 * 3. 허용 목록 경로(/health, /adapter-enroll/*, /, /web/*) → 토큰 없이 통과.
 * 4. 그 외 → Authorization: Bearer <token> 필수. verifyToken 반환값이 null이면 401.
 *    예외: SSE 스트림 경로(/events/stream)와 이미지 자산 경로(/thumbs/{sha}·
 *    /assets/{sha})는 Bearer 헤더가 없을 때 query(?token=)도 인증 토큰으로 받는다
 *    (브라우저 EventSource·<img src> 둘 다 커스텀 헤더를 못 붙이는 같은 제약).
 *    Bearer 헤더가 있으면 헤더가 우선이고, query 폴백은 이 둘로만 좁힌다 — 다른
 *    보호 경로는 그대로 Bearer 필수다. 이미지 폴백은 sha256 정확 양식 경로에만
 *    걸려 prefix 하위 다른 경로로 새지 않는다.
 *
 * 보안 요건: 토큰 값은 401 응답 본문·로그 어디에도 들어가지 않는다.
 */

import type { MiddlewareHandler } from "hono";
import type { SseTokenStore, TokenScope } from "../federation/sse-tokens.ts";
import { canUseScopedHttp } from "../federation/token-scope.ts";
import { canUseMcpTool } from "../mcp/access.ts";
import { SHA256_HEX_RE } from "./http-helpers.ts";
import { isPublicPath } from "./auth-gate-public-paths.ts";
import { createBodyLimit } from "./body-limit.ts";

/**
 * 인증된 adapterId를 MCP와 REST의 공통 근거 기록에 전달한다. 이름은 호환성을 위해
 * 유지하며, 저장 클라이언트의 자기신고 author와 검증된 호출자 신원을 구분한다.
 */
export const MCP_ADAPTER_ID_VAR = "mcpAdapterId" as const;
export const MCP_TOKEN_SCOPE_VAR = "mcpTokenScope" as const;

/** 같은 origin 대시보드가 쓰는 소유자 토큰의 adapterId. 소유자 전용 라우트(토큰 관리·SSE 토큰·서버 재시작)가 호출자 확인에 쓰는 단일 출처. */
export const DASHBOARD_ADAPTER_ID = "dashboard";

/**
 * Hono 전역 ContextVariableMap 보강 — c.get/c.set 이 제네릭 Env 지정 없이도
 * MCP_ADAPTER_ID_VAR 키를 string | undefined 로 타입 검사하도록 등록한다.
 * (Hono Context.get/set 은 제네릭 E['Variables'] 와 전역 ContextVariableMap
 * 둘 중 하나에 키가 있어야 통과 — 여기서 후자에 등록한다.)
 */
declare module "hono" {
  interface ContextVariableMap {
    [MCP_ADAPTER_ID_VAR]: string | undefined;
    [MCP_TOKEN_SCOPE_VAR]: TokenScope | undefined;
  }
}

/**
 * 허용 목록 경로 판별. P3 G4-c — 공개 경로 계약을 auth-gate-public-paths.ts 단일
 * 출처로 옮기고 여기서는 그 판정 함수를 참조만 한다(순수 리팩터 — 옛 리터럴 판정과
 * byte 동일). 부팅 시 verifyPublicPathRegistration 이 이 목록과 등록 라우트를 대조해
 * 손동기화 드리프트를 잡는다.
 */
function isAllowlisted(path: string): boolean {
  return isPublicPath(path);
}

/** 대시보드 SSE 토큰 발급 경로 판별. 새 어댑터는 /adapter-enroll 승인 큐를 쓴다. */
function isIssuePath(path: string): boolean {
  return path === "/dashboard/sse-token";
}

/**
 * SSE 스트림 구독 경로. 이 경로만 query(?token=) 토큰 폴백을 추가로 받는다.
 *
 * 브라우저 EventSource API 는 커스텀 헤더(Authorization)를 못 붙이고 URL query 로만
 * 인증할 수 있다. 그래서 routes/events.ts 의 extractToken 이 헤더(Bearer) 없으면
 * query(?token=)를 받도록 이미 의도적으로 통로를 열어 뒀다(events.ts L84~100 주석).
 * 전역 게이트도 같은 경로에 한해 같은 폴백을 허용하지 않으면, 게이트가 먼저 401 로
 * 막아 라우트의 query 통로에 닿지 못한다. 폴백을 *이 경로 하나로만* 좁혀 다른 보호
 * 경로의 Bearer 필수가 약해지지 않게 한다.
 *
 * query token 이 URL 에 남는 한계(접근 로그·Referer 노출)는 SSE 표준 제약이라
 * 불가피하며, events.ts 가 이미 같은 이유로 의도적으로 연 통로다(같은 파일 TLS
 * 통로 한정 주석 — 127.0.0.1 바인딩 + TLS 터널 전제 위에서 토큰을 구독 식별용으로
 * 쓴다). 정확한 경로 일치만 인정한다(prefix·하위 경로로 폴백을 넓히지 않는다).
 */
function isSseStreamPath(path: string): boolean {
  return path === "/events/stream";
}

/**
 * 이미지 자산 경로. `/thumbs/{sha256}`·`/assets/{sha256}` 정확 양식만 query(?token=)
 * 폴백을 추가로 받는다. SSE 스트림 폴백과 대칭인 이유·트레이드오프는 위 isSseStreamPath
 * 주석과 같다 — `<img src>` 는 EventSource 와 마찬가지로 Authorization 헤더를 못 붙이고
 * URL query 로만 인증할 수 있다.
 *
 * 경로 판별을 sha256 정확 양식(`SHA256_HEX_RE` — assets 라우트와 단일 출처 공유)으로
 * 좁힌다. `/thumbs/`·`/assets/` prefix 전체가 아니라 64 자 소문자 hex 가 붙은 경로만
 * 폴백을 허용해, 미래에 그 prefix 아래 다른 경로가 생겨도 폴백이 새지 않게 한다(SSE 가
 * 정확 일치만 인정한 정신 계승). Bearer 헤더가 있으면 그대로 헤더가 우선이다.
 */
const IMAGE_ASSET_PATH_RE = new RegExp(
  `^/(thumbs|assets)/${SHA256_HEX_RE.source.replace(/^\^|\$$/g, "")}$`,
);
function isImageAssetPath(path: string): boolean {
  return IMAGE_ASSET_PATH_RE.test(path);
}

/**
 * 보호 경로의 요청에서 인증 토큰을 추출한다. Authorization: Bearer 헤더가 우선이고,
 * allowQueryToken 이 true 인 경로(SSE 스트림·이미지 자산)에 한해 헤더가 없을 때
 * query(?token=)를 폴백으로 받는다. 폴백을 켤지는 호출부가 경로별로 정한다.
 * 토큰 값은 반환만 하고 응답·로그 어디에도 넣지 않는다(보안 요건).
 */
function extractGateToken(
  c: Parameters<MiddlewareHandler>[0],
  allowQueryToken: boolean,
): string {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  if (allowQueryToken) {
    const queryToken = c.req.query("token");
    if (queryToken && queryToken.length > 0) {
      return queryToken;
    }
  }
  return "";
}

/** loopback 주소 판별. */
function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function permissionPath(path: string): string | null {
  // Do not grant access when routing interpretations could differ. Hono's
  // strict:false trailing slash is the only alternate spelling we accept.
  if (/[\\%\u0000-\u001f]/u.test(path) || path.includes("//")) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function canUseRpc(scope: TokenScope, value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => canUseRpc(scope, item));
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (["initialize", "ping", "tools/list", "notifications/initialized", "notifications/cancelled", "notifications/progress"].includes(String(message.method))) return true;
  if (message.method !== "tools/call" || !message.params || typeof message.params !== "object") return false;
  const name = (message.params as Record<string, unknown>).name;
  return typeof name === "string" && canUseMcpTool(scope, name);
}

/** 게이트 생성에 필요한 의존 주입 인터페이스. */
export interface AuthGateDeps {
  sseTokens: SseTokenStore;
  /**
   * Auth precedes the general body limiter; bounds restricted RPC inspection too.
   * 필수(SA-12) — 옛 `?? MEMORY_DEFAULTS.security.maxTextBytes` 조용한 대체값을
   * 없앤다. 호출부가 실제 설정값을 넘기지 않으면 컴파일이 막아 loud fail 한다
   * (silent 기본값으로 다른 한도가 조용히 적용되는 사고를 원천 차단).
   */
  getMcpBodyLimit: () => number;
  /** 요청에서 원격 IP 주소를 추출하는 함수. 프로덕션은 server.requestIP 연결, 테스트는 스텁 주입. */
  remoteAddrOf: (c: Parameters<MiddlewareHandler>[0]) => string | undefined;
}

/**
 * 인증 게이트 미들웨어를 생성한다.
 *
 * 의존성을 주입 받아 반환하는 Hono 미들웨어는 app.use("*", ...) 에 등록한다.
 */
export function createAuthGate(deps: AuthGateDeps): MiddlewareHandler {
  return async (c, next) => {
    const normalizedPath = permissionPath(c.req.path);
    const path = normalizedPath ?? c.req.path;
    const token = extractGateToken(c, isSseStreamPath(path) || isImageAssetPath(path));
    const adapterId = deps.sseTokens.verifyToken(token);
    const scope = adapterId === null ? undefined : deps.sseTokens.getTokenScope(adapterId);
    if (adapterId !== null) {
      c.set(MCP_ADAPTER_ID_VAR, adapterId);
      c.set(MCP_TOKEN_SCOPE_VAR, scope);
    }
    if (scope !== undefined && scope !== "full") {
      let allowed = false;
      if (normalizedPath !== null && !isIssuePath(path)) {
        if (path === "/mcp") {
          if (c.req.method === "POST") {
            const limit = deps.getMcpBodyLimit();
            const limited = await createBodyLimit(() => ({ maxTextBytes: limit, maxAssetBytes: limit }))(c, async () => {});
            if (limited) return limited;
            try {
              allowed = canUseRpc(scope, await c.req.raw.clone().json());
            } catch {
              return c.json({ code: "INVALID_INPUT", error: "Invalid MCP request body" }, 400);
            }
          } else {
            allowed = c.req.method === "GET" || c.req.method === "DELETE";
          }
        } else if (isAllowlisted(path)) {
          allowed = (c.req.method === "POST" && path === "/adapter-enroll") ||
            ((c.req.method === "GET" || c.req.method === "HEAD") &&
              (path === "/" || path === "/health" || path.startsWith("/web/") || /^\/adapter-enroll\/[^/]+\/token$/.test(path)));
        } else {
          allowed = canUseScopedHttp(scope, c.req.method, path, adapterId!);
        }
      }
      if (!allowed) return c.json({ code: "FORBIDDEN", error: "Token scope does not permit this operation." }, 403);
    }

    // Bootstrap is a filesystem-authorized local link. Loopback alone is not
    // authorization: SSH-forwarded restricted clients also appear local.
    if (isIssuePath(path)) {
      if (!isLoopback(deps.remoteAddrOf(c))) {
        return c.json({ error: "토큰 발급은 로컬에서만 가능합니다." }, 403);
      }
      if (adapterId === null) {
        return c.json({ error: "대시보드 인증 링크가 필요합니다. 서버에서 bun run dashboard:link --url <주소> --tokens-file <토큰 파일> 을 실행하세요." }, 401);
      }
      if (scope !== "full") return c.json({ error: "대시보드 토큰 발급에는 full 권한이 필요합니다." }, 403);
      await next();
      return;
    }

    // 허용 목록 경로 — 토큰 없이 통과.
    if (isAllowlisted(path)) {
      await next();
      return;
    }

    // 보호 경로 — 토큰 필수. Authorization: Bearer 헤더가 기본이고, SSE 스트림 경로
    // (/events/stream)와 이미지 자산 경로(/thumbs/{sha}·/assets/{sha})에 한해 헤더가
    // 없으면 query(?token=)도 받아들인다(브라우저 EventSource·<img src> 가 커스텀 헤더를
    // 못 붙이는 같은 제약 때문). 토큰 값은 응답·로그에 절대 넣지 않는다.
    if (adapterId === null) {
      return c.json({ error: "인증이 필요합니다." }, 401);
    }
    await next();
  };
}
