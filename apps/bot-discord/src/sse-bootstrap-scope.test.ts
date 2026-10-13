/**
 * sse-bootstrap-scope.test.ts — WP-B1-15: mcp-standard 토큰의 403 처리(토큰 보존 +
 * 권한 안내) + requestedScope 전송 검증.
 *
 * sse-bootstrap.test.ts 는 이미 613줄이었고, 공용 규칙("800줄 캡을 넘긴 파일은
 * 키우지 않고 새 작은 모듈로 분리")에 따라 이 WP 가 추가하는 통합 테스트를 별도
 * 파일로 둔다(WP 의 수정 파일 목록에는 없지만, 캡 규칙이 우선한다 — "계획 밖 변경").
 *
 * 핵심 버그 재현 + 수정 검증: mcp-standard 토큰이 저장된 상태로 재시작하면 probe 가
 * GET /stats 에서 403 을 받는다(auth-gate 의 scope 표에 /stats 가 없어 full 미만은
 * 기본 거부). 옛 구현은 이 403 을 401 과 똑같이 "무효 토큰"으로 판정해 토큰을
 * 지우고 영구히 재enroll 을 반복했다. 실 SseTokenStore + 실 createAuthGate + 실
 * createAdapterTokenRoutes + 실 /stats 를 Bun.serve 로 띄운 완전한 서버로, mock
 * 클라이언트 없이 이 시나리오를 재현하고 수정을 검증한다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterScopeInsufficientError,
  BOT_ADAPTER_ENROLLMENT,
  createAdapterApprovalTokenIssuer,
  describeMemoryApiAuthFailure,
  startSseWithRetry,
  type SseBootstrapAbort,
} from "./sse-bootstrap.ts";
import { MemoryApiClient, MemoryApiError } from "../../memory/src/api-client.ts";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";
import { createAdapterTokenRoutes } from "../../memory/src/server-internal/routes/adapter-tokens.ts";
import { createAuthGate } from "../../memory/src/server-internal/auth-gate.ts";
import { MEMORY_DEFAULTS } from "../../memory/src/settings/memory-defaults.ts";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 실 memory-api 의 축소판을 Bun.serve 로 띄운다 — mock 클라이언트가 아니라 실
 * SseTokenStore + 실 createAuthGate(scope 판정) + 실 createAdapterTokenRoutes +
 * 진짜 200 을 돌리는 /stats 로 이루어진 완전한 HTTP 서버다(WP-B1-15 완료 기준:
 * "실제 memory API 를 Bun.serve 로 띄워 확인"). auth-gate 가 scope 표(token-scope.ts)
 * 에서 /stats 를 찾지 못해 mcp-standard 이하 토큰에는 항상 403 을 돌린다 — 이 표에
 * 없는 조합은 기본 거부이기 때문. full 토큰(또는 레거시 scope 없는 토큰)만 200.
 */
