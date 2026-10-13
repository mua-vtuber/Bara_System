/**
 * sse-bootstrap.test.ts — SSE 부트스트랩(토큰 발급 + 첫 연결) backoff 재시도 검증.
 *
 * 운영 버그 재현: 봇이 memory-api 보다 먼저 깨면 토큰 발급이 처음 몇 번 실패한다.
 * 옛 일회성 try/catch 는 거기서 끝나 구독을 영영 못 붙였다. 이 테스트는 "처음 N번
 * throw 후 성공"하는 실제 토큰 발급 함수를 주입해, 재시도가 결국 붙는지·취소가
 * 루프를 멈추는지·로그에 토큰이 새지 않는지를 실 Bun.serve + 실 fetch 로 확인한다.
 *
 * mock 인터페이스 금지 정책 정합: 가짜 SseConsumer·가짜 fetch 를 만들지 않고,
 * sse-consumer.test.ts 와 같은 실 SSE 로컬 서버를 띄운다. 토큰 발급 함수도 mock
 * 객체가 아니라 "호출 횟수를 세서 동작을 바꾸는 평범한 클로저"다(fixture 허용 범위).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAdapterApprovalTokenIssuer,
  startSseWithRetry,
  isNonRetryableTokenError,
  SSE_BOOTSTRAP_INITIAL_DELAY_MS,
  SSE_BOOTSTRAP_MAX_DELAY_MS,
  SSE_BOOTSTRAP_BACKOFF_FACTOR,
  type SseBootstrapAbort,
} from "./sse-bootstrap.ts";
import type { SseEvent } from "./sse-consumer.ts";
import { MemoryApiClient, MemoryApiError } from "../../memory/src/api-client.ts";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";
import { createAdapterTokenRoutes } from "../../memory/src/server-internal/routes/adapter-tokens.ts";

/** sse-consumer.test.ts 와 동일한 실 SSE 로컬 서버(가짜 구현 아님). */
interface QueuedEvent {
  id: number;
  type: string;
  data: string;
}

