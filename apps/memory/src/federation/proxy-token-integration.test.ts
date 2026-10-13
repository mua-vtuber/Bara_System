/**
 * P1-통합 T6 — 3단 관통 통합 테스트 (대시보드 → 코어 federation → 봇 admin-gate).
 *
 * 권위 spec: docs/decisions/2026-07-02-proxy-token-integration-spec.md (I7·I8)
 *
 * mock 객체 금지 — 실 SseTokenStore(임시 파일) + 실 봇 createHttpServer(host guard +
 * admin gate + 라우트) + 실 createAdapterApprovalTokenIssuer 로 봇 enroll 을 재현하고,
 * federation 프록시를 fetchImpl 로 봇 Hono app 에 연결한다. 봇 admin-gate 가 실제로
 * 401/200 을 판정해야 의미가 있다.
 *
 * fetchImpl 은 코어 프록시가 부르는 upstream URL(http://127.0.0.1:3100/...)을 봇
 * Hono app.request 로 변환하고 Host 헤더를 127.0.0.1:3100 으로 세팅한다 — 운영에서
 * loopback fetch 가 Host 를 자동으로 붙여 봇 host guard 를 통과하는 동작의 재현이다
 * (server-to-server 라 Origin 부재).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FederationRegistry } from "./registry.ts";
import { createFederationRoutes } from "./routes.ts";
import { SseTokenStore } from "./sse-tokens.ts";
import type { AppManifest } from "./manifest-schema.ts";
import { createAdapterTokenRoutes } from "../server-internal/routes/adapter-tokens.ts";
import { MemoryApiClient } from "../api-client.ts";

import { createHttpServer, BOT_HTTP_ENDPOINT } from "../../../bot-discord/src/http-server.ts";
import { createAdapterApprovalTokenIssuer } from "../../../bot-discord/src/sse-bootstrap.ts";
import { loadOrCreateAdminToken } from "../../../bot-discord/src/admin-token-store.ts";
import { ReloadBus } from "../../../bot-discord/src/reload-bus.ts";

const ADAPTER_ID = "bot-discord";

/** 코어 federation registry 에 넣을 봇 매니페스트(실 app.manifest.json 정합). */
function botManifest(): AppManifest {
  return {
    id: ADAPTER_ID,
    name: "디스코드 봇",
    version: "0.1.0",
    manifestVersion: 1,
    endpoint: BOT_HTTP_ENDPOINT,
    health: "/health",
    settings: {
      schemaPath: "/settings/schema",
      getPath: "/settings",
      putPath: "/settings",
    },
    actions: [
      {
        id: "verify-token",
        label: "토큰 검증",
        method: "POST",
        path: "/actions/verify-token",
        returns: "toast",
      },
      {
        id: "list-channels",
        label: "채널 목록",
        method: "GET",
        path: "/actions/list-channels",
        returns: "enum",
      },
    ],
  };
}

interface Harness {
  store: SseTokenStore;
  registry: FederationRegistry;
  federation: ReturnType<typeof createFederationRoutes>;
  botApp: ReturnType<typeof createHttpServer>;
  botFetchCalls: () => number;
  cleanup: () => void;
}

/**
 * 코어 저장소 + 코어 프록시 + 봇 app 을 fetchImpl 로 잇는 harness 를 만든다.
 * botAdminToken 을 주면 봇 admin-gate 가 그 토큰을 요구한다.
 */
