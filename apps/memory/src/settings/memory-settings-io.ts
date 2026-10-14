/**
 * Memory Core Settings — 파일 read/write·secret 분리·마스킹 (P3 G5-a 분할).
 *
 * memory-settings.ts 파사드의 파일 I/O 본문 — 동작 불변.
 *
 * 파일 위치: 읽기·쓰기(get/putMemorySettings)는 settings 파일과 비밀값 파일 경로를 둘 다 인자로 받는다 —
 * 이 모듈은 process.env 를 읽지 않는다. env(MEMORY_SETTINGS_PATH·BARA_SECRETS_PATH)는 부팅 진입점(index.ts·운영
 * 스크립트)이 resolveSettingsFilePaths 에 넘겨 한 쌍으로 정한다. 그래서 임시 경로를 넘긴 테스트는 .env 가 가리키는
 * 운영 파일을 읽거나 쓰지 않는다.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { PASSWORD_FIELD_PATHS } from "./memory-schema";
import { rerankerMaxPairTokensError } from "../memory/reranker-limits";
import {
  extractorMaxOutputTokensError,
  extractorOutputExceedsOllamaContextError,
} from "../memory/extractor-output-limit";
import { resolveOllamaNumCtx } from "../llm/ollama-num-ctx";
import { validateStageAllocation } from "../memory/cleanup-deep-pass/cycle-budget";
import { migrateLegacyKeys } from "./migrate-legacy-keys";
import type { SecretCopy } from "./migrate-document-ocr-api";
import { SecretStore } from "./secrets";
import { backfillRetryDelayErrors, validateMemorySettings } from "./memory-settings-validate";
import {
  cloneDefaults,
  deepMergeWithDefaults,
  mergeShallowGroups,
  getByPath,
  setByPath,
} from "./memory-settings-merge";
import type {
  MemorySettings,
  MemorySettingsPartial,
  MemorySettingsWithMask,
} from "./memory-settings-types";

// ─────────────────────────────────────────────────────────────────────────────
// 경로 / 파일 I/O
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FILE_PATH = "data/memory-settings.json";

/**
 * at-rest 파일 권한(소유자만 읽기·쓰기). Phase 7 2차 Task 8 / 설계 9.3 ⓐ.
 * memory-settings.json 은 anthropicApiKey·discordToken 같은 비밀값을 담을 수 있어
 * 다른 사용자가 읽지 못하게 좁힌다. sse-tokens.ts 와 같은 보안 상수다.
 * 주의: WSL drvfs 마운트는 권한 비트를 강제하지 않아(개발 PC) 600 이 안 보일 수
 * 있다 — 실제 600 검증은 A1 운영(ext4) sanity 로 확인한다.
 */
const FILE_MODE = 0o600;

/** 서버가 읽고 쓰는 설정 파일 한 쌍 — 비밀값 파일은 늘 이 settings 파일과 함께 움직인다. */
export interface SettingsFilePaths {
  settingsPath: string;
  secretsPath: string;
}

/**
 * Phase 7 2차 Task 9 — settings 파일 옆 secret 파일 경로(env 를 보지 않는 규칙).
 *
 * settings 파일과 *같은 디렉토리* 에 secrets.json 을 둔다 — 테스트가 임시 디렉토리에 settings
 * 를 두면 secret 도 그 옆에 따라가, 두 파일이 한 묶음으로 움직인다. 디폴트 settings
 * 경로면 data/secrets.json.
 */
export function secretsPathBesideSettings(settingsPath: string): string {
  const dir = dirname(settingsPath);
  // settings 파일 이름이 memory-settings.json 이면 secrets.json 을 옆에 둔다.
  // 디렉토리가 비면(상대 파일명만 들어온 흐름) 현재 디렉토리 기준.
  const secretsName = basename(settingsPath).includes("settings")
    ? "secrets.json"
    : `${basename(settingsPath)}.secrets.json`;
  return dir && dir !== "." ? join(dir, secretsName) : secretsName;
}

/**
 * 부팅 진입점이 env 로 settings·비밀값 파일 한 쌍을 정한다 — env 를 해석하는 유일한 곳.
 * settings = MEMORY_SETTINGS_PATH → 디폴트(`data/memory-settings.json`), 비밀값 = BARA_SECRETS_PATH →
 * settings 옆(secretsPathBesideSettings). index.ts 는 이 결과 하나를 설정 읽기·/settings 라우트에 그대로 넘긴다.
 */
