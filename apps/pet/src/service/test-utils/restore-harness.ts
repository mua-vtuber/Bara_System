import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProgressDetail, ProgressStage, PublicSettings, RequestContext, RuntimePaths } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import type { FreeSpace } from "../install/disk-space.ts";
import { RESTORE_STATE_FILE, type Rename, type RestoreJournal } from "../restore-journal.ts";
import { RestoreService, type RestoreBlocker, type RestoreDeps } from "../restore.ts";

// Shared by `restore.test.ts` and `restore-lifecycle.test.ts` (test-only; production code never imports this folder).
// `backup.restore` runs the core's offline scripts as real processes. These tests give it test-only stand-ins at the
// paths the packaged core has (`<resources>/core/apps/memory/scripts/{portable-memory,prefetch-core-models}.ts`), run
// by this Bun. They keep the scripts' contracts (one JSON result line, errors on stderr, nonzero exit, the restore's
// published folder with its receipt and its staging folder beside it) as far as the tests need, log each run to
// `<resources>/calls.log` and read what to do from `<resources>/stub-mode.json`. The server is a stand-in too: the
// test's `startServer` runs the restore's start gate the way `InstallManager` does. The last test of
// `restore-lifecycle.test.ts` runs the real exporter, check and restore and the real `managed-prepare` on real databases.

export const NOW = new Date(2026, 9, 7, 9, 5, 3);

const STUB_HEAD = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const resources = join(process.cwd(), "..", "..", "..");
const mode = existsSync(join(resources, "stub-mode.json")) ? JSON.parse(readFileSync(join(resources, "stub-mode.json"), "utf8")) : {};
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const log = (entry) => appendFileSync(join(resources, "calls.log"), JSON.stringify(entry) + "\\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const released = async () => { while (!existsSync(join(resources, "release"))) await Bun.sleep(20); };
`;
const PORTABLE = `${STUB_HEAD}
if (args[0] === "verify") {
  const archive = value("--archive");
  log({ step: "verify", archive });
  if (mode.verify === "wait") await released();
  if (mode.verify === "fail") { console.error("checking collections"); console.error("portable-memory: Collection hash mismatch: memories"); process.exit(1); }
  const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));
  process.stdout.write(JSON.stringify({ valid: true, directory: archive, fingerprint: sha(archive + (mode.fingerprint ?? "")), manifest }) + "\\n");
} else if (args[0] === "restore") {
  const archive = value("--archive"), out = value("--out");
  const stage = join(out, "..", ".target.portable-restore");
  log({ step: "restore", archive, args, stageExisted: existsSync(stage), hfCache: process.env.BARA_HF_CACHE_DIR, kiwi: process.env.BARA_KIWI_MODEL_DIR });
  mkdirSync(stage, { recursive: true }); writeFileSync(join(stage, "checkpoint"), archive);
  if (mode.restore === "hang") { console.error("[rows] 41/41"); await Bun.sleep(60_000); }
  if (mode.restore === "wait" || mode.restore === "wait-fail") await released();
  if (mode.restore === "fail" || mode.restore === "wait-fail") { console.error("[index:vec_nodes] 8/20"); console.error("portable-memory: Embedding unavailable or invalid: index:vec_nodes"); process.exit(1); }
  const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));
  if (!existsSync(out)) {
    mkdirSync(join(out, "assets", "content"), { recursive: true });
    const files = {};
    const put = (file, text) => { writeFileSync(join(out, file), text); files[file] = { sha256: sha(text), byteSize: Buffer.byteLength(text) }; };
    put("memory.sqlite", "restored from " + archive);
    put("assets/bara-asset-pairing.json", JSON.stringify({ format: 1, pairingId: "11111111-2222-4333-8444-555555555555" }));
    const attachments = mode.restore === "lose-attachment" ? manifest.attachments.slice(1) : manifest.attachments;
    for (const a of attachments) put("assets/content/" + a.sha256 + "." + a.extension, "attachment " + a.sha256);
    writeFileSync(join(out, "portable-restore.json"), JSON.stringify({ format: "bara-portable-restore", version: 1, status: "complete", destination: out, files }));
  }
  rmSync(stage, { recursive: true });
  const counts = Object.fromEntries(Object.entries(manifest.collections).map(([name, entry]) => [name, entry.count]));
  if (mode.restore === "miscount") counts.memories += 1;
  process.stdout.write(JSON.stringify({ destination: out, dbPath: join(out, "memory.sqlite"), assetDir: join(out, "assets"), counts, indexCounts: {}, attachmentBytes: 0, elapsedMs: 5 }) + "\\n");
}
`;
const PREFETCH = `${STUB_HEAD}
log({ step: "models", hfCache: process.env.BARA_HF_CACHE_DIR, lines: process.env.BARA_INSTALL_PROGRESS });
if (mode.models === "fail") { console.error("[prefetch] bge-m3"); console.error("TypeError: fetch failed"); process.exit(1); }
process.stdout.write('@@bara-progress {"part":1,"parts":4,"loaded":5000000,"total":10000000}\\n');
console.log("[prefetch] done");
`;

export interface Fixture {
  dir: string; paths: RuntimePaths; memoryData: string; db: string; assets: string; backupDir: string; preUpdate: string;
  calls(): Array<Record<string, unknown>>; mode(value: Record<string, string>): void; journal(): RestoreJournal | null;
  /** Lets a stand-in in a `wait` mode go on. */
  release(): void;
}

export function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pet-restore-${name}-`));
  roots.push(root);
  return root;
}

