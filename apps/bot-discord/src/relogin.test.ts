/**
 * reloginWithNewToken — 토큰 변경 시 client destroy + 새 login (Phase 5.5.6 / S16).
 *
 * reloginWithNewToken 이 봇 hot-reload 의 핵심. 가짜 Client *구현체* 만들지 않는
 * 정신 정합 — fixture 객체 (단순 record + spy) 한 벌로 destroy/login 순서와
 * 인자만 점검.
 */

import { describe, expect, test } from "bun:test";

import {
  reloginWithNewToken,
  type MinimalDiscordClient,
} from "./relogin.ts";

function makeClient(opts: {
  destroyImpl?: () => Promise<unknown> | unknown;
  loginImpl?: (token: string) => Promise<unknown>;
}): {
  client: MinimalDiscordClient;
  calls: Array<{ kind: "destroy" } | { kind: "login"; token: string }>;
} {
  const calls: Array<{ kind: "destroy" } | { kind: "login"; token: string }> = [];
  const client: MinimalDiscordClient = {
    async destroy() {
      calls.push({ kind: "destroy" });
      if (opts.destroyImpl) return opts.destroyImpl();
      return undefined;
    },
    async login(token: string) {
      calls.push({ kind: "login", token });
      if (opts.loginImpl) return opts.loginImpl(token);
      return "ok";
    },
  };
  return { client, calls };
}

describe("reloginWithNewToken — 단계 2 재진입 흐름", () => {
  test("양성 — destroy 1회 → login 1회 (새 토큰) 순서", async () => {
    const { client, calls } = makeClient({});
    await reloginWithNewToken(client, "new-token-xyz");
    expect(calls).toEqual([
      { kind: "destroy" },
      { kind: "login", token: "new-token-xyz" },
    ]);
  });

  test("새 토큰이 빈 문자열 = destroy/login 둘 다 호출 안 함", async () => {
    const { client, calls } = makeClient({});
    await reloginWithNewToken(client, "");
    expect(calls).toEqual([]);
  });

  test("destroy 실패해도 login 은 계속 시도 (사용자에게 surface)", async () => {
    const { client, calls } = makeClient({
      destroyImpl: () => {
        throw new Error("destroy boom");
      },
    });
    await reloginWithNewToken(client, "tok-2");
    expect(calls).toEqual([
      { kind: "destroy" },
      { kind: "login", token: "tok-2" },
    ]);
  });

  test("login 실패 = throw 잡고 silent 안 흘림 (error 로그만)", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const { client, calls } = makeClient({
        loginImpl: () => {
          throw new Error("Discord token rejected");
        },
      });
      await reloginWithNewToken(client, "bad-token");
      expect(calls.length).toBe(2);
      expect(errors.some((e) => e.includes("Discord token rejected"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  test("단계 2 재진입 — 새 토큰으로 교체 시 destroy + login 순서", async () => {
    // hot-reload 시 기존 세션을 destroy 후 새 토큰으로 login 하는 패턴 검증.
    const { client, calls } = makeClient({});
    // 첫 번째 연결 (이미 된 상태 가정 — destroy + login 으로 재진입)
    await reloginWithNewToken(client, "token-v2");
    expect(calls).toEqual([
      { kind: "destroy" },
      { kind: "login", token: "token-v2" },
    ]);
  });

  test("단계 2 재진입 후 다시 재진입 — 각 재진입이 독립적으로 destroy + login", async () => {
    const { client, calls } = makeClient({});
    await reloginWithNewToken(client, "token-round1");
    await reloginWithNewToken(client, "token-round2");
    expect(calls).toEqual([
      { kind: "destroy" },
      { kind: "login", token: "token-round1" },
      { kind: "destroy" },
      { kind: "login", token: "token-round2" },
    ]);
  });

  test("단계 2 재진입 거부 — 새 토큰 빈 문자열 = 현 세션 유지 (destroy 안 함)", async () => {
    const { client, calls } = makeClient({});
    await reloginWithNewToken(client, "");
    // 빈 토큰 = 재진입 안 함 — destroy/login 모두 호출 안 됨
    expect(calls).toEqual([]);
  });
});
