import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BASELINE_VERSION } from "../../memory/src/db/baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../../memory/src/db/migrations.ts";
import { getMemorySettings } from "../../memory/src/settings/memory-settings.ts";
import { APP_VERSION } from "../../memory/src/version.ts";
import { MANAGED_PREPARE_FAILURE_LINE, managedOpenOptions, withLogsOnStderr, type ManagedPrepared } from "./managed-prepare.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-managed-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runPrepare(dataDir: string, port: number): { code: number; output: string; error: string } {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "managed-prepare.ts"),
    "--data-dir", dataDir, "--port", String(port)], { stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, output: new TextDecoder().decode(child.stdout), error: new TextDecoder().decode(child.stderr) };
}
function prepare(dataDir: string, port: number): ManagedPrepared {
  const result = runPrepare(dataDir, port);
  if (result.code !== 0) throw new Error(result.error);
  return JSON.parse(result.output) as ManagedPrepared;
}

test("managed preparation keeps all writable paths under its explicit data root", () => {
  const prepared = prepare(dir, 44123);
  const settings = getMemorySettings(prepared.settingsPath, join(dir, "config", "secrets.json"));
  expect(settings.db.path).toBe(join(dir, "db", "bara.sqlite"));
  expect(settings.db.port).toBe(44123);
  expect(settings.db.host).toBe("127.0.0.1");
  expect(settings.assets.dir).toBe(join(dir, "assets"));
  expect(settings.backup.dir).toBe(join(dir, "backups"));
  expect(settings.llm.extractor.enabled).toBe(false);
  expect(settings.llm.cleanup.enabled).toBe(false);
  expect(prepared.env.SSE_TOKEN_PATH).toBe(join(dir, "tokens", "sse-tokens.json"));
  expect(prepared.env.BARA_HF_CACHE_DIR).toBe(join(dir, "models", "hf-cache"));
  expect(existsSync(settings.db.path)).toBe(true);
  expect(prepared.schemaVersion).toBeGreaterThan(0);
});

test("retry reuses the managed port and never rewrites existing data or secrets", () => {
  const first = prepare(dir, 44123);
  const original = readFileSync(first.settingsPath);
  const second = prepare(dir, 44124);
  expect(second.port).toBe(44123);
  expect(readFileSync(first.settingsPath)).toEqual(original);
  expect(second.settingsPath).toBe(first.settingsPath);
});

test("relative data roots and existing settings pointing outside the root are refused", () => {
  expect(runPrepare("relative", 44123).code).not.toBe(0);
  const first = prepare(dir, 44123);
  const settings = JSON.parse(readFileSync(first.settingsPath, "utf8"));
  settings.db.path = resolve(dir, "..", "unowned.sqlite");
  writeFileSync(first.settingsPath, JSON.stringify(settings));
  expect(runPrepare(dir, 44123).code).not.toBe(0);
});
/** 첫 준비로 기준 DB 와 설정을 만든 뒤 그 DB 파일 경로를 돌려준다. */
function seedBaselineDb(): string {
  prepare(dir, 44123);
  return join(dir, "db", "bara.sqlite");
}

/** DB 파일과 -wal·-shm 을 지운다(첫 준비의 자식 프로세스는 이미 끝났다). */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
}

function stderrLines(error: string): string[] {
  return error.split("\n").filter((line) => line !== "");
}

test("an old schema_version stops with the generic line followed by the named error message", () => {
  const dbPath = seedBaselineDb();
  const db = new Database(dbPath);
  // schema_version 은 적용된 버전마다 한 행이다. 기준 스키마보다 옛 DB 를 흉내 내려면 행을 모두 지우고 하나만 남긴다.
  db.run("DELETE FROM schema_version");
  db.run("INSERT INTO schema_version (version) VALUES (?)", [BASELINE_VERSION - 1]);
  db.close();

  const result = runPrepare(dir, 44123);
  const lines = stderrLines(result.error);
  expect(result.code).toBe(1);
  expect(result.output).toBe("");
  expect(lines[0]).toBe(MANAGED_PREPARE_FAILURE_LINE);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(`schema_version v${BASELINE_VERSION - 1}`);
  expect(lines[1]).toContain(dbPath);
});