/** A backup's manifest as the exporter writes it, with `attachments` attachment entries. */
export function manifest(createdAt: string, memories: number, archived: number, attachments: number, extra: Record<string, number> = {}) {
  return { format: "bara-memory", version: 1, archiveId: "a", createdAt, source: { appVersion: "0.1.0", schemaVersion: 47 },
    collections: Object.fromEntries(Object.entries({ memories, archivedMemories: archived, ...extra })
      .map(([name, count]) => [name, { file: `collections/${name}.json`, count, sha256: "0".repeat(64) }])),
    allocators: {}, attachments: Array.from({ length: attachments }, (_, index) => ({ sha256: String(index).repeat(64).slice(0, 64), extension: "png",
      byteSize: 10 + index, file: `attachments/content/${index}.png` })), indexes: { policy: "recompute", sourceCounts: {} }, exclusions: [] };
}
export function writeArchive(folder: string, value: unknown): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(value));
}

export const MANUAL_OLD = "bara-backup-20261001-120000";
export const MANUAL_NEW = "bara-backup-20261005-080000";
export const PRE_UPDATE = "0.1.0-to-0.2.0-20261006-090000";

/** A finished local install (settings, a database with its log and index, attachments), two settings backups and a
 * pre-update backup beside folders that are not backups, and a fake core holding the stand-ins. */
export function fixture(): Fixture {
  const dir = scratch("fixture");
  const dataDir = join(dir, "data"), resourceDir = join(dir, "resources"), backupDir = join(dir, "Documents", "Bara 백업");
  const memoryData = join(dataDir, "memory");
  const db = join(memoryData, "db", "bara.sqlite"), assets = join(memoryData, "assets");
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(db, "current database"); writeFileSync(`${db}-wal`, "current log"); writeFileSync(`${db}-shm`, "current index");
  mkdirSync(join(assets, "content"), { recursive: true });
  writeFileSync(join(assets, "content", "a.png"), "current picture");
  writeFileSync(join(assets, "bara-asset-pairing.json"), "current pairing");
  mkdirSync(join(memoryData, "config"), { recursive: true });
  writeFileSync(join(memoryData, "config", "memory-settings.json"), JSON.stringify(
    { db: { path: db, host: "127.0.0.1", port: 41031 }, assets: { dir: assets }, backup: { dir: join(memoryData, "backups") } }));
  writeFileSync(join(memoryData, "managed-install.json"), JSON.stringify({ version: 1, phase: "complete", port: 41031 }));
  // Backups the list shows.
  writeArchive(join(backupDir, MANUAL_OLD), manifest("2026-10-01T03:00:00.000Z", 3, 1, 2));
  writeArchive(join(backupDir, MANUAL_NEW), manifest("2026-10-04T23:00:00.000Z", 5, 0, 0));
  const preUpdate = join(memoryData, "backups", "pre-update");
  writeArchive(join(preUpdate, PRE_UPDATE, "portable"), manifest("2026-10-05T23:59:00.000Z", 4, 0, 1));
  writeFileSync(join(preUpdate, PRE_UPDATE, "update-backup.json"), JSON.stringify({ format: 1, createdAt: "2026-10-06T00:00:00.000Z" }));
  // Folders that are not usable backups.
  mkdirSync(join(backupDir, "bara-backup-20261002-000000"));
  mkdirSync(join(backupDir, "bara-backup-20261003-000000")); writeFileSync(join(backupDir, "bara-backup-20261003-000000", "manifest.json"), "{ broken");
  writeArchive(join(backupDir, "bara-backup-20261003-000001"), { ...manifest("2026-10-03T00:00:00.000Z", 1, 0, 0), format: "other" });
  writeArchive(join(backupDir, "my copy"), manifest("2026-10-06T00:00:00.000Z", 9, 0, 0));
  const elsewhere = join(dir, "elsewhere");
  writeArchive(elsewhere, manifest("2026-10-06T00:00:00.000Z", 9, 0, 0));
  // Junctions retain the linked-directory boundary check without Windows symlink elevation.
  symlinkSync(elsewhere, join(backupDir, "bara-backup-20261004-000000"), process.platform === "win32" ? "junction" : "dir");
  writeArchive(join(preUpdate, "0.1.0-to-0.2.0-20261006-100000", "portable"), manifest("2026-10-06T01:00:00.000Z", 9, 0, 0));
  const scripts = join(resourceDir, "core", "apps", "memory", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "portable-memory.ts"), PORTABLE);
  writeFileSync(join(scripts, "prefetch-core-models.ts"), PREFETCH);
  const log = join(resourceDir, "calls.log");
  const journalFile = join(dataDir, RESTORE_STATE_FILE);
  return { dir, memoryData, db, assets, backupDir, preUpdate, paths: { dataDir, resourceDir, bunPath: process.execPath, backupDir },
    calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    mode: (value) => writeFileSync(join(resourceDir, "stub-mode.json"), JSON.stringify(value)),
    release: () => writeFileSync(join(resourceDir, "release"), ""),
    journal: () => existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) as RestoreJournal : null };
}

