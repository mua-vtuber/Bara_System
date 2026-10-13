/**
 * 관리 어댑터 권한 — 저장소 단위 검증 (WP-B1-13, CR-0·SA-2·SA-6).
 *
 * 검증 범위:
 *   - requestedScope 는 저장·표시만 하고 승인 권한으로 쓰지 않는다.
 *   - 운영 옛 토큰(scope 칸 없음 = full)은 어떤 자동 경로에서도 교체·축소되지 않는다.
 *   - share 승인은 같은 토큰, rotate 승인은 새 토큰 + 옛 토큰 무효 + 다른 approved 요청 거절.
 *   - 회수·교체·권한 변경은 onTokenChange 로 통지되고, 통지 실패는 격리된다.
 *
 * mock 객체 금지 — 실제 SseTokenStore 를 임시 파일로 쓴다(sse-tokens.test.ts 와 같은 방식).
 * sse-tokens.test.ts 가 800줄 상한에 가까워 이 WP 의 저장소 테스트를 이 파일로 나눴다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseTokenStore, type TokenChange, type TokenScope } from "./sse-tokens.ts";

let workDir: string;
let tokenPath: string;
const endpoint = "http://127.0.0.1:3100";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sse-tokens-approval-"));
  tokenPath = join(workDir, "sse-tokens.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 운영 A1 에 남아 있는 형태의 옛 봇 토큰 파일(version 2 양식, tokenMeta 에 scope 칸 없음). */
function writeLegacyBotFile(token: string): void {
  writeFileSync(tokenPath, JSON.stringify({
    version: 2,
    tokens: { "bot-discord": token },
    tokenMeta: { "bot-discord": { issuedAt: "2026-01-01T00:00:00.000Z", endpoint } },
    requests: {},
  }));
}

function recordChanges(store: SseTokenStore): TokenChange[] {
  const seen: TokenChange[] = [];
  store.onTokenChange((change) => seen.push(change));
  return seen;
}

describe("requestedScope — 저장·표시 전용", () => {
  test("요청 권한은 저장·재로드되지만 scope 생략 승인의 기본값은 여전히 mcp-standard", () => {
    const store = new SseTokenStore(tokenPath);
    const req = store.createTokenRequest({ adapterId: "ocr-companion", requestedScope: "full" });
    expect(req.request.requestedScope).toBe("full");
    store.approveTokenRequest(req.request.requestId);
    expect(store.getTokenScope("ocr-companion")).toBe("mcp-standard");
    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.getTokenRequest(req.request.requestId)?.requestedScope).toBe("full");
  });

  test("잘못된 requestedScope 는 거부되고 기존 pending 요청을 건드리지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const first = store.createTokenRequest({ adapterId: "bot-discord" });
    expect(() =>
      store.createTokenRequest({ adapterId: "bot-discord", requestedScope: "admin" as TokenScope }),
    ).toThrow("requestedScope");
    expect(store.getTokenRequest(first.request.requestId)?.status).toBe("pending");
  });

  test("파일의 잘못된 requestedScope 는 조용히 버리지 않고 로드를 거부한다", () => {
    writeFileSync(tokenPath, JSON.stringify({
      version: 2, tokens: {},
      requests: { atr_x: { requestId: "atr_x", adapterId: "bot-discord", pickupSecretHash: "h", requestedScope: "admin" } },
    }));
    expect(() => new SseTokenStore(tokenPath)).toThrow("requestedScope");
  });
});

describe("운영 옛 토큰 보호 — 자동 경로는 교체·축소하지 않는다", () => {
  test("자동 재등록(requestedScope 포함)·pickup·다른 어댑터 처리·scope 생략 승인 뒤에도 같은 토큰, full, scope 칸 없음", () => {
    writeLegacyBotFile("legacy-bot-token");
    const store = new SseTokenStore(tokenPath);
    const changes = recordChanges(store);
    expect(store.getIssuedTokenScope("bot-discord")).toEqual({ scope: "full", legacyScope: true });

    // 봇 재시작 = 기존 토큰 소유 증명 재등록. 어떤 requestedScope 를 실어도 무시된다.
    for (const requestedScope of ["read-only", "mcp-standard", "full"] as const) {
      const auto = store.createTokenRequest({
        adapterId: "bot-discord", endpoint, existingToken: "legacy-bot-token", adminToken: "AT", requestedScope,
      });
      expect(auto.request.status).toBe("approved");
      expect(store.pickupApprovedToken(auto.request.requestId, auto.pickupSecret)?.token).toBe("legacy-bot-token");
    }
    // 다른 어댑터의 승인·회수는 봇 토큰과 무관하다.
    const other = store.createTokenRequest({ adapterId: "ocr-companion", requestedScope: "full" });
    store.approveTokenRequest(other.request.requestId);
    store.removeToken("ocr-companion");
    // 관리자가 scope·existingToken 을 생략하고 승인하면 현재 권한 유지 + 기존 토큰 공유(현행).
    const manual = store.createTokenRequest({ adapterId: "bot-discord", requestedScope: "read-only" });
    store.approveTokenRequest(manual.request.requestId);
    expect(store.pickupApprovedToken(manual.request.requestId, manual.pickupSecret)?.token).toBe("legacy-bot-token");

    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.verifyToken("legacy-bot-token")).toBe("bot-discord");
    expect(reloaded.getIssuedTokenScope("bot-discord")).toEqual({ scope: "full", legacyScope: true });
    expect(JSON.parse(readFileSync(tokenPath, "utf8")).tokenMeta["bot-discord"].scope).toBeUndefined();
    expect(changes.filter((change) => change.adapterId === "bot-discord")).toEqual([]);
  });
});

