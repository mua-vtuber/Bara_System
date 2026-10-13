import { PET_VERSION } from "../shared/version.ts";
import { messages } from "../ui/messages.ts";
import { HTTP_STATUS_FAILURE_CODES } from "./client.ts";
import { isServiceErrorCode, ServiceError, serviceError } from "./errors.ts";
import { causeOf, classifyFetchFailure } from "./fetch-failure.ts";

export interface McpTool { name: string; inputSchema: Record<string, unknown> }
const MAX_MCP_RESPONSE = 2_000_000;
/** The MCP spec's own version string, unrelated to this Pet's release version (`PET_VERSION`). Kept as a
 * local constant only because it repeats three times below. */
const MCP_PROTOCOL_VERSION = "2025-06-18";
/** How long one request to the cleanup server may take, from sending it to reading its whole body. */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

/** The code of a cleanup tool failure that names no code of its own, or one with an unusable code. */
const MCP_TOOL_ERROR_CODE = "MCP_TOOL_ERROR";

/** The codes of a request to the cleanup server that produced no HTTP answer. They are the kinds of
 * `classifyFetchFailure` under an `MCP_` prefix, so the cleanup screen can say "cleanup server" in its
 * Korean text: a plain `NETWORK` or `TIMEOUT` may as well be the cleanup AI's own server. */
export const MCP_FAILURE_CODES = {
  network: "MCP_NETWORK", timeout: "MCP_TIMEOUT", redirect: "MCP_REDIRECT", unexpected: "MCP_REQUEST_UNEXPECTED",
} as const;

/** The `ServiceError` for a request that threw. Cancellation, a time limit that ran out, a refused redirect,
 * a connection that never answered and an answer that is not HTTP each say so; any other exception reports
 * its own cause (`causeOf`), because blaming the connection for a Pet defect hides what to fix. */
function mcpFailureError(error: unknown, signal: AbortSignal): ServiceError {
  const kind = classifyFetchFailure(error, signal);
  if (kind === "cancelled") return serviceError("CANCELLED", messages.cleanupService.cancelled);
  if (kind === "timeout") return serviceError(MCP_FAILURE_CODES.timeout, messages.cleanupService.mcp.timedOut);
  if (kind === "redirect") return serviceError(MCP_FAILURE_CODES.redirect, messages.cleanupService.mcp.redirected);
  if (kind === "network") return serviceError(MCP_FAILURE_CODES.network, messages.cleanupService.mcp.networkFailed);
  if (kind === "malformed") return serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseMalformed);
  return serviceError(MCP_FAILURE_CODES.unexpected, messages.cleanupService.mcp.requestUnexpected(causeOf(error)));
}

/** The `ServiceError` for a body read that threw after the answer began. The time limit, a cancellation and
 * an answer that turns out not to be HTTP keep their own texts (`mcpFailureError`); anything else, such as
 * the connection closing partway, is an unreadable answer that names its cause. */
function mcpBodyReadError(error: unknown, signal: AbortSignal): ServiceError {
  const kind = classifyFetchFailure(error, signal);
  return kind === "cancelled" || kind === "timeout" || kind === "malformed"
    ? mcpFailureError(error, signal) : serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseReadFailed(causeOf(error)));
}

/** The `ServiceError` for a cleanup server answer that is not a success, with its code and text chosen
 * together from the HTTP status. The two credential refusals use the memory-server client's codes
 * (`HTTP_STATUS_FAILURE_CODES`), so the cleanup screen reads them like the same refusals everywhere else. */
function mcpStatusError(status: number): ServiceError {
  const text = messages.cleanupService.mcp;
  if (status === 401) return serviceError(HTTP_STATUS_FAILURE_CODES.authRequired, text.authRequired);
  if (status === 403) return serviceError(HTTP_STATUS_FAILURE_CODES.forbidden, text.forbidden);
  return serviceError("MCP_ERROR", text.requestFailed(status));
}

export function parseMcpResponse(text: string, contentType: string, id: number): unknown {
  let frames: unknown[];
  try {
    frames = contentType.includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).flatMap((event) => {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
        })
      : [JSON.parse(text)];
  } catch { throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseUnreadable); }
  const envelope = frames.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
  if (!envelope || envelope.jsonrpc !== "2.0" || "error" in envelope || !("result" in envelope)) throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseUnconfirmed);
  return envelope.result;
}

