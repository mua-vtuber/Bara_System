/**
 * 어댑터 토큰 승인 큐 라우트 테스트.
 *
 * 실 SseTokenStore + 임시 파일을 사용한다. 요청/승인/픽업/회수 흐름만 검증하므로
 * DB나 외부 어댑터는 만들지 않는다. 권한이 걸린 흐름은 실제 인증 게이트를 앞에 둔
 * 앱(guardedApp)으로, 클라이언트 계약은 Bun.serve 위 실제 HTTP 로 확인한다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore } from "../../federation/sse-tokens.ts";
import { ADAPTER_ENROLL_ERROR_CODES, ADAPTER_ENROLL_LIMITS } from "../../federation/adapter-enroll-limits.ts";
import { ClientRateLimiter } from "../client-rate-limiter.ts";
import { Hono } from "hono";
import { MemoryApiClient } from "../../api-client.ts";
import { createAuthGate } from "../auth-gate.ts";
import { createAdapterTokenRoutes } from "./adapter-tokens.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";

let dir: string;
let tokenPath: string;
let tokens: SseTokenStore;
let app: ReturnType<typeof createAdapterTokenRoutes>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adapter-token-routes-"));
  tokenPath = join(dir, "tokens.json");
  tokens = new SseTokenStore(tokenPath);
  app = createAdapterTokenRoutes({
    sseTokens: tokens,
    remoteAddrOf: () => "10.0.0.8",
  });
});

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

/** 운영 조립과 같은 순서 — 인증 게이트 뒤에 어댑터 토큰 라우트. */
function guardedApp(): Hono {
  const guarded = new Hono({ strict: false });
  guarded.use(
    "*",
    createAuthGate({
      sseTokens: tokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  guarded.route("/", app);
  return guarded;
}

async function enroll(): Promise<{
  adapterId: string;
  requestId: string;
  pickupSecret: string;
}> {
  const res = await app.request("/adapter-enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adapterId: "bot-discord",
      displayName: "Discord Bot",
      endpoint: "http://127.0.0.1:3100",
    }),
  });
  expect(res.status).toBe(202);
  return (await res.json()) as {
    adapterId: string;
    requestId: string;
    pickupSecret: string;
  };
}