function startSseServer(opts: {
  validToken: string;
  events: QueuedEvent[];
  closeAfterDrain?: boolean;
}): { url: string; stop: () => void; connectionCount: () => number } {
  let connections = 0;
  const closeAfterDrain = opts.closeAfterDrain ?? false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/events/stream") {
        return new Response("not found", { status: 404 });
      }
      const auth = req.headers.get("Authorization") ?? "";
      const m = auth.match(/^Bearer\s+(.+)$/);
      if (!m || m[1] !== opts.validToken) {
        return new Response("unauthorized", { status: 401 });
      }
      connections += 1;

      const lastEventIdRaw = req.headers.get("Last-Event-ID");
      const lastId =
        lastEventIdRaw !== null && lastEventIdRaw.trim().length > 0
          ? Number(lastEventIdRaw)
          : 0;
      const toSend = opts.events.filter((e) => e.id > lastId);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          for (const e of toSend) {
            controller.enqueue(
              enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${e.data}\n\n`),
            );
          }
          if (closeAfterDrain) controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    connectionCount: () => connections,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * "처음 failTimes 번은 throw, 그 뒤로는 토큰을 반환"하는 실 토큰 발급 함수를 만든다.
 * mock 객체가 아니라 호출 횟수를 세는 평범한 클로저 — 운영의 "memory-api 가 늦게
 * 깨는" 상황을 그대로 흉내 낸다. errorFactory 로 던질 에러 종류를 바꿀 수 있다.
 */
function makeTokenIssuer(opts: {
  failTimes: number;
  token: string;
  errorFactory?: (attempt: number) => Error;
}): { issue: () => Promise<{ token: string }>; calls: () => number } {
  let calls = 0;
  const errorFactory =
    opts.errorFactory ??
    ((attempt: number) =>
      new Error(`memory-api unreachable (attempt ${attempt})`));
  return {
    issue: async () => {
      calls += 1;
      if (calls <= opts.failTimes) {
        throw errorFactory(calls);
      }
      return { token: opts.token };
    },
    calls: () => calls,
  };
}

describe("startSseWithRetry — backoff 재시도", () => {
  let server: ReturnType<typeof startSseServer> | undefined;
  afterEach(() => server?.stop());

  test("(t1) 토큰 발급이 처음 3번 실패한 뒤 붙어 SSE 이벤트를 받는다(운영 버그 재현)", async () => {
    server = startSseServer({
      validToken: "tok-ok",
      events: [{ id: 1, type: "cleanup_proposals_ready", data: '{"count":2}' }],
      closeAfterDrain: false,
    });
    const issuer = makeTokenIssuer({ failTimes: 3, token: "tok-ok" });
    const received: SseEvent[] = [];
    const abort: SseBootstrapAbort = { cancelled: false };
    // 테스트 sleep 은 즉시 반환 — 실제 backoff 시계를 기다리지 않고 횟수 흐름만 본다.
    const result = await startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: server.url,
      sseReconnectDelayMs: 50,
      onEvent: (e) => {
        received.push(e);
      },
      abort,
      sleepImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    expect(result.consumer).not.toBeNull();
    // 처음 3번 실패 + 4번째 성공 = 토큰 발급 4회 호출.
    expect(issuer.calls()).toBe(4);

    await wait(200);
    result.consumer?.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].type).toBe("cleanup_proposals_ready");
    expect(JSON.parse(received[0].data)).toEqual({ count: 2 });
  });

  test("(t2) 계속 실패하면 대기가 배수로 늘다 상한에서 멈춘다", async () => {
    // 토큰 발급이 영영 실패 — sleep 에 넘어온 대기값을 기록해 backoff 곡선을 본다.
    const issuer = makeTokenIssuer({ failTimes: Number.MAX_SAFE_INTEGER, token: "x" });
    const delays: number[] = [];
    const abort: SseBootstrapAbort = { cancelled: false };

    void startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: "http://127.0.0.1:1", // 닿지 않는 주소 — 어차피 토큰 발급이 먼저 실패.
      sseReconnectDelayMs: 50,
      onEvent: () => {},
      abort,
      sleepImpl: async (ms) => {
        delays.push(ms);
        // 몇 사이클 기록한 뒤 루프를 멈춘다(무한 루프 방지).
        if (delays.length >= 8) {
          abort.cancelled = true;
        }
      },
      log: () => {},
      warn: () => {},
    });
    // 비동기 루프가 sleepImpl 을 8번 부를 때까지 양보.
    await wait(50);

    // import 한 상수로 기대 곡선을 계산한다(코드 안 매직 넘버 금지 — 단일 출처 검증).
    const expected: number[] = [];
    let d = SSE_BOOTSTRAP_INITIAL_DELAY_MS;
    for (let i = 0; i < delays.length; i++) {
      expected.push(Math.min(d, SSE_BOOTSTRAP_MAX_DELAY_MS));
      d = Math.min(d * SSE_BOOTSTRAP_BACKOFF_FACTOR, SSE_BOOTSTRAP_MAX_DELAY_MS);
    }
    expect(delays).toEqual(expected);
    // 마지막 대기는 상한에 닿아 있어야 한다(로그 도배 차단 장치).
    expect(delays[delays.length - 1]).toBe(SSE_BOOTSTRAP_MAX_DELAY_MS);
    // 첫 대기는 초기값.
    expect(delays[0]).toBe(SSE_BOOTSTRAP_INITIAL_DELAY_MS);
  });

  test("(t3) consumer 생성 전 취소되면 토큰 발급 호출이 더 안 늘고 루프가 멈춘다", async () => {
    const issuer = makeTokenIssuer({ failTimes: Number.MAX_SAFE_INTEGER, token: "x" });
    const abort: SseBootstrapAbort = { cancelled: false };

    void startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: "http://127.0.0.1:1",
      sseReconnectDelayMs: 50,
      onEvent: () => {},
      abort,
      // 매 대기마다 잠깐 멈춰, 일정 시점에 외부에서 취소를 건다.
      sleepImpl: async () => {
        await wait(5);
      },
      log: () => {},
      warn: () => {},
    });

    await wait(60); // 몇 번 시도하게 둔다.
    abort.cancelled = true; // consumer 생성 전 취소.
    const callsAtCancel = issuer.calls();
    await wait(80); // 취소 뒤로 더 도는지 확인.

    // 취소 시점 ±1 회 안에서 멈춘다(취소를 건 순간 대기 중이던 1회는 깨어날 수 있음).
    expect(issuer.calls()).toBeLessThanOrEqual(callsAtCancel + 1);
  });

  test("(t4) consumer 가 붙은 뒤 취소하면 서버 연결이 더 안 늘어난다", async () => {
    server = startSseServer({
      validToken: "tok-ok",
      events: [{ id: 1, type: "cleanup_proposals_ready", data: "{}" }],
      closeAfterDrain: true, // 매 연결이 닫혀 consumer 가 재연결 시도 → 연결 수가 는다.
    });
    const issuer = makeTokenIssuer({ failTimes: 0, token: "tok-ok" });
    const abort: SseBootstrapAbort = { cancelled: false };

    const result = await startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: server.url,
      sseReconnectDelayMs: 30,
      onEvent: () => {},
      abort,
      sleepImpl: async () => {},
      log: () => {},
      warn: () => {},
    });
    expect(result.consumer).not.toBeNull();

    await wait(120); // 몇 번 재연결하게 둔다.
    result.consumer?.stop(); // consumer stop = 취소 효과.
    const countAfterStop = server.connectionCount();
    await wait(120);
    expect(server.connectionCount()).toBe(countAfterStop);
  });

  test("(t5) 실패·성공 로그/에러 어디에도 토큰 문자열이 새지 않는다", async () => {
    server = startSseServer({
      validToken: "secret-token-value",
      events: [{ id: 1, type: "cleanup_proposals_ready", data: "{}" }],
      closeAfterDrain: false,
    });
    const issuer = makeTokenIssuer({ failTimes: 2, token: "secret-token-value" });
    const logs: string[] = [];
    const warns: string[] = [];
    const abort: SseBootstrapAbort = { cancelled: false };

    const result = await startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: server.url,
      sseReconnectDelayMs: 50,
      onEvent: () => {},
      abort,
      sleepImpl: async () => {},
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    await wait(120);
    result.consumer?.stop();

    const all = [...logs, ...warns].join("\n");
    expect(all.includes("secret-token-value")).toBe(false);
    // 실패 경고(2회)와 성공 로그(1회)는 떠야 한다 — silent 아님.
    expect(warns.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes("연결 성공"))).toBe(true);
  });

  test("(t6) 인증 실패(401 MemoryApiError)는 재시도하지 않고 loud 경고만 남긴다", async () => {
    // api-client unwrap 이 던지는 실제 타입(MemoryApiError, status=401)을 그대로 던진다.
    const issuer = makeTokenIssuer({
      failTimes: Number.MAX_SAFE_INTEGER,
      token: "x",
      errorFactory: () =>
        new MemoryApiError(
          401,
          "Unauthorized",
          "memory-api request failed: 401 Unauthorized",
        ),
    });
    const warns: string[] = [];
    const abort: SseBootstrapAbort = { cancelled: false };

    const result = await startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: "http://127.0.0.1:1",
      sseReconnectDelayMs: 50,
      onEvent: () => {},
      abort,
      sleepImpl: async () => {},
      log: () => {},
      warn: (m) => warns.push(m),
    });

    expect(result.consumer).toBeNull();
    // 401 은 한 번만 시도하고 멈춘다(재시도 안 함).
    expect(issuer.calls()).toBe(1);
    expect(warns.some((m) => m.includes("재시도 중단"))).toBe(true);
  });

  test("(t7) 401 이 아닌 MemoryApiError(500)는 재시도된다", async () => {
    // 처음 2번은 500(MemoryApiError) 을 던지고 그 뒤 붙는지 확인 — 5xx 는 일시 장애라 재시도 대상.
    const issuer = makeTokenIssuer({
      failTimes: 2,
      token: "tok-ok",
      errorFactory: () =>
        new MemoryApiError(
          500,
          "Internal Server Error",
          "memory-api request failed: 500 Internal Server Error",
        ),
    });
    server = startSseServer({
      validToken: "tok-ok",
      events: [{ id: 1, type: "cleanup_proposals_ready", data: "{}" }],
      closeAfterDrain: false,
    });
    const abort: SseBootstrapAbort = { cancelled: false };

    const result = await startSseWithRetry({
      issueToken: issuer.issue,
      memoryApiUrl: server.url,
      sseReconnectDelayMs: 50,
      onEvent: () => {},
      abort,
      sleepImpl: async () => {},
      log: () => {},
      warn: () => {},
    });

    // 500 두 번을 재시도로 넘기고 세 번째에 붙는다 — 비재시도가 아님.
    expect(result.consumer).not.toBeNull();
    expect(issuer.calls()).toBe(3);

    await wait(60);
    result.consumer?.stop();
  });
});

describe("createAdapterApprovalTokenIssuer — 승인 큐 polling", () => {
  let server: Bun.Server<undefined> | undefined;
  // 어댑터 토큰 저장소가 실제 data/ 를 건드리지 않게 임시 경로를 주입한다.
  // (issuer 가 승인 뒤 saveAdapterToken 을 호출하므로 tokenStorePath 필수.)
  let storeDir: string;
  let tokenStorePath: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "sse-bootstrap-store-"));
    tokenStorePath = join(storeDir, "bot-adapter-token.json");
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });
  });

  test("첫 호출만 enroll 하고, 승인 전 polling 뒤 승인되면 토큰을 반환한다", async () => {
    let enrollCalls = 0;
    let pickupCalls = 0;
    let approved = false;

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/adapter-enroll" && req.method === "POST") {
          enrollCalls += 1;
          const body = (await req.json()) as { adapterId: string };
          expect(body.adapterId).toBe("bot-discord");
          return Response.json(
            {
              status: "pending",
              adapterId: "bot-discord",
              requestId: "atr_test",
              pickupSecret: "pickup-secret",
            },
            { status: 202 },
          );
        }
        if (url.pathname === "/adapter-enroll/atr_test/token") {
          pickupCalls += 1;
          expect(url.searchParams.get("pickupSecret")).toBe("pickup-secret");
          if (!approved) {
            return Response.json(
              { status: "pending", adapterId: "bot-discord", requestId: "atr_test" },
              { status: 202 },
            );
          }
          return Response.json({
            status: "approved",
            adapterId: "bot-discord",
            requestId: "atr_test",
            token: "issued-token",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const client = new MemoryApiClient(`http://127.0.0.1:${server.port}`);
    const logs: string[] = [];
    const issue = createAdapterApprovalTokenIssuer({
      client: () => client,
      adapterId: "bot-discord",
      displayName: "디스코드 봇",
      log: (m) => logs.push(m),
      tokenStorePath,
    });

    await expect(issue()).rejects.toThrow("승인 대기");
    expect(enrollCalls).toBe(1);
    expect(pickupCalls).toBe(0);

    await expect(issue()).rejects.toThrow("승인 대기");
    expect(enrollCalls).toBe(1);
    expect(pickupCalls).toBe(1);

    approved = true;
    await expect(issue()).resolves.toEqual({ token: "issued-token" });
    expect(enrollCalls).toBe(1);
    expect(pickupCalls).toBe(2);
    expect(logs.some((m) => m.includes("승인 요청 등록"))).toBe(true);
    expect(logs.join("\n")).not.toContain("issued-token");
    expect(logs.join("\n")).not.toContain("pickup-secret");
  });
});

