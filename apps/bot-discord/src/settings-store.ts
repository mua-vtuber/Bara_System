/**
 * 디스코드 봇 settings-store — read / write / 디폴트 merge / atomic
 * (Phase 5.5.6 / S14)
 *
 * 옛 process.env.* (DISCORD_BOT_TOKEN 등) 항목을 한 JSON 파일로 묶어 관리.
 * S14 단계에서 store 자체와 라우터를 정착. 옛 env 호출처 이전은 S16 단계.
 *
 * 파일 위치: 디폴트 `data/bot-settings.json`. 호출자가 직접 경로를 지정할
 * 수도 있고, 부트스트랩 한정으로 `BOT_SETTINGS_PATH` 환경변수로 override 가능.
 * settings-store 가 process.env 를 직접 읽는 *유일한* 예외 — settings 파일 자체가
 * process.env 대체이므로 부트스트랩 경로는 의도적으로 env 로 받는다.
 *
 * 메모리 코어 `apps/memory/src/settings/memory-settings.ts` (S8) 패턴 follow.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { migrateLegacyBotKeys } from "./migrate-legacy-bot-keys.ts";
import {
  BOT_DEFAULTS,
  BOT_FIELD_KEYS,
  validateBotSettings,
  type BotSettings,
  type BotValidationResult,
} from "./settings-schema.ts";
import { botDataPath } from "./data-dir.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 경로 / 파일 I/O
// ─────────────────────────────────────────────────────────────────────────────

const FILE_NAME = "bot-settings.json";

/**
 * at-rest 파일 권한(소유자만 읽기·쓰기). Phase 7 2차 Task 8 / 설계 9.3 ⓐ.
 * bot-settings.json 은 discordToken(봇 토큰) 비밀값을 담아 다른 사용자가 읽지
 * 못하게 좁힌다. memory-settings.ts·sse-tokens.ts 와 같은 보안 상수다.
 * 주의: WSL drvfs 마운트는 권한 비트를 강제하지 않아(개발 PC) 600 이 안 보일 수
 * 있다 — 실제 600 검증은 A1 운영(ext4) sanity 로 확인한다.
 */
const FILE_MODE = 0o600;

function resolveFilePath(filePath?: string): string {
  if (filePath !== undefined) return filePath;
  const envPath = process.env.BOT_SETTINGS_PATH?.trim();
  if (envPath) return envPath;
  return botDataPath(FILE_NAME);
}

/**
 * 파일 읽기 + 디폴트 deep merge.
 *
 * 파일이 없으면 디폴트 그대로 반환 (throw 안 함) — 첫 가동 시 자연 흐름.
 * 파싱 실패는 throw — silent fallback 금지 정신.
 *
 * 파일 부재가 "디폴트 사용" 인지 호출자가 알고 싶으면 두 번째 인자 helper
 * `isBotSettingsFilePresent()` 활용.
 */
export function getBotSettings(filePath?: string): BotSettings {
  const path = resolveFilePath(filePath);
  if (!existsSync(path)) {
    return cloneDefaults();
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `bot-settings 읽기 실패: ${path} — ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `bot-settings JSON 파싱 실패: ${path} — ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`bot-settings 형식 오류: ${path} — 객체 필요`);
  }

  // Phase 5.7.1 W3 — 옛 4 칸 (autoExtract / activeMode / ollamaUrl / ollamaModel)
  // 통째 삭제 + 명시 로그. silent fallback 금지 — emit 책임은 호출자가 console.warn.
  const { migrated, warnings } = migrateLegacyBotKeys(
    parsed as Record<string, unknown>,
  );
  for (const warning of warnings) {
    console.warn(`[bot-settings] ${warning}`);
  }

  return mergeWithDefaults(migrated as Partial<BotSettings>);
}

/**
 * 부분 갱신 → 검증 → atomic 저장 (tmp + rename, race condition 차단).
 *
 * 패스워드 필드 (discordToken) 는 명시적 약속:
 *   - partial 에 부재 (undefined) 또는 빈 문자열 → 옛 디스크 값 *유지*
 *   - partial 에 비어있지 않은 string → 그 값으로 덮어쓰기
 * 마스킹된 폼이 다시 전송될 때 빈 값이 옛 값을 덮어쓰지 않게 막는 약속.
 */
