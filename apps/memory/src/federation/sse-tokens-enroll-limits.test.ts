/**
 * 무인증 등록 요청 상한 테스트 — pending 상한, pending·rejected 수명 정리, 같은 adapterId
 * 충돌 처리, 소유 증명 재등록 예외.
 *
 * mock 객체 금지 — 실제 SseTokenStore 를 임시 토큰 파일로 돌린다. 오래된 요청은 실제
 * 파일에 지난 시각을 적어 넣고 다시 읽어 만든다(데이터 fixture).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_ENROLL_ERROR_CODES,
  ADAPTER_ENROLL_LIMITS,
  AdapterEnrollRefusedError,
  isEnrollRequestExpired,
} from "./adapter-enroll-limits.ts";
import { SseTokenStore } from "./sse-tokens.ts";

let workDir: string;
let tokenPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sse-tokens-limits-"));
  tokenPath = join(workDir, "sse-tokens.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function refusalCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof AdapterEnrollRefusedError) return err.code;
    throw err;
  }
  return null;
}

/** 파일에 저장된 요청 하나의 시각 칸을 바꿔 쓴다. */
function backdate(requestId: string, fields: Record<string, string>): void {
  const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
  Object.assign(stored.requests[requestId], fields);
  writeFileSync(tokenPath, JSON.stringify(stored));
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("pending 요청 상한", () => {
  test("상한에 닿으면 새 무인증 요청을 pendingLimit 으로 거절하고 파일을 다시 쓰지 않는다", () => {
    const store = new SseTokenStore(tokenPath, { ...ADAPTER_ENROLL_LIMITS, maxPendingRequests: 3 });
    ["a1", "a2", "a3"].forEach((id, i) => store.createTokenRequest({ adapterId: id, remoteAddr: `10.0.0.${i}` }));
    const before = readFileSync(tokenPath, "utf8");

    expect(refusalCode(() => store.createTokenRequest({ adapterId: "a4", remoteAddr: "10.0.0.9" }))).toBe(
      ADAPTER_ENROLL_ERROR_CODES.pendingLimit,
    );
    expect(readFileSync(tokenPath, "utf8")).toBe(before);
    expect(store.listTokenRequests("pending")).toHaveLength(3);
  });

  test("거절·승인으로 대기열이 비면 다시 받는다", () => {
    const store = new SseTokenStore(tokenPath, { ...ADAPTER_ENROLL_LIMITS, maxPendingRequests: 1 });
    const first = store.createTokenRequest({ adapterId: "a1" });
    expect(refusalCode(() => store.createTokenRequest({ adapterId: "a2" }))).toBe(
      ADAPTER_ENROLL_ERROR_CODES.pendingLimit,
    );
    store.rejectTokenRequest(first.request.requestId);
    expect(store.createTokenRequest({ adapterId: "a2" }).request.status).toBe("pending");
  });

  test("기존 토큰 소유를 증명한 재등록은 상한·충돌과 무관하게 자동 승인되고 남은 pending 을 정리한다", () => {
    const store = new SseTokenStore(tokenPath, { ...ADAPTER_ENROLL_LIMITS, maxPendingRequests: 1 });
    const token = store.issueToken("bot-discord");
    const stale = store.createTokenRequest({ adapterId: "bot-discord" });

    const proven = store.createTokenRequest({ adapterId: "bot-discord", existingToken: token });
    expect(proven.request.status).toBe("approved");
    expect(store.getTokenRequest(stale.request.requestId)?.status).toBe("rejected");
    expect(store.pickupApprovedToken(proven.request.requestId, proven.pickupSecret)?.token).toBe(token);
  });

  test("다른 adapterId 의 토큰으로는 소유 증명이 안 된다 — 같은 adapterId pending 이 있으면 충돌", () => {
    const store = new SseTokenStore(tokenPath);
    store.issueToken("bot-discord");
    const otherToken = store.issueToken("pet");
    const first = store.createTokenRequest({ adapterId: "bot-discord" });

    expect(
      refusalCode(() => store.createTokenRequest({ adapterId: "bot-discord", existingToken: otherToken })),
    ).toBe(ADAPTER_ENROLL_ERROR_CODES.pendingExists);
    expect(store.getTokenRequest(first.request.requestId)?.status).toBe("pending");
  });
});

describe("주소별 pending 상한", () => {
  test("한 주소의 pending 이 상한에 닿으면 addressPendingLimit, 다른 주소는 받는다", () => {
    const store = new SseTokenStore(tokenPath);
    const limit = ADAPTER_ENROLL_LIMITS.maxPendingPerAddress;
    for (let i = 0; i < limit; i++) store.createTokenRequest({ adapterId: `same-${i}`, remoteAddr: "203.0.113.7" });
    expect(
      refusalCode(() => store.createTokenRequest({ adapterId: "same-extra", remoteAddr: "203.0.113.7" })),
    ).toBe(ADAPTER_ENROLL_ERROR_CODES.addressPendingLimit);
    expect(store.createTokenRequest({ adapterId: "other", remoteAddr: "203.0.113.8" }).request.status).toBe("pending");
  });

  test("주소를 모르는 요청끼리는 한 주소로 함께 센다", () => {
    const store = new SseTokenStore(tokenPath);
    for (let i = 0; i < ADAPTER_ENROLL_LIMITS.maxPendingPerAddress; i++) store.createTokenRequest({ adapterId: `anon-${i}` });
    expect(refusalCode(() => store.createTokenRequest({ adapterId: "anon-extra" }))).toBe(
      ADAPTER_ENROLL_ERROR_CODES.addressPendingLimit,
    );
  });
});

describe("요청 수명 정리", () => {
  test("토큰을 회수한 승인 요청은 회수 시각부터 보관 기간이 지나면 지운다", () => {
    const store = new SseTokenStore(tokenPath);
    const req = store.createTokenRequest({ adapterId: "picked" });
    store.approveTokenRequest(req.request.requestId);
    expect(store.pickupApprovedToken(req.request.requestId, req.pickupSecret)?.token).toBeString();
    const persisted = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(persisted.requests[req.request.requestId].pickedUpAt).toBeString();
    // 대시보드 목록에는 회수 시각 칸을 싣지 않는다.
    expect(store.getTokenRequest(req.request.requestId)).not.toHaveProperty("pickedUpAt");

    backdate(req.request.requestId, { pickedUpAt: isoAgo(ADAPTER_ENROLL_LIMITS.pickedUpRetentionMs - 60_000) });
    expect(new SseTokenStore(tokenPath).getTokenRequest(req.request.requestId)?.status).toBe("approved");
    backdate(req.request.requestId, { pickedUpAt: isoAgo(ADAPTER_ENROLL_LIMITS.pickedUpRetentionMs + 1000) });
    expect(new SseTokenStore(tokenPath).getTokenRequest(req.request.requestId)).toBeNull();
  });

  test("수명이 지난 pending 은 다시 읽을 때 지워지고 파일에서도 사라진다", () => {
    const store = new SseTokenStore(tokenPath);
    const old = store.createTokenRequest({ adapterId: "old-adapter" });
    const fresh = store.createTokenRequest({ adapterId: "fresh-adapter" });
    backdate(old.request.requestId, { createdAt: isoAgo(ADAPTER_ENROLL_LIMITS.pendingTtlMs + 1000) });

    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.listTokenRequests().map((r) => r.requestId)).toEqual([fresh.request.requestId]);
    expect(reloaded.pickupApprovedToken(old.request.requestId, old.pickupSecret)).toBeNull();
    const persisted = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(Object.keys(persisted.requests)).toEqual([fresh.request.requestId]);
  });

  test("pickup polling 은 pending 수명을 늘리지 않는다(createdAt 기준)", () => {
    const store = new SseTokenStore(tokenPath);
    const req = store.createTokenRequest({ adapterId: "poller" });
    backdate(req.request.requestId, {
      createdAt: isoAgo(ADAPTER_ENROLL_LIMITS.pendingTtlMs + 1000),
      lastSeenAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.getTokenRequest(req.request.requestId)).toBeNull();
  });

  test("만료된 pending 이 지워지면 같은 adapterId 의 새 요청을 받는다", () => {
    const store = new SseTokenStore(tokenPath);
    const old = store.createTokenRequest({ adapterId: "bot-discord" });
    backdate(old.request.requestId, { createdAt: isoAgo(ADAPTER_ENROLL_LIMITS.pendingTtlMs + 1000) });
    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.createTokenRequest({ adapterId: "bot-discord" }).request.status).toBe("pending");
  });

  test("보관 기간이 지난 rejected 는 지우고, 오래된 approved 는 남긴다", () => {
    const store = new SseTokenStore(tokenPath);
    const rejected = store.createTokenRequest({ adapterId: "rejected-one" });
    store.rejectTokenRequest(rejected.request.requestId);
    const approved = store.createTokenRequest({ adapterId: "approved-one" });
    store.approveTokenRequest(approved.request.requestId);
    const longAgo = isoAgo(ADAPTER_ENROLL_LIMITS.rejectedRetentionMs + ADAPTER_ENROLL_LIMITS.pendingTtlMs);
    backdate(rejected.request.requestId, { rejectedAt: isoAgo(ADAPTER_ENROLL_LIMITS.rejectedRetentionMs + 1000) });
    backdate(approved.request.requestId, { createdAt: longAgo, approvedAt: longAgo, updatedAt: longAgo });

    const reloaded = new SseTokenStore(tokenPath);
    expect(reloaded.listTokenRequests().map((r) => r.requestId)).toEqual([approved.request.requestId]);
    expect(reloaded.pickupApprovedToken(approved.request.requestId, approved.pickupSecret)?.token).toBeString();
  });

  test("수명 안의 요청은 그대로 둔다", () => {
    const store = new SseTokenStore(tokenPath);
    const req = store.createTokenRequest({ adapterId: "recent" });
    backdate(req.request.requestId, { createdAt: isoAgo(ADAPTER_ENROLL_LIMITS.pendingTtlMs - 60_000) });
    expect(new SseTokenStore(tokenPath).getTokenRequest(req.request.requestId)?.status).toBe("pending");
  });
});

