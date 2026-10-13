/**
 * 어댑터 토큰 등록/관리 라우트.
 *
 * 공개 경로:
 * - POST /adapter-enroll: 어댑터가 토큰을 신청한다. requestedScope(선택)는 저장·표시만
 *   하고 권한을 주지 않는다. scope 칸은 거부한다(관리자만 지정).
 * - GET /adapter-enroll/:requestId/token?pickupSecret=...: 승인 후 토큰을 회수한다.
 *
 * 보호 경로:
 * - GET /adapter-tokens: 대시보드 관리 목록. requests[] 에 requestedScope 와
 *   existingAdapter({scope, legacyScope} | null), issued[] 에 scope·legacyScope.
 * - POST /adapter-tokens/:requestId/approve: 승인 + 토큰 발급. body(선택)
 *   { scope?, existingToken?: "share" | "rotate" } — sse-tokens.ts approveTokenRequest 참고.
 * - POST /adapter-tokens/:requestId/reject: 거절.
 * - PATCH /adapter-tokens/:adapterId/scope: 발급 토큰 권한 변경.
 * - DELETE /adapter-tokens/:adapterId: 발급 토큰 회수.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AdapterTokenRequestInput,
  SseTokenStore,
} from "../../federation/sse-tokens.ts";
import {
  EXISTING_TOKEN_CHOICES,
  isExistingTokenChoice,
  isTokenScope,
  TOKEN_SCOPES,
} from "../../federation/sse-tokens.ts";
import { DASHBOARD_ADAPTER_ID, MCP_TOKEN_SCOPE_VAR } from "../auth-gate.ts";

interface AdapterTokenRoutesDeps {
  sseTokens: SseTokenStore;
  remoteAddrOf?: (c: Context) => string | undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return asObject(await c.req.json());
  } catch {
    return null;
  }
}

function error(c: Context, status: 400 | 403 | 404 | 409, message: string): Response {
  return c.json({ error: message }, status);
}

export function createAdapterTokenRoutes(deps: AdapterTokenRoutesDeps): Hono {
  const app = new Hono({ strict: false });

  app.post("/adapter-enroll", async (c) => {
    const body = await readJsonObject(c);
    if (!body) return error(c, 400, "JSON 객체 body 필요");
    if ("scope" in body) return error(c, 400, "scope는 관리자만 지정할 수 있습니다.");
    const adapterId = optionalString(body, "adapterId");
    if (!adapterId) return error(c, 400, "adapterId 필요");
    const requestedScope = body.requestedScope;
    if (requestedScope !== undefined && !isTokenScope(requestedScope)) {
      return error(c, 400, `requestedScope는 ${TOKEN_SCOPES.join(", ")} 중 하나여야 합니다.`);
    }

    const input: AdapterTokenRequestInput = {
      adapterId,
      displayName: optionalString(body, "displayName"),
      description: optionalString(body, "description"),
      endpoint: optionalString(body, "endpoint"),
      remoteAddr: deps.remoteAddrOf?.(c) ?? "",
      // 이미 발급된 토큰 소유 증명. 같은 adapterId 로 검증될 때만 자동 승인에 쓰며
      // 저장·응답·목록에는 남기지 않는다.
      existingToken: optionalString(body, "existingToken"),
      // 봇 로컬 관리 토큰(P1-통합 I1) — 코어→봇 프록시 hop 부착용. store 가 승인
      // 흐름을 관통해 발급 메타에 보관한다. 값은 응답·목록·로그에 노출하지 않는다.
      adminToken: optionalString(body, "adminToken"),
      // 요청자가 필요하다고 밝힌 권한. 관리자 승인 화면 표시용이며 권한 부여에 쓰지 않는다.
      requestedScope,
    };

    try {
      const { request, pickupSecret } = deps.sseTokens.createTokenRequest(input);
      // 기존 토큰 소유를 증명한 재등록이면 store가 request.status를 approved로 만든다.
      // 그 경우 200 + status:"approved"
      // 로 응답해 봇이 즉시 pickup 하게 한다. 신규/불일치는 기존대로 202 pending.
      const approved = request.status === "approved";
      return c.json(
        {
          status: request.status,
          adapterId: request.adapterId,
          requestId: request.requestId,
          pickupSecret,
        },
        approved ? 200 : 202,
      );
    } catch (e) {
      return error(c, 400, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/adapter-enroll/:requestId/token", (c) => {
    const requestId = c.req.param("requestId");
    const pickupSecret = c.req.query("pickupSecret") ?? "";
    if (pickupSecret.length === 0) {
      return error(c, 400, "pickupSecret 필요");
    }

    const picked = deps.sseTokens.pickupApprovedToken(requestId, pickupSecret);
    if (picked === null) {
      return error(c, 404, "토큰 요청을 찾을 수 없거나 pickupSecret 이 맞지 않습니다.");
    }
    if (picked.status === "pending") {
      return c.json(
        { status: "pending", adapterId: picked.request.adapterId, requestId },
        202,
      );
    }
    if (picked.status === "rejected") {
      return error(c, 403, "어댑터 토큰 요청이 거절되었습니다.");
    }
    return c.json({
      status: "approved",
      adapterId: picked.request.adapterId,
      requestId,
      token: picked.token,
    });
  });

  app.get("/adapter-tokens", (c) => {
    // issued[] 는 store 가 scope·legacyScope(옛 토큰 = full)를 함께 준다. 토큰 값은 없다.
    const issued = deps.sseTokens
      .listIssuedTokens()
      .filter((entry) => entry.adapterId !== DASHBOARD_ADAPTER_ID);
    // requests[] 는 승인 전에 위험을 보이는 재료를 싣는다(SA-2): 요청자가 밝힌 권한과,
    // 같은 adapterId 에 이미 토큰이 있으면 그 권한·옛 토큰 여부(없으면 null = 새 어댑터).
    const requests = deps.sseTokens
      .listTokenRequests()
      .filter((entry) => entry.adapterId !== DASHBOARD_ADAPTER_ID)
      .map((entry) => ({
        ...entry,
        requestedScope: entry.requestedScope ?? null,
        existingAdapter: deps.sseTokens.getIssuedTokenScope(entry.adapterId),
      }));
    return c.json({ issued, requests });
  });

  app.patch("/adapter-tokens/:adapterId/scope", async (c) => {
    if (c.get(MCP_TOKEN_SCOPE_VAR) !== "full") return error(c, 403, "full 권한이 필요합니다.");
    const body = await readJsonObject(c);
    if (!body || !isTokenScope(body.scope)) return error(c, 400, "유효한 scope 필요");
    const adapterId = c.req.param("adapterId");
    if (adapterId === DASHBOARD_ADAPTER_ID && body.scope !== "full") {
      return error(c, 403, "대시보드 관리 권한은 낮출 수 없습니다.");
    }
    try {
      if (!deps.sseTokens.setTokenScope(adapterId, body.scope)) {
        return error(c, 404, "발급된 어댑터 토큰을 찾을 수 없습니다.");
      }
      return c.json({ adapterId, scope: body.scope });
    } catch (e) {
      return error(c, 400, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/adapter-tokens/:requestId/approve", async (c) => {
    const requestId = c.req.param("requestId");
    let body: Record<string, unknown> | null;
    try {
      const raw = await c.req.text();
      body = raw.trim() ? asObject(JSON.parse(raw)) : {};
    } catch {
      return error(c, 400, "JSON 객체 body 필요");
    }
    if (!body || (body.scope !== undefined && !isTokenScope(body.scope))) {
      return error(c, 400, "유효한 scope 필요");
    }
    if (body.scope !== undefined && c.get(MCP_TOKEN_SCOPE_VAR) !== "full") {
      return error(c, 403, "scope 지정에는 full 권한이 필요합니다.");
    }
    if (body.existingToken !== undefined && !isExistingTokenChoice(body.existingToken)) {
      return error(c, 400, `existingToken은 ${EXISTING_TOKEN_CHOICES.join(" 또는 ")}만 지정할 수 있습니다.`);
    }
    if (body.existingToken !== undefined && c.get(MCP_TOKEN_SCOPE_VAR) !== "full") {
      return error(c, 403, "기존 토큰 공유·교체 지정에는 full 권한이 필요합니다.");
    }
    try {
      const existing = deps.sseTokens.getTokenRequest(requestId);
      if (!existing) return error(c, 404, "어댑터 토큰 요청을 찾을 수 없습니다.");
      if (existing.adapterId === DASHBOARD_ADAPTER_ID) {
        return error(c, 409, "대시보드 토큰은 어댑터 관리에서 승인하지 않습니다.");
      }
      // existingToken 생략 = share(현행). 토큰이 없는 어댑터에 지정하면 store 가 throw → 409.
      const request = deps.sseTokens.approveTokenRequest(requestId, body.scope, body.existingToken);
      if (!request) return error(c, 404, "어댑터 토큰 요청을 찾을 수 없습니다.");
      return c.json({ approved: requestId, request });
    } catch (e) {
      return error(c, 409, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/adapter-tokens/:requestId/reject", (c) => {
    const requestId = c.req.param("requestId");
    const request = deps.sseTokens.rejectTokenRequest(requestId);
    if (!request) return error(c, 404, "어댑터 토큰 요청을 찾을 수 없습니다.");
    return c.json({ rejected: requestId, request });
  });

  app.delete("/adapter-tokens/:adapterId", (c) => {
    const adapterId = c.req.param("adapterId");
    if (adapterId === DASHBOARD_ADAPTER_ID) {
      return error(c, 403, "대시보드 토큰은 회수할 수 없습니다.");
    }
    try {
      const removed = deps.sseTokens.removeToken(adapterId);
      if (!removed) return error(c, 404, "발급된 어댑터 토큰을 찾을 수 없습니다.");
      return c.json({ revoked: adapterId });
    } catch (e) {
      return error(c, 400, e instanceof Error ? e.message : String(e));
    }
  });

  return app;
}

export function registerAdapterTokenRoutes(
  app: Hono,
  deps: AdapterTokenRoutesDeps,
): void {
  app.route("/", createAdapterTokenRoutes(deps));
}
