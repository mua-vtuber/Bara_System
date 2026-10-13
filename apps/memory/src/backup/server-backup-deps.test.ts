/**
 * server-backup-deps — 서버 백업 회차가 서버가 실제로 키를 쓰는 비밀값 파일을 담는지. 실 SQLite·실 파일·실 /settings 라우트.
 *
 * 회귀: index.ts 백업 cron 이 비밀값 경로를 env BARA_SECRETS_PATH → data/secrets.json 으로 따로 골랐다. 서버(설정 읽기·
 * /settings)는 settings 옆 secrets.json 을 쓰므로, .env.example 처럼 MEMORY_SETTINGS_PATH 만 data/ 밖을 가리키면 백업이
 * 진짜 키 파일을 빠뜨렸다.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "../db/wal-test-helpers.ts";
import { resolveSettingsFilePaths } from "../settings/memory-settings.ts";
import { ReloadBus } from "../settings/reload-bus.ts";
import { createSettingsRoutes } from "../settings/routes.ts";
import { SecretStore } from "../settings/secrets.ts";
import { runBackupRound } from "./backup-runner.ts";
import { makeEnv, type BackupTestEnv } from "./backup-test-env.ts";
import { serverBackupRunDeps } from "./server-backup-deps.ts";

const KEY_PATH = "llm.cleanup.anthropicApiKey";
const KEY = "sk-ant-test-backup-pair";

const envs: BackupTestEnv[] = [];
afterEach(() => {
  while (envs.length > 0) {
    const e = envs.pop()!;
    e.db.close();
    cleanupTempDir(e.dir);
  }
});

test("settings·비밀값이 data/ 밖(.env.example 배치)에 있으면 백업 회차가 서버가 키를 쓴 그 비밀값 파일을 담는다", async () => {
  const e = makeEnv();
  envs.push(e);
  // .env.example 처럼 MEMORY_SETTINGS_PATH 만 기본 data/ 밖을 가리키고 BARA_SECRETS_PATH 는 없다.
  const confDir = join(e.dir, "operator-conf");
  mkdirSync(confDir);
  const settingsFiles = resolveSettingsFilePaths({ MEMORY_SETTINGS_PATH: join(confDir, "memory-settings.json") });
  const realSecretsPath = join(confDir, "secrets.json");
  expect(settingsFiles.secretsPath).toBe(realSecretsPath);

  // 서버 쪽 — 부팅이 같은 한 쌍을 넘긴 /settings PUT 이 키를 저장한다.
  const app = createSettingsRoutes({
    reloadBus: new ReloadBus(),
    settingsPath: settingsFiles.settingsPath,
    secretsPath: settingsFiles.secretsPath,
  });
  const put = await app.request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: { cleanup: { anthropicApiKey: KEY } } }),
  });
  expect(put.status).toBe(200);
  expect(new SecretStore(realSecretsPath).get(KEY_PATH)).toBe(KEY);

  const { roundDir, manifest } = await runBackupRound(
    serverBackupRunDeps({
      db: e.db,
      dbPath: e.file,
      backupDir: e.backupDir,
      assetDir: e.assetDir,
      settingsFiles,
      sseTokenFilePath: join(e.dir, "sse-tokens.json"),
    }),
  );

  expect(manifest.files.map((f) => f.name)).toContain("secrets.json");
  expect(readFileSync(join(roundDir, "secrets.json"))).toEqual(readFileSync(realSecretsPath));
  expect(new SecretStore(join(roundDir, "secrets.json")).get(KEY_PATH)).toBe(KEY);
  expect(readFileSync(join(roundDir, "memory-settings.json"))).toEqual(readFileSync(settingsFiles.settingsPath));
});
