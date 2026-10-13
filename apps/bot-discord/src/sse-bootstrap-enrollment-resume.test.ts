/**
 * 봇 등록 대기 요청 이어받기 — 재시작 뒤 같은 요청 회수, 끝난 요청(거절·만료) 폐기 후 새 등록,
 * 옛 대기 요청에 막힌 상태(409)에서 재시도 중단.
 *
 * 실 SseTokenStore + 실 createAdapterTokenRoutes 를 Bun.serve 로 띄우고 실 MemoryApiClient 로
 * 붙는다(mock 객체 금지). 봇 쪽 파일은 임시 폴더에 둔다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryApiClient } from "../../memory/src/api-client.ts";
import { SseTokenStore } from "../../memory/src/federation/sse-tokens.ts";
import { createAdapterTokenRoutes } from "../../memory/src/server-internal/routes/adapter-tokens.ts";
import { resolvePendingEnrollmentPath } from "./adapter-enrollment-store.ts";
import { saveAdapterToken } from "./adapter-token-store.ts";
import {
  AdapterEnrollmentBlockedError,
  AdapterEnrollmentRejectedError,
  createAdapterApprovalTokenIssuer,
  SSE_BOOTSTRAP_BLOCKED_RECHECK_MS,
  startSseWithRetry,
  type IssueSseToken,
} from "./sse-bootstrap.ts";

const ADAPTER_ID = "bot-discord";
const OWNER_ONLY_FILE_MODE = 0o600;
const FILE_MODE_BITS = 0o777;

let coreServer: Bun.Server<undefined> | undefined;
let coreDir: string;
let store: SseTokenStore;
let botDir: string;
let tokenStorePath: string;
let baseUrl: string;

beforeEach(() => {
  coreDir = mkdtempSync(join(tmpdir(), "enroll-resume-core-"));
  store = new SseTokenStore(join(coreDir, "sse-tokens.json"));
  const routes = createAdapterTokenRoutes({ sseTokens: store, remoteAddrOf: () => "127.0.0.1" });
  coreServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });
  baseUrl = `http://127.0.0.1:${coreServer.port}`;
  botDir = mkdtempSync(join(tmpdir(), "enroll-resume-bot-"));
  tokenStorePath = join(botDir, "bot-adapter-token.json");
});

afterEach(() => {
  coreServer?.stop(true);
  coreServer = undefined;
  rmSync(coreDir, { recursive: true, force: true });
  rmSync(botDir, { recursive: true, force: true });
});

/** 봇 한 번의 실행에 해당하는 issuer. 새로 만들면 메모리 상태가 없는 재시작과 같다. */
function botRun(logs: string[] = []) {
  const client = new MemoryApiClient(baseUrl);
  return createAdapterApprovalTokenIssuer({
    client: () => client,
    adapterId: ADAPTER_ID,
    displayName: "디스코드 봇",
    endpoint: "http://127.0.0.1:3100",
    log: (m) => logs.push(m),
    tokenStorePath,
  });
}

const enrollmentPath = () => resolvePendingEnrollmentPath(tokenStorePath);

/** startSseWithRetry 를 실제로 돌리되 sleep 은 기록만 하고, onSleep 으로 대기 사이에 상황을 바꾼다. */
async function runRetryLoop(issue: IssueSseToken, onSleep: (index: number, abort: { cancelled: boolean }) => void) {
  const abort = { cancelled: false };
  const warnings: string[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const result = await startSseWithRetry({
    issueToken: async () => {
      calls += 1;
      return issue();
    },
    memoryApiUrl: baseUrl,
    sseReconnectDelayMs: 1000,
    onEvent: () => {},
    abort,
    log: () => {},
    warn: (m) => warnings.push(m),
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      onSleep(sleeps.length, abort);
    },
  });
  return { result, warnings, sleeps, calls: () => calls };
}