test("a newer schema_version stops with the named error message", () => {
  const dbPath = seedBaselineDb();
  const db = new Database(dbPath);
  // 이 코드가 아는 최고 버전보다 한 단계 새 DB — 행을 하나 더 얹는다(기존 행을 바꾸면 PRIMARY KEY 가 겹친다).
  db.run("INSERT INTO schema_version (version) VALUES (?)", [CURRENT_SCHEMA_VERSION + 1]);
  db.close();

  const result = runPrepare(dir, 44123);
  const lines = stderrLines(result.error);
  expect(result.code).toBe(1);
  expect(lines[0]).toBe(MANAGED_PREPARE_FAILURE_LINE);
  expect(lines[1]).toContain(`schema_version v${CURRENT_SCHEMA_VERSION + 1}`);
});

test("a SQLite file without schema_version stops with the named error message", () => {
  const dbPath = seedBaselineDb();
  removeDbFiles(dbPath);
  const foreign = new Database(dbPath);
  foreign.run("CREATE TABLE foreign_app_data (id INTEGER PRIMARY KEY)");
  foreign.close();

  const result = runPrepare(dir, 44123);
  const lines = stderrLines(result.error);
  expect(result.code).toBe(1);
  expect(lines[0]).toBe(MANAGED_PREPARE_FAILURE_LINE);
  expect(lines[1]).toContain("schema_version 기록이 없어");
});

test("a vector dimension mismatch stops with the named error message", () => {
  const dbPath = seedBaselineDb();
  removeDbFiles(dbPath);
  const otherDim = 384;
  openMemoryDatabase(dbPath, { embeddingDim: otherDim }).close();

  const result = runPrepare(dir, 44123);
  const lines = stderrLines(result.error);
  expect(result.code).toBe(1);
  expect(lines[0]).toBe(MANAGED_PREPARE_FAILURE_LINE);
  expect(lines[1]).toContain("임베딩 차원 불일치");
  expect(lines[1]).toContain(String(otherDim));
});

test("errors outside the allow-list print only the generic line", () => {
  const relativeRoot = runPrepare("relative", 44123);
  expect(relativeRoot.code).toBe(1);
  expect(relativeRoot.error).toBe(MANAGED_PREPARE_FAILURE_LINE + "\n");

  const first = prepare(dir, 44123);
  const settings = JSON.parse(readFileSync(first.settingsPath, "utf8"));
  settings.db.path = resolve(dir, "..", "unowned.sqlite");
  writeFileSync(first.settingsPath, JSON.stringify(settings));
  const outside = runPrepare(dir, 44123);
  expect(outside.code).toBe(1);
  expect(outside.error).toBe(MANAGED_PREPARE_FAILURE_LINE + "\n");
});

test("preparation opens the database with the memory server's pre-migration snapshot in the managed backup folder", () => {
  const prepared = prepare(dir, 44123);
  const settings = getMemorySettings(prepared.settingsPath, join(dir, "config", "secrets.json"));
  expect(managedOpenOptions(settings)).toEqual({ embeddingDim: 1024,
    preMigrationSnapshot: { dir: join(dir, "backups"), appVersion: APP_VERSION } });
  // With no pending migration nothing is copied, and a second preparation leaves the database as it was.
  const before = readFileSync(settings.db.path);
  prepare(dir, 44123);
  expect(readFileSync(settings.db.path)).toEqual(before);
  expect(existsSync(join(dir, "backups", "pre-migration"))).toBe(false);
});

test("the memory app's progress logs go to stderr so stdout stays the one JSON result line", () => {
  const out: unknown[][] = [], err: unknown[][] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => { out.push(args); };
  console.error = (...args: unknown[]) => { err.push(args); };
  try {
    expect(withLogsOnStderr(() => { console.log("[pre-migration] snapshot: x"); return 7; })).toBe(7);
    expect(() => withLogsOnStderr(() => { throw new Error("stop"); })).toThrow("stop");
    console.log("after");
  } finally { console.log = log; console.error = error; }
  expect(err).toEqual([["[pre-migration] snapshot: x"]]);
  expect(out).toEqual([["after"]]);
});
