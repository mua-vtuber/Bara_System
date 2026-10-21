/**
 * mcp/tools-doctor.ts — bara_doctor 도구 1종 (T23 / spec E, 13번째 도구).
 *
 * REST GET /doctor(server-internal/routes/doctor.ts)와 같은 내부 함수 runDoctor 를
 * 그대로 재노출한다 — 인자 0개, 읽기 전용, 쓰기 0.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runDoctor } from "../server-internal/doctor.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { toolJson, toolError, type McpToolContext } from "./server.ts";
import { canUseMcpTool } from "./access.ts";

export function registerDoctorTools(server: McpServer, ctx: McpToolContext): void {
  const { deps } = ctx;

  server.registerTool(
    "bara_doctor",
    {
      description: TOOL_DESCRIPTIONS.bara_doctor,
      annotations: TOOL_ANNOTATIONS.bara_doctor,
      inputSchema: {},
    },
    async () => {
      if (!canUseMcpTool(ctx.scope, "bara_doctor")) return toolError("FORBIDDEN", "bara_doctor is not allowed by this token");
      try {
        return toolJson(runDoctor(deps));
      } catch (e) {
        // runDoctor 내부는 단계별 try-catch 로 예외를 흡수한다(각 단계가 unhealthy
        // 결과로 정직 변환) — 여기 닿는 예외는 그 흡수망 밖의 예상 밖 결함이다.
        return toolError(
          "INTERNAL",
          `Self-diagnosis failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