describe("POST /adapter-enroll", () => {
  test("등록 요청은 scope를 직접 지정할 수 없다", async () => {
    const res = await app.request("/adapter-enroll", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapterId: "untrusted", scope: "full" }),
    });
    expect(res.status).toBe(400);
    expect(tokens.listTokenRequests()).toHaveLength(0);
  });
  test("토큰 요청을 pending 으로 만든다", async () => {
    const body = await enroll();
    expect(body.adapterId).toBe("bot-discord");
    expect(body.requestId).toMatch(/^atr_/);
    expect(body.pickupSecret.length).toBeGreaterThan(0);

    const list = await app.request("/adapter-tokens");
    const listed = (await list.json()) as {
      requests: Array<{ adapterId: string; status: string; remoteAddr: string }>;
    };
    expect(listed.requests).toHaveLength(1);
    expect(listed.requests[0]).toMatchObject({
      adapterId: "bot-discord",
      status: "pending",
      remoteAddr: "10.0.0.8",
    });
  });

  test("adapterId 양식이 틀리면 400", async () => {
    const res = await app.request("/adapter-enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapterId: "Bad Adapter!" }),
    });
    expect(res.status).toBe(400);
  });

  test("같은 adapterId 무인증 재신청은 409 — 기존 pending 은 그대로 남아 회수할 수 있다", async () => {
    const first = await enroll();
    const res = await app.request("/adapter-enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapterId: "bot-discord", displayName: "Impostor" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe(ADAPTER_ENROLL_ERROR_CODES.pendingExists);
    expect(body.error).toContain("bot-discord");
    // 먼저 와 있는 요청이 남의 것일 수 있다 — 승인하라가 아니라 본인 것인지 확인하라고 안내한다.
    expect(body.error).toContain("본인 요청인지");

    const list = (await (await app.request("/adapter-tokens")).json()) as {
      requests: Array<{ requestId: string; status: string; displayName: string }>;
    };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({ requestId: first.requestId, status: "pending", displayName: "Discord Bot" });

    const stillPending = await app.request(
      `/adapter-enroll/${first.requestId}/token?pickupSecret=${encodeURIComponent(first.pickupSecret)}`,
    );
    expect(stillPending.status).toBe(202);
  });

  test("대기 요청 상한에 닿으면 429 + ADAPTER_ENROLL_PENDING_LIMIT, 파일은 다시 쓰지 않는다", async () => {
    const limited = new SseTokenStore(tokenPath, { ...ADAPTER_ENROLL_LIMITS, maxPendingRequests: 2 });
    const limitedApp = createAdapterTokenRoutes({ sseTokens: limited, remoteAddrOf: () => "10.0.0.8" });
    const post = (adapterId: string) => limitedApp.request("/adapter-enroll", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapterId }),
    });
    expect((await post("adapter-a")).status).toBe(202);
    expect((await post("adapter-b")).status).toBe(202);
    const before = readFileSync(tokenPath, "utf8");
    const refused = await post("adapter-c");
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: string; code: string };
    expect(body.code).toBe(ADAPTER_ENROLL_ERROR_CODES.pendingLimit);
    expect(body.error).toContain("2개");
    expect(readFileSync(tokenPath, "utf8")).toBe(before);
  });

  test("한 주소의 대기 요청이 주소별 상한에 닿으면 429 + ADAPTER_ENROLL_ADDRESS_PENDING_LIMIT", async () => {
    const post = (adapterId: string) => app.request("/adapter-enroll", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapterId }),
    });
    for (let i = 0; i < ADAPTER_ENROLL_LIMITS.maxPendingPerAddress; i++) {
      expect((await post(`adapter-${i}`)).status).toBe(202);
    }
    const refused = await post("adapter-extra");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe(ADAPTER_ENROLL_ERROR_CODES.addressPendingLimit);
  });

  test("같은 주소의 요청 빈도 상한을 넘으면 본문을 읽기 전에 429 + Retry-After, 다른 주소는 통과", async () => {
    let nowMs = 1_000_000;
    let remote = "203.0.113.5";
    const limiter = new ClientRateLimiter(
      { maxRequestsPerWindow: 2, windowMs: 60_000, maxTrackedClients: 100 },
      () => nowMs,
    );
    const limitedApp = createAdapterTokenRoutes({ sseTokens: tokens, remoteAddrOf: () => remote, enrollRateLimiter: limiter });
    const post = (adapterId: string) => limitedApp.request("/adapter-enroll", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapterId }),
    });
    expect((await post("adapter-a")).status).toBe(202);
    expect((await post("adapter-b")).status).toBe(202);
    const refused = await limitedApp.request("/adapter-enroll", {
      method: "POST", headers: { "content-type": "application/json" }, body: "not json",
    });
    // 깨진 본문이어도 400 이 아니라 429 — 빈도 검사가 본문 해석보다 먼저다.
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    const body = (await refused.json()) as { error: string; code: string };
    expect(body.code).toBe(ADAPTER_ENROLL_ERROR_CODES.rateLimited);
    expect(tokens.listTokenRequests()).toHaveLength(2);

    remote = "203.0.113.6";
    expect((await post("adapter-c")).status).toBe(202);

    remote = "203.0.113.5";
    nowMs += 60_000;
    expect((await post("adapter-d")).status).toBe(202);
  });

  test("수명이 지나 지워진 요청의 pickup 은 404 이고 다시 시작하라고 알린다", async () => {
    const first = await enroll();
    const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
    stored.requests[first.requestId].createdAt = new Date(Date.now() - ADAPTER_ENROLL_LIMITS.pendingTtlMs - 1).toISOString();
    writeFileSync(tokenPath, JSON.stringify(stored));
    const reloaded = new SseTokenStore(tokenPath);
    const reloadedApp = createAdapterTokenRoutes({ sseTokens: reloaded, remoteAddrOf: () => "10.0.0.8" });
    const res = await reloadedApp.request(
      `/adapter-enroll/${first.requestId}/token?pickupSecret=${encodeURIComponent(first.pickupSecret)}`,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("다시 시작");
  });
});

