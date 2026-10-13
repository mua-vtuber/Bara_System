/**
 * App Federation Routes (Phase 5.5 / spec section 6.1)
 *
 * `GET /federation/apps` — 등록된 어댑터 목록 + 각 어댑터의 health 상태 반환.
 * 대시보드 설정 페이지의 탭 노출이 이 API 응답을 활용한다.
 *
 * Phase 5.5.7 추가 (spec section 5):
 * `GET /federation/apps/:id/schema`        — 어댑터 settings schema forward
 * `GET /federation/apps/:id/settings`      — 어댑터 settings 조회 forward
 * `PUT /federation/apps/:id/settings`      — 어댑터 settings 저장 forward
 * `POST /federation/apps/:id/actions/:actionId` — 어댑터 action forward
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { FederationRegistry, RegisteredApp } from "./registry";
import {
  proxyFetch,
  TimeoutError,
  NetworkError,
  HttpError,
} from "./proxy-fetch";

// ---------------------------------------------------------------------------
// 코어→봇 프록시 hop 토큰 부착 (P1-통합 I4·I5·I6)
// ---------------------------------------------------------------------------

/**
 * federation 라우트 의존성 주입(P1-통합). 미지정 시 토큰 부착·424 판정 없음
 * (기존 무토큰 프록시 동작 — 라우트 단위 테스트 전용). 운영 배선(index.ts)은
 * adminTokenForAdapter 를 항상 주입한다.
 */
export interface FederationRoutesDeps {
  /**
   * 대상 어댑터의 로컬 관리 토큰 조회(I4). 코어→봇 hop 부착용. 발급된 관리 토큰이
   * 있으면 값, 없으면 null. 미지정 시 부착·424 판정 자체를 하지 않는다(하위 호환).
   * 코어는 이 토큰의 의미를 해석하지 않고 그대로 싣기만 한다(경계 유지).
   */
  adminTokenForAdapter?: (adapterId: string) => string | null;
  /**
   * proxyFetch 가 쓸 fetch 구현체 주입(테스트 전용). 미지정 시 전역 fetch.
   * 통합 테스트가 봇 Hono app.request 를 감싼 함수를 넣어 실 봇 게이트를 통과시킨다.
   */
  proxyFetchImpl?: typeof fetch;
}

/**
 * 봇 upstream 경로가 봇 admin-gate 의 인증을 요구하는지 판정한다(순수 함수).
 *
 * 봇 `apps/bot-discord/src/http-admin-gate.ts` 의 `isUnauthenticatedPath(method, path)`
 * 와 **대칭**이어야 한다 — 봇은 `method === "GET"` 이면서 경로가 /health 또는
 * /settings/schema 일 때만 무인증 허용하고, GET 이 아니면 경로와 무관하게 인증을
 * 요구한다. 코어도 같은 규칙을 써야 두 판정이 어긋나지 않는다(spec § 약점 I-2 / P3
 * G4-b): 봇이 GET 만 무인증으로 여는 경로에 코어가 비-GET forward 를 보내면서 path
 * 만 보고 "무인증"으로 판정해 토큰을 빠뜨리면 봇 게이트가 401 을 낸다(드리프트).
 * 반대(과부착)는 무해하지만 비대칭 자체가 미래 드리프트의 씨앗이라 method 를 함께
 * 본다. 봇 게이트를 바꾸면 여기도 함께 바꾸고 routes.test.ts 의 대칭 fixture 를
 * 갱신하라. 이 중복은 P3(계약 단일출처)에서 봇 manifest 가 "인증 필요 경로"를
 * 선언하는 방식으로 수렴 후보.
 *
 * strict:false 라우터라 trailing slash 도 같은 경로로 본다 — 봇 판정과 같은 톤으로
 * 정규화한다.
 */
export function needsAdapterAuth(method: string, upstreamPath: string): boolean {
  // 봇 게이트와 대칭: GET 이 아니면 경로 무관하게 인증 필요(봇 isUnauthenticatedPath
  // 이 method !== "GET" 을 먼저 컷하는 것과 1:1).
  if (method !== "GET") {
    return true;
  }
  const normalized = upstreamPath.replace(/\/+$/, "") || "/";
  if (normalized === "/health" || normalized === "/settings/schema") {
    return false;
  }
  return true;
}