function makeHarness(opts: { botSettingsPath: string; botAdminToken: string }): Harness {
  const storeDir = mkdtempSync(join(tmpdir(), "proxy-int-store-"));
  const tokenPath = join(storeDir, "sse-tokens.json");
  const store = new SseTokenStore(tokenPath);

  // 봇 app — 실 host guard + 실 admin gate + 실 라우트.
  const reloadBus = new ReloadBus();
  const botApp = createHttpServer({
    reloadBus,
    settingsPath: opts.botSettingsPath,
    adminToken: () => opts.botAdminToken,
  });

  // fetchImpl — upstream URL 을 봇 app.request 로 변환. Host 헤더를 세팅해 host
  // guard 를 통과시킨다(운영 loopback fetch 재현). Authorization 등 다른 헤더는
  // 코어 프록시가 실은 것을 그대로 전달한다.
  let botFetchCalls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    botFetchCalls += 1;
    const full = typeof url === "string" ? url : url.toString();
    const u = new URL(full);
    const path = `${u.pathname}${u.search}`;
    const headers = new Headers(init?.headers);
    headers.set("host", `${u.hostname}:${u.port}`);
    return botApp.request(path, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    });
  }) as typeof fetch;

  const registry = new FederationRegistry();
  registry.register(botManifest(), "/apps/bot-discord");
  registry.setHealth(ADAPTER_ID, "ok", 5);

  const federation = createFederationRoutes(registry, {
    adminTokenForAdapter: (id) => store.getAdapterAdminToken(id),
    proxyFetchImpl: fetchImpl,
  });

  return {
    store,
    registry,
    federation,
    botApp,
    botFetchCalls: () => botFetchCalls,
    cleanup: () => rmSync(storeDir, { recursive: true, force: true }),
  };
}

/**
 * 봇 enroll 을 재현한다 — 봇 issuer 가 실 코어 저장소 라우트에 enroll 요청(관리
 * 토큰 body 동봉)을 보내는 왕복을, 실 createAdapterTokenRoutes 를 issuer 의 client
 * fetch 로 감싸 그대로 재현한다. pending 이면 대시보드 approve 후 pickup, D6 자동
 * 승인이면 즉시 pickup — 관리 토큰이 코어 발급 메타에 도달할 때까지 진행한다.
 *
 * issuer 의 client fetch 를 라우트 app.request 로 감싸므로, 봇 sse-bootstrap 의
 * enrollAndMaybePickup 실 로직(adminToken 을 enroll body 에 싣는 배선)이 실제로
 * 실행된다 — 봇→코어 enroll 왕복의 진짜 재현이다(mock 아님).
 */
async function enrollBot(opts: {
  store: SseTokenStore;
  botAdminToken: string;
  botTokenStorePath: string;
}): Promise<void> {
  const routes = createAdapterTokenRoutes({
    sseTokens: opts.store,
    remoteAddrOf: () => "127.0.0.1",
  });

  // issuer 의 client 가 부르는 전역 fetch 를 코어 라우트 app.request 로 임시 교체한다
  // (loopback 재현 — routes.test.ts 의 전역 fetch stub 패턴 답습). 이렇게 하면
  // issuer 의 실 enroll/pickup 배선(adminToken 을 enroll body 에 싣는 코드)이 실제로
  // 실행돼 코어 라우트를 친다. 봇 프록시 fetchImpl(harness)과 별개 통로라 충돌 없음.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = typeof url === "string" ? url : url.toString();
    const u = new URL(full);
    return routes.request(`${u.pathname}${u.search}`, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
    });
  }) as typeof fetch;

  try {
    const issuer = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient("http://core.local"),
      adapterId: ADAPTER_ID,
      displayName: "디스코드 봇",
      endpoint: BOT_HTTP_ENDPOINT,
      adminToken: opts.botAdminToken,
      tokenStorePath: opts.botTokenStorePath,
    });

    // 첫 호출: enroll. pending 이면 throw(승인 대기) — 이때 요청이 코어에 저장됐다.
    // D6 자동 승인이면 즉시 토큰 반환(재enroll 시나리오).
    let issued = false;
    try {
      await issuer();
      issued = true;
    } catch {
      // pending — 대시보드 수동 승인 후 재호출로 pickup.
    }
    if (!issued) {
      const pending = opts.store.listTokenRequests("pending");
      if (pending.length > 0) {
        opts.store.approveTokenRequest(pending[0]!.requestId);
      }
      // 재호출 — 보관된 pending 요청을 pickup 해 토큰 회수(발급 메타 확정).
      await issuer();
    }
  } finally {
    globalThis.fetch = origFetch;
  }
}

let botStoreDir: string;
let botSettingsPath: string;
let botTokenStorePath: string;

beforeEach(() => {
  botStoreDir = mkdtempSync(join(tmpdir(), "proxy-int-bot-"));
  botSettingsPath = join(botStoreDir, "bot-settings.json");
  botTokenStorePath = join(botStoreDir, "bot-adapter-token.json");
});

afterEach(() => {
  rmSync(botStoreDir, { recursive: true, force: true });
});