describe("권한 관리 — 실제 인증 게이트", () => {
  test("full만 권한을 변경하고 제한 토큰은 자기 권한을 올릴 수 없다", async () => {
    const owner = tokens.issueToken("owner");
    const reader = tokens.issueToken("reader", "http://localhost:3100", "local-admin", "read-only");
    const guarded = guardedApp();
    const change = (token: string, scope: string) => guarded.request("/adapter-tokens/reader/scope/", {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    expect((await change(reader, "full")).status).toBe(403);
    expect((await change(owner, "mcp-standard")).status).toBe(200);
    expect(new SseTokenStore(tokenPath).getTokenScope("reader")).toBe("mcp-standard");
    expect(tokens.getAdapterAdminToken("reader")).toBe("local-admin");
    expect((await change(owner, "invalid")).status).toBe(400);
  });

  test("full 승인자가 scope를 선택하고 목록에 토큰 없이 scope를 표시한다", async () => {
    const owner = tokens.issueToken("owner");
    const pending = await enroll();
    const guarded = guardedApp();
    const approved = await guarded.request(`/adapter-tokens/${pending.requestId}/approve`, {
      method: "POST", headers: { Authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "read-only" }),
    });
    expect(approved.status).toBe(200);
    expect(tokens.getTokenScope("bot-discord")).toBe("read-only");
    const listed = await guarded.request("/adapter-tokens", { headers: { Authorization: `Bearer ${owner}` } });
    const body = await listed.json() as { issued: Array<{ adapterId: string; scope: string; token?: string }> };
    expect(body.issued.find((entry) => entry.adapterId === "bot-discord")).toMatchObject({ scope: "read-only" });
    expect(JSON.stringify(body)).not.toContain(owner);
  });
});

describe("승인 전/후 pickup", () => {
  test("승인 전 pickup 은 202 pending 이고 토큰을 숨긴다", async () => {
    const req = await enroll();
    const res = await app.request(
      `/adapter-enroll/${req.requestId}/token?pickupSecret=${encodeURIComponent(
        req.pickupSecret,
      )}`,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; token?: string };
    expect(body.status).toBe("pending");
    expect(body.token).toBeUndefined();
  });

  test("대시보드 승인 후 pickup 이 토큰을 반환하고 Bearer 검증에 통과한다", async () => {
    const req = await enroll();
    const approve = await app.request(`/adapter-tokens/${req.requestId}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);

    const pickup = await app.request(
      `/adapter-enroll/${req.requestId}/token?pickupSecret=${encodeURIComponent(
        req.pickupSecret,
      )}`,
    );
    expect(pickup.status).toBe(200);
    const body = (await pickup.json()) as {
      status: string;
      adapterId: string;
      token: string;
    };
    expect(body.status).toBe("approved");
    expect(body.adapterId).toBe("bot-discord");
    expect(tokens.verifyToken(body.token)).toBe("bot-discord");
  });

  test("pickupSecret 이 틀리면 404 이고 토큰 값은 없다", async () => {
    const req = await enroll();
    await app.request(`/adapter-tokens/${req.requestId}/approve`, { method: "POST" });
    const res = await app.request(
      `/adapter-enroll/${req.requestId}/token?pickupSecret=wrong-secret`,
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("bot-discord");
  });

  test("거절 후 pickup 은 403", async () => {
    const req = await enroll();
    const reject = await app.request(`/adapter-tokens/${req.requestId}/reject`, {
      method: "POST",
    });
    expect(reject.status).toBe(200);

    const pickup = await app.request(
      `/adapter-enroll/${req.requestId}/token?pickupSecret=${encodeURIComponent(
        req.pickupSecret,
      )}`,
    );
    expect(pickup.status).toBe(403);
  });
});

describe("재등록 자동 승인 (기존 토큰 소유 증명)", () => {
  async function enrollWith(endpoint?: string, existingToken?: string): Promise<Response> {
    return app.request("/adapter-enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "bot-discord",
        displayName: "Discord Bot",
        ...(endpoint !== undefined ? { endpoint } : {}),
        existingToken,
      }),
    });
  }

  test("최초 등록은 pending, 승인 뒤 기존 토큰을 증명한 재등록은 approved + 즉시 토큰", async () => {
    const endpoint = "http://127.0.0.1:3100";
    // 최초 enroll → 202 pending.
    const firstRes = await enrollWith(endpoint);
    expect(firstRes.status).toBe(202);
    const first = (await firstRes.json()) as {
      status: string;
      requestId: string;
      pickupSecret: string;
    };
    expect(first.status).toBe("pending");

    // 대시보드 승인 + pickup → 첫 토큰.
    await app.request(`/adapter-tokens/${first.requestId}/approve`, {
      method: "POST",
    });
    const firstPickup = await app.request(
      `/adapter-enroll/${first.requestId}/token?pickupSecret=${encodeURIComponent(
        first.pickupSecret,
      )}`,
    );
    const firstToken = ((await firstPickup.json()) as { token: string }).token;

    // 기존 토큰을 증명한 재등록 → 200 approved.
    const secondRes = await enrollWith(endpoint, firstToken);
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as {
      status: string;
      requestId: string;
      pickupSecret: string;
    };
    expect(second.status).toBe("approved");

    // 즉시 pickup → 첫 토큰과 동일(멱등).
    const secondPickup = await app.request(
      `/adapter-enroll/${second.requestId}/token?pickupSecret=${encodeURIComponent(
        second.pickupSecret,
      )}`,
    );
    expect(secondPickup.status).toBe(200);
    const secondBody = (await secondPickup.json()) as {
      status: string;
      token: string;
    };
    expect(secondBody.status).toBe("approved");
    expect(secondBody.token).toBe(firstToken);
    expect(tokens.verifyToken(secondBody.token)).toBe("bot-discord");
  });

  test("다른 endpoint 재enroll → 202 pending 유지(자동승인 안 됨)", async () => {
    const first = (await (await enrollWith("http://127.0.0.1:3100")).json()) as {
      requestId: string;
      pickupSecret: string;
    };
    await app.request(`/adapter-tokens/${first.requestId}/approve`, {
      method: "POST",
    });
    await app.request(
      `/adapter-enroll/${first.requestId}/token?pickupSecret=${encodeURIComponent(
        first.pickupSecret,
      )}`,
    );

    const secondRes = await enrollWith("http://127.0.0.1:9999");
    expect(secondRes.status).toBe(202);
    const second = (await secondRes.json()) as { status: string };
    expect(second.status).toBe("pending");
  });

  test("자동 승인 응답에 토큰 값 노출 0", async () => {
    const endpoint = "http://127.0.0.1:3100";
    const first = (await (await enrollWith(endpoint)).json()) as {
      requestId: string;
      pickupSecret: string;
    };
    await app.request(`/adapter-tokens/${first.requestId}/approve`, {
      method: "POST",
    });
    const firstPickup = await app.request(
      `/adapter-enroll/${first.requestId}/token?pickupSecret=${encodeURIComponent(
        first.pickupSecret,
      )}`,
    );
    const firstToken = ((await firstPickup.json()) as { token: string }).token;

    const secondRes = await enrollWith(endpoint, firstToken);
    const text = await secondRes.text();
    // enroll 응답(자동승인)에는 토큰 값이 들어가지 않는다 — pickupSecret 만.
    expect(text).not.toContain(firstToken);
  });
});

describe("POST /adapter-enroll — 봇 관리 토큰 등록 (P1-통합 I1)", () => {
  async function enrollWithAdmin(
    adminToken: string,
    endpoint = "http://127.0.0.1:3100",
  ): Promise<Response> {
    return app.request("/adapter-enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "bot-discord",
        displayName: "Discord Bot",
        endpoint,
        adminToken,
      }),
    });
  }

  test("adminToken 을 body 에서 읽어 store 에 등록한다 (승인 후 조회 가능)", async () => {
    const res = await enrollWithAdmin("ADMIN-XYZ");
    expect(res.status).toBe(202);
    const body = (await res.json()) as { requestId: string };

    // 승인 → 관리 토큰이 발급 메타로 전파돼 조회된다.
    await app.request(`/adapter-tokens/${body.requestId}/approve`, {
      method: "POST",
    });
    expect(tokens.getAdapterAdminToken("bot-discord")).toBe("ADMIN-XYZ");
  });

  test("adminToken 없는 enroll 은 기존대로 동작하고 관리 토큰은 null (하위 호환)", async () => {
    // enroll() 헬퍼는 이미 파싱된 요청 정보를 반환한다.
    const { requestId } = await enroll();
    await app.request(`/adapter-tokens/${requestId}/approve`, {
      method: "POST",
    });
    expect(tokens.getAdapterAdminToken("bot-discord")).toBeNull();
  });

  test("existingToken 이 같은 adapterId 토큰이면 승인 대기 없이 관리 토큰을 재등록한다", async () => {
    const existingToken = tokens.issueToken("bot-discord");
    const res = await app.request("/adapter-enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "bot-discord",
        displayName: "Discord Bot",
        endpoint: "http://127.0.0.1:3100",
        existingToken,
        adminToken: "ADMIN-XYZ",
      }),
    });
    expect(res.status).toBe(200);
    const enrolled = (await res.json()) as {
      status: "approved";
      requestId: string;
      pickupSecret: string;
    };
    expect(enrolled.status).toBe("approved");

    const picked = await app.request(
      `/adapter-enroll/${enrolled.requestId}/token?pickupSecret=${encodeURIComponent(
        enrolled.pickupSecret,
      )}`,
    );
    const pickedBody = (await picked.json()) as { token: string };
    expect(pickedBody.token).toBe(existingToken);
    expect(tokens.getAdapterAdminToken("bot-discord")).toBe("ADMIN-XYZ");
  });

  test("enroll 응답에 관리 토큰 값이 노출되지 않는다", async () => {
    const res = await enrollWithAdmin("SECRET-ADMIN-VALUE");
    const text = await res.text();
    expect(text).not.toContain("SECRET-ADMIN-VALUE");

    // 대시보드 요청 목록에도 없다.
    const list = await app.request("/adapter-tokens");
    const listText = await list.text();
    expect(listText).not.toContain("SECRET-ADMIN-VALUE");
  });
});

describe("GET/DELETE /adapter-tokens", () => {
  test("발급 목록은 dashboard 토큰과 토큰 값을 숨긴다", async () => {
    const dashboard = tokens.issueToken("dashboard");
    const bot = tokens.issueToken("bot-discord");

    const res = await app.request("/adapter-tokens");
    const body = (await res.json()) as {
      issued: Array<{ adapterId: string }>;
    };
    expect(body.issued.map((i) => i.adapterId)).toEqual(["bot-discord"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(dashboard);
    expect(text).not.toContain(bot);
  });

  test("DELETE 는 어댑터 토큰을 회수하고 dashboard 회수는 막는다", async () => {
    const token = tokens.issueToken("bot-discord");
    const removed = await app.request("/adapter-tokens/bot-discord", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(tokens.verifyToken(token)).toBeNull();

    tokens.issueToken("dashboard");
    const dash = await app.request("/adapter-tokens/dashboard", {
      method: "DELETE",
    });
    expect(dash.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// WP-B1-13 — 요청 권한 표시, 기존 어댑터 재등록 공유/교체 선택 (CR-0·SA-2)
// ---------------------------------------------------------------------------

describe("관리 어댑터 권한 — 요청 권한 표시와 재등록 공유·교체", () => {
  interface ListedScope { scope: string; legacyScope: boolean }
  interface ListedBody {
    issued: Array<{ adapterId: string } & ListedScope>;
    requests: Array<{ adapterId: string; requestedScope: string | null; existingAdapter: ListedScope | null }>;
  }
  interface Enrolled { status: string; requestId: string; pickupSecret: string }

  async function enrollAs(adapterId: string, extra: Record<string, unknown> = {}) {
    const res = await app.request("/adapter-enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapterId, displayName: adapterId, ...extra }),
    });
    return { res, body: (await res.json()) as Enrolled };
  }

  function approveAs(guarded: Hono, token: string, requestId: string, body?: unknown) {
    return guarded.request(`/adapter-tokens/${requestId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  function pickup(req: Enrolled) {
    return app.request(
      `/adapter-enroll/${req.requestId}/token?pickupSecret=${encodeURIComponent(req.pickupSecret)}`,
    );
  }

  async function pickedToken(req: Enrolled): Promise<string> {
    const res = await pickup(req);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  async function listAs(guarded: Hono, token: string): Promise<{ text: string; body: ListedBody }> {
    const res = await guarded.request("/adapter-tokens", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, body: JSON.parse(text) as ListedBody };
  }

  test("실제 HTTP 등록의 requestedScope 가 목록에 표시되고, scope 생략 승인은 그 값을 쓰지 않는다", async () => {
    const owner = tokens.issueToken("owner");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: guardedApp().fetch });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const enrolled = await new MemoryApiClient(base).enrollAdapterToken({
        adapterId: "ocr-companion",
        displayName: "OCR companion",
        requestedScope: "full",
      });
      expect(enrolled.status).toBe("pending");
      const auth = { Authorization: `Bearer ${owner}` };
      const listed = (await (await fetch(`${base}/adapter-tokens`, { headers: auth })).json()) as ListedBody;
      expect(listed.requests).toEqual([
        expect.objectContaining({ adapterId: "ocr-companion", requestedScope: "full", existingAdapter: null }),
      ]);
      const approved = await fetch(`${base}/adapter-tokens/${enrolled.requestId}/approve`, {
        method: "POST",
        headers: auth,
      });
      expect(approved.status).toBe(200);
      expect(tokens.getIssuedTokenScope("ocr-companion")).toEqual({ scope: "mcp-standard", legacyScope: false });
    } finally {
      server.stop(true);
    }
  });

  test("잘못된 requestedScope 는 400 이고 scope 자기 지정 거부는 그대로다", async () => {
    expect((await enrollAs("bot-discord", { requestedScope: "admin" })).res.status).toBe(400);
    expect((await enrollAs("bot-discord", { requestedScope: "full", scope: "full" })).res.status).toBe(400);
    expect(tokens.listTokenRequests()).toHaveLength(0);
  });

  test("목록은 기존 어댑터 요청의 현재 권한·옛 토큰 여부와 발급 행 legacyScope 를 보이고 비밀값은 싣지 않는다", async () => {
    const owner = tokens.issueToken("owner");
    const legacyBot = tokens.issueToken("bot-discord", "http://127.0.0.1:3100", "BOT-ADMIN-SECRET");
    const reader = tokens.issueToken("reader", undefined, undefined, "read-only");
    const botReq = await enrollAs("bot-discord", { requestedScope: "full", adminToken: "NEW-ADMIN-SECRET" });
    const readerReq = await enrollAs("reader", { requestedScope: "mcp-standard" });
    const freshReq = await enrollAs("fresh-ai");

    const { text, body } = await listAs(guardedApp(), owner);
    const request = (id: string) => body.requests.find((entry) => entry.adapterId === id);
    const issued = (id: string) => body.issued.find((entry) => entry.adapterId === id);
    expect(request("bot-discord")).toMatchObject({
      requestedScope: "full", existingAdapter: { scope: "full", legacyScope: true },
    });
    expect(request("reader")).toMatchObject({
      requestedScope: "mcp-standard", existingAdapter: { scope: "read-only", legacyScope: false },
    });
    expect(request("fresh-ai")).toMatchObject({ requestedScope: null, existingAdapter: null });
    expect(issued("bot-discord")).toMatchObject({ scope: "full", legacyScope: true });
    expect(issued("reader")).toMatchObject({ scope: "read-only", legacyScope: false });
    const secrets = [
      owner, legacyBot, reader, botReq.body.pickupSecret, readerReq.body.pickupSecret,
      freshReq.body.pickupSecret, "BOT-ADMIN-SECRET", "NEW-ADMIN-SECRET",
    ];
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain("pickupSecretHash");
  });

  test("share 승인은 같은 토큰, rotate 승인은 새 토큰·옛 토큰 401·다른 approved 요청 거절", async () => {
    const owner = tokens.issueToken("owner");
    const original = tokens.issueToken("bot-discord", "http://127.0.0.1:3100");
    const guarded = guardedApp();
    // 기존 봇의 자동 재등록 요청(approved) — rotate 뒤 옛 요청자는 새 토큰을 받지 못해야 한다.
    const auto = await enrollAs("bot-discord", { existingToken: original });
    expect(auto.body.status).toBe("approved");

    const shareReq = await enrollAs("bot-discord");
    expect((await approveAs(guarded, owner, shareReq.body.requestId, { existingToken: "share" })).status).toBe(200);
    expect(await pickedToken(shareReq.body)).toBe(original);

    const rotateReq = await enrollAs("bot-discord", { requestedScope: "full" });
    expect((await approveAs(guarded, owner, rotateReq.body.requestId, { existingToken: "rotate" })).status).toBe(200);
    const rotated = await pickedToken(rotateReq.body);
    expect(rotated).not.toBe(original);
    const listWith = (token: string) =>
      guarded.request("/adapter-tokens", { headers: { Authorization: `Bearer ${token}` } });
    expect((await listWith(original)).status).toBe(401);
    expect((await listWith(rotated)).status).toBe(200);
    expect((await pickup(auto.body)).status).toBe(403);
    expect((await pickup(shareReq.body)).status).toBe(403);
  });

  test("scope 생략 승인은 현행과 같다 — 새 어댑터 mcp-standard, 옛 토큰 어댑터는 같은 토큰·full", async () => {
    const owner = tokens.issueToken("owner");
    const legacy = tokens.issueToken("bot-discord");
    const guarded = guardedApp();
    const fresh = await enrollAs("fresh-ai", { requestedScope: "full" });
    expect((await approveAs(guarded, owner, fresh.body.requestId)).status).toBe(200);
    expect(tokens.getIssuedTokenScope("fresh-ai")).toEqual({ scope: "mcp-standard", legacyScope: false });

    const again = await enrollAs("bot-discord", { requestedScope: "read-only" });
    expect((await approveAs(guarded, owner, again.body.requestId)).status).toBe(200);
    expect(await pickedToken(again.body)).toBe(legacy);
    expect(tokens.getIssuedTokenScope("bot-discord")).toEqual({ scope: "full", legacyScope: true });
  });

  test("Pet 설치기 형식 승인(scope mcp-standard 한 칸)은 새 pet 과 기존 pet 모두 성공하고 토큰을 공유한다", async () => {
    const owner = tokens.issueToken("owner");
    const guarded = guardedApp();
    const first = await enrollAs("pet");
    expect((await approveAs(guarded, owner, first.body.requestId, { scope: "mcp-standard" })).status).toBe(200);
    const petToken = await pickedToken(first.body);
    const second = await enrollAs("pet");
    expect((await approveAs(guarded, owner, second.body.requestId, { scope: "mcp-standard" })).status).toBe(200);
    expect(await pickedToken(second.body)).toBe(petToken);
    expect(tokens.getIssuedTokenScope("pet")).toEqual({ scope: "mcp-standard", legacyScope: false });
  });

  test("승인 body 검증 — existingToken 값 오류 400(값 미노출), 새 어댑터 지정 409, 제한 토큰 403", async () => {
    const owner = tokens.issueToken("owner");
    const standard = tokens.issueToken("ai-x", undefined, undefined, "mcp-standard");
    tokens.issueToken("bot-discord");
    const guarded = guardedApp();
    const botReq = await enrollAs("bot-discord");
    const bad = await approveAs(guarded, owner, botReq.body.requestId, { existingToken: "stolen-token-value" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("stolen-token-value");

    const fresh = await enrollAs("fresh-ai");
    expect((await approveAs(guarded, owner, fresh.body.requestId, { existingToken: "rotate" })).status).toBe(409);
    expect(tokens.getTokenRequest(fresh.body.requestId)?.status).toBe("pending");
    expect(tokens.getIssuedTokenScope("fresh-ai")).toBeNull();

    expect((await approveAs(guarded, standard, botReq.body.requestId, { existingToken: "rotate" })).status).toBe(403);
    // 게이트 없이 라우트만 마운트해도 full 확인 없는 공유·교체 지정은 거부한다.
    const ungated = await app.request(`/adapter-tokens/${botReq.body.requestId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ existingToken: "share" }),
    });
    expect(ungated.status).toBe(403);
    expect(tokens.getTokenRequest(botReq.body.requestId)?.status).toBe("pending");
  });

  test("운영 Discord 봇 옛 토큰은 배포 뒤 재시작 재등록(requestedScope full 포함)에도 같은 토큰·full 로 남는다", async () => {
    const legacy = tokens.issueToken("bot-discord", "http://127.0.0.1:3100");
    const guarded = guardedApp();
    const restart = await enrollAs("bot-discord", {
      endpoint: "http://127.0.0.1:3100", existingToken: legacy, requestedScope: "full",
    });
    expect(restart.res.status).toBe(200);
    expect(restart.body.status).toBe("approved");
    expect(await pickedToken(restart.body)).toBe(legacy);
    // full 전용 관리 경로가 계속 열린다 = 권한이 줄지 않았다.
    const { body } = await listAs(guarded, legacy);
    expect(body.issued.find((entry) => entry.adapterId === "bot-discord")).toMatchObject({
      scope: "full", legacyScope: true,
    });
  });
});
