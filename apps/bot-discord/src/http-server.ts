/**
 * 디스코드 봇 어댑터 HTTP 서버 (Phase 5.5.6 / S14 + S15)
 *
 * 메모리 코어 디스커버리가 이 서버를 향해 settings schema/get/put 을 호출 →
 * 자기 대시보드 탭으로 자동 폼 노출. 서버 자체는 127.0.0.1 한정 — 외부 노출 X.
 *
 * 라우터 4 + 액션 2 = 총 6 endpoint:
 *   - GET  /health             → { ok: true }
 *   - GET  /settings/schema    → botSettingsSchema (JSON Schema)
 *   - GET  /settings           → 현 값 + 마스킹 ($masked: ["discordToken"])
 *   - PUT  /settings           → 검증 → 저장 → reload-bus emit → 마스킹된 값 반환
 *   - POST /actions/verify-token  → 토큰 검증 toast
 *   - GET  /actions/list-channels → 가입 길드 채널 옵션 enum
 *
 * Phase 5.7.1 W2 — 옛 list-ollama-models 액션 폐기 (능동 모드 Phase 10 미구현
 * 잔존 코드 정리). ollama* 키 자체가 봇 schema 안 자리 0.
 *
 * 권위: docs/decisions/2026-05-18-app-federation-spec.md section 4 / 5
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import {
  handleListChannels,
  type ChannelListClient,
} from "./actions/list-channels.ts";
import { handleVerifyToken } from "./actions/verify-token.ts";
import { createAdminGate } from "./http-admin-gate.ts";
import { createHostGuard } from "./http-host-guard.ts";
import { botSettingsSchema, maskBotSecrets } from "./settings-schema.ts";
import type { BotSettings } from "./settings-schema.ts";
import {
  getBotSettings,
  isBotSettingsFilePresent,
  putBotSettings,
  validate,
} from "./settings-store.ts";
import type { ReloadBus } from "./reload-bus.ts";

/** 봇 HTTP 서버가 bind 할 호스트. 외부 노출 절대 X — 127.0.0.1 한정. */
export const BOT_HTTP_HOST = "127.0.0.1";
/** 봇 HTTP 서버가 bind 할 포트. spec section 4.1 약속. */
export const BOT_HTTP_PORT = 3100;
/**
 * 봇 HTTP 서버의 어댑터 endpoint. host·port 상수에서 파생한 단일 출처.
 *
 * 옛 구조는 이 문자열을 index.ts(어댑터 enroll)·app.manifest.json 두 곳에서
 * 각각 리터럴 3100 으로 다시 조립해 드리프트 위험이 있었다. 이제 코드 쪽은 이
 * 상수 하나만 참조하고, 정적 JSON 인 manifest 는 코드 상수를 읽을 수 없으므로
 * http-server.test.ts 의 정합 테스트가 manifest.endpoint === BOT_HTTP_ENDPOINT
 * 를 단언해 드리프트를 잡는다(D7 단일 검증 지점).
 */
export const BOT_HTTP_ENDPOINT = `http://${BOT_HTTP_HOST}:${BOT_HTTP_PORT}`;

export interface HttpServerOptions {
  reloadBus: ReloadBus;
  /**
   * settings 파일 경로 override. 미지정 시 settings-store 가 디폴트 경로
   * (data/bot-settings.json) 또는 BOT_SETTINGS_PATH 환경변수를 사용.
   * 테스트는 임시 디렉토리 경로를 주입.
   */
  settingsPath?: string;
  /**
   * 가동 중인 discord.js Client — 직접 주입 (테스트 호환).
   * `getDiscordClient` 와 동시 지정 시 `getDiscordClient` 우선.
   */
  discordClient?: ChannelListClient;
  /**
   * 단계 2 세션 client 를 동적으로 가져오는 getter.
   * index.ts 가 단계 2 재진입 후 새 client 를 참조할 수 있도록
   * 클로저로 주입. 미지정 시 `discordClient` 정적 참조 사용.
   */
  getDiscordClient?: () => ChannelListClient | undefined;
  /**
   * Host/Origin 검증 미들웨어 override (D1·D3). 미지정 시 createHostGuard() 기본값
   * (포트 상수 파생 허용목록 + BOT_ALLOWED_HOSTS env). 테스트가 스텁 주입한
   * 미들웨어를 넣을 수 있게 열어 둔다.
   */
  hostGuard?: MiddlewareHandler;
  /**
   * 로컬 관리 토큰 게이트가 검증할 기대 토큰을 반환하는 함수 (D2). 지정하면
   * 상태변경·민감읽기 경로(PUT /settings, GET /settings, /actions/*)가 이 토큰을
   * Bearer 로 요구한다. index.ts 가 loadOrCreateAdminToken 으로 만든 토큰을
   * 클로저로 넘긴다. 미지정 시 게이트를 걸지 않는다 — 이 옵션 부재는 봇을
   * 무인증으로 여는 것이므로, 운영 배선(index.ts)은 항상 지정해야 한다. 미지정
   * 통로는 게이트를 우회한 단위 테스트(라우트 로직만 검증)를 위한 것이다.
   */
  adminToken?: () => string;
}

function badJson(c: Context, message: string, errors?: string[]) {
  if (errors && errors.length > 0) {
    return c.json({ error: message, errors }, 400);
  }
  return c.json({ error: message }, 400);
}

function serverError(c: Context, message: string) {
  return c.json({ error: message }, 500);
}

