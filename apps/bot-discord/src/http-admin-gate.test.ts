/**
 * 로컬 관리 토큰 게이트 통합 테스트 (D2).
 *
 * 실 createHttpServer 에 adminToken 을 주입해 게이트가 걸린 전체 서버로 검증한다.
 * Host 게이트(D1)가 선행하므로 모든 요청에 유효 Host 를 붙인다. Mock 없음 —
 * 실 settings-store 파일 I/O + Hono app.request.
 *
 * 검증(spec Completion Criteria 3·4·9):
 *   - GET /health, GET /settings/schema → 무인증 통과.
 *   - PUT /settings 토큰 없이 → 401; 올바른 Bearer → 통과.
 *   - GET /settings 토큰 없이 → 401 (ownerId·memoryApiUrl 평문 보호).
 *   - 401 응답 본문·에러에 토큰 값 없음.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOT_HTTP_HOST,
  BOT_HTTP_PORT,
  createHttpServer,
} from "./http-server.ts";
import { ReloadBus } from "./reload-bus.ts";

const ADMIN_TOKEN = "test-admin-token-abc123";
const HOST = `${BOT_HTTP_HOST}:${BOT_HTTP_PORT}`;

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-admin-gate-"));
  settingsPath = join(dir, "bot-settings.json");
});

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function gatedApp(): ReturnType<typeof createHttpServer> {
  return createHttpServer({
    reloadBus: new ReloadBus(),
    settingsPath,
    adminToken: () => ADMIN_TOKEN,
  });
}

/** 유효 Host + 선택 Authorization 헤더로 요청. */
function req(
  app: ReturnType<typeof createHttpServer>,
  path: string,
  opts: { method?: string; token?: string; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: HOST };
  if (opts.token !== undefined) {
    headers["authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  // app.request 오버로드가 body:string|undefined 때문에 Response|Promise<Response>
  // 로 넓게 추론된다 — 실제로는 항상 Promise 라 좁혀 반환한다.
  return app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
  }) as Promise<Response>;
}

describe("무인증 허용 경로 (게이트 통과)", () => {
  test("GET /health → 무인증 200", async () => {
    const res = await req(gatedApp(), "/health");
    expect(res.status).toBe(200);
  });

  test("GET /settings/schema → 무인증 200", async () => {
    const res = await req(gatedApp(), "/settings/schema");
    expect(res.status).toBe(200);
  });

  test("GET /settings/schema/ (trailing slash) → 무인증 200", async () => {
    const res = await req(gatedApp(), "/settings/schema/");
    expect(res.status).toBe(200);
  });
});

describe("보호 경로 — 토큰 필수", () => {
  test("GET /settings 토큰 없이 → 401 (ownerId·memoryApiUrl 평문 보호)", async () => {
    const res = await req(gatedApp(), "/settings");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("인증이 필요합니다.");
  });

  test("GET /settings 올바른 Bearer → 200", async () => {
    const res = await req(gatedApp(), "/settings", { token: ADMIN_TOKEN });
    expect(res.status).toBe(200);
  });

  test("PUT /settings 토큰 없이 → 401", async () => {
    const res = await req(gatedApp(), "/settings", {
      method: "PUT",
      body: JSON.stringify({ discordToken: "t.t.t", ownerId: "1" }),
    });
    expect(res.status).toBe(401);
  });

  test("PUT /settings 올바른 Bearer → 통과(200)", async () => {
    const res = await req(gatedApp(), "/settings", {
      method: "PUT",
      token: ADMIN_TOKEN,
      body: JSON.stringify({ discordToken: "t.t.t", ownerId: "12345" }),
    });
    expect(res.status).toBe(200);
  });

  test("PUT /settings 틀린 Bearer → 401", async () => {
    const res = await req(gatedApp(), "/settings", {
      method: "PUT",
      token: "wrong-token",
      body: JSON.stringify({ discordToken: "t.t.t", ownerId: "1" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /actions/verify-token 토큰 없이 → 401", async () => {
    const res = await req(gatedApp(), "/actions/verify-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("GET /actions/list-channels 토큰 없이 → 401", async () => {
    const res = await req(gatedApp(), "/actions/list-channels");
    expect(res.status).toBe(401);
  });
});

describe("토큰 값 노출 금지 (보안 핵심)", () => {
  test("401 응답 본문에 기대 토큰 값 없음", async () => {
    const res = await req(gatedApp(), "/settings", { token: "wrong" });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(ADMIN_TOKEN);
  });

  test("게이트 전 과정 console 출력에 토큰 값 미포함", async () => {
    const captured: string[] = [];
    const orig = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    console.log = sink as typeof console.log;
    console.warn = sink as typeof console.warn;
    console.error = sink as typeof console.error;
    console.info = sink as typeof console.info;
    try {
      const app = gatedApp();
      await req(app, "/settings", { token: ADMIN_TOKEN });
      await req(app, "/settings", { token: "wrong" });
      await req(app, "/settings");
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
    }
    expect(captured.join("\n")).not.toContain(ADMIN_TOKEN);
  });
});

describe("adminToken 미지정 — 게이트 우회 (단위 테스트 통로)", () => {
  test("adminToken 없으면 보호 경로도 토큰 없이 통과(라우트 로직 검증용)", async () => {
    const app = createHttpServer({
      reloadBus: new ReloadBus(),
      settingsPath,
      // adminToken 미지정 — 게이트 안 걸림.
    });
    const res = await req(app, "/settings");
    expect(res.status).toBe(200);
  });
});