export function putBotSettings(
  partial: Partial<BotSettings>,
  filePath?: string,
): void {
  const path = resolveFilePath(filePath);
  const current = getBotSettings(path);
  const merged = mergeShallow(current, partial);
  const shielded = applyMaskingShield(merged, current);

  const validation = validateBotSettings(shielded);
  if (!validation.ok) {
    throw new Error(
      `bot-settings 검증 실패: ${validation.errors.join("; ")}`,
    );
  }

  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 권한 600 — 비밀값(discordToken) 보호. tmp·대상 파일 둘 다 좁힌다.
    writeFileSync(tmpPath, `${JSON.stringify(shielded, null, 2)}\n`, {
      encoding: "utf-8",
      mode: FILE_MODE,
    });
    // 일부 마운트는 writeFileSync mode 인자를 무시할 수 있어 명시 chmod 보강.
    chmodSync(tmpPath, FILE_MODE);
    renameSync(tmpPath, path);
    // rename 후 대상 파일 권한도 명시(이미 존재했던 파일도 다음 저장 시 600 으로 좁혀짐).
    chmodSync(path, FILE_MODE);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp 정리 실패는 쓰기 실패 메시지를 가리지 않도록 무시.
      }
    }
    throw new Error(
      `bot-settings 쓰기 실패: ${path} — ${(err as Error).message}`,
    );
  }
}

/**
 * 파일 존재 여부 — 호출자가 "디폴트 사용" 인지 명시적으로 알고 싶을 때.
 * silent fallback 차단 정신 — 라우터가 응답에 "using-defaults" 플래그를 박는다.
 */
export function isBotSettingsFilePresent(filePath?: string): boolean {
  return existsSync(resolveFilePath(filePath));
}

/** schema-defined 검증을 그대로 노출 (라우터 사전 검증용). */
export function validate(value: unknown): BotValidationResult {
  return validateBotSettings(value);
}

/**
 * 단계 2 (Discord 연결) 진입 가능 여부 검사.
 *
 * settings.json 부재는 "아직 셋업 안 함" 상태 — 에러 아님, `ready: false`로 반환.
 * settings.json 존재 시 discordToken / ownerId 가 비어있지 않은지 검사.
 * 형식 위반도 개별 메시지로 반환해 사용자가 어느 필드가 왜 문제인지 알 수 있게 함.
 *
 * silent fallback 금지 정신 — 정합 실패 시 빈 응답 반환 대신 명시 에러 목록 반환.
 */
export interface Stage2ReadinessResult {
  /** 단계 2 진입 가능 여부. */
  ready: boolean;
  /** 진입 불가 이유 목록 (빈 배열 = 진입 가능). */
  reasons: string[];
  /** settings 파일 자체가 없음 (첫 셋업 흐름). */
  settingsAbsent: boolean;
}