export function resolveSettingsFilePaths(
  env: Readonly<Record<string, string | undefined>>,
): SettingsFilePaths {
  const settingsPath = env.MEMORY_SETTINGS_PATH?.trim() || DEFAULT_FILE_PATH;
  const secretsPath = env.BARA_SECRETS_PATH?.trim() || secretsPathBesideSettings(settingsPath);
  return { settingsPath, secretsPath };
}

/**
 * Phase 7 2차 Task 9 — settings 객체에 secret 파일의 비밀값을 얹는다(read overlay).
 *
 * settings json 에는 비밀값이 빈 문자열로만 남아 있고, 진짜 키는 secret 파일에 있다.
 * 이 함수가 PASSWORD_FIELD_PATHS 각 자리에 secret 값을 채워, 호출자(extractor /
 * cleanup / vision / setup 자가검증)는 옛날처럼 settings.llm.*.anthropicApiKey 로
 * 키를 그대로 본다 — 호출처 회귀 0. 비밀값은 로그에 절대 안 남긴다.
 */
function overlaySecrets(settings: MemorySettings, store: SecretStore): void {
  for (const path of PASSWORD_FIELD_PATHS) {
    const secretValue = store.get(path);
    if (typeof secretValue === "string" && secretValue.length > 0) {
      setByPath(settings, path, secretValue);
    }
  }
}

/**
 * Phase 7 2차 Task 9 (Acceptance 4 — 핵심) — 기존 운영 settings 자동·멱등 마이그레이션.
 *
 * 옛 운영 settings json 은 비밀값이 *json 안에* 있다. 읽는 시점에 그 비밀값을 secret
 * 파일로 옮기고 json 의 자리는 비운다(다음 저장 때 비운 채로 디스크에 반영). A1 배포
 * 시 부팅이 settings 를 읽기만 해도 키가 자동으로 secret 파일로 분리돼, cleanup 이
 * 안 멈춘다.
 *
 * 멱등: 이미 secret 파일로 옮긴 뒤(=parsed json 자리가 빔)면 옮길 게 없어 no-op.
 * 비밀값 충돌(json·secret 둘 다 비어있지 않고 값이 다름) 시 secret 파일을 권위로
 * 두고 json 값은 버린다(secret 파일이 단일 출처) — 명시 warning(값 미포함).
 *
 * 반환 = 마이그레이션 안내 warning 목록(emit 책임은 getMemorySettings).
 * 비밀값은 warning 에 절대 안 넣는다 — 키 이름·자릿수만.
 */
function migrateInlineKeysToSecretFile(
  parsed: Record<string, unknown>,
  store: SecretStore,
): string[] {
  const warnings: string[] = [];
  for (const path of PASSWORD_FIELD_PATHS) {
    const inline = getByPath(parsed, path);
    if (typeof inline !== "string" || inline.length === 0) {
      // json 자리에 비밀값 없음 — 옮길 게 없다(이미 분리됐거나 미설정).
      continue;
    }
    const existing = store.get(path);
    if (existing !== undefined && existing.length > 0 && existing !== inline) {
      // secret 파일이 권위 — json 안 옛 값은 버린다(값 미포함 warning).
      warnings.push(
        `Task 9 secret 분리 — ${path}: json 안 옛 키 버림(secret 파일 우선, 자릿수 json=${inline.length}/secret=${existing.length}).`,
      );
    } else if (existing === undefined || existing.length === 0) {
      // secret 파일로 처음 옮김(자동 마이그레이션 핵심 경로).
      store.set(path, inline);
      warnings.push(
        `Task 9 secret 분리 — ${path}: json 안 키를 secret 파일로 옮김(자릿수 ${inline.length}, 값 미포함).`,
      );
    }
    // 어느 갈래든 json 자리는 비운다(다음 저장 때 빈 채로 디스크 반영).
    setByPath(parsed, path, "");
  }
  return warnings;
}

