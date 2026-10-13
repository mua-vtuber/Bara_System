import { registerHappyDom } from "./test-happy-dom.ts";
registerHappyDom();
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { apiFetch, getToken, _resetTokenCacheForTest } from "./api-fetch.ts";

const TOKEN = "test-bearer-token-xyz";
const ORIGINAL_FETCH = globalThis.fetch;
const KEY = "bara.dashboard.token";
let calls: Array<[string, RequestInit | undefined]>;

beforeEach(() => {
  _resetTokenCacheForTest();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    calls.push([path, init]);
    return new Response(path === "/dashboard/sse-token" ? JSON.stringify({ token: TOKEN }) : "ok", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  _resetTokenCacheForTest();
});

describe("authenticated dashboard bootstrap", () => {
  test("fragment is stored and removed before authenticated token exchange", async () => {
    window.history.replaceState(null, "", "/?view=home#bara-token=" + TOKEN + "&panel=graph");
    await apiFetch("/search");
    expect(window.location.hash).toBe("#panel=graph");
    expect(window.location.search).toBe("?view=home");
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(calls.map(call => call[0])).toEqual(["/dashboard/sse-token", "/search"]);
    for (const [, init] of calls) expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });
  test("cached session token survives module cache reset and exchange happens once", async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    await apiFetch("/search");
    await apiFetch("/memories");
    expect(calls.filter(call => call[0] === "/dashboard/sse-token")).toHaveLength(1);
    _resetTokenCacheForTest();
    expect(await getToken()).toBe(TOKEN);
  });
  test("missing token fails with dashboard:link guidance and sends no requests", async () => {
    await expect(apiFetch("/search")).rejects.toThrow("dashboard:link");
    await expect(apiFetch("/search")).rejects.toThrow("dashboard:link");
    expect(calls).toHaveLength(0);
  });
  test("invalid bootstrap token stops retries until a fresh fragment is supplied", async () => {
    window.sessionStorage.setItem(KEY, "expired-test-token");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init]);
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;
    await expect(getToken()).rejects.toThrow("dashboard:link");
    await expect(getToken()).rejects.toThrow("dashboard:link");
    expect(calls).toHaveLength(1);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    window.history.replaceState(null, "", "/#bara-token=" + TOKEN);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init]);
      return new Response(JSON.stringify({ token: TOKEN }), { status: 200 });
    }) as typeof fetch;
    expect(await getToken()).toBe(TOKEN);
    expect(calls).toHaveLength(2);
  });
  test("existing request headers and method are preserved", async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    await apiFetch("/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const init = calls[1]![1]!;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBe("POST");
  });
  test("temporary network failure preserves the valid session capability for a reload", async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(getToken()).rejects.toThrow("dashboard:link");
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
  });
});
