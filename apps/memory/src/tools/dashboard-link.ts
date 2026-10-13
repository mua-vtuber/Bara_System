import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { SseTokenStore, DEFAULT_SSE_TOKEN_PATH } from "../federation/sse-tokens.ts";

export interface DashboardLinkOptions { url: string; tokensFile: string }

/** Resolve relative paths in the server's working directory, just like index.ts. */
export function resolveDashboardLinkOptions(
  memoryDir: string,
  env: Record<string, string | undefined> = process.env,
): DashboardLinkOptions {
  const settingsPath = resolve(memoryDir, env.MEMORY_SETTINGS_PATH?.trim() || "data/memory-settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const port = Number(env.MEMORY_PORT ?? settings.db?.port ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("서버 포트 설정을 확인하세요.");
  const configuredHost = env.MEMORY_HOST?.trim() || settings.db?.host || "127.0.0.1";
  const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost === "::" ? "::1" : configuredHost;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`http://${authority}:${port}/`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("서버 주소 설정을 확인하세요.");
  if (settings.ui?.startPage === "graph") url.pathname = "/web/graph.html";
  return { url: url.toString(), tokensFile: resolve(memoryDir, env.SSE_TOKEN_PATH?.trim() || DEFAULT_SSE_TOKEN_PATH) };
}

/** Do not open a browser until the running instance accepts this on-disk capability. */
export async function waitForDashboardLink(
  options: DashboardLinkOptions,
  { timeoutMs = 180_000, pollMs = 500, signal }: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now())));
      const request = { redirect: "error" as const, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
      const health = await fetch(new URL("/health", options.url), request);
      if (health.ok) {
        const link = buildDashboardLink(options);
        const token = new URLSearchParams(new URL(link).hash.slice(1)).get("bara-token")!;
        const response = await fetch(new URL("/dashboard/sse-token", options.url), {
          ...request, headers: { authorization: `Bearer ${token}` },
        });
        if (response.ok && (await response.json() as { token?: unknown }).token === token) return link;
      }
    } catch { /* Startup/model loading may take minutes. Never log credentials or response bodies. */ }
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("대시보드 준비를 확인하지 못했습니다. 서버 시작 오류, 포트와 토큰 파일(SSE_TOKEN_PATH)을 확인한 뒤 다시 열어 주세요.");
}

/** Local filesystem access authorizes this capability. Never expose through HTTP. */
export function buildDashboardLink(options: DashboardLinkOptions): string {
  if (!options.tokensFile?.trim()) throw new Error("--tokens-file is required");
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) dashboard base URL without credentials, query or fragment");
  }
  const store = new SseTokenStore(resolve(options.tokensFile));
  const token = store.issueToken("dashboard", undefined, undefined, "full");
  url.hash = new URLSearchParams({ "bara-token": token }).toString();
  return url.toString();
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
      url: { type: "string" }, "tokens-file": { type: "string" },
      "memory-dir": { type: "string" }, settings: { type: "string" },
      wait: { type: "boolean", default: false },
    } });
    if (Boolean(values.url) !== Boolean(values["tokens-file"])) throw new Error("URL and token file must be supplied together");
    const options = values.url && values["tokens-file"]
      ? { url: values.url, tokensFile: values["tokens-file"] }
      : resolveDashboardLinkOptions(values["memory-dir"] || process.cwd(), { ...process.env, MEMORY_SETTINGS_PATH: values.settings || process.env.MEMORY_SETTINGS_PATH });
    process.stdout.write((values.wait ? await waitForDashboardLink(options) : buildDashboardLink(options)) + "\n");
  } catch {
    process.stderr.write("Dashboard link failed. Check server/settings/token paths. Use: bun run dashboard:link --settings <settings file> --wait, or --url <base URL> --tokens-file <server token file> --wait.\n");
    process.exitCode = 1;
  }
}