describe("isEnrollRequestExpired", () => {
  const nowMs = Date.parse("2026-10-13T00:00:00.000Z");
  const base = { createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", rejectedAt: null };

  test("pending 은 createdAt + pendingTtlMs 경계에서 만료", () => {
    const limits = { ...ADAPTER_ENROLL_LIMITS, pendingTtlMs: 24 * 60 * 60 * 1000 };
    expect(isEnrollRequestExpired({ ...base, status: "pending" }, nowMs, limits)).toBe(true);
    expect(isEnrollRequestExpired({ ...base, status: "pending" }, nowMs - 1, limits)).toBe(false);
  });

  test("rejected 는 rejectedAt 이 없으면 updatedAt 기준, 회수 전 approved 는 만료되지 않는다", () => {
    const limits = { ...ADAPTER_ENROLL_LIMITS, rejectedRetentionMs: 1000 };
    expect(isEnrollRequestExpired({ ...base, status: "rejected" }, nowMs, limits)).toBe(true);
    expect(isEnrollRequestExpired({ ...base, status: "approved" }, nowMs, limits)).toBe(false);
  });

  test("시각을 읽을 수 없는 pending 은 만료로 본다", () => {
    expect(isEnrollRequestExpired({ ...base, createdAt: "garbage", status: "pending" }, nowMs, ADAPTER_ENROLL_LIMITS)).toBe(true);
  });
});
