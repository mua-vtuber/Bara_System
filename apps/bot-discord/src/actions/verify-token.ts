/**
 * POST /actions/verify-token — 토큰 검증 액션 (Phase 5.5.6 / S15)
 *
 * 입력: body `{ discordToken: string }`. 임시 discord.js Client 를 만들어 `login(discordToken)`
 * 시도 → 응답이 통과하면 즉시 `destroy()` 로 세션 종료. 매일 사용 봇
 * 동작에는 영향 0 — 임시 client 한 개로만 검증.
 *
 * 응답:
 *   - 통과 = 200 + `{ ok: true, message: "토큰 검증 통과 — ..." }` (대시보드 toast 녹색)
 *   - 실패 = 500 + `{ ok: false, message: "Discord 응답 거부: ..." }` (toast 빨강)
 *
 * 테스트 편의: caller 가 `createClient` 팩토리 옵션을 주입할 수 있다 — 실제
 * Discord API 호출 없이 양성/음성 시나리오 검증 가능. 디폴트는 진짜 discord.js
 * Client 를 활용.
 *
 * 권위: docs/decisions/2026-05-18-app-federation-spec.md section 5.4
 */

import type { Context } from "hono";
import { Client, GatewayIntentBits } from "discord.js";

/** 검증용 임시 client 가 만족해야 할 최소 인터페이스. */
export interface VerifyClient {
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown> | unknown;
}

export interface VerifyTokenDeps {
  /**
   * 임시 client 팩토리. 디폴트는 실제 discord.js Client. 테스트가 fixture 객체를
   * 주입하면 실 API 호출 없이 양성/음성 흐름 검증 가능.
   */
  createClient?: () => VerifyClient;
}

function defaultCreateClient(): Client {
  // 검증 한 번이면 충분 — Guilds 인텐트 하나면 로그인 자체는 통과 판정 가능.
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

/**
 * 토큰 검증 핸들러. body 안 token 을 임시 client 로 시도 로그인.
 *
 * 빈 토큰 / 잘못된 body 도 *toast* 형태로 받아야 하므로 (S15 returns:"toast"),
 * 검증 실패는 500 + JSON `{ ok:false, message }` 로 응답해 대시보드가
 * 빨강 toast 로 자동 활성.
 */
export async function handleVerifyToken(
  c: Context,
  deps: VerifyTokenDeps = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { ok: false, message: "잘못된 JSON body — discordToken 필드 필요" },
      500,
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json(
      { ok: false, message: "body 는 { discordToken: string } 객체여야 한다" },
      500,
    );
  }
  const token = (body as { discordToken?: unknown }).discordToken;
  if (typeof token !== "string" || token.length === 0) {
    return c.json(
      { ok: false, message: "discordToken 값이 비어 있다" },
      500,
    );
  }

  const factory = deps.createClient ?? defaultCreateClient;
  const client = factory();
  try {
    await client.login(token);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // login 실패는 destroy 가 의미 없지만 silent fallback 차단 정신으로 시도.
    try {
      await client.destroy();
    } catch {
      // destroy 실패는 응답 메시지를 가리지 않도록 무시.
    }
    return c.json(
      { ok: false, message: `Discord 응답 거부: ${reason}` },
      500,
    );
  }

  try {
    await client.destroy();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // login 은 성공했으니 양성으로 보고. destroy 실패는 warn 만 남긴다.
    console.warn(
      `[bot-discord verify-token] destroy 실패 (login 은 통과): ${reason}`,
    );
  }

  return c.json({ ok: true, message: "토큰 검증 통과 — Discord 응답 정상" });
}
