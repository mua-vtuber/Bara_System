/**
 * 어댑터 토큰 저장·재사용·재enroll 통합 테스트 (D5 + D6, T8).
 *
 * 실 SseTokenStore + 실 파일 + 실 코어 adapter-token 라우트를 Bun.serve 로 띄우고,
 * 봇 issuer(createAdapterApprovalTokenIssuer)가 실 MemoryApiClient 로 그 서버를
 * 호출하게 한다. Mock 객체 없음 — 코어 store·라우트·파일 I/O 모두 실제.
 *
 * probeToken 은 스텁 함수를 주입한다(코어 라우트에 /stats 가 없으므로 저장 토큰
 * 유효성 확인만 스텁). 이는 mock 객체가 아니라 코어 auth-gate 의 remoteAddrOf
 * 처럼 함수 1개를 주입하는 의존성 주입 패턴이다.
 *
 * 검증(spec Completion Criteria 6·7 + plan T8 시나리오 A/B/C):
 *   A. 저장 토큰 유효 → enroll 호출 0, 저장 토큰 반환.
 *   B. 저장 토큰 무효 → clear + 재enroll → 수동 승인 대기 → 승인 후 pickup·저장.
 *   C. 저장 토큰 없음(첫 셋업) → enroll → pending → (승인 후) pickup → 저장.
 *   유효 토큰을 보관한 재시작 2회에서 수동 승인이 첫 셋업 1회만 필요함을 단언.
 *   자동 재등록은 유효한 existingToken 소유 증명이 있을 때만 허용된다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";
import { createAdapterTokenRoutes } from "../../memory/src/server-internal/routes/adapter-tokens.ts";
import { MemoryApiClient } from "../../memory/src/api-client.ts";
import { createAdapterApprovalTokenIssuer } from "./sse-bootstrap.ts";
import {
  loadAdapterToken,
  saveAdapterToken,
} from "./adapter-token-store.ts";

const ADAPTER_ID = "bot-discord";
const ENDPOINT = "http://127.0.0.1:3100";

let dir: string;
let coreTokenPath: string;
let botTokenPath: string;
let store: SseTokenStore;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adapter-token-reuse-"));
  coreTokenPath = join(dir, "core-sse-tokens.json");
  botTokenPath = join(dir, "bot-adapter-token.json");
  store = new SseTokenStore(coreTokenPath);

  const app = new Hono();
  app.route("/", createAdapterTokenRoutes({ sseTokens: store }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

/** 실 MemoryApiClient 를 띄운 서버로 가리킨다(미인증 — enroll/pickup 은 공개 경로). */
function client(): MemoryApiClient {
  return new MemoryApiClient(baseUrl);
}

/**
 * 대시보드가 pending 요청을 승인하는 것을 흉내 — 코어 store 를 직접 승인.
 * (실 라우트 approve 를 호출해도 되지만, 여기선 사용자 승인 액션을 직접 재현.)
 */
function approvePending(): void {
  const pending = store.listTokenRequests("pending");
  for (const req of pending) {
    store.approveTokenRequest(req.requestId);
  }
}

describe("시나리오 C — 첫 셋업(저장 토큰 없음) → enroll → 승인 → pickup → 저장", () => {
  test("첫 issue 는 승인 대기로 throw, 승인 후 재호출이 토큰을 회수·저장", async () => {
    const issue = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      tokenStorePath: botTokenPath,
      // 저장 토큰이 없으므로 probe 는 호출되지 않는다 — 안전값 주입.
      probeToken: async () => false,
    });

    // 저장 토큰 없음 → enroll → pending → throw.
    await expect(issue()).rejects.toThrow();
    // 저장 파일은 아직 없다(승인 전).
    expect(loadAdapterToken(botTokenPath)).toBeNull();

    // 사용자 승인.
    approvePending();

    // 재호출 → pickup → 토큰 반환 + 저장.
    const result = await issue();
    expect(typeof result.token).toBe("string");
    expect(store.verifyToken(result.token)).toBe(ADAPTER_ID);
    const saved = loadAdapterToken(botTokenPath);
    expect(saved?.token).toBe(result.token);
    expect(saved?.endpoint).toBe(ENDPOINT);
  });
});