describe("createAdapterApprovalTokenIssuer — 봇 관리 토큰 등록 (P1-통합 I1·T3)", () => {
  // 실 SseTokenStore + 실 createAdapterTokenRoutes 를 Bun.serve 로 띄워 봇 issuer 를
  // 연결한다(mock 객체 금지). 봇 부팅 배선(index.ts)이 adminToken 을 issuer 에
  // 넘긴다는 계약을 issuer 레벨에서 검증한다 — index.ts main 은 top-level await 라
  // 단위 테스트가 어려워 배선 관통은 코어 통합 테스트(T6)로 확인한다.
  let coreServer: Bun.Server<undefined> | undefined;
  let coreDir: string;
  let coreTokenPath: string;
  let store: SseTokenStore;
  let storeDir: string;
  let tokenStorePath: string;

  beforeEach(() => {
    coreDir = mkdtempSync(join(tmpdir(), "sse-bootstrap-core-"));
    coreTokenPath = join(coreDir, "sse-tokens.json");
    store = new SseTokenStore(coreTokenPath);
    const routes = createAdapterTokenRoutes({
      sseTokens: store,
      remoteAddrOf: () => "127.0.0.1",
    });
    coreServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });

    storeDir = mkdtempSync(join(tmpdir(), "sse-bootstrap-botstore-"));
    tokenStorePath = join(storeDir, "bot-adapter-token.json");
  });

  afterEach(() => {
    coreServer?.stop(true);
    coreServer = undefined;
    if (existsSync(coreDir)) rmSync(coreDir, { recursive: true, force: true });
    if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });
  });

  test("enroll 시 adminToken 을 코어에 등록 → 승인 후 getAdapterAdminToken 이 그 값 반환", async () => {
    const endpoint = "http://127.0.0.1:3100";
    const client = new MemoryApiClient(`http://127.0.0.1:${coreServer!.port}`);
    const logs: string[] = [];
    const issue = createAdapterApprovalTokenIssuer({
      client: () => client,
      adapterId: "bot-discord",
      displayName: "디스코드 봇",
      endpoint,
      adminToken: "BOT-ADMIN-TOKEN-123",
      log: (m) => logs.push(m),
      tokenStorePath,
    });

    // 첫 enroll — pending 이라 throw(승인 대기). 이 시점에 요청이 코어에 저장됨.
    await expect(issue()).rejects.toThrow("승인 대기");
    const requests = store.listTokenRequests("pending");
    expect(requests).toHaveLength(1);

    // 대시보드 승인 → 관리 토큰이 발급 메타로 전파.
    store.approveTokenRequest(requests[0]!.requestId);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("BOT-ADMIN-TOKEN-123");

    // 관리 토큰 값이 로그로 새지 않는다.
    expect(logs.join("\n")).not.toContain("BOT-ADMIN-TOKEN-123");
  });

  test("저장 토큰 없는 재등록은 승인 전 관리 토큰을 유지하고 승인 후 갱신한다", async () => {
    const endpoint = "http://127.0.0.1:3100";
    const client = new MemoryApiClient(`http://127.0.0.1:${coreServer!.port}`);

    // 1) 최초 등록 — 관리 토큰 V1, 수동 승인.
    const issueV1 = createAdapterApprovalTokenIssuer({
      client: () => client,
      adapterId: "bot-discord",
      displayName: "디스코드 봇",
      endpoint,
      adminToken: "ADMIN-V1",
      tokenStorePath,
    });
    await expect(issueV1()).rejects.toThrow("승인 대기");
    const pending = store.listTokenRequests("pending");
    store.approveTokenRequest(pending[0]!.requestId);
    // pickup 으로 토큰 회수(발급 메타 확정).
    await expect(issueV1()).resolves.toHaveProperty("token");
    expect(store.getAdapterAdminToken("bot-discord")).toBe("ADMIN-V1");

    // 2) 저장 토큰을 잃어 소유를 증명할 수 없으면 같은 주소라도 승인을 기다린다.
    //    승인 전에는 제3자의 재등록 요청이 기존 관리 토큰을 덮어쓸 수 없다.
    rmSync(tokenStorePath, { force: true });
    const issueV2 = createAdapterApprovalTokenIssuer({
      client: () => client,
      adapterId: "bot-discord",
      displayName: "디스코드 봇",
      endpoint,
      adminToken: "ADMIN-V2",
      tokenStorePath,
    });
    await expect(issueV2()).rejects.toThrow("승인 대기");
    const renewal = store.listTokenRequests("pending");
    expect(renewal).toHaveLength(1);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("ADMIN-V1");
    expect(existsSync(tokenStorePath)).toBe(false);

    await expect(issueV2()).rejects.toThrow("승인 대기");
    expect(store.listTokenRequests("pending")).toHaveLength(1);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("ADMIN-V1");

    store.approveTokenRequest(renewal[0]!.requestId);
    await expect(issueV2()).resolves.toHaveProperty("token");
    expect(existsSync(tokenStorePath)).toBe(true);
    // 코어 메타의 관리 토큰이 새 값으로 덮어써졌다(옛 V1 이 남지 않음).
    expect(store.getAdapterAdminToken("bot-discord")).toBe("ADMIN-V2");
  });
});

