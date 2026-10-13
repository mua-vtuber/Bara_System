/**
 * security-phase1.e2e.test.ts — 보안 Phase 1 통합·불변식 종합 가드 (Task 8)
 *
 * 권위: docs/decisions/2026-06-07-security-phase1-input-limits-token-gate-plan.md Task 8
 *
 * 검증 목표:
 *   - body-limit 미들웨어와 auth-gate 미들웨어를 index.ts 와 동일한 순서
 *     (body-limit 먼저, auth-gate 두 번째)로 함께 연결한다.
 *   - Mock 없음 — 실제 SseTokenStore + 실제 미들웨어.
 *   - 두 미들웨어의 상호작용(입력 초과 시 auth 전에 413, 인증 실패 시 401 등)을
 *     하나의 Hono 앱에서 종합 검증한다.
 */

import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createBodyLimit } from "./body-limit.ts";
import { createAuthGate } from "./auth-gate.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";

// ── 테스트 앱 구성 ─────────────────────────────────────────────────────────

/**
 * index.ts 와 동일한 순서로 미들웨어를 연결한 Hono 앱을 만든다.
 * 상한은 테스트에서 쉽게 초과할 수 있도록 작게 설정한다:
 *   maxTextBytes = 50  (텍스트 경로)
 *   maxAssetBytes = 200 (/ingest 경로)
 *
 * remoteAddr 는 테스트가 setRemote() 로 변경할 수 있는 가변 값이다.
 */
