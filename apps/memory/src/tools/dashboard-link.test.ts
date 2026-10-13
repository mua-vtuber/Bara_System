import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { buildDashboardLink } from "./dashboard-link.ts";
import * as dashboardLinks from "./dashboard-link.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tokenPath() {
  const dir = mkdtempSync(join(tmpdir(), "bara-dashboard-link-"));
  dirs.push(dir);
  return join(dir, "tokens.json");
}
test("local token-store link contains full dashboard token only in fragment", () => {
  const path = tokenPath();
  const url = new URL(buildDashboardLink({ url: "http://localhost:3001/", tokensFile: path }));
  const token = new URLSearchParams(url.hash.slice(1)).get("bara-token")!;
  const store = new SseTokenStore(path);
  expect(store.verifyToken(token)).toBe("dashboard");
  expect(store.getTokenScope("dashboard")).toBe("full");
  expect(url.search).toBe("");
  expect(buildDashboardLink({ url: "http://localhost:3001/", tokensFile: path })).toBe(url.toString());
});
test("invalid URLs and missing token path are rejected before filesystem writes", () => {
  const path = tokenPath();
  for (const url of ["ftp://localhost/", "https://user:pass@localhost/", "https://localhost/?token=x", "https://localhost/#old"]) {
    expect(() => buildDashboardLink({ url, tokensFile: path })).toThrow();
  }
  expect(existsSync(path)).toBe(false);
  expect(() => buildDashboardLink({ url: "http://localhost:3001/", tokensFile: "" })).toThrow();
});

test("CLI reuses server-startup capability without requiring an in-memory reload", () => {
  const path = tokenPath();
  const runningServer = new SseTokenStore(path);
  const existing = runningServer.issueToken("dashboard", undefined, undefined, "full");
  const url = new URL(buildDashboardLink({ url: "http://localhost:3001/", tokensFile: path }));
  const picked = new URLSearchParams(url.hash.slice(1)).get("bara-token")!;
  expect(picked).toBe(existing);
  expect(runningServer.verifyToken(picked)).toBe("dashboard");
});

test("configured entry uses settings port, graph start page and the server token path", () => {
  const path = tokenPath();
  const dir = join(path, "..");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ db: { port: 4321, host: "0.0.0.0" }, ui: { startPage: "graph" } }));
  expect(typeof dashboardLinks.resolveDashboardLinkOptions).toBe("function");
  const options = dashboardLinks.resolveDashboardLinkOptions(dir, {
    MEMORY_SETTINGS_PATH: "settings.json", SSE_TOKEN_PATH: "custom/tokens.json",
  });
  expect(options.url).toBe("http://127.0.0.1:4321/web/graph.html");
  expect(options.tokensFile).toBe(join(dir, "custom", "tokens.json"));
  expect(dashboardLinks.resolveDashboardLinkOptions(dir, {
    MEMORY_SETTINGS_PATH: "settings.json", MEMORY_PORT: "4567", MEMORY_HOST: "::1",
  }).url).toBe("http://[::1]:4567/web/graph.html");
});

test("ready link waits for the real HTTP listener and verifies the file-backed capability", async () => {
  expect(typeof dashboardLinks.waitForDashboardLink).toBe("function");
  const path = tokenPath();
  const store = new SseTokenStore(path);
  const token = store.issueToken("dashboard", undefined, undefined, "full");
  let ready = false;
  let exchanges = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (!ready) return new Response("preparing", { status: 503 });
    if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
    exchanges++;
    return request.headers.get("authorization") === `Bearer ${token}`
      ? Response.json({ token }) : new Response("unauthorized", { status: 401 });
  } });
  const timer = setTimeout(() => { ready = true; }, 40);
  try {
    const url = await dashboardLinks.waitForDashboardLink({ url: `http://127.0.0.1:${server.port}/`, tokensFile: path }, { timeoutMs: 1000, pollMs: 10 });
    expect(new URLSearchParams(new URL(url).hash.slice(1)).get("bara-token")).toBe(token);
    expect(exchanges).toBe(1);
  } finally { clearTimeout(timer); server.stop(true); }
});

test("unready listener times out without issuing a token", async () => {
  expect(typeof dashboardLinks.waitForDashboardLink).toBe("function");
  const path = tokenPath();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not ready", { status: 503 }) });
  try {
    await expect(dashboardLinks.waitForDashboardLink({ url: `http://127.0.0.1:${server.port}/`, tokensFile: path }, { timeoutMs: 40, pollMs: 10 })).rejects.toThrow("준비");
    expect(existsSync(path)).toBe(false);
  } finally { server.stop(true); }
});

test("healthy listener that rejects the capability cannot open an authenticated dashboard", async () => {
  const path = tokenPath();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    return new URL(request.url).pathname === "/health" ? Response.json({ status: "ok" }) : new Response("unauthorized", { status: 401 });
  } });
  try {
    await expect(dashboardLinks.waitForDashboardLink({ url: `http://127.0.0.1:${server.port}/`, tokensFile: path }, { timeoutMs: 40, pollMs: 10 })).rejects.toThrow("토큰");
  } finally { server.stop(true); }
});

test("launcher CLI captures exactly one authenticated link using configured paths", async () => {
  const path = tokenPath();
  const store = new SseTokenStore(path);
  const token = store.issueToken("dashboard", undefined, undefined, "full");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
    return request.headers.get("authorization") === `Bearer ${token}`
      ? Response.json({ token }) : new Response("unauthorized", { status: 401 });
  } });
  const settingsPath = join(path, "..", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ db: { port: server.port, host: "127.0.0.1" }, ui: { startPage: "graph" } }));
  try {
    const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../../../setup/src/launch.ts"), "--local", "--link"], {
      env: { ...process.env, MEMORY_SETTINGS_PATH: settingsPath, SSE_TOKEN_PATH: path, MEMORY_PORT: String(server.port), MEMORY_HOST: "127.0.0.1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(new URL(stdout.trim()).pathname).toBe("/web/graph.html");
    expect(new URLSearchParams(new URL(stdout.trim()).hash.slice(1)).get("bara-token")).toBe(token);
    expect(stderr).not.toContain(token);
  } finally { server.stop(true); }
});
