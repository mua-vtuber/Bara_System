/**
 * server-internal/routes/profile.ts — GET /profile 라우트 등록기 (T25 / spec H).
 *
 * getProfile(server-internal/profile.ts) 를 그대로 재노출한다 — REST 재노출 원칙
 * (doctor.ts 선례) 그대로, 이 라우트는 HTTP 얇은 표면일 뿐 facet 분류 로직을 갖지
 * 않는다. MCP get_profile(tools-profile.ts) 도 같은 getProfile 을 불러 두 표면이
 * 항상 같은 facets 구성·note 문구를 낸다.
 *
 * facet 쿼리 파라미터는 닫힌 enum(cleanup-candidates.ts stage 선례) — 무효 값은
 * 조용히 무시하지 않고 400 으로 정직하게 되돌린다. get_profile 은 preference 를
 * 검색이 아니라 그대로 주입하는 표면이라, 오타를 "전 facet 회신"으로 조용히
 * 넓히면 호출자가 좁혀 받았다고 착각한다(spec H facet 계약과 동형 판단 —
 * responseMode 가 통과형 검색 칸들과 달리 닫힌 enum 을 쓰는 이유와 같다).
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { getProfile, PROFILE_FACETS, type ProfileFacet } from "../profile.ts";
import { parseMemoryReadScope } from "../../memory/shared-memory-contract.ts";

function isProfileFacet(value: string): value is ProfileFacet {
  return (PROFILE_FACETS as readonly string[]).includes(value);
}

export function registerProfileRoutes(app: Hono, deps: MemoryApiDeps): void {
  app.get("/profile", (c) => {
    const raw = c.req.query("facet");
    if (raw !== undefined && !isProfileFacet(raw)) {
      return err(c, 400, `미지원 facet '${raw}' — 유효 값: ${PROFILE_FACETS.join("/")}`);
    }
    try {
      const rawScope = c.req.query("scope");
      const scope = parseMemoryReadScope(rawScope === undefined ? undefined : JSON.parse(rawScope));
      const includeInactive = c.req.query("includeInactive");
      if (includeInactive !== undefined && includeInactive !== "true" && includeInactive !== "false") return err(c, 400, "includeInactive must be true or false");
      return c.json(getProfile(deps, { ...(raw ? { facet: raw } : {}), scope, includeInactive: includeInactive === "true" }));
    } catch (error) {
      return err(c, 400, `Invalid profile scope: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