describe("P1-통합 T6 — 3단 관통 (대시보드 → 코어 → 봇)", () => {
  test("시나리오 A(정상): enroll 후 GET /settings → 관리 토큰 부착 → 봇 200 관통", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      await enrollBot({ store: h.store, botAdminToken, botTokenStorePath });
      // 관리 토큰이 코어에 등록됐다.
      expect(h.store.getAdapterAdminToken(ADAPTER_ID)).toBe(botAdminToken);

      const res = await h.federation.request("/apps/bot-discord/settings");
      // 봇 admin-gate 통과 → 봇 GET /settings 200 관통.
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // 봇 settings 응답 형태 확인(마스킹된 값 + $usingDefaults).
      expect(body.$usingDefaults).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  test("시나리오 A(정상): PUT /settings → 관리 토큰 부착 → 봇 admin-gate 통과", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      await enrollBot({ store: h.store, botAdminToken, botTokenStorePath });
      const res = await h.federation.request("/apps/bot-discord/settings", {
        method: "PUT",
        body: JSON.stringify({ sseReconnectDelayMs: 5000 }),
        headers: { "content-type": "application/json" },
      });
      // 봇 admin-gate 통과 — 401 이 아니다. 봇 PUT /settings 는 검증·저장 후 200.
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("시나리오 B(등록 전): enroll 없이 PUT /settings → 코어 424, 봇에 요청 0", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      // enroll 하지 않는다 — 코어에 관리 토큰 없음.
      expect(h.store.getAdapterAdminToken(ADAPTER_ID)).toBeNull();
      const res = await h.federation.request("/apps/bot-discord/settings", {
        method: "PUT",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(424);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("관리 토큰");
      // 봇에 요청이 닿지 않았다(무토큰 401 세탁 아님).
      expect(h.botFetchCalls()).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("시나리오 C(schema): enroll 없이 GET /schema → 봇 무인증 200 (등록 전 폼 노출)", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      // 관리 토큰 미등록 상태에서도 schema 는 봇 무인증으로 통과해야 폼을 그린다.
      expect(h.store.getAdapterAdminToken(ADAPTER_ID)).toBeNull();
      const res = await h.federation.request("/apps/bot-discord/schema");
      expect(res.status).toBe(200);
      // 봇에 실제로 요청이 갔다(무인증 통과).
      expect(h.botFetchCalls()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("시나리오 D(액션): enroll 후 POST /actions/verify-token → 봇 admin-gate 통과(비401)", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      await enrollBot({ store: h.store, botAdminToken, botTokenStorePath });
      const res = await h.federation.request(
        "/apps/bot-discord/actions/verify-token",
        {
          method: "POST",
          body: JSON.stringify({ discordToken: "invalid-token" }),
          headers: { "content-type": "application/json" },
        },
      );
      // 관리 토큰이 부착돼 봇 admin-gate 를 통과했다 — 401 이 아니다.
      // (verify-token 은 Discord 실 연결이 없어 500 을 내지만, 게이트 통과가 핵심.)
      expect(res.status).not.toBe(401);
      // 봇에 요청이 닿았다.
      expect(h.botFetchCalls()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("시나리오 D(회귀): 관리 토큰 미등록 시 POST /actions/verify-token → 코어 424, 봇에 요청 0", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      const res = await h.federation.request(
        "/apps/bot-discord/actions/verify-token",
        {
          method: "POST",
          body: JSON.stringify({ discordToken: "x" }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(res.status).toBe(424);
      expect(h.botFetchCalls()).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("시나리오 E(복구): 봇 관리 토큰 재생성 → 재enroll(D6) → 코어 메타 갱신 → 이후 프록시 통과", async () => {
    // 1) 최초 관리 토큰 V1 로 enroll → 코어 등록.
    const v1 = loadOrCreateAdminToken(join(botStoreDir, "admin-token-v1.json")).token;
    const h1 = makeHarness({ botSettingsPath, botAdminToken: v1 });
    try {
      await enrollBot({ store: h1.store, botAdminToken: v1, botTokenStorePath });
      expect(h1.store.getAdapterAdminToken(ADAPTER_ID)).toBe(v1);

      // 2) 봇 관리 토큰 재생성(V2) — 파일 삭제 후 새 토큰. V1 != V2 확인.
      const v2 = loadOrCreateAdminToken(join(botStoreDir, "admin-token-v2.json")).token;
      expect(v2).not.toBe(v1);

      // 봇 재시작 — 재enroll(같은 endpoint, 새 관리 토큰 V2) → D6 자동 승인 → pickup.
      rmSync(botTokenStorePath, { force: true });
      await enrollBot({
        store: h1.store,
        botAdminToken: v2,
        botTokenStorePath,
      });
      // 코어 메타가 V2 로 갱신됐다(stale 1회 재시작 복구).
      expect(h1.store.getAdapterAdminToken(ADAPTER_ID)).toBe(v2);

      // 3) 새 관리 토큰을 요구하는 봇 app 으로 프록시 → 통과.
      const h2 = makeHarness({ botSettingsPath, botAdminToken: v2 });
      try {
        // 같은 저장소를 쓰도록 V2 를 그대로 등록한 store 를 공유하는 게 아니라,
        // h2 는 새 store 라 다시 enroll 이 필요하다. 대신 h1 의 store 로 부착하는
        // federation 을 쓰려면 h1.federation 을 그대로 쓴다 — 봇 app 은 V2 를 요구.
        // h1.federation 은 h1.botApp(V1 요구)에 붙어 있으므로, V2 검증은 새로
        // 조립한 federation + h2.botApp 으로 확인한다.
        await enrollBot({ store: h2.store, botAdminToken: v2, botTokenStorePath });
        const res = await h2.federation.request("/apps/bot-discord/settings");
        expect(res.status).toBe(200);
      } finally {
        h2.cleanup();
      }
    } finally {
      h1.cleanup();
    }
  });

  test("시나리오 F(하위 호환 stale): 관리 토큰 없이 발급된 기존 어댑터 → 424 → 재enroll 1회 후 200", async () => {
    // P1-통합 이전에 발급된 어댑터를 흉내낸다 — 어댑터 토큰·endpoint 메타는 있으나
    // adminToken 이 없는 하위 호환 상태. store.issueToken 을 adminToken 없이 부르면
    // getAdapterAdminToken 이 null 이라 상태변경 프록시가 424 를 낸다(안전 측).
    const endpoint = BOT_HTTP_ENDPOINT;
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      // 하위 호환 메타 — 관리 토큰 없이 어댑터 토큰만 발급(같은 endpoint 로 D6 자동
      // 승인 성립 조건은 갖춰 두되 adminToken 은 비운다).
      h.store.issueToken(ADAPTER_ID, endpoint);
      expect(h.store.getAdapterAdminToken(ADAPTER_ID)).toBeNull();

      // 상태변경 → 코어 424 + 복구 경로 안내(봇에 안 보냄).
      const before = await h.federation.request("/apps/bot-discord/settings", {
        method: "PUT",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(before.status).toBe(424);
      const errBody = (await before.json()) as { error: string };
      expect(errBody.error).toContain("관리 토큰");
      expect(errBody.error).toContain("재시작"); // 복구 경로 안내
      expect(h.botFetchCalls()).toBe(0);

      // 재enroll 1회(관리 토큰 동봉, 같은 endpoint = D6 자동 승인) → 메타 채워짐.
      await enrollBot({ store: h.store, botAdminToken, botTokenStorePath });
      expect(h.store.getAdapterAdminToken(ADAPTER_ID)).toBe(botAdminToken);

      // 이후 상태변경 → 관리 토큰 부착 → 봇 admin-gate 통과 → 200(1회 재enroll 복구).
      const after = await h.federation.request("/apps/bot-discord/settings");
      expect(after.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("관리 토큰 값이 3단 관통 응답 어디에도 노출되지 않는다", async () => {
    const botAdminToken = loadOrCreateAdminToken(
      join(botStoreDir, "admin-token.json"),
    ).token;
    const h = makeHarness({ botSettingsPath, botAdminToken });
    try {
      await enrollBot({ store: h.store, botAdminToken, botTokenStorePath });
      const res = await h.federation.request("/apps/bot-discord/settings");
      const text = await res.text();
      expect(text).not.toContain(botAdminToken);
    } finally {
      h.cleanup();
    }
  });
});
