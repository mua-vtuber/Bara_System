import { readFileSync, statSync } from "node:fs";
import { unzipSync, type Unzipped } from "fflate";
import { assertBackupFilename, assertNoDownloadSecrets, parseBackupSettings, RestoreError, validateSnapshot } from "./restore-validation.ts";

export const DOWNLOAD_BACKUP_FORMAT = "bara-download-v1";
export const DOWNLOAD_BACKUP_CONTENTS = ["bara.sqlite", "memory-settings.json"] as const;
const MEMBERS = [...DOWNLOAD_BACKUP_CONTENTS, "manifest.json"];
// unzipSync holds the snapshot in memory. Larger backups must use a server round.
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

export function readDownloadBackup(path: string): { entries: Unzipped; settings: Record<string, unknown> } {
  let entries: Unzipped;
  try {
    if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new Error("size");
    const seen = new Set<string>();
    let total = 0;
    entries = unzipSync(readFileSync(path), {
      filter: (entry) => {
        assertBackupFilename(entry.name);
        if (!MEMBERS.includes(entry.name) || seen.has(entry.name)) throw new Error("member");
        seen.add(entry.name);
        const size = entry.originalSize;
        total += size;
        if (!Number.isSafeInteger(size) || size < 1 || total > MAX_ARCHIVE_BYTES ||
            (entry.name !== "bara.sqlite" && size > MAX_SETTINGS_BYTES)) throw new Error("size");
        return true;
      },
    });
    if (Object.keys(entries).length !== MEMBERS.length || MEMBERS.some((name) => !entries[name])) {
      throw new Error("missing member");
    }
  } catch {
    throw new RestoreError("복원 거부 — 손상된 ZIP, 누락·중복·허용되지 않은 파일 또는 512 MiB 크기 제한 초과. 서버 회차 백업을 확인하라.");
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries["manifest.json"]!));
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object" ||
        (manifest.format !== undefined && manifest.format !== DOWNLOAD_BACKUP_FORMAT) ||
        typeof manifest.timestamp !== "string" || !manifest.timestamp ||
        typeof manifest.appVersion !== "string" || !manifest.appVersion ||
        !Array.isArray(manifest.contents) || manifest.contents.length !== 2 ||
        DOWNLOAD_BACKUP_CONTENTS.some((name) => !(manifest.contents as unknown[]).includes(name))) {
      throw new Error("manifest");
    }
  } catch { throw new RestoreError("복원 거부 — 다운로드 ZIP manifest 형식이 올바르지 않다"); }
  validateSnapshot(entries["bara.sqlite"]!, manifest.schemaVersion as number);
  const settings = parseBackupSettings(entries["memory-settings.json"]!);
  assertNoDownloadSecrets(settings);
  return { entries, settings };
}