function buildApp() {
  const dir = mkdtempSync(join(tmpdir(), "sec-e2e-"));
  const tokens = new SseTokenStore(join(dir, "t.json"));
  const valid = tokens.issueToken("e2e-adapter");

  let remoteAddr = "127.0.0.1";

  const app = new Hono();

  // 1단계: 입력 상한 — body-limit 이 먼저 실행된다.
  app.use(
    "*",
    createBodyLimit(() => ({ maxTextBytes: 50, maxAssetBytes: 200 })),
  );
  // 2단계: 인증 게이트 — body-limit 통과 후 실행된다.
  app.use(
    "*",
    createAuthGate({
      sseTokens: tokens,
      remoteAddrOf: () => remoteAddr,
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );

  // 테스트 대상 경로들.
  app.get("/health", (c) => c.text("ok"));
  app.post("/memories", async (c) => c.json({ stored: (await c.req.text()).length }));
  app.post("/search", (c) => c.json({ results: [] }));
  app.post("/ingest", async (c) => {
    const buf = await c.req.arrayBuffer();
    return c.json({ ok: true, bytes: buf.byteLength });
  });
  app.get("/dashboard/sse-token", (c) => c.json({ token: "issued" }));

  return {
    app,
    valid,
    setRemote: (addr: string) => {
      remoteAddr = addr;
    },
  };
}

// ── 테스트 ─────────────────────────────────────────────────────────────────

describe("통합 E2E — 인증 게이트", () => {
  test("토큰 없이 /memories 요청 → 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/memories", { method: "POST", body: "hi" });
    expect(res.status).toBe(401);
  });

  test("토큰 없이 /search 요청 → 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/search", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("토큰 없이 /ingest 요청 → 401", async () => {
    const { app } = buildApp();
    // 50 byte 미만 — 입력 상한 통과, 인증 게이트에서 걸려야 한다.
    const res = await app.request("/ingest", { method: "POST", body: "x".repeat(10) });
    expect(res.status).toBe(401);
  });

  test("유효 토큰으로 /memories 요청 → 200", async () => {
    const { app, valid } = buildApp();
    const res = await app.request("/memories", {
      method: "POST",
      body: "단어 몇 개",
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("유효 토큰으로 /search 요청 → 200", async () => {
    const { app, valid } = buildApp();
    const res = await app.request("/search", {
      method: "POST",
      body: "{}",
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("유효 토큰으로 /ingest 요청 → 200", async () => {
    const { app, valid } = buildApp();
    const res = await app.request("/ingest", {
      method: "POST",
      body: "x".repeat(10),
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("통합 E2E — /health 는 토큰 없이 통과", () => {
  test("/health 는 토큰 없이 200", async () => {
    const { app } = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("통합 E2E — /dashboard/sse-token loopback 제한", () => {
  test("loopback(127.0.0.1)에서 토큰 없이 /dashboard/sse-token → 401 (loopback 만으로는 발급 불가)", async () => {
    const { app, setRemote } = buildApp();
    setRemote("127.0.0.1");
    const res = await app.request("/dashboard/sse-token");
    expect(res.status).toBe(401);
  });

  test("loopback(127.0.0.1)에서 full 토큰으로 /dashboard/sse-token → 200", async () => {
    const { app, valid, setRemote } = buildApp();
    setRemote("127.0.0.1");
    const res = await app.request("/dashboard/sse-token", {
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("비-loopback 주소에서 /dashboard/sse-token → 403", async () => {
    const { app, setRemote } = buildApp();
    setRemote("10.0.0.5");
    const res = await app.request("/dashboard/sse-token");
    expect(res.status).toBe(403);
  });
});

describe("통합 E2E — 입력 상한 (body-limit 이 auth-gate 보다 먼저 실행)", () => {
  /**
   * body-limit 이 먼저 실행되므로, 입력이 상한을 초과하면 토큰 유무와 관계없이
   * 413 을 반환한다. 이 동작을 명시적으로 검증한다.
   *
   * 설정: maxTextBytes=50, maxAssetBytes=200
   */

  test("텍스트 경로 — 100 byte 입력(maxTextBytes 50 초과) → 413 (토큰 유무 무관)", async () => {
    const { app, valid } = buildApp();
    // 유효 토큰을 달아도 body-limit 이 먼저 걸리므로 413 이어야 한다.
    const res = await app.request("/memories", {
      method: "POST",
      body: "x".repeat(100),
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(413);
  });

  test("텍스트 경로 — 100 byte 입력, 토큰 없어도 → 413 (body-limit 우선)", async () => {
    const { app } = buildApp();
    // 토큰이 없어도 413 — body-limit 이 auth-gate 보다 먼저 동작함을 증명한다.
    const res = await app.request("/memories", {
      method: "POST",
      body: "x".repeat(100),
    });
    expect(res.status).toBe(413);
  });

  test("/ingest — 250 byte 입력(maxAssetBytes 200 초과) + 유효 토큰 → 413", async () => {
    const { app, valid } = buildApp();
    // 250 byte > maxAssetBytes(200) → body-limit 에서 413.
    const res = await app.request("/ingest", {
      method: "POST",
      body: "x".repeat(250),
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(413);
  });

  test("/ingest — 100 byte 입력(maxAssetBytes 200 이하) + 유효 토큰 → 200", async () => {
    const { app, valid } = buildApp();
    // 100 byte < maxAssetBytes(200) — 입력 상한 통과 + 인증 통과 → 200.
    const res = await app.request("/ingest", {
      method: "POST",
      body: "x".repeat(100),
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("/ingest — 100 byte 는 maxTextBytes(50) 를 초과하지만 maxAssetBytes(200) 이하 → 통과", async () => {
    // /ingest 는 텍스트 상한이 아닌 자산 상한을 적용한다.
    const { app, valid } = buildApp();
    const res = await app.request("/ingest", {
      method: "POST",
      body: "x".repeat(100),
      headers: { Authorization: `Bearer ${valid}` },
    });
    // maxAssetBytes(200) > 100 이므로 입력 상한 통과 → 인증도 통과 → 200.
    expect(res.status).toBe(200);
  });

  test("텍스트 경로 — 정확히 50 byte(상한과 같음) + 유효 토큰 → 200", async () => {
    const { app, valid } = buildApp();
    const res = await app.request("/memories", {
      method: "POST",
      body: "x".repeat(50),
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("413 응답 본문에 상한 값이 포함된다", async () => {
    const { app } = buildApp();
    const res = await app.request("/memories", {
      method: "POST",
      body: "x".repeat(100),
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("50");
  });
});
