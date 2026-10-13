/**
 * Server-round restore into the pet-managed layout (db/, config/, tokens/, assets/) — real SQLite, real
 * runBackupRound rounds, real file system and the real CLI process. No stand-in implementations.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../db/migrations.ts";
import { cleanupTempDir, makeWalTempDir } from "../db/wal-test-helpers.ts";
import { managedLayout } from "../settings/managed-layout.ts";
import { runBackupRound } from "./backup-runner.ts";
import { assertManagedRound, executeRestore, managedTargets, planRestore, readManagedRestoreSettings, RestoreError } from "./restore.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) cleanupTempDir(dirs.pop()!); });
const ASSET = "b".repeat(64) + ".png";
const MEMORY_APP = resolve(import.meta.dir, "..", "..");

/** A managed data root laid out as managed-prepare does, with one memory and one attachment in a server round, and a
 * second memory written after the round. `settingsInRound: false` makes a round without the settings file. */
async function managedServer(prefix: string, port = 39_201, settingsInRound = true) {
  const { dir } = makeWalTempDir(prefix);
  dirs.push(dir);
  const layout = managedLayout(join(dir, "data"));
  for (const folder of [join(layout.root, "config"), join(layout.root, "db"), join(layout.assetDir, "content"), join(layout.root, "tokens"), layout.backupDir])
    mkdirSync(folder, { recursive: true });
  const settings = { db: { path: layout.dbPath, host: "127.0.0.1", port }, assets: { dir: layout.assetDir }, backup: { dir: layout.backupDir } };
  writeFileSync(layout.settingsPath, JSON.stringify(settings));
  writeFileSync(layout.secretsPath, JSON.stringify({ k: "v" }));
  writeFileSync(layout.tokenPath, JSON.stringify({ round: true }));
  writeFileSync(join(layout.assetDir, "content", ASSET), "png-bytes");
  // The live database is built in a work folder and its bytes written to db/bara.sqlite: Windows bun keeps a closed
  // vec0 file DB's handle for a while (wal-test-helpers.ts), which would block the restore's move of the live file.
  const workDir = join(dir, "work");
  mkdirSync(workDir);
  const db = openMemoryDatabase(join(workDir, "bara.sqlite"));
  db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("회차 시점 기억");
  const aside = `${layout.settingsPath}.aside`;
  if (!settingsInRound) renameSync(layout.settingsPath, aside);
  const { roundDir } = await runBackupRound({ db, dbPath: layout.dbPath, backupDir: layout.backupDir, assetDir: layout.assetDir,
    settingsFilePath: layout.settingsPath, secretsFilePath: layout.secretsPath, sseTokenFilePath: layout.tokenPath,
    appVersion: "0.1.0", schemaVersion: CURRENT_SCHEMA_VERSION });
  if (!settingsInRound) renameSync(aside, layout.settingsPath);
  db.prepare("INSERT INTO knowledge_nodes (content) VALUES (?)").run("회차 뒤 기억");
  writeFileSync(layout.dbPath, db.serialize());
  db.close();
  writeFileSync(layout.tokenPath, JSON.stringify({ round: false }));
  return { layout, settings, roundDir, mirror: join(layout.backupDir, "assets-mirror") };
}

function memories(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT content FROM knowledge_nodes ORDER BY id").all() as Array<{ content: string }>).map((row) => row.content); }
  finally { db.close(); }
}

