import { expect, test } from "bun:test";
import { HTTP_STATUS_FAILURE_CODES } from "../src/service/client.ts";
import { ServiceError } from "../src/service/errors.ts";
import { McpClient } from "../src/service/mcp.ts";
import { messages } from "../src/ui/messages.ts";

// WP-PFIX-14: the cleanup server's refusals of a request keep the codes `McpClient.rpc` has always given them:
// 401 and 403 use the memory-server client's `AUTH_REQUIRED` and `FORBIDDEN` (read from `HTTP_STATUS_FAILURE_CODES`
// now, no longer written as literals), any other status is `MCP_ERROR`. Each case runs the real client against a
// real loopback listener.
const text = messages.cleanupService.mcp;
const CASES: ReadonlyArray<readonly [number, string, string]> = [
  [401, "AUTH_REQUIRED", text.authRequired],
  [403, "FORBIDDEN", text.forbidden],
  [404, "MCP_ERROR", text.requestFailed(404)],
  [500, "MCP_ERROR", text.requestFailed(500)],
];

test("a cleanup server answer other than a success gets its code and its text together from the status", async () => {
  expect(HTTP_STATUS_FAILURE_CODES.authRequired).toBe("AUTH_REQUIRED");
  expect(HTTP_STATUS_FAILURE_CODES.forbidden).toBe("FORBIDDEN");
  for (const [status, code, message] of CASES) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status }) });
    try {
      const client = new McpClient(`http://127.0.0.1:${server.port}`, "scoped", new AbortController().signal, async () => {});
      const caught = await client.listTools().then(() => null, (error: unknown) => error);
      expect(caught).toBeInstanceOf(ServiceError);
      expect({ status, code: (caught as ServiceError).code, message: (caught as ServiceError).publicMessage }).toEqual({ status, code, message });
    } finally { server.stop(true); }
  }
});