describe("시나리오 A — 저장 토큰 유효 → enroll 호출 0, 저장 토큰 재사용", () => {
  test("유효한 저장 토큰이 있으면 즉시 반환하고 새 요청을 만들지 않는다", async () => {
    // 코어에 토큰을 발급해 두고, 그 토큰을 봇 저장소에도 저장(재시작 후 상태 재현).
    const token = store.issueToken(ADAPTER_ID, ENDPOINT);
    saveAdapterToken(
      {
        adapterId: ADAPTER_ID,
        endpoint: ENDPOINT,
        token,
        requestId: "atr_seed",
        pickupSecret: "seed-secret",
      },
      botTokenPath,
    );

    let probeCalls = 0;
    const issue = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      tokenStorePath: botTokenPath,
      probeToken: async (t) => {
        probeCalls += 1;
        return store.verifyToken(t) !== null; // 실 store 로 유효성 확인.
      },
    });

    const result = await issue();
    expect(result.token).toBe(token);
    expect(probeCalls).toBe(1);
    // enroll 호출 0 — 코어에 pending 요청이 하나도 안 생겼다.
    expect(store.listTokenRequests("pending")).toHaveLength(0);
  });

  test("유효 저장 토큰에 관리 토큰 동기화 표시가 없으면 existingToken 재enroll 로 메타를 채운다", async () => {
    // 옛 발급분: API 토큰은 유효하지만 tokenMeta 에 endpoint/adminToken 이 없다.
    const token = store.issueToken(ADAPTER_ID);
    saveAdapterToken(
      {
        adapterId: ADAPTER_ID,
        endpoint: ENDPOINT,
        token,
        requestId: "atr_seed",
        pickupSecret: "seed-secret",
      },
      botTokenPath,
    );

    const issue1 = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      adminToken: "ADMIN-V1",
      tokenStorePath: botTokenPath,
      probeToken: async (t) => store.verifyToken(t) !== null,
    });

    const first = await issue1();
    expect(first.token).toBe(token);
    expect(store.getAdapterAdminToken(ADAPTER_ID)).toBe("ADMIN-V1");
    const saved = loadAdapterToken(botTokenPath);
    expect(saved?.adminTokenHash?.length).toBe(64);
    const requestCountAfterSync = store.listTokenRequests().length;

    // 두 번째 issuer 는 verifyAdminTokenRegistration/authedClientFactory 를
    // 주지 않는다 — 즉 코어 관리 토큰 등록 여부를 확인할 통로가 없다. 이 경우
    // silent 성공 단정은 금지이므로 미확인 상태로 간주해 매번 재enroll 한다
    // (해시는 이미 일치하므로 해시 불일치 분기가 아니라 verifyAdminRegistration
    // 분기가 재enroll 을 유발한다). 유효한 existingToken 소유 증명으로 자동승인돼
    // 재사용되지만, 확인 통로 부재로 요청 건수는 1건 늘어난다.
    const issue2 = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      adminToken: "ADMIN-V1",
      tokenStorePath: botTokenPath,
      probeToken: async (t) => store.verifyToken(t) !== null,
    });

    const second = await issue2();
    expect(second.token).toBe(token);
    expect(store.listTokenRequests()).toHaveLength(requestCountAfterSync + 1);
  });

  test("로컬 hash 가 있어도 코어 관리 메타가 없으면 existingToken 재enroll 로 복구한다", async () => {
    const token = store.issueToken(ADAPTER_ID, ENDPOINT);
    const adminToken = "ADMIN-V1";
    const adminTokenHash = createHash("sha256").update(adminToken).digest("hex");
    saveAdapterToken(
      {
        adapterId: ADAPTER_ID,
        endpoint: ENDPOINT,
        token,
        requestId: "atr_seed",
        pickupSecret: "seed-secret",
        adminTokenHash,
      },
      botTokenPath,
    );
    expect(store.getAdapterAdminToken(ADAPTER_ID)).toBeNull();

    const issue = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      adminToken,
      tokenStorePath: botTokenPath,
      probeToken: async (t) => store.verifyToken(t) !== null,
      verifyAdminTokenRegistration: async () =>
        store.getAdapterAdminToken(ADAPTER_ID) !== null,
    });

    const result = await issue();
    expect(result.token).toBe(token);
    expect(store.getAdapterAdminToken(ADAPTER_ID)).toBe(adminToken);
    const saved = loadAdapterToken(botTokenPath);
    expect(saved?.adminTokenHash).toBe(adminTokenHash);
  });

  test("저장 토큰 probe 가 일시 실패하면 다음 호출에서 existingToken 재enroll 을 다시 시도한다", async () => {
    const token = store.issueToken(ADAPTER_ID);
    saveAdapterToken(
      {
        adapterId: ADAPTER_ID,
        endpoint: ENDPOINT,
        token,
        requestId: "atr_seed",
        pickupSecret: "seed-secret",
      },
      botTokenPath,
    );

    let probeCalls = 0;
    const issue = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      adminToken: "ADMIN-V1",
      tokenStorePath: botTokenPath,
      probeToken: async (t) => {
        probeCalls += 1;
        if (probeCalls === 1) {
          throw new Error("temporary memory-api outage");
        }
        return store.verifyToken(t) !== null;
      },
    });

    await expect(issue()).rejects.toThrow("temporary memory-api outage");
    const result = await issue();
    expect(result.token).toBe(token);
    expect(probeCalls).toBe(2);
    expect(store.getAdapterAdminToken(ADAPTER_ID)).toBe("ADMIN-V1");
    expect(store.listTokenRequests("pending")).toHaveLength(0);
  });
});

