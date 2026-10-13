/**
 * 서버 백업 cron 한 회차의 입력 조립 — index.ts 에서 떼어 냈다(index.ts 는 import 하는 순간 서버를 띄워 테스트할 수 없다).
 *
 * 백업은 설정·비밀값 파일 경로를 스스로 고르지 않는다. 부팅이 resolveSettingsFilePaths 로 정해 설정 읽기·/settings
 * 라우트에 넘긴 바로 그 한 쌍(settingsFiles)을 받는다. 옛 백업은 비밀값 경로를 env BARA_SECRETS_PATH → data/secrets.json
 * 으로 따로 골라, .env.example 처럼 settings 가 data/ 밖에 있으면 서버가 키를 쓰는 settings 옆 secrets.json 을 빠뜨렸다.
 */
import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION } from "../db/migrations.ts";
import type { SettingsFilePaths } from "../settings/memory-settings.ts";
import { APP_VERSION } from "../version.ts";
import type { BackupRunDeps } from "./backup-runner.ts";

export interface ServerBackupSources {
  db: Database;
  dbPath: string;
  backupDir: string;
  assetDir: string;
  /** 부팅이 정한 settings·비밀값 한 쌍 — 서버가 설정을 읽고 /settings 가 키를 쓰는 그 파일들. */
  settingsFiles: SettingsFilePaths;
  sseTokenFilePath: string;
}

/** 부팅 값 그대로 BackupRunDeps 를 만든다. 경로를 새로 계산하지 않는다. */
export function serverBackupRunDeps(sources: ServerBackupSources): BackupRunDeps {
  return {
    db: sources.db,
    dbPath: sources.dbPath,
    backupDir: sources.backupDir,
    assetDir: sources.assetDir,
    settingsFilePath: sources.settingsFiles.settingsPath,
    secretsFilePath: sources.settingsFiles.secretsPath,
    sseTokenFilePath: sources.sseTokenFilePath,
    appVersion: APP_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}
