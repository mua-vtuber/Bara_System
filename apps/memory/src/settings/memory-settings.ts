/**
 * Memory Core Settings — read / write / validate / mask (Phase 5.5 / S8)
 *
 * 옛 process.env.* 항목을 한 JSON 파일로 묶어 관리. 1차에서는 schema 정의 +
 * 파일 read/write + 단위 검증만 정착. 옛 env 사용처 이전은 S10 단계.
 *
 * P3 G5-a — 본문은 책임별 모듈로 분할하고, 이 파일은 옛 import 경로
 * (`./memory-settings`)의 export 심볼을 이름 그대로 유지하는 파사드로 남긴다
 * (동작 불변).
 *  - memory-settings-slots.ts    : LLM 슬롯·문서 OCR 타입
 *  - memory-settings-types.ts    : 루트 MemorySettings·partial·mask 타입
 *  - memory-settings-io.ts       : 파일 read/write·secret 분리·마스킹
 *  - memory-settings-validate.ts : 단위 검증 (기존 분할)
 *  - memory-settings-merge.ts    : 디폴트 merge·부분 갱신 (기존 분할)
 */

// 검증 심볼 재노출 — 옛 import 경로(`./memory-settings`)를 그대로 유지한다.
export { validateMemorySettings } from "./memory-settings-validate";
export type { ValidationResult } from "./memory-settings-validate";

export type {
  LlmExtractorSlot,
  LlmCleanupSlot,
  LlmVisionSlot,
  DocumentOcrMode,
  DocumentOcrResourceProfile,
  DocumentOcrLocalProvider,
  DocumentOcrApiProvider,
  DocumentOcrApiResponseFormat,
  DocumentOcrCommandSource,
  DocumentOcrAutoStatus,
  DocumentOcrSettings,
} from "./memory-settings-slots";

export type {
  MemorySettings,
  LlmExtractorPartial,
  LlmVisionPartial,
  DocumentOcrPartial,
  MemorySettingsPartial,
  MemorySettingsWithMask,
} from "./memory-settings-types";

export {
  getMemorySettings,
  putMemorySettings,
  MemorySettingsValidationError,
  maskSecrets,
  resolveSettingsFilePaths,
  secretsPathBesideSettings,
  _DEFAULT_FILE_PATH_FOR_TEST,
} from "./memory-settings-io";
export type { SettingsFilePaths } from "./memory-settings-io";