function startMiniMemoryApi(): {
  url: string;
  store: SseTokenStore;
  stop: () => void;
  storeDir: string;
} {
  const storeDir = mkdtempSync(join(tmpdir(), "sse-bootstrap-miniapi-"));
  const store = new SseTokenStore(join(storeDir, "sse-tokens.json"));
  const app = new Hono();
  app.use(
    "*",
    createAuthGate({
      sseTokens: store,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  app.get("/stats", (c) => c.json({ ok: true }));
  const routes = createAdapterTokenRoutes({
    sseTokens: store,
    remoteAddrOf: () => "127.0.0.1",
  });
  app.route("/", routes);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    store,
    stop: () => server.stop(true),
    storeDir,
  };
}

describe("mcp-standard 토큰의 403 처리 — 토큰 보존 + 권한 안내 (WP-B1-15)", () => {
  let api: ReturnType<typeof startMiniMemoryApi> | undefined;
  let storeDir: string;
  let tokenStorePath: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "sse-bootstrap-scope-"));
    tokenStorePath = join(storeDir, "bot-adapter-token.json");
  });

  afterEach(() => {
    api?.stop();
    api = undefined;
    if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });
  });

  // createAdapterApprovalTokenIssuer 호출부와 반드시 같은 값을 써야 한다
  // (isStoredTokenForEndpoint 가 단순 문자열 동등 비교라 어긋나면 저장 토큰이
  // "endpoint 불일치"로 오분류돼 폐기된다).
  const TEST_ENDPOINT = "http://127.0.0.1:3100";

  /**
   * mcp-standard 권한으로 어댑터 토큰을 발급해 로컬 저장소 파일에 저장해 둔다
   * (재시작 재현). loadAdapterToken 은 endpoint 를 isNonEmptyString 으로 검증하므로
   * 빈 문자열이면 손상된 레코드로 보고 null 을 반환한다 — 반드시 비어있지 않은
   * endpoint 를 써야 한다. Bun.write 는 Promise 를 반환하므로 await 필수(경쟁 상태
   * 방지 — await 없이 다음 코드가 파일을 읽으면 아직 안 쓰인 상태를 볼 수 있다).
   */
  async function issueAndStoreMcpStandardToken(): Promise<string> {
    const token = api!.store.issueToken(
      BOT_ADAPTER_ENROLLMENT.adapterId,
      undefined,
      undefined,
      "mcp-standard",
    );
    await Bun.write(
      tokenStorePath,
      JSON.stringify({
        adapterId: BOT_ADAPTER_ENROLLMENT.adapterId,
        endpoint: TEST_ENDPOINT,
        token,
        requestId: "seed",
        pickupSecret: "seed",
      }),
    );
    return token;
  }

  test("(u1) 저장된 mcp-standard 토큰은 403 을 받아도 폐기되지 않고 재enroll 요청이 생기지 않는다", async () => {
    api = startMiniMemoryApi();
    const storedToken = await issueAndStoreMcpStandardToken();

    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    await expect(issue()).rejects.toThrow(AdapterScopeInsufficientError);

    // 저장 파일이 그대로 남아 있다(폐기되지 않음) — clearAdapterToken 이 안 불렸다.
    expect(existsSync(tokenStorePath)).toBe(true);
    const saved = JSON.parse(await Bun.file(tokenStorePath).text()) as { token: string };
    expect(saved.token).toBe(storedToken);

    // enroll 요청이 코어에 새로 쌓이지 않았다(재등록 시도 없음 — 옛 버그의 핵심 증상).
    expect(api!.store.listTokenRequests()).toHaveLength(0);
  });

  test("(u2) 403 은 여러 번 재시도해도 계속 같은 권한 안내를 반복한다(경고마다 조치 방법 포함)", async () => {
    api = startMiniMemoryApi();
    await issueAndStoreMcpStandardToken();

    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    // storeProbed 가 세워지지 않아 매 호출이 다시 probe 해 같은 결과를 낸다.
    for (let i = 0; i < 3; i++) {
      await expect(issue()).rejects.toThrow(AdapterScopeInsufficientError);
    }
    expect(api!.store.listTokenRequests()).toHaveLength(0);
  });

  test("(u3) startSseWithRetry 는 403 을 재시도 대상으로 취급하고 경고에 권한 변경 방법을 담는다", async () => {
    api = startMiniMemoryApi();
    await issueAndStoreMcpStandardToken();

    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    const warns: string[] = [];
    const abort: SseBootstrapAbort = { cancelled: false };
    let sleepCalls = 0;
    void startSseWithRetry({
      issueToken: issue,
      memoryApiUrl: api!.url,
      sseReconnectDelayMs: 50,
      onEvent: () => {},
      abort,
      sleepImpl: async () => {
        sleepCalls += 1;
        if (sleepCalls >= 3) abort.cancelled = true;
      },
      log: () => {},
      warn: (m) => warns.push(m),
    });
    await wait(50);

    // 종료하지 않고 계속 재시도했다(401 처럼 즉시 멈추지 않음).
    expect(sleepCalls).toBeGreaterThanOrEqual(3);
    expect(warns.length).toBeGreaterThanOrEqual(3);
    // 경고마다 무엇이 부족하고 어떻게 고치는지 안내한다.
    for (const w of warns) {
      expect(w).toContain("어댑터 관리");
      expect(w).toContain("full");
    }
  });

  test("(u4) 관리자가 PATCH scope full 로 올리면 다음 시도에서 같은 토큰으로 클라이언트가 붙는다", async () => {
    api = startMiniMemoryApi();
    const storedToken = await issueAndStoreMcpStandardToken();

    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    // 1차 시도 — 403.
    await expect(issue()).rejects.toThrow(AdapterScopeInsufficientError);

    // 관리자가 대시보드에서 권한을 full 로 올린다(PATCH /adapter-tokens/:adapterId/scope
    // 가 결국 부르는 store API를 직접 호출 — 라우트 자체는 auth-gate 로 보호돼 있어
    // 이 유닛 테스트에서는 store 계층으로 같은 효과를 낸다).
    expect(api!.store.setTokenScope(BOT_ADAPTER_ENROLLMENT.adapterId, "full")).toBe(true);

    // 2차 시도 — 같은 저장 토큰으로 즉시 통과(재enroll 없이).
    await expect(issue()).resolves.toEqual({ token: storedToken });
    expect(api!.store.listTokenRequests()).toHaveLength(0);
  });

  test("(u5) 401(회수된 토큰)은 여전히 폐기되고 재enroll 로 넘어간다(기존 동작 보존)", async () => {
    api = startMiniMemoryApi();
    await issueAndStoreMcpStandardToken();
    // 토큰을 회수(401 유발) — mcp-standard 로 발급한 토큰을 지운다.
    expect(api!.store.removeToken(BOT_ADAPTER_ENROLLMENT.adapterId)).toBe(true);

    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    // 401 이므로 AdapterScopeInsufficientError 가 아니라 승인 대기 Error 로 전환.
    await expect(issue()).rejects.toThrow("승인 대기");
    // 저장 파일은 폐기되고(clearAdapterToken), 새 enroll 요청이 코어에 쌓인다.
    expect(existsSync(tokenStorePath)).toBe(false);
    expect(api!.store.listTokenRequests()).toHaveLength(1);
  });

  test("(u6) 레거시 full 토큰(scope 칸 없음)은 200 을 받아 그대로 재사용된다(운영 봇 무변화)", async () => {
    api = startMiniMemoryApi();
    // scope 인자를 생략 — issueToken 기본 동작이 곧 "옛 scope 없는 토큰"과 동일하게
    // full 로 해석되는지는 getTokenScope/legacyScope 계약이 보장한다(WP-B1-13).
    const legacyToken = api!.store.issueToken(BOT_ADAPTER_ENROLLMENT.adapterId);
    await Bun.write(
      tokenStorePath,
      JSON.stringify({
        adapterId: BOT_ADAPTER_ENROLLMENT.adapterId,
        endpoint: TEST_ENDPOINT,
        token: legacyToken,
        requestId: "seed",
        pickupSecret: "seed",
      }),
    );

    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    await expect(issue()).resolves.toEqual({ token: legacyToken });
    expect(api!.store.listTokenRequests()).toHaveLength(0);
  });

  test("(u7) enroll 요청 body 에 requestedScope: full 이 실린다", async () => {
    api = startMiniMemoryApi();
    // 저장 토큰 없음(새 어댑터) — enrollAndMaybePickup 이 곧바로 호출된다.
    const issue = createAdapterApprovalTokenIssuer({
      client: () => new MemoryApiClient(api!.url),
      ...BOT_ADAPTER_ENROLLMENT,
      endpoint: TEST_ENDPOINT,
      tokenStorePath,
      authedClientFactory: (token) => new MemoryApiClient(api!.url, { token }),
    });

    await expect(issue()).rejects.toThrow("승인 대기");
    const requests = api!.store.listTokenRequests("pending");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.requestedScope).toBe("full");
  });

  test("describeMemoryApiAuthFailure — 401·403 을 구분해 조치 방법을 안내한다", () => {
    const unauthorized = describeMemoryApiAuthFailure(
      new MemoryApiError(401, "Unauthorized", "memory-api request failed: 401 Unauthorized"),
    );
    expect(unauthorized).toContain("401");
    expect(unauthorized).not.toContain("full");

    const forbidden = describeMemoryApiAuthFailure(
      new MemoryApiError(403, "Forbidden", "memory-api request failed: 403 Forbidden"),
    );
    expect(forbidden).toContain("403");
    expect(forbidden).toContain("full");

    // MemoryApiError 가 아닌 평범한 오류는 message 그대로.
    expect(describeMemoryApiAuthFailure(new Error("network down"))).toBe("network down");
  });
});