export function checkStage2Readiness(filePath?: string): Stage2ReadinessResult {
  const absent = !isBotSettingsFilePresent(filePath);
  if (absent) {
    return {
      ready: false,
      reasons: ["settings.json 부재 — 메모리 대시보드에서 토큰을 입력해 주세요"],
      settingsAbsent: true,
    };
  }

  const settings = getBotSettings(filePath);
  const reasons: string[] = [];

  if (!settings.discordToken || settings.discordToken.trim().length === 0) {
    reasons.push("discordToken: 비어 있음 — 디스코드 봇 탭에서 토큰을 입력해 주세요");
  }
  if (!settings.ownerId || settings.ownerId.trim().length === 0) {
    reasons.push("ownerId: 비어 있음 — 봇 오너 Discord user id를 설정해 주세요");
  }

  // 형식 검증 (token, ownerId 가 있을 때만)
  // 단일 느슨한 검사 — 점(.) 2개로 구분된 3개 부분, 각 파트 비어있지 않음.
  // Discord 봇 토큰 형식은 시간에 따라 길이/구성이 바뀔 수 있으므로 엄격 정규식을 쓰지 않는다.
  // 실제 토큰 유효성은 Discord login 시 서버가 검증한다.
  if (settings.discordToken) {
    const parts = settings.discordToken.trim().split(".");
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      reasons.push("discordToken: 형식 무효 — Discord 봇 토큰은 점(.) 으로 분리된 3개 부분 구조 필요");
    }
  }
  if (settings.ownerId && !/^\d+$/.test(settings.ownerId.trim())) {
    reasons.push("ownerId: 형식 무효 — Discord user id는 숫자만 허용됩니다");
  }

  return {
    ready: reasons.length === 0,
    reasons,
    settingsAbsent: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function cloneDefaults(): BotSettings {
  return structuredClone(BOT_DEFAULTS);
}

/**
 * 디스크에서 읽은 partial 을 디폴트와 merge.
 * 봇 schema 는 단일 평면(flat) 형 — 그룹 단위 분기가 없으므로 키 단위 덮어쓰기.
 *
 * 2026-05-19 마이그레이션: 옛 `evolverPollIntervalMs` (밀리초) 키가 있고 새
 * `evolverPollIntervalMin` (분) 키가 없으면 ms → 분 환산해서 옮긴다. 다음 저장
 * 시점에 새 키만 디스크에 남는다.
 */
function mergeWithDefaults(partial: Partial<BotSettings>): BotSettings {
  const migrated = migrateLegacyKeys(partial);
  const merged = cloneDefaults();
  const mergedView = merged as unknown as Record<string, unknown>;
  for (const key of BOT_FIELD_KEYS) {
    const incoming = (migrated as Record<string, unknown>)[key];
    if (incoming !== undefined) {
      mergedView[key] = incoming;
    }
  }
  return merged;
}

/**
 * 옛 키 → 새 키 마이그레이션 (one-shot, idempotent). 입력 객체 사본을 반환.
 *
 * 옛 `evolverPollIntervalMs` (밀리초) → 새 `evolverPollIntervalMin` (분).
 * 둘 다 있으면 새 키를 신뢰 (이미 마이그레이션됐다고 본다).
 */
function migrateLegacyKeys(
  partial: Partial<BotSettings>,
): Partial<BotSettings> {
  const copy: Record<string, unknown> = { ...(partial as Record<string, unknown>) };
  const legacyMs = copy["evolverPollIntervalMs"];
  if (
    typeof legacyMs === "number" &&
    copy["evolverPollIntervalMin"] === undefined
  ) {
    copy["evolverPollIntervalMin"] = Math.max(1, Math.round(legacyMs / 60_000));
  }
  // 옛 키는 흘려보내지 않는다 — BOT_FIELD_KEYS 에서 빠져 있어 어차피 무시되지만,
  // 명시 삭제로 의도를 분명히 한다.
  delete copy["evolverPollIntervalMs"];
  return copy as Partial<BotSettings>;
}

/** put 입력 partial 을 현 값에 얕은 키 단위 merge. */
function mergeShallow(
  current: BotSettings,
  partial: Partial<BotSettings>,
): BotSettings {
  const next = structuredClone(current);
  const nextView = next as unknown as Record<string, unknown>;
  for (const key of BOT_FIELD_KEYS) {
    const incoming = (partial as Record<string, unknown>)[key];
    if (incoming !== undefined) {
      nextView[key] = incoming;
    }
  }
  return next;
}

/**
 * 입력 partial 의 패스워드 필드가 비어 있으면 *디스크의 옛 값* 으로 복원.
 * 마스킹된 폼이 다시 전송될 때 빈 값이 옛 값을 덮어쓰지 않게 막는 약속.
 *
 * memory-settings 의 applyMaskingShield 와 같은 톤. 봇은 schema 가 flat
 * 형이라 path 분해 없이 직접 키 단위로 처리.
 */
function applyMaskingShield(
  candidate: BotSettings,
  previous: BotSettings,
): BotSettings {
  const next = structuredClone(candidate);
  if (typeof next.discordToken !== "string" || next.discordToken.length === 0) {
    if (
      typeof previous.discordToken === "string" &&
      previous.discordToken.length > 0
    ) {
      next.discordToken = previous.discordToken;
    }
  }
  return next;
}

/** 테스트 편의 — 디폴트 경로 export. */
export const _DEFAULT_FILE_PATH_FOR_TEST = botDataPath(FILE_NAME, {});