describe("isNonRetryableTokenError — 에러 분류(MemoryApiError.status 필드 기반)", () => {
  test("401 MemoryApiError 는 비재시도(토큰 자체가 무효)", () => {
    expect(
      isNonRetryableTokenError(
        new MemoryApiError(401, "Unauthorized", "memory-api request failed: 401 Unauthorized"),
      ),
    ).toBe(true);
  });

  test("403 MemoryApiError 는 재시도 대상이다(WP-B1-15 — 토큰은 유효, 권한만 부족)", () => {
    // 옛 구현은 401·403 을 똑같이 비재시도로 묶어, mcp-standard 로 발급된 유효한
    // 토큰까지 폐기하고 재enroll 을 반복하는 운영 버그를 냈다. 403 은 이제
    // isNonRetryableTokenError 의 대상이 아니다(토큰 폐기 없이 재시도 루프로 감).
    expect(
      isNonRetryableTokenError(
        new MemoryApiError(403, "Forbidden", "memory-api request failed: 403 Forbidden"),
      ),
    ).toBe(false);
  });

  test("연결 거부(TypeError)는 MemoryApiError 가 아니라 재시도된다(운영 버그 보존 핵심)", () => {
    // fetch 가 연결 거부 시 던지는 TypeError — instanceof MemoryApiError 가 false 라 재시도.
    expect(
      isNonRetryableTokenError(
        new TypeError("Unable to connect. Is the computer able to access the url?"),
      ),
    ).toBe(false);
    // 평범한 Error 도 MemoryApiError 가 아니므로 재시도 대상.
    expect(
      isNonRetryableTokenError(new Error("memory-api unreachable")),
    ).toBe(false);
  });

  test("401 이 아닌 MemoryApiError(403·5xx)는 재시도된다", () => {
    expect(
      isNonRetryableTokenError(
        new MemoryApiError(
          503,
          "Service Unavailable",
          "memory-api request failed: 503 Service Unavailable",
        ),
      ),
    ).toBe(false);
    expect(
      isNonRetryableTokenError(
        new MemoryApiError(500, "Internal Server Error", "memory-api request failed: 500"),
      ),
    ).toBe(false);
    // status 가 메시지 문자열 안에 401 이 우연히 섞여도, status 필드가 503 이면 재시도.
    expect(
      isNonRetryableTokenError(
        new MemoryApiError(503, "Service Unavailable", "upstream returned 401 then 503"),
      ),
    ).toBe(false);
  });
});