/** resolveAdapterAuthHeaders 결과 — 부착 헤더 또는 424 명시 실패. */
type AdapterAuthResolution =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; status: 424; body: { error: string } };

/**
 * upstream 경로·대상 어댑터에 대해 코어→봇 hop 의 Authorization 헤더를 결정한다.
 *
 * - deps 미지정: 부착·판정 없음(하위 호환) → 빈 헤더.
 * - 봇 무인증 경로(needsAdapterAuth=false): 부착 안 함 → 빈 헤더(등록 전에도 통과).
 * - 봇 게이트 경로 + 관리 토큰 있음: `Authorization: Bearer <token>` 부착.
 * - 봇 게이트 경로 + 관리 토큰 없음: 424 명시 실패(봇에 안 보냄, I6). 무토큰
 *   부착으로 게이트를 우회하거나 봇 401 을 세탁하지 않는다.
 *
 * P3 G4-b — 봇 게이트가 method+path 로 판정하므로 코어도 실제 forward method 를
 * 함께 넘긴다(봇 isUnauthenticatedPath 와 대칭). GET /settings 는 무인증 오판 없이
 * 봇 게이트 대상으로 정확히 잡힌다.
 */
function resolveAdapterAuthHeaders(
  deps: FederationRoutesDeps | undefined,
  adapterId: string,
  method: string,
  upstreamPath: string,
): AdapterAuthResolution {
  if (!deps?.adminTokenForAdapter || !needsAdapterAuth(method, upstreamPath)) {
    return { ok: true, headers: {} };
  }
  const adminToken = deps.adminTokenForAdapter(adapterId);
  if (adminToken === null) {
    return {
      ok: false,
      status: 424,
      body: {
        error:
          `어댑터 '${adapterId}' 관리 토큰이 아직 등록되지 않았습니다 — ` +
          `봇을 재시작해 재등록하세요.`,
      },
    };
  }
  // Authorization 헤더 값(관리 토큰)은 로그에 남기지 말 것(spec § 약점 I-6).
  return { ok: true, headers: { authorization: `Bearer ${adminToken}` } };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** actions 항목에 path 포함 (Phase 5.5.7 — 대시보드 통로 URL 생성용). */
export interface FederationAppActionDTO {
  id: string;
  label: string;
  method: "GET" | "POST";
  path: string;
  returns: "toast" | "enum" | "redirect";
  needsConfirm: boolean;
}

/** manifest.settings 항목 (Phase 5.5.7 — 대시보드 통로 URL 생성용). */
export interface FederationAppSettingsDTO {
  schemaPath: string;
  getPath: string;
  putPath: string;
}

export interface FederationAppDTO {
  id: string;
  name: string;
  version: string;
  manifestVersion: number;
  endpoint: string;
  health: "ok" | "down" | "unknown";
  lastHealthCheckAt: number;
  lastHealthLatencyMs: number;
  icon?: string;
  description?: string;
  tags?: string[];
  settings: FederationAppSettingsDTO;
  actions: FederationAppActionDTO[];
}

function toDTO(app: RegisteredApp): FederationAppDTO {
  const m = app.manifest;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    manifestVersion: m.manifestVersion,
    endpoint: m.endpoint,
    health: app.health,
    lastHealthCheckAt: app.lastHealthCheckAt,
    lastHealthLatencyMs: app.lastHealthLatencyMs,
    icon: m.icon,
    description: m.description,
    tags: m.tags,
    settings: {
      schemaPath: m.settings.schemaPath,
      getPath: m.settings.getPath,
      putPath: m.settings.putPath,
    },
    actions: (m.actions ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      method: a.method,
      path: a.path,
      returns: a.returns,
      needsConfirm: a.needsConfirm ?? false,
    })),
  };
}

// ---------------------------------------------------------------------------
// 등록 + health 확인 helper
// ---------------------------------------------------------------------------

type LookupResult =
  | { ok: true; entry: RegisteredApp }
  | { ok: false; status: 404 | 503; body: { error: string } };

/**
 * 레지스트리에서 어댑터를 찾고 health 상태를 확인한다.
 * 미등록 → 404, health=down → 503, 그 외 → ok.
 */
