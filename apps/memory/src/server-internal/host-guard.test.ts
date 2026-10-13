/**
 * 코어 :3001 Host/Origin 검증 미들웨어 테스트 (P1-A2, C1·C2·C3·C4).
 *
 * 권위: docs/decisions/2026-07-02-core-host-guard-spec.md
 *
 * 순수 함수(isLoopbackOrigin / parseAllowedHostsEnv / defaultAllowedHosts)는
 * 데이터 fixture 로, 미들웨어(createHostGuard)는 최소 Hono app 에 등록해
 * app.request 로 검증한다. Mock 객체 없음 — hostOf/originOf 스텁 함수 주입은
 * 코어 auth-gate 의 remoteAddrOf 의존성 주입 패턴 답습.
 *
 * 순서 통합 테스트(T2)는 실 SseTokenStore + 실 createAuthGate + 실 createHostGuard
 * 를 같은 순서로 등록해 "Host 게이트가 auth-gate 앞" 계약을 검증한다(mock 0).
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHostGuard,
  defaultAllowedHosts,
  isLoopbackOrigin,
  isLoopbackForwardHost,
  parseAllowedHostsEnv,
} from "./host-guard.ts";
import { createAuthGate } from "./auth-gate.ts";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";

// 테스트 전용 포트 — 봇(3100)·코어(3001) 어느 리터럴과도 다른 값으로 골라
// "허용목록이 주입 port 에서 파생됨"을 리터럴 우연 일치 없이 단언한다.
const TEST_PORT = 9999;
const TEST_HOST = "127.0.0.1";

describe("isLoopbackOrigin (순수 함수 fixture)", () => {
  test("http://127.0.0.1:<port> → true", () => {
    expect(isLoopbackOrigin(`http://127.0.0.1:${TEST_PORT}`)).toBe(true);
  });

  test("http://localhost:<port> → true", () => {
    expect(isLoopbackOrigin(`http://localhost:${TEST_PORT}`)).toBe(true);
  });

  test("http://[::1]:<port> → true", () => {
    expect(isLoopbackOrigin(`http://[::1]:${TEST_PORT}`)).toBe(true);
  });

  test("포트 없는 loopback → true", () => {
    expect(isLoopbackOrigin("http://127.0.0.1")).toBe(true);
    expect(isLoopbackOrigin("https://localhost")).toBe(true);
  });

  test("http://evil.com → false", () => {
    expect(isLoopbackOrigin("http://evil.com")).toBe(false);
  });

  test("비-loopback IP → false", () => {
    expect(isLoopbackOrigin("http://192.168.1.5:3001")).toBe(false);
  });

  test("파싱 불가 origin(빈 문자열·null 문자열·비-URL) → false", () => {
    expect(isLoopbackOrigin("")).toBe(false);
    expect(isLoopbackOrigin("null")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

test("SSH forwarded Host permits only a numeric loopback port", () => {
  expect(isLoopbackForwardHost("127.0.0.1:49162")).toBe(true);
  expect(isLoopbackForwardHost("localhost:49162")).toBe(true);
  expect(isLoopbackForwardHost("[::1]:49162")).toBe(true);
  for (const host of ["evil.com:49162", "127.0.0.2:49162", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:49162.evil"])
    expect(isLoopbackForwardHost(host)).toBe(false);
});

describe("parseAllowedHostsEnv (순수 함수 fixture)", () => {
  test("undefined / 빈 문자열 → []", () => {
    expect(parseAllowedHostsEnv(undefined)).toEqual([]);
    expect(parseAllowedHostsEnv("")).toEqual([]);
    expect(parseAllowedHostsEnv("   ")).toEqual([]);
  });

  test("콤마 구분 파싱 + trim + 빈 항목 제거", () => {
    expect(
      parseAllowedHostsEnv("memory.example.com, a.test ,, b.test"),
    ).toEqual(["memory.example.com", "a.test", "b.test"]);
  });
});

describe("defaultAllowedHosts (주입 host/port 파생 — 하드코딩 금지)", () => {
  test("주입한 host/port 에서 파생한 형태", () => {
    // port=9999 주입 시 리터럴이 아니라 주입 값으로 파생됨을 단언한다.
    expect(defaultAllowedHosts({ host: TEST_HOST, port: TEST_PORT })).toEqual([
      `127.0.0.1:${TEST_PORT}`,
      `localhost:${TEST_PORT}`,
      `${TEST_HOST}:${TEST_PORT}`,
      "127.0.0.1",
      "localhost",
      TEST_HOST,
    ]);
  });

  test("커스텀 host 주입 시 host:port 형태가 파생됨", () => {
    const derived = defaultAllowedHosts({ host: "0.0.0.0", port: TEST_PORT });
    expect(derived).toContain(`0.0.0.0:${TEST_PORT}`);
    expect(derived).toContain("0.0.0.0");
    // loopback 형태도 함께 남는다(브라우저는 실제 접속 host 를 Host 로 보냄).
    expect(derived).toContain(`127.0.0.1:${TEST_PORT}`);
  });
});

/** 게이트만 등록한 최소 app — 통과 시 /probe 가 200 을 준다. */
function guardApp(deps: Parameters<typeof createHostGuard>[0]): Hono {
  const app = new Hono();
  app.use("*", createHostGuard(deps));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("createHostGuard — Host 검증 (C1)", () => {
  test("forwards a loopback request on another local port, but still checks Origin", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    expect((await app.request("/probe", { headers: { host: "127.0.0.1:49162" } })).status).toBe(200);
    expect((await app.request("/probe", { headers: { host: "127.0.0.1:49162", origin: "http://127.0.0.1:49162" } })).status).toBe(200);
    expect((await app.request("/probe", { headers: { host: "127.0.0.1:49162", origin: "http://127.0.0.1:49163" } })).status).toBe(403);
    expect((await app.request("/probe", { headers: { host: "127.0.0.1:49162", origin: "http://evil@127.0.0.1:49162" } })).status).toBe(403);
    expect((await app.request("/probe", { headers: { host: "127.0.0.1:49162", origin: "http://evil.com" } })).status).toBe(403);
    expect((await app.request("/probe", { headers: { host: "127.0.0.1.nip.io:49162" } })).status).toBe(403);
  });
  test("허용 Host(loopback:port) → 통과", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", {
      headers: { host: `127.0.0.1:${TEST_PORT}` },
    });
    expect(res.status).toBe(200);
  });

  test("포트 없는 loopback Host → 통과", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", { headers: { host: "127.0.0.1" } });
    expect(res.status).toBe(200);
  });

  test("허용목록 밖 Host(evil.com) → 403", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", { headers: { host: "evil.com" } });
    expect(res.status).toBe(403);
  });

  test("Host 헤더 부재 → 403", async () => {
    // hostOf 스텁으로 부재를 강제(app.request 는 어차피 Host 를 안 붙임).
    const app = new Hono();
    app.use(
      "*",
      createHostGuard({
        host: TEST_HOST,
        port: TEST_PORT,
        hostOf: () => undefined,
      }),
    );
    app.get("/probe", (c) => c.json({ ok: true }));
    const res = await app.request("/probe");
    expect(res.status).toBe(403);
  });

  test("MEMORY_ALLOWED_HOSTS 스타일 확장 Host → 통과", async () => {
    const app = guardApp({
      host: TEST_HOST,
      port: TEST_PORT,
      allowedHosts: [
        ...defaultAllowedHosts({ host: TEST_HOST, port: TEST_PORT }),
        ...parseAllowedHostsEnv("memory.example.com"),
      ],
    });
    const res = await app.request("/probe", {
      headers: { host: "memory.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("hostOf 스텁 주입 — 주입한 Host 로 판정", async () => {
    const app = new Hono();
    app.use(
      "*",
      createHostGuard({
        host: TEST_HOST,
        port: TEST_PORT,
        allowedHosts: ["injected.host"],
        hostOf: () => "injected.host",
      }),
    );
    app.get("/probe", (c) => c.json({ ok: true }));
    const res = await app.request("/probe");
    expect(res.status).toBe(200);
  });

  test("403 응답 본문에 Host 값이 들어가지 않는다", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", {
      headers: { host: "sentinel-evil-host.example" },
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("sentinel-evil-host.example");
  });
});

