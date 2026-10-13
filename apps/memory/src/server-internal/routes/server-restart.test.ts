import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import { createAuthGate, DASHBOARD_ADAPTER_ID } from "../auth-gate.ts";
import { PROCESS_BOOT_ID, RESTART_BUSY_REASON, RESTART_FORBIDDEN_MESSAGE, RESTART_ON_EXIT_ENV, RESTART_ON_EXIT_VALUE, RESTART_UNSUPPORTED_REASON } from "../restart-policy.ts";
import { registerServerRestartRoutes, SERVER_RESTART_PATH } from "./server-restart.ts";

let tmpDir: string;
let sseTokens: SseTokenStore;
let tokens: { dashboard: string; standard: string; readOnly: string; otherFull: string };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-restart-"));
  sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  tokens = {
    dashboard: sseTokens.issueToken(DASHBOARD_ADAPTER_ID, undefined, undefined, "full"),
    standard: sseTokens.issueToken("claude-code", undefined, undefined, "mcp-standard"),
    readOnly: sseTokens.issueToken("viewer", undefined, undefined, "read-only"),
    otherFull: sseTokens.issueToken("some-bot", undefined, undefined, "full"),
  };
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

const SUPPORTED_ENV = { [RESTART_ON_EXIT_ENV]: RESTART_ON_EXIT_VALUE };

/** 실제 auth-gate 뒤에 라우트를 마운트한다 (운영 server.ts/index.ts 의 outer/inner 구조와 같다). */
function makeApp(env: Record<string, string | undefined>, requestRestart?: () => void, backgroundWritersRunning?: () => boolean): Hono {
  const outer = new Hono({ strict: false });
  outer.use("*", createAuthGate({
    sseTokens,
    remoteAddrOf: () => "127.0.0.1",
    getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
  }));
  const inner = new Hono({ strict: false });
  registerServerRestartRoutes(inner, { requestRestart, backgroundWritersRunning }, { env, triggerDelayMs: 0 });
  outer.route("/", inner);
  return outer;
}

const send = (app: Hono, method: "GET" | "POST", token?: string) =>
  app.request(SERVER_RESTART_PATH, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("GET /server/restart", () => {
  test("대시보드 토큰 + 표시 없음 -> supported false, 이유, bootId", async () => {
    const res = await send(makeApp({}), "GET", tokens.dashboard);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supported: false, reason: RESTART_UNSUPPORTED_REASON, busy: false, busyReason: null, bootId: PROCESS_BOOT_ID });
  });

  test("대시보드 토큰 + 표시 있음 -> supported true, 이유 null", async () => {
    const res = await send(makeApp(SUPPORTED_ENV), "GET", tokens.dashboard);
    expect(await res.json()).toEqual({ supported: true, reason: null, busy: false, busyReason: null, bootId: PROCESS_BOOT_ID });
  });

  test("표시 값이 1 이 아니면 지원 아님", async () => {
    const res = await send(makeApp({ [RESTART_ON_EXIT_ENV]: "0" }), "GET", tokens.dashboard);
    expect(((await res.json()) as { supported: boolean }).supported).toBe(false);
  });

  test("백그라운드 쓰기 작업이 도는 중이면 busy true + 이유", async () => {
    const res = await send(makeApp(SUPPORTED_ENV, () => {}, () => true), "GET", tokens.dashboard);
    expect(await res.json()).toEqual({ supported: true, reason: null, busy: true, busyReason: RESTART_BUSY_REASON, bootId: PROCESS_BOOT_ID });
  });

  test("bootId 는 호출마다 같다", async () => {
    const app = makeApp({});
    const a = (await (await send(app, "GET", tokens.dashboard)).json()) as { bootId: string };
    const b = (await (await send(app, "GET", tokens.dashboard)).json()) as { bootId: string };
    expect(a.bootId).toBe(b.bootId);
    expect(a.bootId.length).toBeGreaterThan(0);
  });
});

describe("POST /server/restart", () => {
  test("표시 없음 -> 409 + 이유, 종료 함수 호출 안 함", async () => {
    const calls: string[] = [];
    const res = await send(makeApp({}, () => { calls.push("restart"); }), "POST", tokens.dashboard);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: RESTART_UNSUPPORTED_REASON });
    await tick();
    expect(calls).toEqual([]);
  });

  test("표시 있음 -> 202 + 응답을 받은 뒤에 종료 함수 호출", async () => {
    const calls: string[] = [];
    const res = await send(makeApp(SUPPORTED_ENV, () => { calls.push("restart"); }), "POST", tokens.dashboard);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: true, bootId: PROCESS_BOOT_ID });
    // 응답을 돌려준 시점에는 아직 호출 전이다 (타이머로 미룬다).
    expect(calls).toEqual([]);
    await tick();
    expect(calls).toEqual(["restart"]);
  });

  test("백그라운드 쓰기 작업이 도는 중이면 409 + 이유, 종료 함수 호출 안 함", async () => {
    const calls: string[] = [];
    const res = await send(makeApp(SUPPORTED_ENV, () => { calls.push("restart"); }, () => true), "POST", tokens.dashboard);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: RESTART_BUSY_REASON });
    await tick();
    expect(calls).toEqual([]);
  });

  test("작업이 끝났으면(false) 다시 202", async () => {
    const calls: string[] = [];
    const res = await send(makeApp(SUPPORTED_ENV, () => { calls.push("restart"); }, () => false), "POST", tokens.dashboard);
    expect(res.status).toBe(202);
    await tick();
    expect(calls).toEqual(["restart"]);
  });

  test("requestRestart 미주입 -> 503 으로 이유를 밝힌다", async () => {
    const res = await send(makeApp(SUPPORTED_ENV, undefined), "POST", tokens.dashboard);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("requestRestart");
  });
});

describe("소유자 전용", () => {
  const cases: Array<[string, () => string]> = [
    ["mcp-standard 토큰", () => tokens.standard],
    ["read-only 토큰", () => tokens.readOnly],
    ["대시보드가 아닌 full 토큰", () => tokens.otherFull],
  ];
  for (const [name, pick] of cases) {
    test(`${name} -> GET·POST 모두 403, 종료 함수 호출 안 함`, async () => {
      const calls: string[] = [];
      const app = makeApp(SUPPORTED_ENV, () => { calls.push("restart"); });
      const forbidden = await send(app, "GET", pick());
      expect(forbidden.status).toBe(403);
      if (name !== "mcp-standard 토큰" && name !== "read-only 토큰") expect(await forbidden.json()).toEqual({ error: RESTART_FORBIDDEN_MESSAGE });
      expect((await send(app, "POST", pick())).status).toBe(403);
      await tick();
      expect(calls).toEqual([]);
    });
  }

  test("토큰 없음 -> 401", async () => {
    const app = makeApp(SUPPORTED_ENV, () => {});
    expect((await send(app, "GET")).status).toBe(401);
    expect((await send(app, "POST")).status).toBe(401);
  });
});
