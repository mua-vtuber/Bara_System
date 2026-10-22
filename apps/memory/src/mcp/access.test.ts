import { describe, expect, test } from "bun:test";
import { assertMcpToolAccess, canUseMcpTool, McpAccessError } from "./access.ts";

describe("MCP token permissions", () => {
  test.each(["search_memory", "get_memory", "list_recent", "get_profile", "bara_doctor", "recall_context", "cleanup_list_candidates", "cleanup_run_status", "get_usage_guide"])("read-only allows %s", (name) => {
    expect(canUseMcpTool("read-only", name)).toBe(true);
  });
  test.each(["store_memory", "save_decision", "save_idea", "save_question", "save_preference", "update_memory", "supersede_memory", "retract_memory", "cleanup_submit_proposal", "cleanup_report_no_finding"])("only writable scopes allow %s", (name) => {
    expect(canUseMcpTool("read-only", name)).toBe(false);
    expect(canUseMcpTool("mcp-standard", name)).toBe(true);
    expect(canUseMcpTool("full", name)).toBe(true);
  });
  test.each(["delete_memory", "approve_cleanup", "reset_memory", "backup", "unknown_tool"])("restricted scopes deny unlisted tool %s", (name) => {
    expect(canUseMcpTool("read-only", name)).toBe(false);
    expect(canUseMcpTool("mcp-standard", name)).toBe(false);
    expect(canUseMcpTool(undefined, name)).toBe(true);
  });
  test("permission failures have a typed FORBIDDEN code", () => {
    try {
      assertMcpToolAccess("read-only", "retract_memory");
      throw new Error("denial expected");
    } catch (error) {
      expect(error).toBeInstanceOf(McpAccessError);
      expect((error as McpAccessError).code).toBe("FORBIDDEN");
    }
  });
});