/** The `ServiceError` for a cleanup tool that answered with `isError`. The server encodes a tool failure as
 * { code, message, details? } JSON in the result's text (apps/memory/src/mcp/server.ts toolError and
 * serializeToolError). Its real code and sentence are surfaced instead of one fixed sentence, so a caller can
 * tell DISABLED from FORBIDDEN from STALE_CANDIDATE, and an `INTERNAL` still says what failed.
 *
 * Both are the server's own words and both reach the cleanup screen (`code: sentence`), so both are checked
 * here. A code that does not have the shape of a service code is not shown: the failure is `MCP_TOOL_ERROR`.
 * The sentence goes through `causeOf` like every cause: read up to a bound, without characters that cannot be
 * shown, its addresses stripped of query string, fragment and user information. The sentence is kept as a
 * cause because it is the only thing that names a server-side failure (an `INTERNAL`'s sentence is the
 * server's own exception message). The server cannot put into it a secret it does not already hold; the one
 * it does hold, the bearer, is withheld by `causeOf` only in the shapes `isShowableText` knows. */
function toolFailure(text: string): ServiceError {
  const envelope = ((): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  })();
  const code = envelope?.code;
  const sentence = envelope?.message;
  return serviceError(isServiceErrorCode(code) ? code : MCP_TOOL_ERROR_CODE, causeOf(typeof sentence === "string" ? sentence : text));
}

function resultObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseUnreadable);
  return value as Record<string, unknown>;
}

/** Stateless MCP over HTTP. The host holds the bearer; CLI models never see it. `beforeRequest` is the
 * credential-route check (`MemoryClient.assertSendable`) and is required, so a new caller cannot send the
 * bearer to a listener the service has not verified; it runs before every request and a rejection stops
 * the request from being sent. */
export class McpClient {
  private id = 0;
  private initialized = false;
  private tools: McpTool[] | null = null;
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly signal: AbortSignal,
    private readonly beforeRequest: () => Promise<void>, private readonly timeoutMs = MCP_REQUEST_TIMEOUT_MS) {}

  private async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    await this.beforeRequest();
    let response: Response;
    try {
      response = await fetch(new URL("/mcp", this.baseUrl), { method: "POST", redirect: "error", signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
    } catch (error) { throw mcpFailureError(error, this.signal); }
    if (!response.ok) throw mcpStatusError(response.status);
    if (Number(response.headers.get("content-length")) > MAX_MCP_RESPONSE) throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseTooLarge);
    let text: string;
    // The same time limit and cancellation still apply while the body streams in.
    try { text = await response.text(); }
    catch (error) { throw mcpBodyReadError(error, this.signal); }
    if (text.length > MAX_MCP_RESPONSE) throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.responseTooLarge);
    return parseMcpResponse(text, response.headers.get("content-type") ?? "", id);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = resultObject(await this.rpc("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "bara-pet", version: PET_VERSION } }));
    if (result.protocolVersion !== MCP_PROTOCOL_VERSION || resultObject(result.serverInfo).name !== "bara-memory") throw serviceError("MCP_VERSION", messages.cleanupService.mcp.versionMismatch);
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    if (this.tools) return this.tools;
    const result = resultObject(await this.rpc("tools/list"));
    if (!Array.isArray(result.tools)) throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.toolListUnreadable);
    this.tools = result.tools.map((entry: unknown) => {
      const value = resultObject(entry);
      if (typeof value.name !== "string") throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.toolListUnreadable);
      return { name: value.name, inputSchema: resultObject(value.inputSchema) };
    });
    return this.tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tools = await this.listTools();
    if (!tools.some((tool) => tool.name === name)) throw serviceError("MCP_TOOL_MISSING", messages.cleanupService.mcp.toolMissing);
    const result = resultObject(await this.rpc("tools/call", { name, arguments: args }));
    if (!Array.isArray(result.content) || result.content.length === 0) {
      if (result.isError === true) throw serviceError(MCP_TOOL_ERROR_CODE, messages.cleanupService.mcp.toolError);
      throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.toolResponseEmpty);
    }
    const item = resultObject(result.content[0]);
    if (item.type !== "text" || typeof item.text !== "string") {
      if (result.isError === true) throw serviceError(MCP_TOOL_ERROR_CODE, messages.cleanupService.mcp.toolError);
      throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.toolResponseUnreadable);
    }
    if (result.isError === true) throw toolFailure(item.text);
    try { return resultObject(JSON.parse(item.text)); } catch { throw serviceError("MCP_RESPONSE", messages.cleanupService.mcp.toolJsonUnreadable); }
  }
}
