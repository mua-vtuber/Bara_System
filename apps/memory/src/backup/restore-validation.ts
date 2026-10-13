import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { BASELINE_VERSION } from "../db/baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION, getAppliedSchemaVersion } from "../db/migrations.ts";
import { MEMORY_GROUP_KEYS, PASSWORD_FIELD_PATHS } from "../settings/memory-schema.ts";
import { deepMergeWithDefaults, getByPath, setByPath } from "../settings/memory-settings-merge.ts";
import { validateMemorySettings } from "../settings/memory-settings-validate.ts";
import { migrateDocumentOcrApiProvider } from "../settings/migrate-document-ocr-api.ts";

export class RestoreError extends Error {}

/** Backup members are flat filenames on both Windows and Linux. */
export function assertBackupFilename(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value === "." || value === ".." ||
      /[\\/:\x00-\x1f<>"|?*]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new RestoreError("복원 거부 — 안전하지 않은 백업 파일명");
  }
}

export function validateSnapshot(bytes: Uint8Array, schemaVersion: number): void {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new RestoreError("복원 거부 — 지원하지 않는 DB 스키마 버전. 같은 버전 또는 더 최신 앱을 사용하라.");
  }
  // 기준 스키마 이전 백업은 복원해도 시작 판정(SchemaVersionTooOldError)에서 멈출 DB 라 받지 않는다.
  if (schemaVersion < BASELINE_VERSION) {
    throw new RestoreError(
      `복원 거부 — 새로 시작(기준 스키마 v${BASELINE_VERSION}) 이전 백업이라 이 버전으로 열 수 없다. 옛 앱 버전으로만 복원한다.`,
    );
  }
  let db: Database | undefined;
  try {
    // Read-only, in-memory inspection: no migrations and no writes to source/live DB.
    db = Database.deserialize(bytes, { readonly: true });
    sqliteVec.load(db);
    const checks = db.query("PRAGMA quick_check").all() as { quick_check: string }[];
    if (checks.length !== 1 || checks[0]?.quick_check !== "ok") throw new Error("integrity");
    if (getAppliedSchemaVersion(db) !== schemaVersion) throw new Error("schema mismatch");
    db.query("SELECT id, content, memory_type FROM knowledge_nodes LIMIT 1").all();
  } catch {
    throw new RestoreError("복원 거부 — DB 손상 또는 manifest와 DB 스키마 불일치");
  } finally { db?.close(); }
}

/** Partial settings from older downloads remain valid after normal default merging. */
export function parseBackupSettings(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RestoreError("복원 거부 — 설정 JSON이 손상됨"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RestoreError("복원 거부 — 설정은 JSON 객체여야 한다");
  }
  const settings = parsed as Record<string, unknown>;
  for (const group of MEMORY_GROUP_KEYS) {
    const value = settings[group];
    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
      throw new RestoreError("복원 거부 — 설정 그룹 형식이 올바르지 않다");
    }
  }
  // 옛 문서 OCR 설정(openai_compatible_vision)은 복원 뒤 첫 읽기가 옮긴다 — 검사는 옮긴 복제본으로 하고 원본을
  // 돌려준다(그래야 첫 읽기가 비밀 값 복사까지 이어서 한다. 문서 OCR spec D8).
  const migratedCopy = structuredClone(settings);
  migrateDocumentOcrApiProvider(migratedCopy, []);
  try {
    if (!validateMemorySettings(deepMergeWithDefaults(migratedCopy)).ok) throw new Error("invalid");
  } catch { throw new RestoreError("복원 거부 — 설정 필드의 형식 또는 값이 올바르지 않다"); }
  return settings;
}

/** Never download inline credentials, including legacy settings not yet migrated. */
export function sanitizeDownloadSettings(bytes: Uint8Array): Uint8Array {
  const settings = parseBackupSettings(bytes);
  for (const path of PASSWORD_FIELD_PATHS) {
    if (getByPath(settings, path) !== undefined) setByPath(settings, path, "");
  }
  return new TextEncoder().encode(JSON.stringify(settings, null, 2));
}

export function assertNoDownloadSecrets(settings: Record<string, unknown>): void {
  if (PASSWORD_FIELD_PATHS.some((path) => Boolean(getByPath(settings, path)))) {
    throw new RestoreError("복원 거부 — 다운로드 사본 설정에 비밀값이 포함되어 있다");
  }
}