describe("재시작 뒤 대기 요청 이어받기", () => {
  test("대기 요청을 토큰 파일 옆에 저장하고, 재시작 뒤 새 요청 없이 같은 요청의 토큰을 회수한다", async () => {
    await expect(botRun()()).rejects.toThrow("승인 대기");
    expect(existsSync(enrollmentPath())).toBe(true);
    const saved = JSON.parse(readFileSync(enrollmentPath(), "utf8"));
    const [request] = store.listTokenRequests("pending");
    expect(saved).toMatchObject({ adapterId: ADAPTER_ID, baseUrl, requestId: request!.requestId });
    expect(saved.createdAt).toBeString();
    if (process.platform !== "win32") {
      expect(statSync(enrollmentPath()).mode & FILE_MODE_BITS).toBe(OWNER_ONLY_FILE_MODE);
    }

    // 재시작: 새 issuer 가 파일로 같은 요청을 이어 확인한다 — 409 도, 새 요청도 없다.
    const logs: string[] = [];
    const restarted = botRun(logs);
    await expect(restarted()).rejects.toThrow("승인 대기");
    expect(store.listTokenRequests()).toHaveLength(1);
    expect(logs.join("\n")).toContain("이어서 확인");

    store.approveTokenRequest(request!.requestId);
    const { token } = await restarted();
    expect(store.verifyToken(token)).toBe(ADAPTER_ID);
    expect(existsSync(enrollmentPath())).toBe(false);
    expect(existsSync(tokenStorePath)).toBe(true);
    // 비밀값은 로그에 남지 않는다.
    expect(logs.join("\n")).not.toContain(saved.pickupSecret);
  });

  test("다른 서버 주소의 대기 요청 파일은 버리고 새로 등록한다", async () => {
    writeFileSync(
      enrollmentPath(),
      JSON.stringify({ version: 1, adapterId: ADAPTER_ID, baseUrl: "http://127.0.0.1:1", requestId: "atr_other", pickupSecret: "x", createdAt: new Date().toISOString() }),
    );
    await expect(botRun()()).rejects.toThrow("승인 대기");
    expect(store.listTokenRequests("pending")).toHaveLength(1);
    expect(JSON.parse(readFileSync(enrollmentPath(), "utf8")).baseUrl).toBe(baseUrl);
  });
});

describe("끝난 요청 처리", () => {
  test("소유자가 거절(403)한 요청은 파일을 지우고 다시 등록하지 않은 채 재시도를 멈춘다", async () => {
    const issue = botRun();
    await expect(issue()).rejects.toThrow("승인 대기");
    const [first] = store.listTokenRequests("pending");
    store.rejectTokenRequest(first!.requestId);

    const run = await runRetryLoop(issue, () => {});
    expect(run.result.consumer).toBeNull();
    expect(run.calls()).toBe(1);
    expect(run.sleeps).toEqual([]);
    expect(run.warnings.join("\n")).toContain("거절됨 — 다시 연결하려면 봇을 재시작하세요");
    expect(existsSync(enrollmentPath())).toBe(false);
    // 새 요청을 만들지 않았다.
    expect(store.listTokenRequests()).toHaveLength(1);
  });

  test("거절은 AdapterEnrollmentRejectedError 로 드러난다", async () => {
    const issue = botRun();
    await expect(issue()).rejects.toThrow("승인 대기");
    store.rejectTokenRequest(store.listTokenRequests("pending")[0]!.requestId);
    await expect(issue()).rejects.toBeInstanceOf(AdapterEnrollmentRejectedError);
  });

  test("서버가 지운(404) 요청은 파일을 지우고 다음 시도에서 새로 등록한다", async () => {
    writeFileSync(
      enrollmentPath(),
      JSON.stringify({ version: 1, adapterId: ADAPTER_ID, baseUrl, requestId: "atr_gone", pickupSecret: "gone", createdAt: new Date().toISOString() }),
    );
    const issue = botRun();
    await expect(issue()).rejects.toThrow("서버에서 사라짐");
    expect(existsSync(enrollmentPath())).toBe(false);
    await expect(issue()).rejects.toThrow("승인 대기");
    expect(store.listTokenRequests("pending")).toHaveLength(1);
  });
});