/**
 * 라우터 4 + 액션 3 = 총 7 endpoint 를 Hono 인스턴스로 묶어 반환. caller
 * (예: index.ts) 가 그 인스턴스를 그대로
 * `Bun.serve({ hostname: "127.0.0.1", port: 3100, fetch: app.fetch })` 에 넘긴다.
 *
 * 디스코드 client 는 옵션으로 주입 (list-channels 액션이 활용) — 부팅 흐름에서
 * client 가 늦게 준비되는 경우를 자연 처리.
 */
export function createHttpServer(opts: HttpServerOptions): Hono {
  // strict: false — `/settings` 와 `/settings/` 양쪽 모두 같은 핸들러로 매칭.
  // memory 코어 settings 라우터와 같은 톤 (2026-05-18 dashboard 회귀 fix 정합).
  const app = new Hono({ strict: false });
  const { reloadBus, settingsPath } = opts;
  // getDiscordClient 우선, 없으면 정적 discordClient 사용.
  const resolveClient = opts.getDiscordClient
    ? opts.getDiscordClient
    : () => opts.discordClient;

  // ── Host/Origin 검증 미들웨어 (D1·D3) — 가장 먼저 등록 ─────────────────────
  // 127.0.0.1 bind 위의 2차 방어(DNS 리바인딩·브라우저發 요청 차단). 코어
  // outerApp.use("*", ...) 선례 대칭. 이 게이트를 통과해야 아래 라우트에 닿는다.
  app.use("*", opts.hostGuard ?? createHostGuard());

  // ── 로컬 관리 토큰 게이트 (D2) — Host 게이트 다음에 등록 ───────────────────
  // 상태변경·민감읽기 경로(PUT /settings, GET /settings, /actions/*)에 Bearer
  // 토큰을 요구한다. adminToken 이 주입된 경우에만 건다 — 운영(index.ts)은 항상
  // 주입하고, 라우트 로직만 보는 단위 테스트는 미지정으로 게이트를 우회한다.
  if (opts.adminToken) {
    app.use("*", createAdminGate({ expectedToken: opts.adminToken }));
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  app.get("/health", (c) => {
    return c.json({ ok: true });
  });

  // ── GET /settings/schema ──────────────────────────────────────────────────
  app.get("/settings/schema", (c) => {
    return c.json(botSettingsSchema);
  });

  // ── GET /settings ─────────────────────────────────────────────────────────
  app.get("/settings", (c) => {
    try {
      const current = getBotSettings(settingsPath);
      const masked = maskBotSecrets(current);
      // 파일 부재 시 호출자에게 명시 — silent fallback 차단 정신.
      // 디스커버리/대시보드가 "디폴트 사용 중" 배지를 표시할 수 있도록.
      const usingDefaults = !isBotSettingsFilePresent(settingsPath);
      return c.json({ ...masked, $usingDefaults: usingDefaults });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `bot-settings 읽기 실패: ${message}`);
    }
  });

  // ── PUT /settings ─────────────────────────────────────────────────────────
  app.put("/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return badJson(c, "invalid JSON body");
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return badJson(c, "body 가 객체 형태여야 한다");
    }

    // 1) 현 값 읽기 — settings-store 가 파일 부재 시 디폴트 반환.
    let current: BotSettings;
    try {
      current = getBotSettings(settingsPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `bot-settings 읽기 실패: ${message}`);
    }

    // 2) 사전 검증 — 들어온 partial 을 현 값에 얹어 *예상 결과* 로 점검.
    //    putBotSettings 내부에서도 한 번 더 검증하지만, 라우터는 명시적
    //    400 응답을 위해 errors 배열을 그대로 노출.
    const candidate = mergeCandidate(current, body as Record<string, unknown>);
    const validation = validate(candidate);
    if (!validation.ok) {
      return badJson(c, "검증 실패", validation.errors);
    }

    // 3) 저장 — putBotSettings 가 applyMaskingShield + atomic write 처리.
    try {
      putBotSettings(body as Partial<BotSettings>, settingsPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `bot-settings 저장 실패: ${message}`);
    }

    // 4) reload-bus 신호 송출.
    reloadBus.emit();

    // 5) 갱신 결과 (마스킹 적용) 반환.
    try {
      const refreshed = getBotSettings(settingsPath);
      return c.json(maskBotSecrets(refreshed));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return serverError(c, `bot-settings 재읽기 실패: ${message}`);
    }
  });

  // ── 액션 2 개 (S15 — Phase 5.7.1 W2 에서 list-ollama-models 폐기) ──────────
  // 매니페스트 `actions` 약속 (`/actions/<id>`) 그대로 mount. 다이나믹 enum 응답
  // 형식 + toast 응답 형식은 spec section 5.4 / 5.5 정합.

  // POST /actions/verify-token → toast
  app.post("/actions/verify-token", (c) => handleVerifyToken(c));

  // GET /actions/list-channels → enum
  // resolveClient() 는 요청 시점마다 호출 — 단계 2 재진입 후 새 client 자동 반영.
  app.get("/actions/list-channels", (c) =>
    handleListChannels(c, { discordClient: resolveClient() }),
  );

  return app;
}

/**
 * partial body 를 현 값 위에 얹는 *키 단위 얕은 merge*.
 * 본 helper 는 settings-store 의 mergeShallow 와 같은 규칙 — 사전 검증용.
 */
function mergeCandidate(
  current: BotSettings,
  partial: Record<string, unknown>,
): BotSettings {
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next as unknown as BotSettings;
}
