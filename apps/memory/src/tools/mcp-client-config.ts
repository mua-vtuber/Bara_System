/** Print secret-free client configuration; --check probes a server without writing memories. */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpClientConfigOptions {
  client: "codex" | "claude-code";
  url: string;
  tokenEnv?: string;
  name?: string;
}

function validated(options: McpClientConfigOptions) {
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) MCP URL without credentials, query parameters or fragments");
  }
  const tokenEnv = options.tokenEnv ?? "BARA_MCP_TOKEN";
  const name = options.name ?? "bara";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv) || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Invalid token environment variable or server name");
  }
  if (options.client !== "codex" && options.client !== "claude-code") throw new Error("client must be codex or claude-code");
  return { url: url.toString(), tokenEnv, name };
}

export function buildMcpClientConfig(options: McpClientConfigOptions): string {
  const { url, tokenEnv, name } = validated(options);
  if (options.client === "codex") {
    return `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(tokenEnv)}\n`;
  }
  return JSON.stringify({ mcpServers: { [name]: {
    type: "http", url, headers: { Authorization: `Bearer \${${tokenEnv}}` },
  } } }, null, 2) + "\n";
}

export async function checkMcpConnection(options: McpClientConfigOptions) {
  const { url, tokenEnv } = validated(options);
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`Set ${tokenEnv} before checking the connection`);
  const client = new Client({ name: "bara-connection-check", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "error" },
    }), { timeout: 10000 });
    const listed = await client.listTools({}, { timeout: 10000 });
    const names = listed.tools.map((tool) => tool.name);
    const required = ["search_memory", "get_memory", "get_profile", "recall_context"];
    const missing = required.filter((name) => !names.includes(name));
    const hasInstructions = Boolean(client.getInstructions());
    const failures: string[] = [];
    if (missing.length > 0) failures.push("missing_tools");
    if (!hasInstructions) failures.push("instructions_missing");
    if (failures.length > 0) return { ok: false, failures, toolCount: names.length, missing };
    const read = await client.callTool({ name: "recall_context", arguments: { budget: 0 } }, undefined, { timeout: 10000 });
    return { ok: read.isError !== true, toolCount: names.length, missing, instructions: hasInstructions };
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
      client: { type: "string", default: "codex" }, url: { type: "string" },
      "token-env": { type: "string", default: "BARA_MCP_TOKEN" }, name: { type: "string", default: "bara" },
      check: { type: "boolean", default: false },
    } });
    if (!values.url) throw new Error("--url is required");
    const options: McpClientConfigOptions = {
      client: values.client as McpClientConfigOptions["client"], url: values.url,
      tokenEnv: values["token-env"], name: values.name,
    };
    if (values.check) {
      const result = await checkMcpConnection(options);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.ok) process.exitCode = 1;
    } else process.stdout.write(buildMcpClientConfig(options));
  } catch {
    // Remote error bodies may echo credentials; do not print them.
    process.stderr.write("MCP configuration/check failed. Check URL, client, token environment and server availability.\n");
    process.exitCode = 1;
  }
}
