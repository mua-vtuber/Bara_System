/**
 * mcp/tools-guide.ts — 사용 안내 도구 get_usage_guide (2026-10-21 mcp-usage-and-guidance spec 12.1).
 *
 * 입력 없음. 안내 문안(usage-guide.ts, 토큰 scope 별) + 지금 쓰이는 분류 값·프로젝트 목록
 * (server-internal/classification-vocabulary.ts)을 돌려준다. 목록 조회가 실패하거나 저장소가
 * 주입되지 않았으면 도구 오류 INTERNAL — 빈 목록으로 가리지 않는다.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readClassificationVocabulary } from "../server-internal/classification-vocabulary.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { canUseMcpTool } from "./access.ts";
import { buildUsageGuideText } from "./usage-guide.ts";
import { toolError, toolJson, type McpToolContext } from "./server.ts";

export function registerGuideTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "get_usage_guide",
    {
      description: TOOL_DESCRIPTIONS.get_usage_guide,
      annotations: TOOL_ANNOTATIONS.get_usage_guide,
      inputSchema: {},
    },
    async () => {
      if (!canUseMcpTool(ctx.scope, "get_usage_guide")) return toolError("FORBIDDEN", "get_usage_guide is not allowed by this token");
      try {
        if (!ctx.deps.store) {
          throw new Error("deps.store 누락 — 분류 값·프로젝트 목록을 읽을 저장소가 주입되지 않았다");
        }
        const vocabulary = await readClassificationVocabulary(ctx.deps.store);
        return toolJson({ guide: buildUsageGuideText(ctx.scope), ...vocabulary });
      } catch (e) {
        return toolError("INTERNAL", `Usage guide failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
