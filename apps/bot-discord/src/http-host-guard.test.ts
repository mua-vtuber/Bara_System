/**
 * Host/Origin 검증 미들웨어 단위 테스트 (D1·D3).
 *
 * 순수 함수(isLoopbackOrigin / parseAllowedHostsEnv / defaultAllowedHosts)는
 * 데이터 fixture 로, 미들웨어(createHostGuard)는 최소 Hono app 에 등록해
 * app.request 로 검증한다. Mock 객체 없음 — hostOf/originOf 스텁 함수 주입은
 * 코어 auth-gate 의 remoteAddrOf 의존성 주입 패턴 답습.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  createHostGuard,
  defaultAllowedHosts,
  isLoopbackOrigin,
  parseAllowedHostsEnv,
} from "./http-host-guard.ts";
import { BOT_HTTP_PORT } from "./http-server.ts";

describe("isLoopbackOrigin (순수 함수 fixture)", () => {
  test("http://127.0.0.1:3100 → true", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:3100")).toBe(true);
  });

  test("http://localhost:3100 → true", () => {
    expect(isLoopbackOrigin("http://localhost:3100")).toBe(true);
  });

  test("http://[::1]:3100 → true", () => {
    expect(isLoopbackOrigin("http://[::1]:3100")).toBe(true);
  });

  test("포트 없는 loopback → true", () => {
    expect(isLoopbackOrigin("http://127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("https://localhost")).toBe(true);
  });

  test("http://evil.com → false", () => {
    expect(isLoopbackOrigin("http://evil.com")).toBe(false);
  });

  test("비-loopback IP → false", () => {
    expect(isLoopbackOrigin("http://192.168.1.5:3100")).toBe(false);
  });

  test("파싱 불가 origin(빈 문자열·null 문자열) → false", () => {
    expect(isLoopbackOrigin("")).toBe(false);
    expect(isLoopbackOrigin("null")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

describe("parseAllowedHostsEnv (순수 함수 fixture)", () => {
  test("undefined / 빈 문자열 → []", () => {
    expect(parseAllowedHostsEnv(undefined)).toEqual([]);
    expect(parseAllowedHostsEnv("")).toEqual([]);
    expect(parseAllowedHostsEnv("   ")).toEqual([]);
  });

  test("콤마 구분 파싱 + trim + 빈 항목 제거", () => {
    expect(parseAllowedHostsEnv("bot.example.com, a.test ,, b.test")).toEqual([
      "bot.example.com",
      "a.test",
      "b.test",
    ]);
  });
});

describe("defaultAllowedHosts (포트 상수 파생 — 하드코딩 금지)", () => {
  test("포트 상수에서 파생한 4 형태", () => {
    expect(defaultAllowedHosts()).toEqual([
      `127.0.0.1:${BOT_HTTP_PORT}`,
      `localhost:${BOT_HTTP_PORT}`,
      "127.0.0.1",
      "localhost",
    ]);
  });
});

/** 게이트만 등록한 최소 app — 통과 시 /probe 가 200 을 준다. */
function guardApp(
  deps: Parameters<typeof createHostGuard>[0],
): Hono {
  const app = new Hono();
  app.use("*", createHostGuard(deps));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("createHostGuard — Host 검증", () => {
  test("허용 Host → 통과", async () => {
    const app = guardApp({ allowedHosts: ["127.0.0.1:3100"] });
    const res = await app.request("/probe", {
      headers: { host: "127.0.0.1:3100" },
    });
    expect(res.status).toBe(200);
  });

  test("허용목록 밖 Host → 403", async () => {
    const app = guardApp({ allowedHosts: ["127.0.0.1:3100"] });
    const res = await app.request("/probe", { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
  });

  test("Host 헤더 부재 → 403", async () => {
    const app = guardApp({ allowedHosts: ["127.0.0.1:3100"] });
    // hostOf 스텁으로 부재를 강제(app.request 는 어차피 Host 를 안 붙임).
    const res = await app.request("/probe");
    expect(res.status).toBe(403);
  });

  test("BOT_ALLOWED_HOSTS 스타일 확장 Host → 통과", async () => {
    const app = guardApp({
      allowedHosts: [
        ...defaultAllowedHosts(),
        ...parseAllowedHostsEnv("bot.example.com"),
      ],
    });
    const res = await app.request("/probe", {
      headers: { host: "bot.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("hostOf 스텁 주입 — 주입한 Host 로 판정", async () => {
    const app = new Hono();
    app.use(
      "*",
      createHostGuard({
        allowedHosts: ["injected.host"],
        hostOf: () => "injected.host",
      }),
    );
    app.get("/probe", (c) => c.json({ ok: true }));
    // 요청엔 Host 를 안 붙여도 스텁이 injected.host 를 반환해 통과.
    const res = await app.request("/probe");
    expect(res.status).toBe(200);
  });
});

describe("createHostGuard — Origin 검증 (D3)", () => {
  test("loopback Origin → 통과", async () => {
    const app = guardApp({ allowedHosts: ["127.0.0.1:3100"] });
    const res = await app.request("/probe", {
      headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
    });
    expect(res.status).toBe(200);
  });

  test("비-loopback Origin → 403", async () => {
    const app = guardApp({ allowedHosts: ["127.0.0.1:3100"] });
    const res = await app.request("/probe", {
      headers: { host: "127.0.0.1:3100", origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  test("Origin 부재(서버-서버) → 통과", async () => {
    const app = guardApp({ allowedHosts: ["127.0.0.1:3100"] });
    const res = await app.request("/probe", {
      headers: { host: "127.0.0.1:3100" },
    });
    expect(res.status).toBe(200);
  });
});