/**
 * Phase 7 2차 Task 9 — settings 객체에서 비밀값을 떼어 secret 파일로 보내고, settings
 * 안 자리는 비운다(write strip-and-route). putMemorySettings 가 json 을 쓰기 직전에
 * 호출한다 — 그 결과 디스크 json 에는 비밀값이 0.
 *
 * 비어있지 않은 값만 secret 파일에 저장(빈 값은 미설정 의미라 secret 파일을 안 건드림 —
 * applyMaskingShield 가 이미 옛 값 보존을 처리). 멱등: 같은 값이면 secret 파일 쓰기 0.
 */
function stripSecretsToFile(
  settings: MemorySettings,
  store: SecretStore,
): void {
  for (const path of PASSWORD_FIELD_PATHS) {
    const value = getByPath(settings, path);
    if (typeof value === "string" && value.length > 0) {
      store.set(path, value);
    }
    // json 에 쓸 객체에서는 항상 비운다(비밀값 0).
    setByPath(settings, path, "");
  }
}

/** 옮기기가 정한 비밀 값 복사를 얹는다 — 대상 칸이 비어 있고 원본에 값이 있을 때만(값은 로그에 안 남김). */
function applySecretCopies(settings: MemorySettings, copies: readonly SecretCopy[]): void {
  for (const copy of copies) {
    const target = getByPath(settings, copy.to);
    if (typeof target === "string" && target.length > 0) continue;
    const source = getByPath(settings, copy.from);
    if (typeof source === "string" && source.length > 0) setByPath(settings, copy.to, source);
  }
}

/**
 * 파일 읽기 + 디폴트 deep merge.
 * 파일이 없으면 디폴트 그대로 반환 (throw 안 함).
 * 파싱 실패는 throw — silent fallback 금지 정신.
 * 읽기도 settings 안 옛 인라인 키를 secretsPath 로 옮겨 쓸 수 있어, 두 경로 모두 호출자가 넘긴다(env 미참조).
 */
export function getMemorySettings(path: string, secretsPath: string): MemorySettings {
  // Phase 7 2차 Task 9 — secret 파일 보관소(키 별도 600 파일).
  const secretStore = new SecretStore(secretsPath);
  if (!existsSync(path)) {
    // settings 파일이 없어도 secret 파일에 키가 있을 수 있다(분리 후 settings 초기화
    // 같은 흐름) — default 위에 secret overlay 까지 얹어 호출처가 키를 본다.
    const defaults = cloneDefaults();
    overlaySecrets(defaults, secretStore);
    return defaults;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `memory-settings 읽기 실패: ${path} — ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `memory-settings JSON 파싱 실패: ${path} — ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`memory-settings 형식 오류: ${path} — 객체 필요`);
  }
  const { migrated, warnings, secretCopies } = migrateLegacyKeys(
    parsed as Record<string, unknown>,
  );
  // Phase 7 2차 Task 9 — 기존 운영 settings 안 인라인 키를 secret 파일로 자동 분리
  // (멱등). migrateLegacyKeys 가 옛 키를 새 위치로 옮긴 *뒤* 라, PASSWORD_FIELD_PATHS
  // 의 새 위치 자리를 본다. 옮긴 뒤 migrated 의 자리는 빈 문자열.
  const secretWarnings = migrateInlineKeysToSecretFile(
    migrated as Record<string, unknown>,
    secretStore,
  );
  for (const warning of [...warnings, ...secretWarnings]) {
    console.warn(`[memory-settings] ${warning}`);
  }
  const merged = deepMergeWithDefaults(migrated as Partial<MemorySettings>);
  // 효율 가동 spec 4.A-5 — stageAllocation 합 1.0 강제. 각 예산 차원을 단계별로 나누는
  // 비율이라 합이 1.0 이 아니면 배분이 어긋나 일부 단계가 조용히 굶는다. 로드 시점에
  // loud fail 로 끊어 잘못된 배분이 운영에 흘러들지 않게 한다(silent fallback 금지).
  const allocValidation = validateStageAllocation(
    merged.cleanupDeepPass.budget.stageAllocation,
  );
  if (!allocValidation.ok) {
    throw new Error(
      `memory-settings 검증 실패: ${path} — ${allocValidation.error}`,
    );
  }
  // 2026-10-14 backfill-retry-ledger spec 4.4 — 손으로 고친 파일도 최대 대기 < 첫 대기면 읽기에서 멈춘다(조용히 맞춰 쓰지 않음).
  const retryDelayErrors = backfillRetryDelayErrors(merged as unknown as Record<string, unknown>);
  if (retryDelayErrors.length > 0) {
    throw new Error(`memory-settings 검증 실패: ${path} — ${retryDelayErrors.join("; ")}`);
  }
  // 2026-10-14 speed-step1 spec 3.2 — 손으로 고친 파일의 쌍 길이 한도도 읽기에서 멈춘다(조용히 고쳐 쓰지 않음).
  const pairTokensError = rerankerMaxPairTokensError(merged.reranker.maxPairTokens);
  if (pairTokensError !== null) {
    throw new Error(`memory-settings 검증 실패: ${path} — ${pairTokensError}`);
  }
  // 2026-10-15 extractor-output-limit spec 3.2 — 손으로 고친 파일의 추출 출력 한도도 읽기에서 멈춘다(조용히 고쳐 쓰지 않음).
  const outputLimitErrors = extractorOutputLimitErrors(merged);
  if (outputLimitErrors.length > 0) {
    throw new Error(`memory-settings 검증 실패: ${path} — ${outputLimitErrors.join("; ")}`);
  }
  // secret 파일의 진짜 키를 settings 객체에 얹는다 — 호출처 회귀 0.
  overlaySecrets(merged, secretStore);
  // 옛 설정 옮기기가 정한 비밀 값 복사(문서 OCR spec D8) — 대상이 비었을 때만. 다음 저장 때 새 경로로 기록된다.
  applySecretCopies(merged, secretCopies);
  return merged;
}

