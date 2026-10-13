/**
 * verify-token 액션 — 양성/음성 검증 (Phase 5.5.6 / S15).
 *
 * 실 Discord API 호출 없이 검증. createClient 팩토리에 fixture 객체를 넘겨
 * login 성공/실패 시나리오를 직접 제어. CLAUDE.md 의 mock 인터페이스 금지
 * 정신을 따라 *fixture 객체* (인터페이스 구현 X) 로만 다룬다.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  handleVerifyToken,
  type VerifyClient,
} from "./verify-token.ts";

function makeApp(opts: {
  createClient?: () => VerifyClient;
} = {}) {
  const app = new Hono();
  app.post("/actions/verify-token", (c) =>
    handleVerifyToken(c, { createClient: opts.createClient }),
  );
  return app;
}

describe("POST /actions/verify-token — 양성", () => {
  test("login 통과 = 200 + ok:true toast 메시지", async () => {
    let loginCalled = false;
    let destroyCalled = false;
    const fixtureClient: VerifyClient = {
      async login(token) {
        loginCalled = true;
        return `session-for-${token}`;
      },
      async destroy() {
        destroyCalled = true;
      },
    };

    const app = makeApp({ createClient: () => fixtureClient });
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "good-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("토큰 검증 통과");
    expect(loginCalled).toBe(true);
    expect(destroyCalled).toBe(true);
  });

  test("destroy 실패해도 login 성공이면 양성 응답", async () => {
    const fixtureClient: VerifyClient = {
      async login() {
        return "ok";
      },
      async destroy() {
        throw new Error("destroy boom");
      },
    };
    const app = makeApp({ createClient: () => fixtureClient });
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "good-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("POST /actions/verify-token — 음성", () => {
  test("login throw = 500 + ok:false + 거부 사유", async () => {
    const fixtureClient: VerifyClient = {
      async login() {
        throw new Error("TOKEN_INVALID");
      },
      async destroy() {
        // login 실패 후 destroy 호출도 throw 가능 — 응답에는 영향 X.
      },
    };
    const app = makeApp({ createClient: () => fixtureClient });
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "bad-token" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Discord 응답 거부");
    expect(body.message).toContain("TOKEN_INVALID");
  });

  test("discordToken 빈 문자열 = 500 + 명시 메시지", async () => {
    const app = makeApp();
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("discordToken");
  });

  test("token 필드 부재 = 500", async () => {
    const app = makeApp();
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("잘못된 JSON body = 500 + 명시 메시지", async () => {
    const app = makeApp();
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("JSON");
  });

  test("배열 body = 500", async () => {
    const app = makeApp();
    const res = await app.request("/actions/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1,2,3]",
    });
    expect(res.status).toBe(500);
  });
});
