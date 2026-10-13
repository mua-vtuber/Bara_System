/**
 * 디스코드 봇 런타임 config (Phase 5.7.2 정합).
 *
 * 5.5.x 흐름 핵심 정신 — "env 안 쓰고 settings 파일로 다 입력 받기".
 * Phase 5.7.2 single-path 정착 — 옛 즉시 추출 분기 변수 + BotConfig 필드 +
 * 모든 호출처 통째 제거. 봇은 `POST /memories` 한 통로만 호출
 * (메모리 자율 결정 정신). mode='immediate' / 'backfill' 갈래 결정은
 * 메모리 코어 권위.
 *
 * ## 부트스트랩 env 예외 (의도적으로 process.env 유지)
 *
 * settings 파일 자체 경로는 settings 안에 둘 수 없는 chicken-and-egg 구조.
 *
 *   - `BOT_SETTINGS_PATH` — settings 파일 위치. settings-store 가 직접 읽음.
 *
 * ## 폐기된 env (settings 이전 완료)
 *
 *   - `DISCORD_APPLICATION_ID`  → settings.applicationId
 *   - `DISCORD_GUILD_ID`        → settings.guildId
 *   - `DISCORD_MEMO_CHANNEL_ID` → settings.activeChannels[0]
 *   - `MEMORY_API_URL`          → settings.memoryApiUrl. 단 단일 배포 경로(spec 6.3 ③)
 *     부터 어댑터 계약 환경변수로 다시 받는다 — 비어 있지 않으면 settings 보다
 *     우선 (resolveMemoryApiUrl).
 *   - `DISCORD_AUTO_EXTRACT`    → (Phase 5.7.1 W2 schema 칸 삭제, 5.7.2 코드 통째 제거)
 */

import { getBotSettings, isBotSettingsFilePresent } from "./settings-store.ts";
import { validateMemoryApiUrlScheme, type BotSettings } from "./settings-schema.ts";

export type { BotSettings } from "./settings-schema.ts";

export interface BotConfig {
  /** Discord 봇 토큰 (settings.discordToken). */
  token: string;
  /** Discord Application id (settings.applicationId). 슬래시 커맨드 등록에 사용. */
  applicationId: string;
  /** 오너 Discord user id (settings.ownerId). 봇이 이 id 외 사용자는 무시. */
  ownerUserId: string;
  /**
   * 자동 저장 대상 채널 id (settings.activeChannels[0]).
   * activeChannels 가 비어 있으면 빈 문자열 — DM 전용 흐름으로 동작.
   */
  memoChannelId: string;
  /** (선택) 길드 id (settings.guildId). 슬래시 등록 대상 길드. 미입력 = 글로벌 등록. */
  guildId?: string;
  /** 메모리 API 엔드포인트 (MEMORY_API_URL 환경변수 → settings.memoryApiUrl → 기본값). */
  memoryApiUrl: string;
  /** evolver 알림 ON/OFF (settings.evolverNotify). */
  notifyEvolverDiscord: boolean;
  /** evolver 결과 확인 주기 (분, settings.evolverPollIntervalMin). */
  evolverPollIntervalMin: number;
  /**
   * 정리 제안 SSE 구독이 끊겼을 때 재연결 대기(ms, settings.sseReconnectDelayMs).
   * Phase 7 2차 Task 7. 하드코딩 금지 — 설정값으로 받는다.
   */
  sseReconnectDelayMs: number;
  /** 일정 알림 ON/OFF (settings.scheduleRemindersEnabled). */
  scheduleRemindersEnabled: boolean;
  /** 일정 후보 확인 주기 (분, settings.scheduleReminderPollIntervalMin). */
  scheduleReminderPollIntervalMin: number;
  /** 날짜만 있는 일정의 하루 전 알림 시각 (HH:MM). */
  scheduleReminderDateOnlyTime: string;
}

/**
 * settings 가 비어 있어도(첫 가동 + settings.json 부재) login 시도가 silent
 * 무동작이 되지 않도록 surface. 토큰/오너 부재 시 caller 가 즉시 알 수 있는
 * 형태로 throw.
 *
 * 이 검증은 *부팅* 흐름에 대해서만 적용. reload-bus 구독자가 settings 재읽기
 * 시점에 토큰이 빈 값이면 단순히 "재로그인 안 함" 으로 처리 (별도 흐름).
 */
function requireSettingsField(value: string, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(
      `settings.${label} 가 비어 있음 — settings 페이지에서 값을 저장한 뒤 ` +
        `봇을 재시작하거나, 첫 가동이면 디스코드 봇 탭에서 ${label} 를 채워라.`,
    );
  }
  return value.trim();
}

/**
 * settings 파일 부재 시 첫 가동 안내 — settings 페이지로 유도. silent 빈 토큰
 * 시도를 막아 사용자가 즉시 원인을 알게 한다.
 */
function requireSettingsFieldForBootstrap(value: string, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(
      `settings.${label} 가 비어 있음 (settings.json 부재 — 첫 가동). ` +
        `메모리 대시보드 → 디스코드 봇 탭 → ${label} 입력 후 저장하라.`,
    );
  }
  return value.trim();
}