/**
 * 추출 출력 한도(llm.extractor.maxOutputTokens)의 범위와 Ollama 컨텍스트 창 관계를 본다 (spec 3.2·3.3).
 * 환경 변수 OLLAMA_NUM_CTX 를 읽으므로 환경을 읽지 않는 validateMemorySettings 가 아닌 이 입출력 계층에 둔다.
 * 공급자가 ollama 가 아니면 환경 변수를 읽지 않는다. 잘못된 환경 변수는 던지지 않고 같은 검증 실패 문장에 담는다.
 */
function extractorOutputLimitErrors(settings: MemorySettings): string[] {
  const slot = settings.llm.extractor;
  const rangeError = extractorMaxOutputTokensError(slot.maxOutputTokens);
  if (rangeError !== null) return [rangeError];
  if (slot.provider !== "ollama") return [];
  let numCtx: number;
  try {
    numCtx = resolveOllamaNumCtx(undefined, process.env);
  } catch (err) {
    return [(err as Error).message];
  }
  const relationError = extractorOutputExceedsOllamaContextError(slot.maxOutputTokens, numCtx);
  return relationError === null ? [] : [relationError];
}

/**
 * 저장하려는 설정이 검증에 걸렸을 때 던진다 — 호출자(설정 라우트)가 400 으로 돌려줄 수 있게 문장 목록을 그대로 담는다.
 * 저장된 파일을 읽다 실패하는 경우는 이 클래스가 아니라 일반 Error 로 남는다(서버 쪽 문제).
 */
export class MemorySettingsValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`memory-settings 검증 실패: ${errors.join("; ")}`);
    this.name = "MemorySettingsValidationError";
    this.errors = errors;
  }
}

/**
 * 부분 갱신 → 검증 → atomic 저장.
 *
 * 패스워드 필드 (anthropicApiKey) 는 명시적 약속:
 *   - partial 에 부재 (undefined) 또는 빈 문자열 → 옛 디스크 값 *유지*
 *   - partial 에 비어있지 않은 string → 그 값으로 덮어쓰기
 * 이는 silent fallback 이 아니라 *마스킹된 폼 재전송 시 옛 값 보전* 약속.
 */