describe("기존 어댑터 재등록 승인 — share / rotate", () => {
  test("share 는 같은 토큰을 전달하고, scope 를 지정하면 그 토큰의 권한이 바뀌며 통지된다", () => {
    const store = new SseTokenStore(tokenPath);
    const token = store.issueToken("pet", undefined, undefined, "mcp-standard");
    const changes = recordChanges(store);
    const shared = store.createTokenRequest({ adapterId: "pet" });
    store.approveTokenRequest(shared.request.requestId, undefined, "share");
    expect(store.pickupApprovedToken(shared.request.requestId, shared.pickupSecret)?.token).toBe(token);
    expect(changes).toEqual([]);

    const narrowed = store.createTokenRequest({ adapterId: "pet" });
    store.approveTokenRequest(narrowed.request.requestId, "read-only");
    expect(store.verifyToken(token)).toBe("pet");
    expect(store.getIssuedTokenScope("pet")).toEqual({ scope: "read-only", legacyScope: false });
    expect(changes).toEqual([{ adapterId: "pet", kind: "scope-changed" }]);
  });

  test("rotate 는 새 토큰 발급, 옛 토큰 무효, 다른 approved 요청 거절, 옛 토큰의 full 을 명시해 기록한다", () => {
    const store = new SseTokenStore(tokenPath);
    const legacy = store.issueToken("bot-discord", endpoint, "OLD-ADMIN");
    const earlier = store.createTokenRequest({ adapterId: "bot-discord", existingToken: legacy });
    expect(earlier.request.status).toBe("approved");
    const changes = recordChanges(store);

    const newEndpoint = "http://127.0.0.1:3200";
    const req = store.createTokenRequest({ adapterId: "bot-discord", endpoint: newEndpoint, requestedScope: "full" });
    store.approveTokenRequest(req.request.requestId, undefined, "rotate");
    const picked = store.pickupApprovedToken(req.request.requestId, req.pickupSecret);
    const rotated = picked?.token;
    expect(typeof rotated).toBe("string");
    expect(rotated).not.toBe(legacy);
    expect(store.verifyToken(legacy)).toBeNull();
    expect(store.verifyToken(rotated!)).toBe("bot-discord");
    const oldPickup = store.pickupApprovedToken(earlier.request.requestId, earlier.pickupSecret);
    expect(oldPickup?.status).toBe("rejected");
    expect(oldPickup?.token).toBeUndefined();
    expect(store.getIssuedTokenScope("bot-discord")).toEqual({ scope: "full", legacyScope: false });
    // 끊어 낸 옛 연결의 관리 토큰을 새 요청자의 endpoint 로 잇지 않는다 — 요청 값만 남는다.
    expect(store.getAdapterAdminToken("bot-discord")).toBeNull();
    const persisted = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(persisted.tokenMeta["bot-discord"]).toEqual({
      issuedAt: expect.any(String), scope: "full", endpoint: newEndpoint,
    });
    expect(changes).toEqual([{ adapterId: "bot-discord", kind: "rotated" }]);
    expect(new SseTokenStore(tokenPath).verifyToken(rotated!)).toBe("bot-discord");
  });

  test("rotate 요청이 관리 토큰을 보내면 그 값이 새 메타에 기록된다", () => {
    const store = new SseTokenStore(tokenPath);
    store.issueToken("bot-discord", endpoint, "OLD-ADMIN", "full");
    const req = store.createTokenRequest({ adapterId: "bot-discord", endpoint, adminToken: "NEW-ADMIN" });
    store.approveTokenRequest(req.request.requestId, "mcp-standard", "rotate");
    expect(store.getAdapterAdminToken("bot-discord")).toBe("NEW-ADMIN");
    expect(store.getIssuedTokenScope("bot-discord")).toEqual({ scope: "mcp-standard", legacyScope: false });
  });

  test("토큰이 없는 어댑터에 existingToken 을 주면 거부하고 요청·발급 상태를 바꾸지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const req = store.createTokenRequest({ adapterId: "fresh" });
    for (const choice of ["share", "rotate"] as const) {
      expect(() => store.approveTokenRequest(req.request.requestId, undefined, choice)).toThrow("existingToken");
    }
    expect(store.getTokenRequest(req.request.requestId)?.status).toBe("pending");
    expect(store.listIssuedTokens()).toEqual([]);
  });
});

describe("onTokenChange — 회수·권한 변경 통지", () => {
  test("회수·권한 변경을 알리고, 해제 뒤에는 알리지 않으며, 한 구독자의 실패가 다른 구독자를 막지 않는다", () => {
    const store = new SseTokenStore(tokenPath);
    const token = store.issueToken("reader", undefined, undefined, "mcp-standard");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => warnings.push(args.map(String).join(" "))) as typeof console.warn;
    const seen: TokenChange[] = [];
    try {
      store.onTokenChange(() => {
        throw new Error("listener failure");
      });
      const stop = store.onTokenChange((change) => seen.push(change));
      store.setTokenScope("reader", "read-only");
      store.removeToken("reader");
      stop();
      store.issueToken("reader", undefined, undefined, "read-only");
      store.setTokenScope("reader", "full");
    } finally {
      console.warn = origWarn;
    }
    expect(seen).toEqual([
      { adapterId: "reader", kind: "scope-changed" },
      { adapterId: "reader", kind: "revoked" },
    ]);
    expect(warnings.some((line) => line.includes("adapterId=reader"))).toBe(true);
    expect(warnings.join("\n")).not.toContain(token);
  });
});