export const enough: FreeSpace = async () => 1_000 * 1_000_000_000;

export interface Harness { service: RestoreService; events: string[]; running(): boolean }
export interface HarnessOptions {
  mode?: PublicSettings["connection"]["mode"]; freeSpace?: FreeSpace; blocker?: () => RestoreBlocker | null; rename?: Rename;
  startFails?: () => boolean; startServer?: (ctx: RequestContext) => Promise<void>; onStop?: () => void;
}

/** The service with a stand-in server: `startServer` passes the restore's start gate first, as `InstallManager` does,
 * and tells it the server started. `exclusive` is a queue like `PetService.withConnection`. */
export function harness(f: Fixture, options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  let server = true;
  let tail: Promise<void> = Promise.resolve();
  const config = { load: async () => ({ connection: { mode: options.mode ?? "local" } }) as unknown as PublicSettings };
  const deps: RestoreDeps = {
    exclusive: async (ctx, work) => {
      const previous = tail; let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      try { await previous; ctx.signal.throwIfAborted(); return await work(); } finally { release(); }
    },
    stopServer: async () => { options.onStop?.(); events.push("stop"); server = false; },
    startServer: async (ctx) => {
      await service.beforeStart();
      if (options.startFails?.()) { events.push("start-failed"); throw serviceError("INSTALL_SERVER_EXITED", messages.installService.localServerExited); }
      await options.startServer?.(ctx);
      events.push("start"); server = true;
      await service.started();
    },
    blocker: () => options.blocker?.() ?? null,
  };
  const service: RestoreService = new RestoreService(config, f.paths, deps,
    { appVersion: "0.2.0", freeSpace: options.freeSpace ?? enough, now: () => NOW, ...(options.rename ? { rename: options.rename } : {}) });
  return { service, events, running: () => server };
}

export function ctx(signal = new AbortController().signal): RequestContext & { stages: ProgressStage[]; details: ProgressDetail[] } {
  const stages: ProgressStage[] = [], details: ProgressDetail[] = [];
  return { signal, stages, details, progress(stage, detail) { stages.push(stage); if (detail) details.push(detail); } };
}
export function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}
export const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
export const steps = (f: Fixture) => f.calls().map((call) => call.step);

/** The store as the fixture made it: nothing moved, nothing written over. */
export function expectUntouched(f: Fixture): void {
  expect(read(f.db)).toBe("current database");
  expect(read(`${f.db}-wal`)).toBe("current log");
  expect(read(`${f.db}-shm`)).toBe("current index");
  expect(readdirSync(join(f.assets, "content"))).toEqual(["a.png"]);
  expect(read(join(f.assets, "bara-asset-pairing.json"))).toBe("current pairing");
  expect(readdirSync(f.memoryData).filter((name) => name.startsWith("before-restore-"))).toEqual([]);
}

export async function idOf(h: Harness, name: string): Promise<string> {
  const entry = (await h.service.list()).entries.find((found) => found.name === name);
  if (!entry) throw new Error(`no entry ${name}`);
  return entry.id;
}

/** Waits until the restore stand-in has made its staging folder, so a cancel lands while it runs. */
export async function restoreRunning(f: Fixture): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (existsSync(join(f.memoryData, "restore-work", ".target.portable-restore", "checkpoint"))) return;
    await Bun.sleep(25);
  }
  throw new Error("the restore never started");
}

const roots: string[] = [];
/** Each test file runs this after every test: removes the scratch folders `scratch` made. */
export function removeScratchRoots(): void { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
