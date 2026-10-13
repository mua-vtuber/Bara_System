/**
 * backup 테스트 공용 환경 — temp 디렉토리 하나에 실 SQLite DB(행 1개) + 자산
 * content/ 파일 1개 + 설정/비밀값 파일을 갖춰 준다. 가짜 구현체 없이 전부 실제
 * 파일과 실제 openMemoryDatabase 연결. T2(backup-runner) 테스트가 쓰고 후속
 * T7(cron) 테스트가 재사용한다.
 *
 * 정리 책임은 호출한 테스트에 있다: e.db.close() 후 cleanupTempDir(e.dir).
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../db/migrations.ts";
import { makeWalTempDir } from "../db/wal-test-helpers.ts";
import type { BackupRunDeps } from "./backup-runner.ts";

/** 자산 파일명은 `{sha256}.{ext}` 꼴 — sha256 hex 64글자를 흉내 낸 실제 파일. */
export const TEST_ASSET_NAME = "a".repeat(64) + ".png";

export interface BackupTestEnv {
  dir: string;
  file: string;
  db: Database;
  backupDir: string;
  assetDir: string;
  settingsPath: string;
  secretsPath: string;
}

export function makeEnv(): BackupTestEnv {
  const { dir, file } = makeWalTempDir("bara-backup-");
  const db = openMemoryDatabase(file);
  db.prepare(
    "INSERT INTO knowledge_nodes (content, memory_type, created_at) VALUES (?, ?, ?)",
  ).run("백업 검증 글", "note", "2026-07-03 12:00:00");
  const backupDir = join(dir, "backups");
  const assetDir = join(dir, "assets");
  mkdirSync(join(assetDir, "content"), { recursive: true });
  writeFileSync(join(assetDir, "content", TEST_ASSET_NAME), "png-bytes");
  const settingsPath = join(dir, "memory-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ time: { zone: "Asia/Seoul" } }));
  const secretsPath = join(dir, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify({ k: "v" }));
  return { dir, file, db, backupDir, assetDir, settingsPath, secretsPath };
}

export function depsOf(e: BackupTestEnv): BackupRunDeps {
  return {
    db: e.db,
    dbPath: e.file,
    backupDir: e.backupDir,
    assetDir: e.assetDir,
    settingsFilePath: e.settingsPath,
    secretsFilePath: e.secretsPath,
    // 일부러 부재 파일 — "존재하는 파일만 복사"의 정직 skip 검증용.
    sseTokenFilePath: join(e.dir, "sse-tokens.json"),
    appVersion: "0.1.0",
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}
