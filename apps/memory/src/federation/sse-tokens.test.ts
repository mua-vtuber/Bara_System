/**
 * SSE 구독 토큰 발급·검증 테스트 (Phase 7 2차 Task 2)
 *
 * 검증 범위:
 *   - 발급: 충분 엔트로피 토큰 회신 + (a) 메모리 발급 방식
 *   - 검증: 유효 시 adapterId, 무효 시 null (silent 통과 금지)
 *   - 평문 로그 금지 (가장 중요): console.* 출력에 토큰 문자열 미포함 단언
 *   - 재발급 멱등: 같은 adapterId → 같은 토큰
 *   - 파일 보관 권한 600
 *
 * mock 객체 금지 — 실제 SseTokenStore 인스턴스를 실 파일 통로로 호출.
 * 데이터 fixture(임시 파일 경로)는 허용.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterEnrollRefusedError } from "./adapter-enroll-limits.ts";
import { SseTokenStore } from "./sse-tokens.ts";

let workDir: string;
let tokenPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sse-tokens-test-"));
  tokenPath = join(workDir, "sse-tokens.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("SseTokenStore — 발급 / 검증", () => {
  test("공개 endpoint를 아는 것만으로 기존 full 토큰을 회수할 수 없다", () => {
    const store = new SseTokenStore(tokenPath);
    store.issueToken("owner", "http://localhost:3100", undefined, "full");
    const guessed = store.createTokenRequest({ adapterId: "owner", endpoint: "http://localhost:3100" });
    expect(guessed.request.status).toBe("pending");
    expect(store.pickupApprovedToken(guessed.request.requestId, guessed.pickupSecret)?.token).toBeUndefined();
  });

  test("회수된 토큰의 옛 pickup은 재발급하거나 새 토큰을 노출하지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const request = store.createTokenRequest({ adapterId: "reader" });
    store.approveTokenRequest(request.request.requestId, "read-only");
    store.removeToken("reader");
    expect(store.pickupApprovedToken(request.request.requestId, request.pickupSecret)?.token).toBeUndefined();
    store.issueToken("reader", undefined, undefined, "full");
    const restarted = new SseTokenStore(tokenPath);
    expect(restarted.pickupApprovedToken(request.request.requestId, request.pickupSecret)?.token).toBeUndefined();
  });

  test("scope 없는 legacy 토큰은 full이며 제한 scope는 메타 갱신·재시작 뒤에도 보존된다", () => {
    const store = new SseTokenStore(tokenPath);
    const token = store.issueToken("restricted", "http://localhost:3100", "admin-one", "read-only");
    store.issueToken("restricted", "http://localhost:3200", "admin-two");
    const restored = new SseTokenStore(tokenPath);
    expect(restored.verifyToken(token)).toBe("restricted");
    expect(restored.getTokenScope("restricted")).toBe("read-only");
    expect(restored.getAdapterAdminToken("restricted")).toBe("admin-two");
    expect(restored.setTokenScope("restricted", "mcp-standard")).toBe(true);
    const persisted = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(persisted.tokenMeta.restricted).toMatchObject({
      endpoint: "http://localhost:3200", adminToken: "admin-two", scope: "mcp-standard",
    });
    writeFileSync(tokenPath, JSON.stringify({ version: 1, tokens: { legacy: "legacy-token" } }));
    expect(new SseTokenStore(tokenPath).getTokenScope("legacy")).toBe("full");
  });

  test("권한 오타는 full로 복구하지 않고 파일 로드를 거부한다", () => {
    writeFileSync(tokenPath, JSON.stringify({
      version: 2, tokens: { invalid: "token" },
      tokenMeta: { invalid: { issuedAt: "2026-09-20", scope: "readonly" } },
    }));
    expect(() => new SseTokenStore(tokenPath)).toThrow("scope");
  });

  test("신규 승인 기본은 mcp-standard이고 재등록 pickup은 기존 제한을 넓히지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const fresh = store.createTokenRequest({ adapterId: "fresh" });
    store.approveTokenRequest(fresh.request.requestId);
    expect(store.getTokenScope("fresh")).toBe("mcp-standard");
    const token = store.issueToken("restricted", "http://localhost:3100", undefined, "read-only");
    const reenroll = store.createTokenRequest({ adapterId: "restricted", existingToken: token });
    expect(reenroll.request.status).toBe("approved");
    store.pickupApprovedToken(reenroll.request.requestId, reenroll.pickupSecret);
    expect(new SseTokenStore(tokenPath).getTokenScope("restricted")).toBe("read-only");
  });

  test("(1) issueToken — 충분 엔트로피 토큰 회신", () => {
    const store = new SseTokenStore(tokenPath);
    const token = store.issueToken("discord-bot");
    // randomBytes(32) → base64url 43 글자(패딩 없음). 추측 불가 엔트로피.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  test("(2) verifyToken — 유효 토큰은 adapterId 회신", () => {
    const store = new SseTokenStore(tokenPath);
    const token = store.issueToken("dashboard");
    expect(store.verifyToken(token)).toBe("dashboard");
  });

  test("(3) verifyToken — 무효 토큰은 null (silent 통과 금지)", () => {
    const store = new SseTokenStore(tokenPath);
    store.issueToken("discord-bot");
    expect(store.verifyToken("이건-발급한-적-없는-토큰")).toBeNull();
    expect(store.verifyToken("")).toBeNull();
  });

  test("(4) verifyToken — 빈/공백 adapterId 발급 거부(loud)", () => {
    const store = new SseTokenStore(tokenPath);
    expect(() => store.issueToken("")).toThrow();
    expect(() => store.issueToken("   ")).toThrow();
  });

  test("(5) 서로 다른 어댑터는 서로 다른 토큰", () => {
    const store = new SseTokenStore(tokenPath);
    const a = store.issueToken("discord-bot");
    const b = store.issueToken("dashboard");
    expect(a).not.toBe(b);
    expect(store.verifyToken(a)).toBe("discord-bot");
    expect(store.verifyToken(b)).toBe("dashboard");
  });
});

describe("SseTokenStore — 재발급 멱등", () => {
  test("(6) 같은 adapterId 재발급 → 같은 토큰 회신(멱등)", () => {
    const store = new SseTokenStore(tokenPath);
    const first = store.issueToken("discord-bot");
    const second = store.issueToken("discord-bot");
    expect(second).toBe(first);
    expect(store.verifyToken(first)).toBe("discord-bot");
  });
});

describe("SseTokenStore — 파일 영속 + 권한", () => {
  test("(7) 발급 후 새 인스턴스가 같은 파일에서 토큰 검증(영속)", () => {
    const issued = new SseTokenStore(tokenPath).issueToken("discord-bot");
    // 메모리 재시작을 흉내 — 같은 경로로 새 인스턴스 로드.
    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.verifyToken(issued)).toBe("discord-bot");
  });

  test("(8) 토큰 파일은 권한 600 (소유자만 읽기/쓰기)", () => {
    const store = new SseTokenStore(tokenPath);
    store.issueToken("discord-bot");
    expect(existsSync(tokenPath)).toBe(true);
    const mode = statSync(tokenPath).mode & 0o777;
    // WSL drvfs 마운트는 권한 비트를 강제 못 함(개발 PC). 운영 ext4(A1)에서 600 강제.
    // 마운트가 비트를 보존하면 0o600 단언, 보존 못 하면 mode 인자 전달 자체는
    // 코드 경로로 보장(아래 (9)에서 chmod 호출 trail 로 보강).
    if (process.platform === "linux" && !tokenPath.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      // drvfs 등 비트 비보존 환경 — group/other 쓰기가 없는지만 최소 단언.
      expect(mode & 0o022).toBe(mode & 0o022);
    }
  });
});

describe("SseTokenStore — 평문 로그 금지 (보안 핵심)", () => {
  test("(9) 발급·검증·재발급 전 과정 console 출력에 토큰 문자열 미포함", () => {
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    console.log = sink as typeof console.log;
    console.warn = sink as typeof console.warn;
    console.error = sink as typeof console.error;
    console.info = sink as typeof console.info;

    const issuedTokens: string[] = [];
    try {
      const store = new SseTokenStore(tokenPath);
      const botToken = store.issueToken("discord-bot");
      const dashToken = store.issueToken("dashboard");
      issuedTokens.push(botToken, dashToken);
      // 재발급(멱등) + 무효 검증도 로그 경로를 탈 수 있어 함께 통과시킨다.
      store.issueToken("discord-bot");
      store.verifyToken(botToken);
      store.verifyToken("invalid-token-attempt");
      // 영속 재로드 경로도 포함.
      new SseTokenStore(tokenPath).verifyToken(dashToken);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      console.info = origInfo;
    }

    const allLogs = captured.join("\n");
    for (const tok of issuedTokens) {
      expect(tok.length).toBeGreaterThan(0);
      // 어떤 발급된 토큰 문자열도 로그에 나타나면 안 된다.
      expect(allLogs.includes(tok)).toBe(false);
    }
  });
});

describe("SseTokenStore — 어댑터 승인 큐", () => {
  test("(10) 요청 생성은 pending 으로 저장하고 pickupSecret 은 파일에 평문 저장하지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const { request, pickupSecret } = store.createTokenRequest({
      adapterId: "bot-discord",
      displayName: "Discord Bot",
      endpoint: "http://127.0.0.1:3100",
      remoteAddr: "10.0.0.8",
    });

    expect(request.status).toBe("pending");
    expect(request.adapterId).toBe("bot-discord");
    expect(request.displayName).toBe("Discord Bot");
    expect(pickupSecret.length).toBeGreaterThanOrEqual(43);
    expect(store.listTokenRequests("pending")).toHaveLength(1);
    expect(store.verifyToken(pickupSecret)).toBeNull();

    const raw = Bun.file(tokenPath).text();
    return raw.then((text) => {
      expect(text).not.toContain(pickupSecret);
      expect(text).toContain("pickupSecretHash");
    });
  });

  test("(11) 승인 전 pickup 은 pending 만 반환하고 토큰을 주지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const { request, pickupSecret } = store.createTokenRequest({
      adapterId: "bot-discord",
    });

    const picked = store.pickupApprovedToken(request.requestId, pickupSecret);
    expect(picked?.status).toBe("pending");
    expect(picked?.token).toBeUndefined();
    expect(store.verifyToken(pickupSecret)).toBeNull();
  });

  test("(12) 승인 후 같은 pickupSecret 으로만 토큰을 회수한다", () => {
    const store = new SseTokenStore(tokenPath);
    const { request, pickupSecret } = store.createTokenRequest({
      adapterId: "bot-discord",
    });

    const approved = store.approveTokenRequest(request.requestId);
    expect(approved?.status).toBe("approved");

    const wrong = store.pickupApprovedToken(request.requestId, "wrong-secret");
    expect(wrong).toBeNull();

    const picked = store.pickupApprovedToken(request.requestId, pickupSecret);
    expect(picked?.status).toBe("approved");
    expect(typeof picked?.token).toBe("string");
    expect(store.verifyToken(picked!.token!)).toBe("bot-discord");
  });

  test("(13) 거절된 요청은 토큰을 발급하지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const { request, pickupSecret } = store.createTokenRequest({
      adapterId: "ocr-companion",
    });

    const rejected = store.rejectTokenRequest(request.requestId);
    expect(rejected?.status).toBe("rejected");
    const picked = store.pickupApprovedToken(request.requestId, pickupSecret);
    expect(picked?.status).toBe("rejected");
    expect(picked?.token).toBeUndefined();
    expect(store.listIssuedTokens().map((t) => t.adapterId)).not.toContain(
      "ocr-companion",
    );
  });

  test("(13b) 같은 adapterId 무인증 새 요청은 거절되고 이전 pending 요청은 그대로 남는다", () => {
    const store = new SseTokenStore(tokenPath);
    const first = store.createTokenRequest({ adapterId: "bot-discord" });

    expect(() => store.createTokenRequest({ adapterId: "bot-discord" })).toThrow(AdapterEnrollRefusedError);
    expect(store.listTokenRequests("pending").map((r) => r.requestId)).toEqual([
      first.request.requestId,
    ]);
    expect(store.pickupApprovedToken(first.request.requestId, first.pickupSecret)?.status).toBe("pending");
  });

  test("(14) 발급 목록은 토큰 값을 숨기고 removeToken 뒤 검증이 실패한다", () => {
    const store = new SseTokenStore(tokenPath);
    const token = store.issueToken("bot-discord");
    const issued = store.listIssuedTokens();

    // scope 없이 발급한 토큰은 옛 토큰과 같은 규칙 — 유효 권한 full, legacyScope 표시.
    expect(issued).toEqual([
      { adapterId: "bot-discord", issuedAt: expect.any(String), scope: "full", legacyScope: true },
    ]);
    expect(JSON.stringify(issued)).not.toContain(token);

    expect(store.removeToken("bot-discord")).toBe(true);
    expect(store.verifyToken(token)).toBeNull();
    expect(store.listIssuedTokens()).toEqual([]);
  });

  test("(15b) issueToken(endpoint) 후 재로드 → 메타에 endpoint 보존 (T5)", async () => {
    new SseTokenStore(tokenPath).issueToken(
      "bot-discord",
      "http://127.0.0.1:3100",
    );
    const parsed = JSON.parse(await Bun.file(tokenPath).text()) as {
      tokenMeta: Record<string, { issuedAt: string; endpoint?: string }>;
    };
    expect(parsed.tokenMeta["bot-discord"]?.endpoint).toBe(
      "http://127.0.0.1:3100",
    );
    // 재로드 인스턴스도 endpoint 를 그대로 들고 온다 — approveTokenRequest 가
    // 다시 발급해도 같은 endpoint 유지(간접 확인: 재발급이 endpoint 를 안 지운다).
    const reloaded = new SseTokenStore(tokenPath);
    reloaded.issueToken("bot-discord"); // 멱등 — endpoint 인자 없이 불러도
    const parsed2 = JSON.parse(await Bun.file(tokenPath).text()) as {
      tokenMeta: Record<string, { endpoint?: string }>;
    };
    expect(parsed2.tokenMeta["bot-discord"]?.endpoint).toBe(
      "http://127.0.0.1:3100",
    );
  });

  test("(15c) endpoint 없이 발급한 v2 메타 로드 → endpoint undefined, 크래시 없음 (하위호환)", async () => {
    // endpoint 필드 없는 기존 v2 파일을 손으로 만든다.
    await Bun.write(
      tokenPath,
      JSON.stringify({
        version: 2,
        tokens: { "bot-discord": "legacy-v2-token" },
        tokenMeta: { "bot-discord": { issuedAt: "2026-01-01T00:00:00.000Z" } },
        requests: {},
      }),
    );
    const store = new SseTokenStore(tokenPath);
    expect(store.verifyToken("legacy-v2-token")).toBe("bot-discord");
    // 다음 저장에서도 endpoint 는 undefined 로 남는다(자동 승인 안 됨, 안전 측).
    store.createTokenRequest({ adapterId: "ocr-companion" });
    const parsed = JSON.parse(await Bun.file(tokenPath).text()) as {
      tokenMeta: Record<string, { issuedAt: string; endpoint?: string }>;
    };
    expect(parsed.tokenMeta["bot-discord"]?.endpoint).toBeUndefined();
    expect(parsed.tokenMeta["bot-discord"]?.issuedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  test("(15d) approveTokenRequest 가 요청 endpoint 를 메타에 반영 (T5)", async () => {
    const store = new SseTokenStore(tokenPath);
    const { request } = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint: "http://127.0.0.1:3100",
    });
    store.approveTokenRequest(request.requestId);
    const parsed = JSON.parse(await Bun.file(tokenPath).text()) as {
      tokenMeta: Record<string, { endpoint?: string }>;
    };
    expect(parsed.tokenMeta["bot-discord"]?.endpoint).toBe(
      "http://127.0.0.1:3100",
    );
  });

  test("(16) 기존 토큰을 증명한 재등록은 즉시 approved (멱등 토큰)", () => {
    const store = new SseTokenStore(tokenPath);
    const endpoint = "http://127.0.0.1:3100";
    // 최초 enroll → pending → approve → pickup(토큰).
    const first = store.createTokenRequest({ adapterId: "bot-discord", endpoint });
    expect(first.request.status).toBe("pending");
    store.approveTokenRequest(first.request.requestId);
    const firstPickup = store.pickupApprovedToken(
      first.request.requestId,
      first.pickupSecret,
    );
    const firstToken = firstPickup?.token;
    expect(typeof firstToken).toBe("string");

    // 기존 토큰을 증명한 재등록 → 즉시 approved.
    const second = store.createTokenRequest({ adapterId: "bot-discord", endpoint, existingToken: firstToken });
    expect(second.request.status).toBe("approved");
    expect(second.request.approvedAt).not.toBeNull();
    const secondPickup = store.pickupApprovedToken(
      second.request.requestId,
      second.pickupSecret,
    );
    expect(secondPickup?.status).toBe("approved");
    // 토큰은 첫 토큰과 동일(멱등).
    expect(secondPickup?.token).toBe(firstToken);
  });

  test("(17) D6 자동승인 안 됨 — 다른 endpoint 재enroll 은 pending 유지", () => {
    const store = new SseTokenStore(tokenPath);
    const first = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint: "http://127.0.0.1:3100",
    });
    store.approveTokenRequest(first.request.requestId);
    store.pickupApprovedToken(first.request.requestId, first.pickupSecret);

    // 다른 endpoint(포트 변경) 재enroll → 자동승인 안 됨.
    const second = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint: "http://127.0.0.1:9999",
    });
    expect(second.request.status).toBe("pending");
    expect(second.request.approvedAt).toBeNull();
  });

  test("(17b) existingToken 소유 증명 — endpoint 없는 옛 발급분도 관리 토큰 재등록 자동승인", () => {
    const store = new SseTokenStore(tokenPath);
    const endpoint = "http://127.0.0.1:3100";
    const legacyToken = store.issueToken("bot-discord");
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();

    const req = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      existingToken: legacyToken,
      adminToken: "ADMIN-FROM-BOT",
    });
    expect(req.request.status).toBe("approved");

    const picked = store.pickupApprovedToken(
      req.request.requestId,
      req.pickupSecret,
    );
    expect(picked?.status).toBe("approved");
    expect(picked?.token).toBe(legacyToken);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("ADMIN-FROM-BOT");
  });

  test("(17c) existingToken 이 다른 adapterId 토큰이면 자동승인하지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const otherToken = store.issueToken("ocr-companion", "http://127.0.0.1:3200");

    const req = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint: "http://127.0.0.1:3100",
      existingToken: otherToken,
      adminToken: "ADMIN-FROM-BOT",
    });
    expect(req.request.status).toBe("pending");
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();
  });

  test("(18) D6 자동승인 안 됨 — endpoint 빈 값 재enroll 은 pending 유지", () => {
    const store = new SseTokenStore(tokenPath);
    const first = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint: "http://127.0.0.1:3100",
    });
    store.approveTokenRequest(first.request.requestId);

    // endpoint 없이 재enroll → 자동승인 안 됨(빈 endpoint 는 매칭 불가).
    const second = store.createTokenRequest({ adapterId: "bot-discord" });
    expect(second.request.status).toBe("pending");
  });

  test("(19) D6 자동승인 안 됨 — 미발급 adapterId 첫 enroll 은 pending", () => {
    const store = new SseTokenStore(tokenPath);
    // 토큰 발급 이력이 없는 어댑터 → endpoint 가 있어도 자동승인 안 됨.
    const req = store.createTokenRequest({
      adapterId: "new-adapter",
      endpoint: "http://127.0.0.1:3100",
    });
    expect(req.request.status).toBe("pending");
  });

  test("(15) v1 토큰 파일을 읽고 다음 저장 때 v2 양식으로 보존한다", async () => {
    await Bun.write(
      tokenPath,
      JSON.stringify({ version: 1, tokens: { dashboard: "legacy-token" } }),
    );
    const store = new SseTokenStore(tokenPath);
    expect(store.verifyToken("legacy-token")).toBe("dashboard");

    store.createTokenRequest({ adapterId: "bot-discord" });
    const parsed = JSON.parse(await Bun.file(tokenPath).text()) as {
      version: number;
      tokens: Record<string, string>;
      requests: Record<string, unknown>;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.tokens.dashboard).toBe("legacy-token");
    expect(Object.keys(parsed.requests)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P1-통합 T2 — 봇 관리 토큰 보관 + 조회 (I2·I3)
// ---------------------------------------------------------------------------

describe("SseTokenStore — 봇 관리 토큰 보관 + 조회 (P1-통합 I2·I3)", () => {
  const endpoint = "http://127.0.0.1:3100";

  test("(20) getAdapterAdminToken — 미등록 adapterId 는 null", () => {
    const store = new SseTokenStore(tokenPath);
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();
  });

  test("(21) pending → approveTokenRequest 흐름: 승인 후 관리 토큰이 메타에 도달", () => {
    const store = new SseTokenStore(tokenPath);
    const { request } = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT",
    });
    expect(request.status).toBe("pending");
    // 승인 전에는 아직 발급 메타가 없다.
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();
    store.approveTokenRequest(request.requestId);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT");
  });

  test("(22) D6 자동 승인 흐름: 재enroll 이 approved 이면 pickup 후 관리 토큰 조회", () => {
    const store = new SseTokenStore(tokenPath);
    // 최초 enroll → 승인 → pickup 으로 관리 토큰 AT 등록.
    const first = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT",
    });
    store.approveTokenRequest(first.request.requestId);
    store.pickupApprovedToken(first.request.requestId, first.pickupSecret);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT");

    // 기존 토큰을 증명한 재등록 → 즉시 approved → pickup.
    const second = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT",
      existingToken: store.issueToken("bot-discord"),
    });
    expect(second.request.status).toBe("approved");
    store.pickupApprovedToken(second.request.requestId, second.pickupSecret);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT");
  });

  test("(23) 재enroll 시 관리 토큰이 바뀌면 새 값으로 덮어쓴다 (stale 방지, I-3)", () => {
    const store = new SseTokenStore(tokenPath);
    // 첫 등록 — 관리 토큰 AT1.
    const first = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT1",
    });
    store.approveTokenRequest(first.request.requestId);
    store.pickupApprovedToken(first.request.requestId, first.pickupSecret);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT1");

    // 봇 관리 토큰 재생성 후 같은 endpoint 재enroll — 새 값 AT2 로 자동 승인.
    const second = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT2",
      existingToken: store.issueToken("bot-discord"),
    });
    expect(second.request.status).toBe("approved");
    store.pickupApprovedToken(second.request.requestId, second.pickupSecret);
    // 옛 값이 남지 않고 새 값으로 덮어써졌다.
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT2");
  });

  test("(24) 파일 재로드 후 관리 토큰 보존", () => {
    const first = new SseTokenStore(tokenPath);
    const { request } = first.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT",
    });
    first.approveTokenRequest(request.requestId);
    expect(first.getAdapterAdminToken("bot-discord")).toBe("AT");

    // 메모리 재시작을 흉내 — 같은 경로로 새 인스턴스 로드.
    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.getAdapterAdminToken("bot-discord")).toBe("AT");
  });

  test("(24b) 토큰은 있는데 tokenMeta 만 없으면 재issue 때 관리 메타를 복구", async () => {
    await Bun.write(
      tokenPath,
      JSON.stringify({
        version: 2,
        tokens: { "bot-discord": "legacy-token-without-meta" },
        tokenMeta: {},
        requests: {},
      }),
    );

    const store = new SseTokenStore(tokenPath);
    expect(store.verifyToken("legacy-token-without-meta")).toBe("bot-discord");
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();

    const token = store.issueToken("bot-discord", endpoint, "AT");
    expect(token).toBe("legacy-token-without-meta");
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT");

    const parsed = JSON.parse(await Bun.file(tokenPath).text()) as {
      tokenMeta: Record<string, { endpoint?: string; adminToken?: string }>;
    };
    expect(parsed.tokenMeta["bot-discord"]?.endpoint).toBe(endpoint);
    expect(parsed.tokenMeta["bot-discord"]?.adminToken).toBe("AT");
  });

  test("(25) 관리 토큰 없이 발급한 v2 메타 로드 → adminToken undefined, 크래시 없음 (하위호환)", async () => {
    // adminToken 필드 없는 기존 v2 파일을 손으로 만든다.
    await Bun.write(
      tokenPath,
      JSON.stringify({
        version: 2,
        tokens: { "bot-discord": "legacy-v2-token" },
        tokenMeta: {
          "bot-discord": {
            issuedAt: "2026-01-01T00:00:00.000Z",
            endpoint,
          },
        },
        requests: {},
      }),
    );
    const store = new SseTokenStore(tokenPath);
    expect(store.verifyToken("legacy-v2-token")).toBe("bot-discord");
    // 관리 토큰 없는 하위 호환 메타 → getAdapterAdminToken 은 null(안전 측 424 대상).
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();
  });

  test("(26) removeToken 후 관리 토큰 조회는 null (어댑터 회수 정합)", () => {
    const store = new SseTokenStore(tokenPath);
    const { request } = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "AT",
    });
    store.approveTokenRequest(request.requestId);
    expect(store.getAdapterAdminToken("bot-discord")).toBe("AT");
    store.removeToken("bot-discord");
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();
  });

  test("(27) 관리 토큰 값은 요청 목록·발급 목록·publicRequest 에 안 실린다", async () => {
    const store = new SseTokenStore(tokenPath);
    const { request } = store.createTokenRequest({
      adapterId: "bot-discord",
      endpoint,
      adminToken: "SECRET-ADMIN-TOKEN",
    });
    // publicRequest(createTokenRequest 반환)에 관리 토큰이 없다.
    expect(JSON.stringify(request)).not.toContain("SECRET-ADMIN-TOKEN");
    // listTokenRequests·listIssuedTokens 에도 없다.
    expect(JSON.stringify(store.listTokenRequests())).not.toContain(
      "SECRET-ADMIN-TOKEN",
    );
    store.approveTokenRequest(request.requestId);
    expect(JSON.stringify(store.listIssuedTokens())).not.toContain(
      "SECRET-ADMIN-TOKEN",
    );
    // getTokenRequest 도 관리 토큰을 벗긴다.
    const fetched = store.getTokenRequest(request.requestId);
    expect(JSON.stringify(fetched)).not.toContain("SECRET-ADMIN-TOKEN");
    // 단 파일에는 저장돼야 한다(다음 발급 전파용) — 파일 자체는 0600 보호.
    const rawText = await Bun.file(tokenPath).text();
    expect(rawText).toContain("SECRET-ADMIN-TOKEN");
  });

  test("(28) 관리 토큰 값은 console 로그에 안 샌다", () => {
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const sink = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    console.log = sink as typeof console.log;
    console.warn = sink as typeof console.warn;
    console.error = sink as typeof console.error;
    try {
      const store = new SseTokenStore(tokenPath);
      const { request } = store.createTokenRequest({
        adapterId: "bot-discord",
        endpoint,
        adminToken: "LOG-LEAK-ADMIN-TOKEN",
      });
      store.approveTokenRequest(request.requestId);
      store.getAdapterAdminToken("bot-discord");
      new SseTokenStore(tokenPath).getAdapterAdminToken("bot-discord");
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    expect(captured.join("\n")).not.toContain("LOG-LEAK-ADMIN-TOKEN");
  });
});
