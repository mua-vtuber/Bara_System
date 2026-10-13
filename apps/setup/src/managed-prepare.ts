/** Pet-owned memory preparation. No dashboard build or repository mutation. */
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openMemoryDatabase, type OpenOptions } from "../../memory/src/db/migrations.ts";
import {
  SchemaVersionTooNewError,
  SchemaVersionTooOldError,
  UnversionedDatabaseError,
} from "../../memory/src/db/schema-version-gate.ts";
import { EmbeddingDimMismatchError } from "../../memory/src/db/vec-dimension-guard.ts";
import { embeddingDimensionOf } from "../../memory/src/embedding/factory.ts";
import { managedLayout } from "../../memory/src/settings/managed-layout.ts";
import { getMemorySettings, putMemorySettings, type MemorySettings } from "../../memory/src/settings/memory-settings.ts";
import { APP_VERSION } from "../../memory/src/version.ts";

/** 준비가 실패했을 때 stderr 에 쓰는 일반 줄. 이름 붙은 멈춤 사유(NAMED_STOP_ERRORS)는 이 줄 다음 줄에 message 가 더해진다. */
export const MANAGED_PREPARE_FAILURE_LINE = "Managed memory preparation failed; inspect the data root and port";

export interface ManagedPrepared {
  port: number;
  settingsPath: string;
  schemaVersion: number;
  env: Record<string, string>;
}

/**
 * DB 를 열 때 던지는, 원인과 해결 방법이 message 에 담긴 이름 붙은 멈춤 사유(옛 DB·더 새 DB·바라 DB 가 아닌 파일·임베딩 차원 불일치).
 * 이 목록(instanceof 허용 목록)에 든 오류만 message 를 stderr 에 그대로 쓴다 — 그 밖의 오류는 경로·내부 상태가 섞일 수 있어 일반 줄만 쓴다.
 */
const NAMED_STOP_ERRORS = [
  SchemaVersionTooOldError,
  SchemaVersionTooNewError,
  UnversionedDatabaseError,
  EmbeddingDimMismatchError,
] as const;

function isNamedStopError(error: unknown): error is Error {
  return NAMED_STOP_ERRORS.some((errorType) => error instanceof errorType);
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, resolve(candidate));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function readSchemaVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: unknown } | null;
    if (typeof row?.v !== "number" || !Number.isSafeInteger(row.v)) throw new Error("unreadable schema version");
    return row.v;
  } finally { db.close(); }
}

function verifiedPreUpdateSnapshot(database: string, snapshot: { root: string; path: string }): boolean {
  const reject = (reason: string): false => {
    console.error(`[managed-prepare] pre-update snapshot ignored: ${reason}; keeping pre-migration snapshot protection`);
    return false;
  };
  if (!isAbsolute(snapshot.path)) return reject("path must be absolute");
  if (!inside(snapshot.root, snapshot.path)) return reject("path must be inside the managed data root");
  try {
    const file = lstatSync(snapshot.path, { throwIfNoEntry: false });
    if (!file?.isFile() || file.isSymbolicLink()) return reject("path must be an existing regular file, not a symbolic link");
    const actualPath = realpathSync(snapshot.path);
    if (!inside(realpathSync(snapshot.root), actualPath)) return reject("resolved path must be inside the managed data root");
    if (actualPath === realpathSync(database)) return reject("snapshot must be separate from the database being prepared");
  } catch { return reject("could not inspect the snapshot or database path"); }
  try {
    if (readSchemaVersion(snapshot.path) !== readSchemaVersion(database)) return reject("schema versions do not match");
  } catch { return reject("could not read both SQLite schema versions read-only"); }
  return true;
}

/** Preparation keeps the server's pre-migration snapshot unless the Pet supplies a separately verified pre-update
 * copy: an absolute regular file inside the managed root, readable with the same schema version as the live DB.
 * Retry paths may have disappeared or predate a migration, so invalid candidates retain the normal snapshot in
 * `<backup.dir>/pre-migration`. The server's own snapshot policy is unchanged. */
export function managedOpenOptions(settings: Pick<MemorySettings, "db" | "backup">,
  preUpdateSnapshot?: { root: string; path: string }): OpenOptions {
  const options: OpenOptions = { embeddingDim: embeddingDimensionOf(settings.db.embeddingModel) };
  if (!preUpdateSnapshot || !verifiedPreUpdateSnapshot(settings.db.path, preUpdateSnapshot)) {
    options.preMigrationSnapshot = { dir: settings.backup.dir, appVersion: APP_VERSION };
  }
  return options;
}

/** Runs `work` with `console.log` sent to stderr: stdout carries the one JSON result line the Pet parses, while the
 * memory app logs progress (the pre-migration snapshot line) with `console.log`. */
export function withLogsOnStderr<T>(work: () => T): T {
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try { return work(); } finally { console.log = log; }
}

export function prepareManagedMemory(args: { dataDir: string; port: number; preUpdateSnapshot?: string }): ManagedPrepared {
  const { root, settingsPath, secretsPath, dbPath, assetDir, hfCacheDir, kiwiModelDir, tokenPath, backupDir } = managedLayout(args.dataDir);
  if (!Number.isSafeInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("invalid managed port");
  for (const dir of [root, join(root, "config"), join(root, "db"), assetDir,
    hfCacheDir, kiwiModelDir, join(root, "tokens"), backupDir]) mkdirSync(dir, { recursive: true });

  if (!existsSync(settingsPath)) {
    putMemorySettings({
      db: { path: dbPath, host: "127.0.0.1", port: args.port },
      assets: { dir: assetDir }, backup: { dir: backupDir },
      ui: { startPage: "dashboard" },
      llm: { extractor: { enabled: false }, cleanup: { enabled: false }, vision: { enabled: false } },
    }, settingsPath, secretsPath);
  }
  const settings = getMemorySettings(settingsPath, secretsPath);
  for (const path of [settings.db.path, settings.assets.dir, settings.backup.dir]) {
    if (!isAbsolute(path) || !inside(root, path)) throw new Error("existing settings point outside managed data root");
  }
  if (settings.db.host !== "127.0.0.1") throw new Error("managed server must bind loopback");
  const db = openMemoryDatabase(settings.db.path, managedOpenOptions(settings,
    args.preUpdateSnapshot === undefined ? undefined : { root, path: args.preUpdateSnapshot }));
  try {
    const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    return { port: settings.db.port, settingsPath, schemaVersion: row.v,
      env: {
        MEMORY_SETTINGS_PATH: settingsPath, MEMORY_DB_PATH: settings.db.path,
        MEMORY_PORT: String(settings.db.port), MEMORY_HOST: "127.0.0.1",
        BARA_SECRETS_PATH: secretsPath, BARA_ASSET_DIR: assetDir,
        BARA_HF_CACHE_DIR: hfCacheDir, BARA_KIWI_MODEL_DIR: kiwiModelDir,
        SSE_TOKEN_PATH: tokenPath, TZ: settings.time.zone,
      } };
  } finally { db.close(); }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true,
      options: { "data-dir": { type: "string" }, port: { type: "string" }, "pre-update-snapshot": { type: "string" } } });
    if (!values["data-dir"] || !values.port) throw new Error("--data-dir and --port are required");
    const prepared = withLogsOnStderr(() => prepareManagedMemory({ dataDir: values["data-dir"]!, port: Number(values.port),
      preUpdateSnapshot: values["pre-update-snapshot"] }));
    process.stdout.write(JSON.stringify(prepared) + "\n");
  } catch (error) {
    process.stderr.write(`${MANAGED_PREPARE_FAILURE_LINE}\n`);
    if (isNamedStopError(error)) process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