describe("createHostGuard — Origin 검증 (C2)", () => {
  test("loopback Origin → 통과", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", {
      headers: {
        host: `127.0.0.1:${TEST_PORT}`,
        origin: `http://127.0.0.1:${TEST_PORT}`,
      },
    });
    expect(res.status).toBe(200);
  });

  test("비-loopback Origin → 403", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", {
      headers: { host: `127.0.0.1:${TEST_PORT}`, origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  test("Origin 부재(서버-서버) → 통과", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", {
      headers: { host: `127.0.0.1:${TEST_PORT}` },
    });
    expect(res.status).toBe(200);
  });

  test("403 응답 본문에 Origin 값이 들어가지 않는다", async () => {
    const app = guardApp({ host: TEST_HOST, port: TEST_PORT });
    const res = await app.request("/probe", {
      headers: {
        host: `127.0.0.1:${TEST_PORT}`,
        origin: "http://sentinel-evil-origin.example",
      },
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("sentinel-evil-origin.example");
  });
});

/**
 * 순서 통합 테스트 (T2, spec Completion #6·#8).
 *
 * index.ts 자체는 top-level await + Bun.serve 라 단위 테스트 불가하므로,
 * host-guard 를 auth-gate **앞**에 등록한 별 Hono app 을 실 미들웨어로 구성해
 * "리바인딩 방어가 인증보다 먼저" 계약을 검증한다. Mock 0 — 실 SseTokenStore +
 * 실 createAuthGate + 실 createHostGuard.
 */