describe("대기 요청 파일 삭제 실패는 연결을 막지 않는다", () => {
  test("토큰을 회수한 뒤 파일 삭제가 실패해도 토큰을 먼저 저장하고 경고만 남긴다", async () => {
    const logs: string[] = [];
    const issue = botRun(logs);
    await expect(issue()).rejects.toThrow("승인 대기");
    // 파일 자리를 폴더로 바꿔 삭제가 실패하게 만든다.
    rmSync(enrollmentPath());
    mkdirSync(join(enrollmentPath(), "blocker"), { recursive: true });
    store.approveTokenRequest(store.listTokenRequests("pending")[0]!.requestId);

    const { token } = await issue();
    expect(store.verifyToken(token)).toBe(ADAPTER_ID);
    expect(existsSync(tokenStorePath)).toBe(true);
    expect(logs.join("\n")).toContain("승인 대기 요청 파일 삭제 실패");
  });

  test("저장 토큰이 유효한 경로에서도 파일 삭제 실패는 경고만 남기고 토큰을 쓴다", async () => {
    saveAdapterToken(
      { adapterId: ADAPTER_ID, endpoint: "http://127.0.0.1:3100", token: "stored-test-token", requestId: "atr_x", pickupSecret: "x" },
      tokenStorePath,
    );
    mkdirSync(join(enrollmentPath(), "blocker"), { recursive: true });
    const logs: string[] = [];
    const client = new MemoryApiClient(baseUrl);
    const issue = createAdapterApprovalTokenIssuer({
      client: () => client,
      adapterId: ADAPTER_ID,
      displayName: "디스코드 봇",
      endpoint: "http://127.0.0.1:3100",
      log: (m) => logs.push(m),
      tokenStorePath,
      probeToken: async () => true,
    });
    expect((await issue()).token).toBe("stored-test-token");
    expect(logs.join("\n")).toContain("승인 대기 요청 파일 삭제 실패");
  });
});

describe("옛 대기 요청에 막힌 상태", () => {
  test("막히면 안내를 한 번만 남기고 느린 간격으로 다시 확인하다가, 옛 요청이 거절되면 스스로 새로 등록한다", async () => {
    const stale = store.createTokenRequest({ adapterId: ADAPTER_ID, remoteAddr: "127.0.0.1" });
    const run = await runRetryLoop(botRun(), (index, abort) => {
      // 두 번째 느린 대기 중에 소유자가 옛 요청을 거절한다. 그 뒤 새 등록이 되면 멈춘다.
      if (index === 2) store.rejectTokenRequest(stale.request.requestId);
      if (index === 3) abort.cancelled = true;
    });
    expect(run.result.consumer).toBeNull();
    expect(run.sleeps.slice(0, 2)).toEqual([SSE_BOOTSTRAP_BLOCKED_RECHECK_MS, SSE_BOOTSTRAP_BLOCKED_RECHECK_MS]);
    const guidance = run.warnings.filter((w) => w.includes("거절하세요"));
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toContain("다시 확인");
    // 봇이 재시작 없이 새 요청을 만들고 파일에 남겼다.
    const pending = store.listTokenRequests("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).not.toBe(stale.request.requestId);
    expect(JSON.parse(readFileSync(enrollmentPath(), "utf8")).requestId).toBe(pending[0]!.requestId);
  });

  test("막힌 상태는 AdapterEnrollmentBlockedError 로 드러난다", async () => {
    store.createTokenRequest({ adapterId: ADAPTER_ID, remoteAddr: "127.0.0.1" });
    await expect(botRun()()).rejects.toBeInstanceOf(AdapterEnrollmentBlockedError);
  });
});
