/**
 * 인증 게이트 미들웨어 테스트 (보안 Phase 1 Task 4)
 *
 * 실제 SseTokenStore 를 임시 파일 경로로 생성해서 검증한다.
 * Mock 객체 없음 — 프로젝트 테스트 정책 준수.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate, MCP_ADAPTER_ID_VAR } from "./auth-gate.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";

/** 테스트용 앱 설정. remoteAddr 기본값은 외부 주소(비-loopback). */
function setup(remoteAddr = "10.0.0.5") {
  const dir = mkdtempSync(join(tmpdir(), "auth-gate-"));
  const tokens = new SseTokenStore(join(dir, "t.json"));
  const valid = tokens.issueToken("test-adapter");
  const app = new Hono();
  app.use(
    "*",
    createAuthGate({
      sseTokens: tokens,
      remoteAddrOf: () => remoteAddr,
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  app.get("/health", (c) => c.text("ok"));
  app.get("/memories", (c) => c.json({ ok: true }));
  app.get("/graph/overview", (c) => c.json({ ok: true }));
  app.get("/events/stream", (c) => c.text("stream"));
  app.get("/thumbs/:sha", (c) => c.text("thumb"));
  app.get("/assets/:sha", (c) => c.text("asset"));
  app.get("/cleanup-proposals", (c) => c.json({ proposals: [] }));
  app.post("/cleanup-proposals/:id/:action", (c) => c.json({ ok: true }));
  app.get("/api/entity-types", (c) => c.json({ entityTypes: [] }));
  app.get("/dashboard/sse-token", (c) => c.json({ token: "issued" }));
  app.post("/adapter-enroll", (c) => c.json({ status: "pending" }, 202));
  app.get("/adapter-enroll/req/token", (c) => c.json({ status: "pending" }, 202));
  app.get("/adapter-tokens", (c) => c.json({ ok: true }));
  app.get("/wizard", (c) => c.text("removed wizard"));
  app.get("/wizard/step1", (c) => c.text("removed wizard step"));
  app.get("/", (c) => c.text("root"));
  app.get("/web/dashboard", (c) => c.text("web"));
  return { app, valid };
}

describe("허용 목록 경로 — 토큰 없이 통과", () => {
  test("/health 는 토큰 없이 통과", async () => {
    const { app } = setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  test("/wizard 는 더 이상 공개 경로가 아니다", async () => {
    const { app } = setup();
    const res = await app.request("/wizard");
    expect(res.status).toBe(401);
  });

  test("/wizard/step1 도 더 이상 공개 경로가 아니다", async () => {
    const { app } = setup();
    const res = await app.request("/wizard/step1");
    expect(res.status).toBe(401);
  });

  test("/ 는 토큰 없이 통과", async () => {
    const { app } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("/web/dashboard 는 토큰 없이 통과", async () => {
    const { app } = setup();
    const res = await app.request("/web/dashboard");
    expect(res.status).toBe(200);
  });

  test("/adapter-enroll 등록/픽업 경로는 토큰 없이 통과", async () => {
    const { app } = setup();
    const enroll = await app.request("/adapter-enroll", { method: "POST" });
    const pickup = await app.request("/adapter-enroll/req/token");
    expect(enroll.status).toBe(202);
    expect(pickup.status).toBe(202);
  });
});

describe("보호 경로 — 토큰 검증", () => {
  test("토큰 없으면 401", async () => {
    const { app } = setup();
    const res = await app.request("/memories");
    expect(res.status).toBe(401);
  });

  test("유효 토큰이면 통과", async () => {
    const { app, valid } = setup();
    const res = await app.request("/memories", {
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("잘못된 토큰은 401", async () => {
    const { app } = setup();
    // HTTP 헤더 값은 ASCII 범위만 허용되므로 ASCII 위조 토큰으로 검증한다.
    const res = await app.request("/memories", {
      headers: { Authorization: "Bearer totally-fake-token-xyz" },
    });
    expect(res.status).toBe(401);
  });

  test("Authorization 헤더 자체가 없으면 401", async () => {
    const { app } = setup();
    const res = await app.request("/memories");
    expect(res.status).toBe(401);
  });
});

describe("SSE 스트림 경로 — query token 폴백", () => {
  test("/events/stream 은 Bearer 헤더 없이 유효한 ?token= 만 있어도 통과", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/events/stream?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(200);
  });

  test("/events/stream 은 유효한 Bearer 헤더면 그대로 통과(기존 동작 유지)", async () => {
    const { app, valid } = setup();
    const res = await app.request("/events/stream", {
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("/events/stream 은 헤더·query 둘 다 없으면 401", async () => {
    const { app } = setup();
    const res = await app.request("/events/stream");
    expect(res.status).toBe(401);
  });

  test("/events/stream 은 query token 이 무효면 401", async () => {
    const { app } = setup();
    const res = await app.request("/events/stream?token=totally-fake-token-xyz");
    expect(res.status).toBe(401);
  });

  test("다른 보호 경로(/memories)는 유효한 ?token= query 가 있어도 401", async () => {
    // query token 폴백이 SSE 스트림 경로 하나로만 좁혀졌음을 확정하는 회귀 가드.
    const { app, valid } = setup();
    const res = await app.request(
      `/memories?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(401);
  });

  test("다른 보호 경로(/graph/overview)는 유효한 ?token= query 가 있어도 401", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/graph/overview?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(401);
  });

  test("/adapter-tokens 관리 경로는 토큰 없이 401", async () => {
    const { app } = setup();
    const res = await app.request("/adapter-tokens");
    expect(res.status).toBe(401);
  });

  test("/events/stream 401 응답 본문에 query token 값이 들어가지 않는다", async () => {
    const { app } = setup();
    const sentinel = "secret-stream-token-sentinel-xyz";
    const res = await app.request(`/events/stream?token=${sentinel}`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(sentinel);
  });
});

describe("정리제안·entity-types 경로 — 보호 경로 확인 (B1·B2 배선 대상)", () => {
  // 대시보드가 tokenFetch(Bearer)로 불러야 통과하는 보호 경로임을 확정한다. 무토큰
  // 은 401(= 옛 raw fetch 가 먹통이던 원인). query token 폴백은 이 경로에 안 걸린다.

  test("무토큰 GET /cleanup-proposals → 401 (옛 raw fetch 먹통 원인)", async () => {
    const { app } = setup();
    const res = await app.request("/cleanup-proposals?status=pending&limit=20");
    expect(res.status).toBe(401);
  });

  test("유효 Bearer GET /cleanup-proposals → 200", async () => {
    const { app, valid } = setup();
    const res = await app.request("/cleanup-proposals?status=pending&limit=20", {
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("유효 Bearer POST /cleanup-proposals/:id/:action → 200", async () => {
    const { app, valid } = setup();
    const res = await app.request("/cleanup-proposals/abc/approve", {
      method: "POST",
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("무토큰 POST /cleanup-proposals/:id/:action → 401", async () => {
    const { app } = setup();
    const res = await app.request("/cleanup-proposals/abc/approve", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("무토큰 GET /api/entity-types → 401 (B2 같은 계열 결함)", async () => {
    const { app } = setup();
    const res = await app.request("/api/entity-types");
    expect(res.status).toBe(401);
  });

  test("유효 Bearer GET /api/entity-types → 200", async () => {
    const { app, valid } = setup();
    const res = await app.request("/api/entity-types", {
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("회귀: /cleanup-proposals?token=유효 는 여전히 401 (이미지 폴백이 안 샌다)", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/cleanup-proposals?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(401);
  });
});

describe("이미지 자산 경로 — query token 폴백 (B4)", () => {
  // 정확 sha256 양식(64 자 소문자 hex) 경로만 폴백을 받는다. SSE 스트림 폴백과 대칭.
  const SHA = "a".repeat(64);

  test("/thumbs/{sha} 는 유효한 ?token= 만 있어도 통과 (Bearer 헤더 없이)", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/thumbs/${SHA}?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(200);
  });

  test("/assets/{sha} 는 유효한 ?token= 만 있어도 통과 (Bearer 헤더 없이)", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/assets/${SHA}?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(200);
  });

  test("/thumbs/{sha} 는 ?token= 이 무효면 401", async () => {
    const { app } = setup();
    const res = await app.request(`/thumbs/${SHA}?token=totally-fake-token-xyz`);
    expect(res.status).toBe(401);
  });

  test("/thumbs/{sha} 는 헤더·query 둘 다 없으면 401", async () => {
    const { app } = setup();
    const res = await app.request(`/thumbs/${SHA}`);
    expect(res.status).toBe(401);
  });

  test("/thumbs/{sha} 는 유효한 Bearer 헤더면 그대로 통과", async () => {
    const { app, valid } = setup();
    const res = await app.request(`/thumbs/${SHA}`, {
      headers: { Authorization: `Bearer ${valid}` },
    });
    expect(res.status).toBe(200);
  });

  test("짧은 sha(양식 미달) 경로는 폴백 미적용 — 유효 ?token= 여도 401", async () => {
    // /thumbs/abc123?token=유효 → 정확 양식 아님 → query 폴백 안 받고 Bearer 필수 → 401.
    const { app, valid } = setup();
    const res = await app.request(
      `/thumbs/abc123?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(401);
  });

  test("대문자 sha(양식 미달) 경로는 폴백 미적용 — 유효 ?token= 여도 401", async () => {
    const { app, valid } = setup();
    const upper = "A".repeat(64);
    const res = await app.request(
      `/thumbs/${upper}?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(401);
  });

  test("회귀 핵심: /memories?token=유효 는 여전히 401 (이미지 폴백이 다른 보호 경로로 안 샌다)", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/memories?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(401);
  });

  test("회귀: /events/stream?token=유효 는 여전히 통과 (기존 SSE 폴백 유지)", async () => {
    const { app, valid } = setup();
    const res = await app.request(
      `/events/stream?token=${encodeURIComponent(valid)}`,
    );
    expect(res.status).toBe(200);
  });

  test("이미지 경로 401 응답 본문에 query token 값이 들어가지 않는다", async () => {
    const { app } = setup();
    const sentinel = "secret-image-token-sentinel-xyz";
    const res = await app.request(`/thumbs/${SHA}?token=${sentinel}`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(sentinel);
  });
});

describe("토큰 발급 경로 — loopback 제한", () => {
  test("비-loopback 주소에서 /dashboard/sse-token 요청 → 403", async () => {
    const { app } = setup("10.0.0.5");
    const res = await app.request("/dashboard/sse-token");
    expect(res.status).toBe(403);
  });

  test("loopback에서 Authorization 생략으로 full 토큰을 발급받을 수 없다", async () => {
    const { app } = setup("127.0.0.1");
    const res = await app.request("/dashboard/sse-token");
    expect(res.status).toBe(401);
  });

  test("loopback(::1)에서 /dashboard/sse-token 요청 → 통과", async () => {
    const { app, valid } = setup("::1");
    const res = await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${valid}` } });
    expect(res.status).toBe(200);
  });

  test("loopback(::ffff:127.0.0.1)에서 /dashboard/sse-token 요청 → 통과", async () => {
    const { app, valid } = setup("::ffff:127.0.0.1");
    const res = await app.request("/dashboard/sse-token", { headers: { Authorization: `Bearer ${valid}` } });
    expect(res.status).toBe(200);
  });

  test("loopback 에서도 /bot/sse-token 은 더 이상 직접 발급 경로가 아니다", async () => {
    const { app } = setup("127.0.0.1");
    const res = await app.request("/bot/sse-token");
    expect(res.status).toBe(401);
  });

  test("loopback 에서도 /ocr-companion/token 은 더 이상 직접 발급 경로가 아니다", async () => {
    const { app } = setup("127.0.0.1");
    const res = await app.request("/ocr-companion/token");
    expect(res.status).toBe(401);
  });
});

describe("MCP와 REST의 검증된 adapterId 컨텍스트 전파", () => {
  test("/mcp와 REST 모두 검증된 호출자 ID를 전달한다(뒤 슬래시 포함)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-gate-mcp-"));
    const sseTokens = new SseTokenStore(join(dir, "tokens.json"));
    const token = sseTokens.issueToken("claude-code");
    // 운영 조립(server.ts)과 같은 strict:false — "/mcp/" 도 라우트에 도달한다.
    const app = new Hono({ strict: false });
    app.use(
      "*",
      createAuthGate({
        sseTokens,
        remoteAddrOf: () => "127.0.0.1",
        getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
      }),
    );
    const seen: Array<string | undefined> = [];
    app.all("/mcp", (c) => {
      seen.push(c.get(MCP_ADAPTER_ID_VAR) as string | undefined);
      return c.json({ ok: true });
    });
    app.get("/memories", (c) => {
      seen.push(c.get(MCP_ADAPTER_ID_VAR) as string | undefined);
      return c.json({ ok: true });
    });
    await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/mcp/", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/memories", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(seen).toEqual(["claude-code", "claude-code", "claude-code"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("보안 — 토큰 값 비노출", () => {
  test("401 응답 본문에 토큰 값이 들어가지 않는다", async () => {
    const { app } = setup();
    // HTTP 헤더 값은 ASCII 범위만 허용된다. 응답 본문에 이 값이 그대로 노출되면 안 된다.
    const secretish = "secret-sentinel-value-abc123";
    const res = await app.request("/memories", {
      headers: { Authorization: `Bearer ${secretish}` },
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(secretish);
  });

  test("403 응답 본문에 원격 주소 이외 민감 정보가 들어가지 않는다", async () => {
    const { app } = setup("10.0.0.5");
    const res = await app.request("/dashboard/sse-token");
    expect(res.status).toBe(403);
    const body = await res.text();
    // 403 응답은 고정 메시지만 포함해야 한다.
    expect(body).toContain("로컬에서만");
  });
});
