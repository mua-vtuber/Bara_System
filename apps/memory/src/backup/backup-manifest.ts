/**
 * 백업 회차 manifest — 회차 폴더에 마지막으로 기록되는 파일이자 유효성 기준.
 * manifest.json 이 없거나 파싱 불가한 회차 폴더는 무효 회차로 취급되어 부팅 청소
 * (cleanupIncompleteRounds) 대상이 된다. (spec D1, P4 T2)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BackupManifest {
  /** nowInZone() 포맷 "YYYY-MM-DD HH:MM:SS" (설정 시간대 기준). */
  timestamp: string;
  /** 회차 시작 시각 epoch ms — retention 만료 판정용(시간대 파싱 없이 산술 비교). */
  epochMs: number;
  appVersion: string;
  schemaVersion: number;
  /** 회차 폴더 안 파일(스냅샷·설정·비밀값·토큰) — manifest 자신은 제외. */
  files: { name: string; bytes: number }[];
  /** 그 시점 자산 파일명 목록 (content/ 하위, "sha.ext"). */
  assets: string[];
  durationMs: number;
}

export const MANIFEST_NAME = "manifest.json";

/**
 * 회차 폴더명 접두사. `<backupDir>/pre-migration/`(T4 소유)·`assets-mirror/` 를
 * 회차 나열·청소·retention 이 건드리지 않도록 이 접두사만 대상으로 삼는다.
 */
export const ROUND_DIR_PREFIX = "round-";

export function writeManifest(roundDir: string, m: BackupManifest): void {
  writeFileSync(join(roundDir, MANIFEST_NAME), JSON.stringify(m, null, 2));
}

/**
 * 회차 manifest 를 읽는다. 없거나 파싱 불가 = null(무효 회차 — 계약).
 * 파일이 존재하는데 읽기 자체가 실패(권한 등)하면 전파한다 — 유효 회차를
 * 무효로 오판해 부팅 청소가 지우는 사고를 막는다.
 */
export function readManifest(roundDir: string): BackupManifest | null {
  const path = join(roundDir, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isBackupManifest(parsed) ? parsed : null;
}

/** manifest 있는(유효한) 회차만, timestamp 오름차순. backupDir 부재 = 회차 0개. */
export function listValidRounds(
  backupDir: string,
): { dir: string; manifest: BackupManifest }[] {
  if (!existsSync(backupDir)) return [];
  const rounds: { dir: string; manifest: BackupManifest }[] = [];
  for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(ROUND_DIR_PREFIX)) continue;
    const dir = join(backupDir, entry.name);
    const manifest = readManifest(dir);
    if (manifest !== null) rounds.push({ dir, manifest });
  }
  rounds.sort((a, b) => a.manifest.timestamp.localeCompare(b.manifest.timestamp));
  return rounds;
}

function isBackupManifest(v: unknown): v is BackupManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["timestamp"] === "string" &&
    typeof m["epochMs"] === "number" &&
    typeof m["appVersion"] === "string" &&
    typeof m["schemaVersion"] === "number" &&
    Array.isArray(m["files"]) &&
    Array.isArray(m["assets"]) &&
    typeof m["durationMs"] === "number"
  );
}