export function putMemorySettings(
  partial: MemorySettingsPartial,
  path: string,
  secretsPath: string,
): void {
  // Phase 7 2차 Task 9 — secret 파일 보관소. secretsPath 는 getMemorySettings 와 같은 뜻(호출자가 넘긴 한 쌍).
  const secretStore = new SecretStore(secretsPath);
  // current 는 getMemorySettings 가 secret 파일 키를 overlay 해 돌려준다 —
  // applyMaskingShield 가 "옛 값 보존" 할 때 그 옛 값이 secret 파일에서 온다.
  const current = getMemorySettings(path, secretsPath);
  const merged = mergeShallowGroups(current, partial);
  const shielded = applyMaskingShield(merged, current);

  const validation = validateMemorySettings(shielded);
  if (!validation.ok) {
    throw new MemorySettingsValidationError(validation.errors);
  }
  // 효율 가동 spec 4.A-5 — 잘못된 stageAllocation(합≠1.0)이 디스크에 써지지 않게
  // 쓰기 전에도 검사한다(로드 검사와 대칭 — 어느 경로로도 어긋난 배분이 안 남는다).
  const allocValidation = validateStageAllocation(
    shielded.cleanupDeepPass.budget.stageAllocation,
  );
  if (!allocValidation.ok) {
    throw new MemorySettingsValidationError([allocValidation.error]);
  }

  // 2026-10-15 extractor-output-limit spec 3.2 — 추출 출력 한도가 Ollama 컨텍스트 창을 넘는 설정이 디스크에 안 써지게 쓰기 전에도 본다.
  const outputLimitErrors = extractorOutputLimitErrors(shielded);
  if (outputLimitErrors.length > 0) {
    throw new MemorySettingsValidationError(outputLimitErrors);
  }

  // Phase 7 2차 Task 9 — 비밀값을 secret 파일로 보내고 json 에 쓸 객체에서는 비운다
  // (write strip-and-route). 검증 통과 *뒤* 라, 디스크 json 에는 비밀값이 0.
  // shielded 는 위에서 새로 만든 객체(structuredClone 기반)라 current/merged 를 안 깬다.
  stripSecretsToFile(shielded, secretStore);

  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 권한 600 — 비밀값은 이미 secret 파일로 분리됐고, json 에는 키 이름·non-secret 만.
    // 그래도 settings json 에 discordToken 등 다른 비밀이 들어갈 수 있어 600 유지.
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
        // tmp 정리 실패는 이 호출 실패 메시지를 가리지 않도록 무시.
      }
    }
    throw new Error(
      `memory-settings 쓰기 실패: ${path} — ${(err as Error).message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 마스킹
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 패스워드 필드를 빈 문자열로 가리고 `$masked`·`$secretsSet` 메타를 첨부한다.
 * spec section 5.3 출력 약속.
 *
 * - `$masked` = 가린 칸 경로 전부(값이 저장돼 있든 없든 — 폼 위젯이 쓰는 기존 뜻 그대로).
 * - `$secretsSet` = 그중 실제로 값이 저장돼 있는 경로만(2026-10-11 llm-api-providers spec D11).
 *   값은 보내지 않고 "저장된 키가 있다"는 여부만 알린다 — 화면의 "저장된 키 유지" 안내와
 *   저장된 키로 모델 목록을 부를지 판단에 쓴다.
 */
export function maskSecrets(settings: MemorySettings): MemorySettingsWithMask {
  const cloned = structuredClone(settings) as MemorySettings;
  const masked: string[] = [];
  const secretsSet: string[] = [];
  for (const path of PASSWORD_FIELD_PATHS) {
    const value = getByPath(cloned, path);
    if (typeof value === "string" && value.length > 0) {
      secretsSet.push(path);
    }
    if (setByPath(cloned, path, "")) {
      masked.push(path);
    }
  }
  return { ...cloned, $masked: masked, $secretsSet: secretsSet };
}

/**
 * 입력 partial 의 패스워드 필드가 비어 있으면 *디스크의 옛 값*으로 복원한다.
 * 마스킹된 폼이 다시 전송될 때 빈 값이 옛 값을 덮어쓰지 않게 막는 명시적 약속.
 */
function applyMaskingShield(
  candidate: MemorySettings,
  previous: MemorySettings,
): MemorySettings {
  const next = structuredClone(candidate);
  for (const path of PASSWORD_FIELD_PATHS) {
    const value = getByPath(next, path);
    if (typeof value !== "string" || value.length === 0) {
      const prev = getByPath(previous, path);
      if (typeof prev === "string" && prev.length > 0) {
        setByPath(next, path, prev);
      }
    }
  }
  return next;
}

/** 테스트 편의 — 디폴트 경로 export (외부 호출자가 알 필요는 적음). */
export const _DEFAULT_FILE_PATH_FOR_TEST = DEFAULT_FILE_PATH;