describe("시나리오 B — 저장 토큰 무효 → 폐기 + 재enroll → 수동 승인 후 토큰 저장", () => {
  test("같은 endpoint라도 무효 토큰은 승인 대기하며, 승인 후 같은 issuer가 회수·저장한다", async () => {
    // 1) 정상 발급 이력과 같은 endpoint가 있어도, 유효 토큰 소유 증명 없이는 자동승인되지 않는다.
    const firstReq = store.createTokenRequest({
      adapterId: ADAPTER_ID,
      endpoint: ENDPOINT,
    });
    store.approveTokenRequest(firstReq.request.requestId);
    const firstPicked = store.pickupApprovedToken(
      firstReq.request.requestId,
      firstReq.pickupSecret,
    );
    const firstToken = firstPicked?.token;
    expect(firstToken).toBeDefined();
    const issuedBefore = store.listIssuedTokens();

    // 2) 봇 저장소에는 코어가 인정하지 않는 토큰이 남아 있다.
    saveAdapterToken(
      {
        adapterId: ADAPTER_ID,
        endpoint: ENDPOINT,
        token: "stale-revoked-token",
        requestId: "atr_stale",
        pickupSecret: "stale-secret",
      },
      botTokenPath,
    );

    const issue = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      tokenStorePath: botTokenPath,
      // stale-revoked-token 은 코어에서 무효 → false.
      probeToken: async (t) => store.verifyToken(t) !== null,
    });

    // probe(무효) → clear → 재enroll. endpoint 일치만으로 토큰을 반환하면 안 된다.
    await expect(issue()).rejects.toThrow("어댑터 토큰 승인 대기 중");
    expect(loadAdapterToken(botTokenPath)).toBeNull();
    expect(existsSync(botTokenPath)).toBe(false);
    const pending = store.listTokenRequests("pending");
    expect(pending).toHaveLength(1);
    const requestId = pending[0]!.requestId;
    expect(pending[0]?.endpoint).toBe(ENDPOINT);
    expect(pending[0]?.approvedAt).toBeNull();
    expect(store.listIssuedTokens()).toEqual(issuedBefore);

    // 승인 전 재호출은 같은 요청을 polling한다. 새 요청·자동승인·로컬 토큰 저장은 없다.
    const requestCount = store.listTokenRequests().length;
    await expect(issue()).rejects.toThrow("어댑터 토큰 승인 대기 중");
    expect(store.listTokenRequests()).toHaveLength(requestCount);
    expect(store.getTokenRequest(requestId)?.status).toBe("pending");
    expect(store.listIssuedTokens()).toEqual(issuedBefore);
    expect(loadAdapterToken(botTokenPath)).toBeNull();

    // 명시적 코어 승인 후 같은 issuer가 기존 요청을 polling해 토큰을 회수한다.
    store.approveTokenRequest(requestId);
    const result = await issue();
    expect(store.verifyToken(result.token)).toBe(ADAPTER_ID);
    // 코어의 발급은 멱등이다. 수동 승인 뒤에만 기존 유효 토큰이 반환된다.
    expect(result.token).toBe(firstToken!);
    expect(store.listTokenRequests()).toHaveLength(requestCount);
    expect(store.listTokenRequests("pending")).toHaveLength(0);
    const saved = loadAdapterToken(botTokenPath);
    expect(saved?.token).toBe(result.token);
    expect(saved?.requestId).toBe(requestId);
    expect(saved?.endpoint).toBe(ENDPOINT);
  });
});

describe("유효 토큰을 보관한 재시작 2회 — 수동 승인은 첫 셋업 1회만", () => {
  test("첫 부팅은 수동 승인 필요, 둘째 부팅은 저장 토큰 재사용으로 승인 0", async () => {
    // ── 부팅 1: 첫 셋업 ──────────────────────────────────────────────────────
    const issue1 = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      tokenStorePath: botTokenPath,
      probeToken: async (t) => store.verifyToken(t) !== null,
    });
    await expect(issue1()).rejects.toThrow(); // pending
    const pendingBefore = store.listTokenRequests("pending").length;
    expect(pendingBefore).toBe(1); // 수동 승인 대상 1건.
    approvePending(); // ← 사용자 수동 승인(1회).
    const token1 = (await issue1()).token;
    expect(store.verifyToken(token1)).toBe(ADAPTER_ID);

    // ── 부팅 2: 재시작 (새 issuer, 같은 저장 파일) ─────────────────────────────
    let manualApprovalsNeeded = 0;
    const issue2 = createAdapterApprovalTokenIssuer({
      client,
      adapterId: ADAPTER_ID,
      displayName: "Discord Bot",
      endpoint: ENDPOINT,
      tokenStorePath: botTokenPath,
      probeToken: async (t) => store.verifyToken(t) !== null,
    });
    const token2 = (await issue2()).token;
    // 저장 토큰 재사용 → 새 pending 요청 0 → 수동 승인 0.
    if (store.listTokenRequests("pending").length > 0) manualApprovalsNeeded += 1;
    expect(manualApprovalsNeeded).toBe(0);
    expect(token2).toBe(token1);
  });
});