describe("미들웨어 순서 통합 — Host 게이트가 auth-gate 앞 (C4)", () => {
  function orderedApp() {
    const dir = mkdtempSync(join(tmpdir(), "host-guard-order-"));
    const tokens = new SseTokenStore(join(dir, "t.json"));
    const valid = tokens.issueToken("test-adapter");
    const app = new Hono();
    // 실제 index.ts 순서 재현: Host 게이트 먼저, 그 다음 auth-gate.
    app.use("*", createHostGuard({ host: TEST_HOST, port: TEST_PORT }));
    app.use(
      "*",
      createAuthGate({
        sseTokens: tokens,
        // auth-gate 발급경로 loopback 판정용 — 이 테스트는 보호경로만 쓰므로
        // 비-loopback 로 둬도 무방하나 실 함수를 그대로 주입한다.
        remoteAddrOf: () => "127.0.0.1",
        getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
      }),
    );
    // /memories 는 auth-gate 보호경로(허용목록 밖) — Bearer 필수.
    app.get("/memories", (c) => c.json({ ok: true }));
    return { app, valid };
  }

  test("Host=evil.com + 유효 Bearer → 403 (auth-gate 도달 전 Host 게이트가 막음)", async () => {
    const { app, valid } = orderedApp();
    const res = await app.request("/memories", {
      headers: { host: "evil.com", authorization: `Bearer ${valid}` },
    });
    // 유효 Bearer 여도 Host 가 허용목록 밖이면 auth-gate(200)에 닿기 전 403.
    expect(res.status).toBe(403);
  });

  test("Host=loopback:port + 유효 Bearer → 200 (둘 다 통과)", async () => {
    const { app, valid } = orderedApp();
    const res = await app.request("/memories", {
      headers: {
        host: `127.0.0.1:${TEST_PORT}`,
        authorization: `Bearer ${valid}`,
      },
    });
    expect(res.status).toBe(200);
  });

  test("Host=loopback:port + 무 Bearer + 보호경로 → 401 (Host 통과 후 auth-gate 가 막음)", async () => {
    const { app } = orderedApp();
    const res = await app.request("/memories", {
      headers: { host: `127.0.0.1:${TEST_PORT}` },
    });
    // Host 는 통과했고 auth-gate 가 Bearer 부재로 막음 → 순서가 맞음을 확정.
    expect(res.status).toBe(401);
  });
});
