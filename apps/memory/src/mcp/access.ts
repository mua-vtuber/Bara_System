import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TokenScope } from "../federation/sse-tokens.ts";

const READ_TOOLS = new Set([
  "search_memory", "get_memory", "list_recent", "get_profile", "bara_doctor",
  "recall_context", "cleanup_list_candidates", "cleanup_run_status",
]);
const WRITE_TOOLS = new Set([
  "store_memory", "save_decision", "save_idea", "save_question", "save_preference",
  "update_memory", "supersede_memory", "retract_memory",
  "cleanup_submit_proposal", "cleanup_report_no_finding",
]);

/** Legacy direct contexts retain full access. Restricted scopes deny unknown tools. */
export function canUseMcpTool(scope: TokenScope | undefined, toolName: string): boolean {
  if (scope === undefined || scope === "full") return true;
  return READ_TOOLS.has(toolName) || (scope === "mcp-standard" && WRITE_TOOLS.has(toolName));
}

export class McpAccessError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(readonly scope: TokenScope, readonly toolName: string) {
    super(`Token scope '${scope}' does not permit '${toolName}'.`);
    this.name = "McpAccessError";
  }
}

export function assertMcpToolAccess(scope: TokenScope | undefined, toolName: string): void {
  if (!canUseMcpTool(scope, toolName)) throw new McpAccessError(scope!, toolName);
}

/**
 * McpServer subclass that disables a tool the moment `canUseMcpTool` refuses it, right after
 * registration (WP-B1-16 / SA-5). The seven registration functions (registerMemoryTools etc.)
 * keep calling `server.registerTool(...)` exactly as before, unaware of scope — only the
 * McpServer instance `buildBaraMcpServer` passes them is this subclass, so their signatures
 * never change.
 *
 * Disabling removes the tool from `tools/list` (the SDK filters by `enabled`) and makes
 * `tools/call` fail at the SDK layer too; the outer auth-gate's HTTP 403 on `tools/call`
 * (auth-gate.ts canUseRpc) and each tool callback's own `canUseMcpTool` check are separate,
 * independent layers and are not touched by this class.
 */
export class ScopedMcpServer extends McpServer {
  constructor(
    serverInfo: ConstructorParameters<typeof McpServer>[0],
    options: ConstructorParameters<typeof McpServer>[1],
    private readonly scope: TokenScope | undefined,
  ) {
    super(serverInfo, options);
  }

  override registerTool(
    name: string,
    config: Parameters<McpServer["registerTool"]>[1],
    cb: Parameters<McpServer["registerTool"]>[2],
  ): RegisteredTool {
    const registered = super.registerTool(name, config as never, cb as never);
    if (!canUseMcpTool(this.scope, name)) registered.disable();
    return registered;
  }
}
