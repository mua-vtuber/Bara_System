/**
 * mcp/tools-profile.ts — get_profile 도구 1종 (T25 / spec H, 14번째 도구).
 *
 * REST GET /profile(server-internal/routes/profile.ts)와 같은 내부 함수
 * getProfile 을 그대로 재노출한다 — 인자는 facet 하나뿐(선택), 읽기 전용, 쓰기 0.
 * facet 은 REST 쿼리 파라미터와 달리 zod 닫힌 enum 으로 검증한다 — MCP SDK
 * inputSchema 가 이미 등록 시점에 계약을 강제하므로, 여기서 유효하지 않은 값은
 * 애초에 도구 호출 스키마 자체가 거부한다(REST 쪽 라우트 수기 400 분기와 동형
 * 계약 — 오타를 조용히 "전 facet" 으로 넓히지 않는다).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProfile, PROFILE_FACETS } from "../server-internal/profile.ts";
import { memoryReadScopeSchema } from "../memory/shared-memory-contract.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { toolJson, toolError, type McpToolContext } from "./server.ts";
import { canUseMcpTool } from "./access.ts";

export function registerProfileTools(server: McpServer, ctx: McpToolContext): void {
  const { deps } = ctx;

  server.registerTool(
    "get_profile",
    {
      description: TOOL_DESCRIPTIONS.get_profile,
      annotations: TOOL_ANNOTATIONS.get_profile,
      inputSchema: {
        facet: z.enum(PROFILE_FACETS).optional(),
        scope: memoryReadScopeSchema.optional(),
        includeInactive: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "get_profile")) return toolError("FORBIDDEN", "Token scope does not permit get_profile");
      return toolJson(getProfile(deps, args));
    },
  );
}
