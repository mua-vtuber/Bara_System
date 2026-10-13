/**
 * middleware-order.test.ts — index.ts 미들웨어 스택 순서 회귀 게이트 (P3 G3-e)
 *
 * index.ts 는 top-level await 모듈 진입부라 단위 테스트가 어렵다(같은 파일 JSDoc
 * 이 이미 인정). 그래서 index.ts 가 조립하는 미들웨어 조합(host-guard →
 * auth-gate → body-limit)을 여기서 같은 순서로 재현해 순서
 * 계약을 못박는다. index.ts 의 실제 등록 순서가 이 순서에서 어긋나면 이 파일이
 * 아니라 검토가 잡아야 하므로, 이 테스트는 "이 순서가 만족해야 할 성질"을 검증한다:
 *
 *   1. 무인증 요청(토큰 없음 + 비-loopback)이 보호 경로에 대용량 본문을 올려도
 *      auth-gate 가 401 로 먼저 막아 body-limit 의 본문 버퍼링에 도달하지 않는다
 *      (감사 지적 = 무인증 대용량 업로드로 메모리 압박). 401 이 나면 body 를 읽지
 *      않았다는 것을 하위 핸들러 미도달로 확인한다.
 *   2. 무인증 *허용* 경로(/adapter-enroll)는 auth-gate 를 통과하지만 그 뒤 body-limit
 *      가 여전히 적용된다 — auth 를 앞세워도 이 경로의 본문 상한 보호가 사라지지
 *      않는다(무인증 본문 경로가 무제한이 되는 회귀 차단).
 *   3. 인증 통과 요청은 body-limit 상한을 여전히 받는다(상한 초과 413 / 이하 통과).
 *   4. host-guard 는 최선두 — 허용 안 된 Host 는 auth 든 body 든 닿기 전에 403.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "./auth-gate.ts";
import { createBodyLimit } from "./body-limit.ts";
import { createHostGuard } from "./host-guard.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";

const HOST = "127.0.0.1";
const PORT = 3001;
const ALLOWED_HOST = `${HOST}:${PORT}`;

/**
 * index.ts 의 outerApp 미들웨어 조합을 같은 순서로 재현한다.
 *   host-guard → auth-gate → body-limit → 라우트.
 * 각 라우트는 본문을 실제로 읽어 "body 버퍼링에 도달했는지"를 응답으로 노출한다
 * (bodyRead=true 면 body-limit 뒤 핸들러까지 갔다는 뜻).
 */
function setup(opts: { limit: number; remoteAddr?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "mw-order-"));
  const tokens = new SseTokenStore(join(dir, "t.json"));
  const valid = tokens.issueToken("test-adapter");

  const app = new Hono({ strict: false });
  // 1. host-guard — 최선두(P1-A2). Host 헤더 기반 판정.
  app.use(
    "*",
    createHostGuard({ host: HOST, port: PORT, allowedHosts: [ALLOWED_HOST] }),
  );
  // 2. auth-gate — body-limit *앞*(P3 G3-e). 무인증 보호 경로 요청을 body 버퍼링
  //    전에 401 로 막는다. allowlist(/adapter-enroll 등)는 통과시킨다.
  app.use(
    "*",
    createAuthGate({
      sseTokens: tokens,
      remoteAddrOf: () => opts.remoteAddr ?? "10.0.0.5",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  // 3. body-limit — auth-gate *뒤*. auth 를 통과한(또는 allowlist) 요청만 본문
  //    버퍼링에 도달한다. getLimits 는 요청마다 호출.
  app.use(
    "*",
    createBodyLimit(() => ({ maxTextBytes: opts.limit, maxAssetBytes: opts.limit })),
  );

  // 보호 경로(비-allowlist) — 본문을 읽어 도달 여부 노출.
  app.post("/memories", async (c) => {
    const text = await c.req.text();
    return c.json({ bodyRead: true, len: text.length });
  });
  // 무인증 허용 경로 — 본문을 읽어 body-limit 적용 여부 노출.
  app.post("/adapter-enroll", async (c) => {
    const text = await c.req.text();
    return c.json({ bodyRead: true, len: text.length });
  });

  return { app, valid };
}

/** ALLOWED_HOST 를 붙인 요청 헬퍼 — host-guard 통과용. */
function req(
  app: Hono,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  const headers = { host: ALLOWED_HOST, ...(init.headers ?? {}) };
  return app.request(path, { ...init, headers });
}

describe("미들웨어 순서 — G3-e (auth 앞, body-limit 뒤)", () => {
  test("무인증 + 대용량 본문 → 보호 경로는 body 버퍼링 전에 401", async () => {
    const { app } = setup({ limit: 10 });
    const res = await req(app, "/memories", {
      method: "POST",
      body: "x".repeat(10_000), // 상한 10 을 훨씬 초과
    });
    // auth-gate 가 먼저 401 — body-limit 의 413 이 아니라 401 이어야 한다.
    expect(res.status).toBe(401);
    // 하위 핸들러(bodyRead)에 닿지 않았다 = body 버퍼링 미도달.
    const body = (await res.json()) as { bodyRead?: boolean; error?: string };
    expect(body.bodyRead).toBeUndefined();
  });

  test("무인증 허용 경로(/adapter-enroll)는 통과하지만 body-limit 여전히 적용 — 초과 413", async () => {
    const { app } = setup({ limit: 10 });
    const res = await req(app, "/adapter-enroll", {
      method: "POST",
      body: "x".repeat(10_000),
    });
    // auth-gate allowlist 통과 → body-limit 가 상한 초과를 413 으로 막는다.
    expect(res.status).toBe(413);
  });

  test("무인증 허용 경로(/adapter-enroll) 작은 본문은 통과 + body 읽힘", async () => {
    const { app } = setup({ limit: 1000 });
    const res = await req(app, "/adapter-enroll", {
      method: "POST",
      body: JSON.stringify({ adapterId: "bot-x" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bodyRead: boolean };
    expect(body.bodyRead).toBe(true);
  });

  test("인증 통과 + 상한 초과 → 413 (body-limit 가 인증 뒤에서도 작동)", async () => {
    const { app, valid } = setup({ limit: 10 });
    const res = await req(app, "/memories", {
      method: "POST",
      headers: { authorization: `Bearer ${valid}` },
      body: "x".repeat(10_000),
    });
    expect(res.status).toBe(413);
  });

  test("인증 통과 + 상한 이하 → 통과 + body 읽힘", async () => {
    const { app, valid } = setup({ limit: 1000 });
    const res = await req(app, "/memories", {
      method: "POST",
      headers: { authorization: `Bearer ${valid}` },
      body: "hello",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bodyRead: boolean; len: number };
    expect(body.bodyRead).toBe(true);
    expect(body.len).toBe(5);
  });

  test("host-guard 최선두 — 허용 안 된 Host 는 auth·body 전에 403", async () => {
    const { app } = setup({ limit: 10 });
    // ALLOWED_HOST 를 안 붙이고 다른 Host — host-guard 가 먼저 403.
    const res = await app.request("/memories", {
      method: "POST",
      headers: { host: "evil.example.com" },
      body: "x".repeat(10_000),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { bodyRead?: boolean };
    expect(body.bodyRead).toBeUndefined();
  });
});