/** settings 와 환경변수 모두 비었을 때 쓰는 기존 기본 메모리 서버 주소. */
const DEFAULT_MEMORY_API_URL = "http://127.0.0.1:3001";

/** 어댑터 계약(spec 6.3 ③) — 서버 설치가 adapter unit 에 넣는 메모리 서버 주소 환경변수. */
export const MEMORY_API_URL_ENV = "MEMORY_API_URL";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * 메모리 서버 주소 결정. 환경변수가 비어 있지 않으면 그 값을 먼저 쓰고,
 * 주소 형식이 아니거나 settings 와 같은 scheme 제약(D4: http/https, 비-loopback 은
 * https)을 어기면 환경변수 이름을 담아 throw — 잘못된 서비스 설정을 settings
 * 값으로 조용히 덮지 않는다. 부팅 config 와 index.ts 사전 점검이 같은 결정을 쓴다.
 */
export function resolveMemoryApiUrl(settingsValue: string | undefined): string {
  const envValue = process.env[MEMORY_API_URL_ENV]?.trim() ?? "";
  if (envValue.length > 0) {
    try {
      new URL(envValue);
    } catch (cause) {
      throw new Error(
        `${MEMORY_API_URL_ENV} 값이 주소 형식이 아님: "${envValue}" — ` +
          `서비스 설정(systemd unit)의 Environment=${MEMORY_API_URL_ENV} 를 확인하라.`,
        { cause },
      );
    }
    const schemeError = validateMemoryApiUrlScheme(envValue);
    if (schemeError !== null) {
      throw new Error(`${MEMORY_API_URL_ENV} 값 거부 ("${envValue}"): ${schemeError}`);
    }
    return stripTrailingSlash(envValue);
  }
  const fromSettings = settingsValue?.trim() ?? "";
  return stripTrailingSlash(fromSettings.length > 0 ? fromSettings : DEFAULT_MEMORY_API_URL);
}

/**
 * 봇 부팅용 합산 config — env (부트스트랩) + settings (운영).
 *
 * settings 파일 부재 = 디폴트 값 흐름이지만 token / ownerId 가 디폴트(빈 문자열)
 * 면 봇 동작 자체가 의미 없으므로 명시 throw — silent fallback 차단 정신.
 *
 * caller (`apps/bot-discord/src/index.ts`) 가 reload-bus 구독에서 loadBotConfig
 * 을 다시 호출해 in-process snapshot 을 갱신하면, 다음 cycle 부터 호출처가
 * 자연스럽게 새 값을 받는다.
 *
 * @param settingsPath 테스트 편의 — 임시 settings 경로 주입.
 */
export function loadBotConfig(settingsPath?: string): BotConfig {
  const settings: BotSettings = getBotSettings(settingsPath);
  const settingsPresent = isBotSettingsFilePresent(settingsPath);

  // 부팅 흐름에서는 token / ownerId 가 필수 — settings 부재 시 첫 가동
  // 안내 메시지가 더 친절. settings 가 있는데 비어 있으면 그 자체로 오류 surface.
  const token = settingsPresent
    ? requireSettingsField(settings.discordToken, "discordToken")
    : requireSettingsFieldForBootstrap(settings.discordToken, "discordToken");
  const ownerId = settingsPresent
    ? requireSettingsField(settings.ownerId, "ownerId")
    : requireSettingsFieldForBootstrap(settings.ownerId, "ownerId");

  // applicationId — settings 에서 읽음. 빈 문자열이면 슬래시 등록 건너뜀
  // (register-commands.ts 가 경고 + 건너뜀 처리).
  const applicationId = settings.applicationId?.trim() ?? "";

  // guildId — settings 에서 읽음. 빈 문자열이면 undefined (글로벌 등록 흐름).
  const guildId =
    settings.guildId && settings.guildId.trim().length > 0
      ? settings.guildId.trim()
      : undefined;

  // memoChannelId — activeChannels[0] 으로 연결. 비어 있으면 DM 전용 흐름.
  const memoChannelId =
    Array.isArray(settings.activeChannels) && settings.activeChannels.length > 0
      ? settings.activeChannels[0]
      : "";

  // memoryApiUrl — 우선순위: MEMORY_API_URL 환경변수(어댑터 계약, 서버 쪽
  // systemd unit 이 넣어 줌) → settings.memoryApiUrl → 기존 기본 주소.
  const memoryApiUrl = resolveMemoryApiUrl(settings.memoryApiUrl);

  // (Phase 5.7.2 — 옛 즉시 추출 분기 상수 + 호출처 통째 폐기. 봇은
  // `POST /memories` 한 통로만 호출 + 메모리 코어가 mode='immediate' /
  // 'backfill' 분기 결정.)

  return {
    token,
    applicationId,
    ownerUserId: ownerId,
    memoChannelId,
    guildId,
    memoryApiUrl,
    notifyEvolverDiscord: settings.evolverNotify,
    evolverPollIntervalMin: settings.evolverPollIntervalMin,
    sseReconnectDelayMs: settings.sseReconnectDelayMs,
    scheduleRemindersEnabled: settings.scheduleRemindersEnabled,
    scheduleReminderPollIntervalMin: settings.scheduleReminderPollIntervalMin,
    scheduleReminderDateOnlyTime: settings.scheduleReminderDateOnlyTime,
  };
}
