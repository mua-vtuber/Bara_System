/** New-install-only credential provisioning. Run before the memory server starts.
 * Usage: bun run src/client-token.ts --url http://127.0.0.1:3001/ --tokens-file ABSOLUTE_PATH --fresh
 * Recovery: replace --fresh with --read-existing only for an installer-owned file.
 * That mode reads both exact existing scopes without minting or modifying tokens.
 */
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";

export interface ClientTokens {
  clientToken: string;
  ownerToken: string;
  mcpUrl: string;
  dashboardUrl: string;
}

function validatedTarget(urlText: string, tokensFile: string): { url: URL; target: string } {
  const url = new URL(urlText);
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use a loopback HTTP(S) server root URL without credentials, query, or fragment");
  }
  if (!isAbsolute(tokensFile)) throw new Error("--tokens-file must be absolute");
  const target = resolve(tokensFile);
  return { url, target };
}

function tokenOutput(url: URL, clientToken: string, ownerToken: string): ClientTokens {
  const mcpUrl = new URL("/mcp", url).toString();
  const dashboard = new URL(url);
  dashboard.hash = new URLSearchParams({ "bara-token": ownerToken }).toString();
  return { clientToken, ownerToken, mcpUrl, dashboardUrl: dashboard.toString() };
}

/** Filesystem-authorized crash recovery; it never issues or changes a token. */
export function readExistingClientTokens(urlText: string, tokensFile: string): ClientTokens {
  const { url, target } = validatedTarget(urlText, tokensFile);
  if (!existsSync(target)) throw new Error("Token file does not exist");
  const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Existing token file is invalid");
  const file = parsed as { version?: unknown; tokens?: Record<string, unknown>; tokenMeta?: Record<string, { scope?: unknown }> };
  const clientToken = file.tokens?.pet;
  const ownerToken = file.tokens?.dashboard;
  if (file.version !== 2 || typeof clientToken !== "string" || !clientToken ||
      typeof ownerToken !== "string" || !ownerToken || clientToken === ownerToken ||
      file.tokenMeta?.pet?.scope !== "mcp-standard" || file.tokenMeta?.dashboard?.scope !== "full") {
    throw new Error("Existing token file lacks the required pet and dashboard scopes");
  }
  const store = new SseTokenStore(target);
  if (store.verifyToken(clientToken) !== "pet" || store.verifyToken(ownerToken) !== "dashboard" ||
      store.getTokenScope("pet") !== "mcp-standard" || store.getTokenScope("dashboard") !== "full") {
    throw new Error("Existing token file lacks the required pet and dashboard scopes");
  }
  return tokenOutput(url, clientToken, ownerToken);
}

export async function prepareClientTokens(urlText: string, tokensFile: string): Promise<ClientTokens> {
  const { url, target } = validatedTarget(urlText, tokensFile);
  if (existsSync(target)) throw new Error("Token file already exists; use enrollment for an existing installation");
  try {
    await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1000) });
    throw new Error("Target server is responding; stop and use enrollment");
  } catch (error) {
    if (error instanceof Error && error.message === "Target server is responding; stop and use enrollment") throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Could not confirm the target server is stopped");
    }
  }

  const temporary = join(dirname(target), `.pet-tokens-${randomBytes(12).toString("hex")}.json`);
  try {
    const store = new SseTokenStore(temporary);
    const clientToken = store.issueToken("pet", undefined, undefined, "mcp-standard");
    const ownerToken = store.issueToken("dashboard", undefined, undefined, "full");
    // Hard-link creation fails if the destination exists, including races.
    linkSync(temporary, target);
    return tokenOutput(url, clientToken, ownerToken);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
      url: { type: "string" }, "tokens-file": { type: "string" }, fresh: { type: "boolean" },
      "read-existing": { type: "boolean" },
    } });
    if (Boolean(values.fresh) === Boolean(values["read-existing"]) || !values.url || !values["tokens-file"]) {
      throw new Error("Usage: bun run src/client-token.ts --url <loopback root URL> --tokens-file <absolute path> (--fresh | --read-existing)");
    }
    const result = values.fresh
      ? await prepareClientTokens(values.url, values["tokens-file"])
      : readExistingClientTokens(values.url, values["tokens-file"]);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const known = new Set([
      "Token file already exists; use enrollment for an existing installation",
      "Token file does not exist",
      "Existing token file is invalid",
      "Existing token file lacks the required pet and dashboard scopes",
      "Target server is responding; stop and use enrollment",
      "Could not confirm the target server is stopped",
      "--tokens-file must be absolute",
      "Use a loopback HTTP(S) server root URL without credentials, query, or fragment",
      "Usage: bun run src/client-token.ts --url <loopback root URL> --tokens-file <absolute path> (--fresh | --read-existing)",
    ]);
    process.stderr.write((error instanceof Error && known.has(error.message)
      ? error.message : "Client token preparation failed; check the target directory and URL") + "\n");
    process.exitCode = 1;
  }
}