/** The CLI's environment without the variables that point the one-folder mode at some other data. */
function cliEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["MEMORY_SETTINGS_PATH", "BARA_SECRETS_PATH", "MEMORY_DB_PATH", "BARA_ASSET_DIR", "SSE_TOKEN_PATH"].includes(key))) as Record<string, string>;
}

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, "scripts/restore-backup.ts", ...args], { cwd: MEMORY_APP, env: cliEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

test("a server round goes back into the managed layout: db/, config/, tokens/ and assets/content", async () => {
  const s = await managedServer("bara-restore-managed-");
  const out = executeRestore(s.roundDir, s.mirror, managedTargets(s.layout, s.settings));
  expect(memories(s.layout.dbPath)).toEqual(["회차 시점 기억"]);
  expect(JSON.parse(readFileSync(s.layout.tokenPath, "utf8"))).toEqual({ round: true });
  expect(existsSync(join(s.layout.assetDir, "content", ASSET))).toBe(true);
  expect(out.beforeRestoreDir!.startsWith(s.layout.root)).toBe(true);
  expect(readdirSync(out.beforeRestoreDir!)).toContain("bara.sqlite");
  expect(existsSync(join(s.layout.root, "bara.sqlite"))).toBe(false);
});

test("the managed restore keeps the current files aside: the pre-restore database and token are in before-restore", async () => {
  const s = await managedServer("bara-restore-managed-aside-");
  const out = executeRestore(s.roundDir, s.mirror, managedTargets(s.layout, s.settings));
  const aside = out.beforeRestoreDir!;
  expect(resolve(aside, "..")).toBe(s.layout.root);
  expect(readdirSync(aside).sort()).toEqual(["bara.sqlite", "memory-settings.json", "secrets.json", "sse-tokens.json"]);
  expect(JSON.parse(readFileSync(join(aside, "sse-tokens.json"), "utf8"))).toEqual({ round: false });
  expect(memories(join(aside, "bara.sqlite"))).toEqual(["회차 시점 기억", "회차 뒤 기억"]);
});

test("the live database's -wal and -shm go into before-restore with it, and none is left beside the restored database", async () => {
  const s = await managedServer("bara-restore-managed-sidecars-");
  writeFileSync(`${s.layout.dbPath}-wal`, "old-wal");
  writeFileSync(`${s.layout.dbPath}-shm`, "old-shm");
  const aside = executeRestore(s.roundDir, s.mirror, managedTargets(s.layout, s.settings)).beforeRestoreDir!;
  expect(readFileSync(join(aside, "bara.sqlite-wal"), "utf8")).toBe("old-wal");
  expect(readFileSync(join(aside, "bara.sqlite-shm"), "utf8")).toBe("old-shm");
  expect(existsSync(`${s.layout.dbPath}-wal`) || existsSync(`${s.layout.dbPath}-shm`)).toBe(false);
  expect(memories(s.layout.dbPath)).toEqual(["회차 시점 기억"]);
});

test("attachments go to the asset folder the managed server reads (layout.assetDir), even when assets.dir was edited", async () => {
  const s = await managedServer("bara-restore-managed-assetdir-");
  rmSync(join(s.layout.assetDir, "content", ASSET));
  const edited = join(s.layout.root, "assets-edited");
  const out = executeRestore(s.roundDir, s.mirror, managedTargets(s.layout, { ...s.settings, assets: { dir: edited } }));
  expect(out.assets).toBe(1);
  expect(readFileSync(join(s.layout.assetDir, "content", ASSET), "utf8")).toBe("png-bytes");
  expect(existsSync(edited)).toBe(false);
});

test("a db.path other than the managed layout's database is refused, naming both paths", async () => {
  const s = await managedServer("bara-restore-managed-dbpath-");
  const moved = join(s.layout.root, "db", "other.sqlite");
  const attempt = () => managedTargets(s.layout, { ...s.settings, db: { path: moved } });
  expect(attempt).toThrow(RestoreError);
  expect(attempt).toThrow(moved);
  expect(attempt).toThrow(s.layout.dbPath);
  expect(memories(s.layout.dbPath)).toEqual(["회차 시점 기억", "회차 뒤 기억"]);
});

test("a round made by another server folder is refused before anything moves", async () => {
  const here = await managedServer("bara-restore-here-");
  const other = await managedServer("bara-restore-other-");
  expect(() => assertManagedRound(other.roundDir, planRestore(other.roundDir), here.settings)).toThrow(RestoreError);
  expect(memories(here.layout.dbPath)).toEqual(["회차 시점 기억", "회차 뒤 기억"]);
});

test("a round whose settings name another asset folder, or that carries no settings file, is refused", async () => {
  const s = await managedServer("bara-restore-assets-moved-");
  const moved = { ...s.settings, assets: { dir: join(s.layout.root, "assets-elsewhere") } };
  expect(() => assertManagedRound(s.roundDir, planRestore(s.roundDir), moved)).toThrow("assets.dir");
  const bare = await managedServer("bara-restore-no-settings-", 39_201, false);
  expect(planRestore(bare.roundDir).extraFiles).not.toContain("memory-settings.json");
  expect(() => assertManagedRound(bare.roundDir, planRestore(bare.roundDir), bare.settings)).toThrow(RestoreError);
});

test("settings pointing outside the managed folder, and round files with no place there, are refused", async () => {
  const s = await managedServer("bara-restore-outside-");
  expect(() => managedTargets(s.layout, { ...s.settings, db: { path: "/elsewhere/bara.sqlite" } })).toThrow(RestoreError);
  expect(() => managedTargets(s.layout, { ...s.settings, assets: { dir: s.layout.root } })).toThrow(RestoreError);
  expect(() => managedTargets(s.layout, s.settings).fileDestination("unknown.json")).toThrow(RestoreError);
});

test("the managed settings file must exist and name every path the restore needs", async () => {
  const s = await managedServer("bara-restore-settings-keys-");
  expect(readManagedRestoreSettings(s.layout)).toEqual({ db: { path: s.layout.dbPath, port: 39_201 },
    assets: { dir: s.layout.assetDir }, backup: { dir: s.layout.backupDir } });
  writeFileSync(s.layout.settingsPath, JSON.stringify({ db: { path: s.layout.dbPath, port: 39_201 }, assets: { dir: s.layout.assetDir } }));
  expect(() => readManagedRestoreSettings(s.layout)).toThrow("backup.dir");
  writeFileSync(s.layout.settingsPath, JSON.stringify({ db: { path: s.layout.dbPath }, assets: { dir: s.layout.assetDir }, backup: { dir: s.layout.backupDir } }));
  expect(() => readManagedRestoreSettings(s.layout)).toThrow("db.port");
  const missing = managedLayout(join(s.layout.root, "nowhere"));
  expect(() => readManagedRestoreSettings(missing)).toThrow(missing.settingsPath);
});

test("the CLI restores into the managed layout with --managed-data", async () => {
  const s = await managedServer("bara-restore-cli-", 39_202);
  const run = await runCli([s.roundDir, "--managed-data", s.layout.root, "--yes"]);
  expect({ code: run.code, err: run.code === 0 ? "" : run.err }).toEqual({ code: 0, err: "" });
  expect(run.out).toContain("bara-pet-memory.service");
  expect(memories(s.layout.dbPath)).toEqual(["회차 시점 기억"]);
});

test("the CLI refuses while the managed server answers /health, without --yes, and with --data-dir", async () => {
  const s = await managedServer("bara-restore-cli-gates-", 39_203);
  const server = Bun.serve({ port: 39_203, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    const live = await runCli([s.roundDir, "--managed-data", s.layout.root, "--yes"]);
    expect(live.code).toBe(1);
    expect(live.err).toContain("sudo systemctl stop bara-pet-memory.service");
  } finally { server.stop(true); }
  expect((await runCli([s.roundDir, "--managed-data", s.layout.root])).code).toBe(1);
  expect((await runCli([s.roundDir, "--managed-data", s.layout.root, "--data-dir", s.layout.root, "--yes"])).code).toBe(2);
  expect((await runCli([s.roundDir, "--managed-data", "relative/data", "--yes"])).code).toBe(1);
  expect(memories(s.layout.dbPath)).toEqual(["회차 시점 기억", "회차 뒤 기억"]);
});