function lookupHealthy(
  registry: FederationRegistry,
  id: string,
): LookupResult {
  const entry = registry.get(id);
  if (!entry) {
    return { ok: false, status: 404, body: { error: `App '${id}' 미등록` } };
  }
  if (entry.health === "down") {
    return {
      ok: false,
      status: 503,
      body: { error: `어댑터 '${id}' 연결 실패 — health 상태 down` },
    };
  }
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// proxy 응답 helper
// ---------------------------------------------------------------------------

/**
 * proxyFetch 에러를 Hono Response 로 변환.
 * TimeoutError / NetworkError → 503.
 * HttpError → 어댑터 응답 status + content-type 그대로 투과.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorToResponse(c: Context<any>, appId: string, err: unknown): Response {
  if (err instanceof TimeoutError) {
    return c.json(
      { error: `어댑터 '${appId}' 연결 실패 — 타임아웃 (30초 초과)` },
      503,
    );
  }
  if (err instanceof NetworkError) {
    return c.json(
      { error: `어댑터 '${appId}' 연결 실패 — ${err.message}` },
      503,
    );
  }
  if (err instanceof HttpError) {
    // 어댑터가 명시적으로 반환한 상태코드 + content-type 그대로 투과
    return new Response(err.body, {
      status: err.status,
      headers: err.contentType ? { "content-type": err.contentType } : {},
    });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return c.json({ error: `어댑터 '${appId}' 연결 실패 — ${detail}` }, 503);
}

// ---------------------------------------------------------------------------
// 라우트
// ---------------------------------------------------------------------------

export function createFederationRoutes(
  registry: FederationRegistry,
  deps?: FederationRoutesDeps,
): Hono {
  const app = new Hono();
  const proxyFetchImpl = deps?.proxyFetchImpl;

  // ── 기존 목록 / 상세 ────────────────────────────────────────────────────

  app.get("/apps", (c) => {
    const apps = registry.list().map(toDTO);
    return c.json({ apps });
  });

  app.get("/apps/:id", (c) => {
    const id = c.req.param("id");
    const entry = registry.get(id);
    if (!entry) {
      return c.json({ error: `App '${id}' 미등록` }, 404);
    }
    return c.json(toDTO(entry));
  });

  // ── Phase 5.5.7 통로 라우트 4개 ─────────────────────────────────────────

  /**
   * GET /apps/:id/schema
   * 어댑터 manifest.settings.schemaPath 로 forward.
   */
  app.get("/apps/:id/schema", async (c) => {
    const id = c.req.param("id");
    const lookup = lookupHealthy(registry, id);
    if (!lookup.ok) return c.json(lookup.body, lookup.status);
    const entry = lookup.entry;
    const url = `${entry.manifest.endpoint}${entry.manifest.settings.schemaPath}`;
    // schema 는 봇 무인증 경로 — 부착·424 없이 forward(등록 전에도 폼 노출).
    try {
      const result = await proxyFetch(url, { method: "GET", fetchImpl: proxyFetchImpl });
      return new Response(result.body, {
        status: result.status,
        headers: result.contentType
          ? { "content-type": result.contentType }
          : {},
      });
    } catch (err) {
      return errorToResponse(c, id, err);
    }
  });

  /**
   * GET /apps/:id/settings
   * 어댑터 manifest.settings.getPath 로 forward.
   */
  app.get("/apps/:id/settings", async (c) => {
    const id = c.req.param("id");
    const lookup = lookupHealthy(registry, id);
    if (!lookup.ok) return c.json(lookup.body, lookup.status);
    const entry = lookup.entry;
    const getPath = entry.manifest.settings.getPath;
    const url = `${entry.manifest.endpoint}${getPath}`;
    // GET /settings 는 봇 게이트 대상(ownerId 노출) — 관리 토큰 부착 또는 424.
    const auth = resolveAdapterAuthHeaders(deps, id, "GET", getPath);
    if (!auth.ok) return c.json(auth.body, auth.status);
    try {
      const result = await proxyFetch(url, {
        method: "GET",
        headers: auth.headers,
        fetchImpl: proxyFetchImpl,
      });
      return new Response(result.body, {
        status: result.status,
        headers: result.contentType
          ? { "content-type": result.contentType }
          : {},
      });
    } catch (err) {
      return errorToResponse(c, id, err);
    }
  });

  /**
   * PUT /apps/:id/settings
   * 어댑터 manifest.settings.putPath 로 body 그대로 forward.
   */
  app.put("/apps/:id/settings", async (c) => {
    const id = c.req.param("id");
    const lookup = lookupHealthy(registry, id);
    if (!lookup.ok) return c.json(lookup.body, lookup.status);
    const entry = lookup.entry;
    const putPath = entry.manifest.settings.putPath;
    const url = `${entry.manifest.endpoint}${putPath}`;
    // PUT /settings 는 봇 게이트 대상 — 관리 토큰 부착 또는 424. 봇에 body 를
    // 보내기 전에 로컬에서 판정한다(무토큰 부착·봇 401 세탁 금지).
    const auth = resolveAdapterAuthHeaders(deps, id, "PUT", putPath);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const body = await c.req.text();
    try {
      const result = await proxyFetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json", ...auth.headers },
        body,
        fetchImpl: proxyFetchImpl,
      });
      return new Response(result.body, {
        status: result.status,
        headers: result.contentType
          ? { "content-type": result.contentType }
          : {},
      });
    } catch (err) {
      return errorToResponse(c, id, err);
    }
  });

  // ── 액션 forward helper (GET + POST 공용) ──────────────────────────────────

  /**
   * 액션 forward 핵심 로직.
   *
   * 1) lookupHealthy — 미등록·down 차단.
   * 2) actionId 매핑 — 미등록 액션 → 404.
   * 3) 클라이언트 method ↔ manifest method 정합 검증 — 불일치 → 405 명시 에러.
   * 4) manifest method + path 로 upstream forward.
   *
   * GET + POST 두 라우트가 모두 이 함수를 호출하므로,
   * 클라이언트 method 는 `c.req.method` 로 확인한다.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleActionForward(c: Context<any>): Promise<Response> {
    const id = c.req.param("id") as string;
    const actionId = c.req.param("actionId") as string;

    const lookup = lookupHealthy(registry, id);
    if (!lookup.ok) return c.json(lookup.body, lookup.status);
    const entry = lookup.entry;

    const action = (entry.manifest.actions ?? []).find(
      (a) => a.id === actionId,
    );
    if (!action) {
      return c.json(
        { error: `App '${id}' 액션 '${actionId}' 미등록` },
        404,
      );
    }

    // 클라이언트 method 와 manifest method 정합 검증 — silent mismatch 금지.
    const clientMethod = c.req.method;
    if (clientMethod !== action.method) {
      return c.json(
        {
          error:
            `App '${id}' 액션 '${actionId}' method 불일치 — ` +
            `클라이언트 ${clientMethod}, manifest ${action.method}`,
        },
        405,
      );
    }

    const url = `${entry.manifest.endpoint}${action.path}`;
    // /actions/* 는 봇 게이트 대상 — 관리 토큰 부착 또는 424. method 정합(405)
    // 이후, 봇에 보내기 전에 판정한다(무토큰 부착·봇 401 세탁 금지). 봇으로 실제
    // forward 하는 method 는 manifest method(action.method) — 봇 게이트가 method+path
    // 로 판정하므로 그 값을 넘긴다(G4-b 대칭).
    const auth = resolveAdapterAuthHeaders(deps, id, action.method, action.path);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const body = action.method === "POST" ? await c.req.text() : null;

    try {
      const result = await proxyFetch(url, {
        method: action.method,
        headers:
          body !== null
            ? { "content-type": "application/json", ...auth.headers }
            : { ...auth.headers },
        body,
        fetchImpl: proxyFetchImpl,
      });
      return new Response(result.body, {
        status: result.status,
        headers: result.contentType
          ? { "content-type": result.contentType }
          : {},
      });
    } catch (err) {
      return errorToResponse(c, id, err);
    }
  }

  /**
   * GET /apps/:id/actions/:actionId
   * manifest method=GET 인 액션 forward — list-channels / list-ollama-models 등.
   */
  app.get("/apps/:id/actions/:actionId", handleActionForward);

  /**
   * POST /apps/:id/actions/:actionId
   * manifest method=POST 인 액션 forward — verify-token 등.
   */
  app.post("/apps/:id/actions/:actionId", handleActionForward);

  return app;
}
