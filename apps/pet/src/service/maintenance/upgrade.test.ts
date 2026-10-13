import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import type { ProgressStage, RequestContext, RuntimePaths } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { BACKUP_MARGIN_BYTES, fileSize, storeBytes } from "../backup.ts";
import { fitted, serviceError } from "../errors.ts";
import type { FreeSpace } from "../install/disk-space.ts";
import { MAINTENANCE_FILE, openMaintenance, type MaintenanceDeps, type MaintenanceRecord } from "./manifest.ts";
import { PRE_UPDATE_KEEP, UPDATE_BACKUP_FILE, UPDATE_STATE_FILE, UpdateGate, parseUpdateState, type UpdateGateOptions, type UpdateState } from "./upgrade.ts";

// The gate runs the core's offline scripts as real processes. These tests give it test-only stand-ins at the paths
// the packaged core has (`<resources>/core/apps/memory/scripts/{db-snapshot,portable-memory}.ts`), run by this Bun.
// They keep the scripts' contracts (one JSON result line, errors on stderr, nonzero exit) as far as the tests need,
// record each run in `<resources>/calls.log` and read what to do from `<resources>/stub-mode.json`. The last test
// runs the real scripts on a real database.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NOW = new Date(2026, 9, 7, 9, 5, 3);
const FOLDER = "0.1.0-to-0.2.0-20261007-090503";
// The sibling core is present in the monorepo, but absent from standalone Pet CI.
const memoryApp = resolve(import.meta.dir, "..", "..", "..", "..", "memory");
const realScripts = existsSync(join(memoryApp, "scripts", "db-snapshot.ts")) && existsSync(join(memoryApp, "node_modules", "sqlite-vec"));
const MANIFEST = { format: "bara-memory", version: 1,
  collections: { memories: { file: "collections/memories.json", count: 3, sha256: "" } },
  attachments: [{ sha256: "a", extension: "png", byteSize: 1, file: "attachments/content/a.png" }] };

const STUB_HEAD = `
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const resources = join(process.cwd(), "..", "..", "..");
const mode = existsSync(join(resources, "stub-mode.json")) ? JSON.parse(readFileSync(join(resources, "stub-mode.json"), "utf8")) : {};
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const called = (name) => appendFileSync(join(resources, "calls.log"), name + "\\n");
`;
const SNAPSHOT = `${STUB_HEAD}
called("snapshot");
const out = value("--out");
if (mode.snapshot === "fail") { console.error("opening source"); console.error("db-snapshot: Snapshot integrity check failed"); process.exit(1); }
if (mode.snapshot === "hang") { writeFileSync(out + ".partial", "x"); await Bun.sleep(60_000); }
copyFileSync(value("--db"), out);
process.stdout.write(JSON.stringify({ path: out, bytes: statSync(out).size, schemaVersion: 47 }) + "\\n");
`;
const PORTABLE = `${STUB_HEAD}
const MANIFEST = ${JSON.stringify(MANIFEST)};
if (args[0] === "export") {
  called("export");
  const out = value("--out");
  if (mode.export === "fail") { console.error("portable-memory: Unsupported source schema version"); process.exit(1); }
  mkdirSync(out); writeFileSync(join(out, "manifest.json"), JSON.stringify(MANIFEST));
  process.stdout.write(JSON.stringify(MANIFEST) + "\\n");
} else {
  called("verify");
  const read = JSON.parse(readFileSync(join(value("--archive"), "manifest.json"), "utf8"));
  if (mode.verify === "mismatch") read.collections.memories.count += 1;
  process.stdout.write(JSON.stringify({ valid: true, directory: value("--archive"), fingerprint: "f".repeat(64), manifest: read }) + "\\n");
}
`;

interface Fixture {
  dir: string; paths: RuntimePaths; memoryData: string; db: string; root: string; stateFile: string;
  calls(): string[]; mode(value: Record<string, string>): void; state(): UpdateState | null; maintenanceFile(): string;
}

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pet-upgrade-${name}-`));
  roots.push(root);
  return root;
}

/** A Pet data folder with a finished local store (settings, a database with its log, an attachment), a fake core
 * holding the stand-ins and, unless `recorded` is null, a `maintenance.json` naming `recorded`. */
function fixture(options: { recorded?: string | null; database?: boolean } = {}): Fixture {
  const dir = scratch("fixture");
  const dataDir = join(dir, "data"), resourceDir = join(dir, "resources");
  const memoryData = join(dataDir, "memory");
  const db = join(memoryData, "db", "bara.sqlite");
  mkdirSync(join(memoryData, "db"), { recursive: true });
  if (options.database !== false) { writeFileSync(db, Buffer.alloc(1_000)); writeFileSync(`${db}-wal`, Buffer.alloc(500)); }
  mkdirSync(join(memoryData, "assets", "content"), { recursive: true });
  writeFileSync(join(memoryData, "assets", "content", "a.png"), Buffer.alloc(200));
  mkdirSync(join(memoryData, "config"), { recursive: true });
  writeFileSync(join(memoryData, "config", "memory-settings.json"), JSON.stringify(
    { db: { path: db, host: "127.0.0.1", port: 41031 }, assets: { dir: join(memoryData, "assets") }, backup: { dir: join(memoryData, "backups") } }));
  const scripts = join(resourceDir, "core", "apps", "memory", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "db-snapshot.ts"), SNAPSHOT);
  writeFileSync(join(scripts, "portable-memory.ts"), PORTABLE);
  const recorded = options.recorded === undefined ? "0.1.0" : options.recorded;
  if (recorded !== null) {
    const record: MaintenanceRecord = { format: 1, installationId: "installation-1", appVersion: recorded, settingsFormat: 1, dbSchemaVersion: 47,
      payload: null, paths: { dataDir, resourceDir }, updatedAt: "2026-10-01T00:00:00.000Z" };
    writeFileSync(join(dataDir, MAINTENANCE_FILE), JSON.stringify(record));
  }
  const stateFile = join(dataDir, UPDATE_STATE_FILE);
  const log = join(resourceDir, "calls.log");
  return { dir, memoryData, db, stateFile, root: join(memoryData, "backups", "pre-update"),
    paths: { dataDir, resourceDir, bunPath: process.execPath },
    calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    mode: (value) => writeFileSync(join(resourceDir, "stub-mode.json"), JSON.stringify(value)),
    state: () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as UpdateState : null,
    maintenanceFile: () => readFileSync(join(dataDir, MAINTENANCE_FILE), "utf8") };
}

const enough: FreeSpace = async () => 1_000 * 1_000_000_000;
async function gate(f: Fixture, version = "0.2.0", options: { freeSpace?: FreeSpace; deps?: MaintenanceDeps } & Pick<UpdateGateOptions, "now" | "remove"> = {}) {
  const maintenance = await openMaintenance(f.paths, version, { existingData: existsSync(f.db), ...options.deps });
  return { maintenance, gate: new UpdateGate({ paths: f.paths, maintenance, freeSpace: options.freeSpace ?? enough, now: options.now ?? (() => NOW),
    ...(options.remove ? { remove: options.remove } : {}) }) };
}
function ctx(signal = new AbortController().signal): RequestContext & { stages: ProgressStage[] } {
  const stages: ProgressStage[] = [];
  return { signal, stages, progress(stage) { stages.push(stage); } };
}
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}
const listing = (folder: string) => existsSync(folder) ? readdirSync(folder).sort() : null;
function writeState(f: Fixture, state: Partial<UpdateState>): void {
  writeFileSync(f.stateFile, JSON.stringify({ format: 1, from: "0.1.0", to: "0.2.0", recordUpdatedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z", ...state }));
}
/** A finished pre-update backup folder under the root, as an earlier run left it. */
function finishedBackup(f: Fixture, name: string, createdAt = "2026-10-06T00:00:00.000Z"): string {
  const folder = join(f.root, name);
  mkdirSync(join(folder, "portable"), { recursive: true });
  writeFileSync(join(folder, "bara.sqlite"), "old");
  writeFileSync(join(folder, UPDATE_BACKUP_FILE), JSON.stringify({ format: 1, createdAt }));
  return folder;
}

test("same-version, fresh and remote-only starts pass without a backup or a record", async () => {
  // Same version: nothing pending.
  const same = fixture({ recorded: "0.2.0" });
  const opened = await gate(same);
  expect(await opened.gate.beforePrepare(ctx())).toBeUndefined();
  await opened.gate.started();
  expect({ calls: same.calls(), state: same.state(), status: await opened.gate.status() }).toEqual({ calls: [], state: null, status: null });

  // An update with no database yet (a remote connection, or a fresh local install after one): nothing to protect, so
  // the new version is recorded at start and the gate does nothing.
  const fresh = fixture({ database: false });
  const update = await gate(fresh);
  expect(update.maintenance.updatePending).toBe(false);
  expect(JSON.parse(fresh.maintenanceFile()).appVersion).toBe("0.2.0");
  const run = ctx();
  expect(await update.gate.beforePrepare(run)).toBeUndefined();
  await update.gate.started();
  expect({ calls: fresh.calls(), stages: run.stages, state: fresh.state() }).toEqual({ calls: [], stages: [], state: null });
  // A first run on a new PC is recorded at start and never gated.
  const first = fixture({ recorded: null, database: false });
  const firstRun = await gate(first);
  expect({ run: firstRun.maintenance.run, pending: firstRun.maintenance.updatePending }).toEqual({ run: "first-run", pending: false });
  expect(await firstRun.gate.beforePrepare(ctx())).toBeUndefined();
  expect(first.calls()).toEqual([]);
});

test("a downgrade, a version record this app does not know or one that cannot be read never opens an existing database", async () => {
  const cases: Array<{ name: string; setup: (f: Fixture) => void; deps?: MaintenanceDeps; text: string }> = [
    { name: "downgrade", setup: () => {}, text: messages.updateErrors.UPDATE_VERSION_UNSAFE("downgrade", "0.3.0", "0.2.0") },
    { name: "unreadable", setup: (f) => writeFileSync(join(f.paths.dataDir, MAINTENANCE_FILE), JSON.stringify({ format: 2, appVersion: "0.3.0" })),
      text: messages.updateErrors.UPDATE_VERSION_UNSAFE("unreadable", null, "0.2.0") },
    { name: "read-failed", setup: () => {}, deps: { fs: { readFile: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
      writeFile: async () => {}, rename: async () => {}, unlink: async () => {}, mkdir: async () => {} } },
      text: messages.updateErrors.UPDATE_VERSION_UNSAFE("read-failed", null, "0.2.0") },
  ];
  for (const { name, setup, deps, text } of cases) {
    const f = fixture({ recorded: "0.3.0" });
    setup(f);
    const before = f.maintenanceFile();
    const opened = await gate(f, "0.2.0", { deps });
    expect(opened.maintenance.run).toBe(name as never);
    expect(await rejection(opened.gate.beforePrepare(ctx()))).toMatchObject({ code: "UPDATE_VERSION_UNSAFE", publicMessage: text });
    expect({ calls: f.calls(), state: f.state(), backups: listing(f.root), record: f.maintenanceFile() })
      .toEqual({ calls: [], state: null, backups: null, record: before });
    // Without a database there is nothing a newer app could own: a new install may go on.
    rmSync(f.db); rmSync(`${f.db}-wal`);
    await opened.gate.beforePrepare(ctx());
  }
  expect(messages.updateErrors.UPDATE_VERSION_UNSAFE("downgrade", "0.3.0", "0.2.0")).toContain("0.3.0 이상을 설치");
  expect(messages.updateErrors.UPDATE_VERSION_UNSAFE("unreadable", null, "0.2.0")).toContain("모르는 형식");
  expect(messages.updateErrors.UPDATE_VERSION_UNSAFE("read-failed", null, "0.2.0")).toContain("잠시 뒤 다시 시도");
});

test("a corrupt version record (zero-filled, cut off, not an object) counts as none: the database is backed up first", async () => {
  for (const corrupt of [Buffer.alloc(300), "{\"format\": 1, \"installa", "", "[]"]) {
    const f = fixture();
    writeFileSync(join(f.paths.dataDir, MAINTENANCE_FILE), corrupt);
    const { maintenance, gate: updates } = await gate(f);
    expect({ run: maintenance.run, pending: maintenance.updatePending }).toEqual({ run: "first-run", pending: true });
    const run = ctx();
    await updates.beforePrepare(run);
    expect(run.stages).toEqual(["update-backup", "prepare"]);
    expect(listing(f.root)).toEqual(["unknown-to-0.2.0-20261007-090503"]);
    // Until the server started on it the corrupt file stays; then a good record replaces it.
    expect(readFileSync(join(f.paths.dataDir, MAINTENANCE_FILE))).toEqual(Buffer.from(corrupt));
    await updates.started();
    expect(JSON.parse(f.maintenanceFile())).toMatchObject({ format: 1, appVersion: "0.2.0" });
    expect((await gate(f)).maintenance.run).toBe("same-version");
  }
});

test("a record that could not be read is read again by the next attempt, which then goes on without a restart", async () => {
  const f = fixture();
  let locked = true;
  const file = join(f.paths.dataDir, MAINTENANCE_FILE);
  const fs: MaintenanceDeps["fs"] = {
    readFile: async (path) => {
      if (locked && path === file) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return readFileSync(path, "utf8");
    },
    writeFile: async (path, data) => writeFileSync(path, data, { flag: "wx" }),
    rename: async (from, to) => { renameSync(from, to); }, unlink: async (path) => rmSync(path, { force: true }), mkdir: async () => {},
  };
  const { maintenance, gate: updates } = await gate(f, "0.2.0", { deps: { fs } });
  expect(maintenance.run).toBe("read-failed");
  expect(await rejection(updates.beforePrepare(ctx()))).toMatchObject({ code: "UPDATE_VERSION_UNSAFE",
    publicMessage: messages.updateErrors.UPDATE_VERSION_UNSAFE("read-failed", null, "0.2.0") });
  expect(f.calls()).toEqual([]);
  // The lock is gone: the same run reads the record, sees an update and backs up before the database is opened.
  locked = false;
  await updates.beforePrepare(ctx());
  expect({ run: maintenance.run, recorded: maintenance.recordedVersion, status: maintenance.status.run }).toEqual({ run: "update", recorded: "0.1.0", status: "update" });
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
  expect(f.state()).toMatchObject({ stage: "migrating", from: "0.1.0", recordUpdatedAt: "2026-10-01T00:00:00.000Z" });
  await updates.started();
  expect(JSON.parse(f.maintenanceFile())).toMatchObject({ appVersion: "0.2.0", installationId: "installation-1" });

  // A record read again that turns out newer still stops, with that text.
  const g = fixture({ recorded: "0.3.0" });
  let gLocked = true;
  const gFile = join(g.paths.dataDir, MAINTENANCE_FILE);
  const newer = await gate(g, "0.2.0", { deps: { fs: { ...fs, readFile: async (path) => {
    if (gLocked && path === gFile) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return readFileSync(path, "utf8");
  } } } });
  gLocked = false;
  expect(await rejection(newer.gate.beforePrepare(ctx()))).toMatchObject({ code: "UPDATE_VERSION_UNSAFE",
    publicMessage: messages.updateErrors.UPDATE_VERSION_UNSAFE("downgrade", "0.3.0", "0.2.0") });
  expect(g.calls()).toEqual([]);
});

test("an update backs up first: snapshot, export, read-back check and a folder record, then migrating, then complete", async () => {
  const f = fixture();
  const recordBefore = f.maintenanceFile();
  const { maintenance, gate: updates } = await gate(f);
  const run = ctx();
  await updates.beforePrepare(run);
  expect(run.stages).toEqual(["update-backup", "prepare"]);
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
  const folder = join(f.root, FOLDER);
  expect(listing(f.root)).toEqual([FOLDER]);
  expect(listing(folder)).toEqual(["bara.sqlite", "portable", UPDATE_BACKUP_FILE]);
  expect(readFileSync(join(folder, "bara.sqlite"))).toEqual(readFileSync(f.db));
  expect(JSON.parse(readFileSync(join(folder, UPDATE_BACKUP_FILE), "utf8"))).toEqual({ format: 1, from: "0.1.0", to: "0.2.0",
    createdAt: NOW.toISOString(), dbSnapshot: { file: "bara.sqlite", bytes: 1_000, schemaVersion: 47 },
    portable: { folder: "portable", fingerprint: "f".repeat(64) }, counts: { memories: 3, attachments: 1 } });
  expect(f.state()).toMatchObject({ stage: "migrating", from: "0.1.0", to: "0.2.0", backupPath: folder, recordUpdatedAt: "2026-10-01T00:00:00.000Z" });
  // The old version stays recorded until the server started on the updated data.
  expect(f.maintenanceFile()).toBe(recordBefore);
  expect(await updates.status()).toEqual({ stage: "migrating", from: "0.1.0", to: "0.2.0", backupPath: folder, failedStage: null, errorCode: null });

  await updates.started();
  expect(f.state()).toMatchObject({ stage: "complete", backupPath: folder });
  expect(f.state()).not.toHaveProperty("errorCode");
  expect(JSON.parse(f.maintenanceFile())).toMatchObject({ appVersion: "0.2.0", installationId: "installation-1" });
  expect(maintenance.updatePending).toBe(false);
  // A later prepare in this process (a server restart) and the next start (same version) back up nothing again.
  await updates.beforePrepare(ctx());
  const next = await gate(f);
  expect(next.maintenance.run).toBe("same-version");
  await next.gate.beforePrepare(ctx());
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
  expect((await next.gate.status())?.stage).toBe("complete");
});

test("a first run over a database an older app left is backed up as from 'unknown'", async () => {
  const f = fixture({ recorded: null });
  const { maintenance, gate: updates } = await gate(f);
  expect({ run: maintenance.run, pending: maintenance.updatePending }).toEqual({ run: "first-run", pending: true });
  await updates.beforePrepare(ctx());
  expect(listing(f.root)).toEqual(["unknown-to-0.2.0-20261007-090503"]);
  expect(f.state()).toMatchObject({ stage: "migrating", from: "unknown", recordUpdatedAt: null });
  expect(existsSync(join(f.paths.dataDir, MAINTENANCE_FILE))).toBe(false);
  await updates.started();
  expect(JSON.parse(f.maintenanceFile())).toMatchObject({ appVersion: "0.2.0" });
});

test.skipIf(!realScripts)("a low drive counts the snapshot once plus the portable archive and stops one byte below the required space", async () => {
  const f = realFixture();
  const database = await fileSize(f.db) + await fileSize(`${f.db}-wal`);
  const needed = await storeBytes({ db: f.db, assets: join(f.memoryData, "assets") }) + database + BACKUP_MARGIN_BYTES;
  // One byte short (the texts round to 0.1GB, so the shortfall is checked by the refusal itself).
  const free = needed - 1;
  const asked: string[] = [];
  const { gate: updates } = await gate(f, "0.2.0", { freeSpace: async (path) => { asked.push(path); return free; } });
  const error = await rejection(updates.beforePrepare(ctx()));
  expect(error).toMatchObject({ code: "UPDATE_BACKUP_DISK_LOW", publicMessage: messages.updateErrors.UPDATE_BACKUP_DISK_LOW(needed - free, free) });
  expect(asked).toEqual([f.root]);
  expect({ calls: f.calls(), backups: listing(f.root) }).toEqual({ calls: [], backups: null });
  expect(f.state()).toMatchObject({ stage: "failed", failedStage: "backup", errorCode: "UPDATE_BACKUP_DISK_LOW" });
  expect(f.state()).not.toHaveProperty("backupPath");
  expect(messages.updateErrors.UPDATE_BACKUP_DISK_LOW(1_234_567_890, 987_654_321))
    .toBe("업데이트 전 백업에 필요한 공간이 부족해 바라 기억 서버를 시작하지 않았어요. 기억은 바뀌지 않았어요. 약 1.3GB를 비운 뒤 다시 시도해 주세요(지금 여유 0.9GB).");
  // Exactly enough, or a drive that cannot be read, goes ahead.
  expect(await (await gate(f, "0.2.0", { freeSpace: async () => needed })).gate.beforePrepare(ctx()))
    .toBe(join(f.root, FOLDER, "bara.sqlite"));
  expect(f.state()?.stage).toBe("migrating");
}, 120_000);

test("a failed backup step removes this run's folder, says nothing changed and is retried by the next request", async () => {
  for (const [mode, cause] of [
    [{ snapshot: "fail" }, "db-snapshot: Snapshot integrity check failed"],
    [{ export: "fail" }, "portable-memory: Unsupported source schema version"],
    [{ verify: "mismatch" }, messages.updateBackup.verifyMismatch],
  ] as const) {
    const f = fixture();
    f.mode(mode);
    const { maintenance, gate: updates } = await gate(f);
    const error = await rejection(updates.beforePrepare(ctx()));
    expect(error).toMatchObject({ code: "UPDATE_BACKUP_FAILED", publicMessage: messages.updateErrors.UPDATE_BACKUP_FAILED(cause) });
    expect(listing(f.root)).toEqual([]);
    expect(f.state()).toMatchObject({ stage: "failed", failedStage: "backup", errorCode: "UPDATE_BACKUP_FAILED" });
    expect(f.state()).not.toHaveProperty("backupPath");
    expect(await updates.status()).toMatchObject({ stage: "failed", backupPath: null, errorCode: "UPDATE_BACKUP_FAILED" });
    expect(maintenance.updatePending).toBe(true);
    // The failure is not kept: once the step works the next request backs up and goes on.
    f.mode({});
    await updates.beforePrepare(ctx());
    expect(listing(f.root)).toEqual([FOLDER]);
    expect(f.state()?.stage).toBe("migrating");
  }
  expect(messages.updateErrors.UPDATE_BACKUP_FAILED("원인"))
    .toBe("업데이트 전 백업을 만들지 못해 바라 기억 서버를 시작하지 않았어요(원인). 기억은 바뀌지 않았어요. 다시 시도해 주세요.");
});

test("settings that point the database elsewhere stop the backup before any script runs", async () => {
  const f = fixture();
  writeFileSync(join(f.memoryData, "config", "memory-settings.json"), JSON.stringify(
    { db: { path: join(f.memoryData, "db", "other.sqlite") }, assets: { dir: join(f.memoryData, "assets") } }));
  const { gate: updates } = await gate(f);
  expect(await rejection(updates.beforePrepare(ctx()))).toMatchObject({ code: "UPDATE_BACKUP_FAILED" });
  expect({ calls: f.calls(), backups: listing(f.root) }).toEqual({ calls: [], backups: null });
});

test("a failure after the backup becomes UPDATE_START_FAILED naming the backup, keeping the original as its cause", async () => {
  const f = fixture();
  const { maintenance, gate: updates } = await gate(f);
  await updates.beforePrepare(ctx());
  const folder = join(f.root, FOLDER);
  const original = Object.assign(serviceError("INSTALL_COMMAND_FAILED", messages.installService.stepFailed(messages.installSteps.prepareMemoryData, 1)),
    { stderr: "Managed memory preparation failed; inspect the data root and port\n임베딩 차원 불일치: DB 는 384 차원\n" });
  const error = await updates.failed(original);
  expect(error).toMatchObject({ code: "UPDATE_START_FAILED", cause: original,
    publicMessage: messages.updateErrors.UPDATE_START_FAILED("임베딩 차원 불일치: DB 는 384 차원", folder) });
  expect((error as { publicMessage: string }).publicMessage).toContain(`이 폴더에 백업해 두었어요: ${folder}`);
  expect(f.state()).toMatchObject({ stage: "failed", failedStage: "migrating", errorCode: "INSTALL_COMMAND_FAILED", backupPath: folder });
  expect(maintenance.updatePending).toBe(true);
  // A plain service error is named by its own text.
  await updates.beforePrepare(ctx());
  const taken = serviceError("INSTALL_PORT_TAKEN", messages.installService.localPortTaken(41031, [7]));
  expect(await updates.failed(taken)).toMatchObject({ code: "UPDATE_START_FAILED",
    publicMessage: messages.updateErrors.UPDATE_START_FAILED(messages.installService.localPortTaken(41031, [7]).replace(/\.$/, ""), folder) });
  // The gate's own errors and errors of a start that never passed a backup are left as they are.
  const own = serviceError("UPDATE_BACKUP_FAILED", "x");
  await updates.beforePrepare(ctx());
  expect(await updates.failed(own)).toBe(own);
  const other = await gate(fixture({ recorded: "0.2.0" }));
  expect(await other.gate.failed(taken)).toBe(taken);
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
});

test("resuming: a start cut off while backing up removes that run's unfinished folder and backs up again", async () => {
  const f = fixture();
  const leftover = join(f.root, "0.1.0-to-0.2.0-20261006-120000");
  mkdirSync(join(leftover, "portable"), { recursive: true });
  writeFileSync(join(leftover, "bara.sqlite"), "half");
  writeState(f, { stage: "backup", backupPath: leftover });
  const { gate: updates } = await gate(f);
  expect(await updates.status()).toMatchObject({ stage: "backup", backupPath: null });
  await updates.beforePrepare(ctx());
  expect(listing(f.root)).toEqual([FOLDER]);
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
});

test("resuming: after backed-up the finished backup is reused; if it is gone the database was not opened, so it is made again", async () => {
  const f = fixture();
  const kept = finishedBackup(f, "0.1.0-to-0.2.0-20261006-120000");
  writeState(f, { stage: "backed-up", backupPath: kept });
  const first = await gate(f);
  await first.gate.beforePrepare(ctx());
  expect(f.calls()).toEqual([]);
  expect(f.state()).toMatchObject({ stage: "migrating", backupPath: kept });

  writeState(f, { stage: "backed-up", backupPath: join(f.root, "0.1.0-to-0.2.0-20261006-130000") });
  const second = await gate(f);
  await second.gate.beforePrepare(ctx());
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
  expect(f.state()).toMatchObject({ stage: "migrating", backupPath: join(f.root, FOLDER) });
});

test("resuming: after migrating or a failed start no second pre-update backup is made; the first is reported", async () => {
  for (const stage of [{ stage: "migrating" }, { stage: "failed", failedStage: "migrating", errorCode: "INSTALL_PORT_TAKEN" }] as const) {
    const f = fixture();
    const kept = finishedBackup(f, "0.1.0-to-0.2.0-20261006-120000");
    writeState(f, { ...stage, backupPath: kept });
    const { maintenance, gate: updates } = await gate(f);
    expect(await updates.status()).toMatchObject({ ...stage, backupPath: kept });
    const run = ctx();
    await updates.beforePrepare(run);
    // Nothing is backed up, so the screen is not told so.
    expect(run.stages).toEqual(["prepare"]);
    expect(f.calls()).toEqual([]);
    expect(f.state()).toMatchObject({ stage: "migrating", backupPath: kept });
    expect(f.state()).not.toHaveProperty("errorCode");
    // It fails again: the same backup is named.
    expect(await updates.failed(serviceError("INSTALL_SERVER_EXITED", messages.installService.localServerExited)))
      .toMatchObject({ code: "UPDATE_START_FAILED", publicMessage: expect.stringContaining(kept) });
    await updates.beforePrepare(ctx());
    await updates.started();
    expect(f.state()).toMatchObject({ stage: "complete", backupPath: kept });
    expect(maintenance.updatePending).toBe(false);
    expect(JSON.parse(f.maintenanceFile()).appVersion).toBe("0.2.0");
    expect(f.calls()).toEqual([]);
  }
  // Even when that backup folder has since been removed: the database may already be migrated.
  const f = fixture();
  writeState(f, { stage: "migrating", backupPath: join(f.root, "0.1.0-to-0.2.0-20261006-120000") });
  await (await gate(f)).gate.beforePrepare(ctx());
  expect(f.calls()).toEqual([]);
});

test("resuming: a completed update whose version was not recorded only records it", async () => {
  const f = fixture();
  writeState(f, { stage: "complete", backupPath: finishedBackup(f, "0.1.0-to-0.2.0-20261006-120000") });
  const { maintenance, gate: updates } = await gate(f);
  expect(maintenance.run).toBe("update");
  const run = ctx();
  await updates.beforePrepare(run);
  expect({ calls: f.calls(), pending: maintenance.updatePending, version: JSON.parse(f.maintenanceFile()).appVersion })
    .toEqual({ calls: [], pending: false, version: "0.2.0" });
  expect(f.state()?.stage).toBe("complete");
});

test("resuming: a record of data another app ran on since, or of another starting version, is not resumed but backed up anew", async () => {
  for (const state of [{ from: "unknown" }, { recordUpdatedAt: "2026-10-05T00:00:00.000Z" }]) {
    const f = fixture();
    const kept = finishedBackup(f, "0.1.0-to-0.1.5-20261006-120000");
    writeState(f, { stage: "migrating", backupPath: kept, ...state });
    await (await gate(f)).gate.beforePrepare(ctx());
    expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
    // The earlier backup is a finished one: it is kept.
    expect(listing(f.root)).toEqual([FOLDER, "0.1.0-to-0.1.5-20261006-120000"].sort());
  }
  // An update that stopped before its database was opened, to another version, has nothing half-done: backed up anew.
  const f = fixture();
  writeState(f, { stage: "backed-up", to: "0.1.5", backupPath: finishedBackup(f, "0.1.0-to-0.1.5-20261006-120000") });
  await (await gate(f)).gate.beforePrepare(ctx());
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
});

test("resuming: a fix release installed over an update that failed after its backup reuses that backup, never a new one", async () => {
  for (const stage of [{ stage: "migrating" }, { stage: "failed", failedStage: "migrating", errorCode: "INSTALL_COMMAND_FAILED" }] as const) {
    // 0.1.0 -> 0.2.0 failed while preparing (the database may be migrated); 0.2.1 is installed over it.
    const f = fixture();
    const kept = finishedBackup(f, "0.1.0-to-0.2.0-20261006-120000");
    writeState(f, { ...stage, to: "0.2.0", backupPath: kept });
    const { maintenance, gate: updates } = await gate(f, "0.2.1");
    const run = ctx();
    await updates.beforePrepare(run);
    expect(run.stages).toEqual(["prepare"]);
    expect({ calls: f.calls(), backups: listing(f.root) }).toEqual({ calls: [], backups: ["0.1.0-to-0.2.0-20261006-120000"] });
    // The record now names the version that carries the update on, still with the backup from before it.
    expect(f.state()).toMatchObject({ stage: "migrating", from: "0.1.0", to: "0.2.1", backupPath: kept, recordUpdatedAt: "2026-10-01T00:00:00.000Z" });
    expect(f.state()).not.toHaveProperty("errorCode");
    expect(await updates.failed(serviceError("INSTALL_SERVER_EXITED", messages.installService.localServerExited)))
      .toMatchObject({ code: "UPDATE_START_FAILED", publicMessage: expect.stringContaining(kept) });
    await updates.beforePrepare(ctx());
    await updates.started();
    expect(f.state()).toMatchObject({ stage: "complete", to: "0.2.1", backupPath: kept });
    expect(JSON.parse(f.maintenanceFile()).appVersion).toBe("0.2.1");
    expect(maintenance.updatePending).toBe(false);
    expect(f.calls()).toEqual([]);
  }
});

test("pruning never removes the backup the update record names, however old", async () => {
  const f = fixture();
  // The record names the oldest finished backup; another app ran since, so this update backs up anew.
  const named = finishedBackup(f, "0.0.9-to-0.1.0-20260901-000000", "2026-09-01T00:00:00.000Z");
  finishedBackup(f, "0.0.8-to-0.0.9-20260801-000000", "2026-08-01T00:00:00.000Z");
  finishedBackup(f, "0.1.0-to-0.1.5-20260920-000000", "2026-09-20T00:00:00.000Z");
  writeState(f, { stage: "failed", failedStage: "migrating", from: "0.0.9", to: "0.1.0", backupPath: named });
  await (await gate(f)).gate.beforePrepare(ctx());
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
  expect(listing(f.root)).toEqual(["0.0.9-to-0.1.0-20260901-000000", "0.1.0-to-0.1.5-20260920-000000", FOLDER].sort());
});

test("an update whose version was recorded but whose 'complete' was not saved is not reported as unfinished", async () => {
  // The app ended between recording 0.2.0 and saving `complete`: the next start is the same version.
  for (const state of [{ stage: "migrating" }, { stage: "failed", failedStage: "migrating", errorCode: "INSTALL_PORT_TAKEN" },
    { stage: "failed", failedStage: "backup", errorCode: "UPDATE_BACKUP_FAILED" }] as const) {
    const f = fixture({ recorded: "0.2.0" });
    writeState(f, { ...state, backupPath: finishedBackup(f, "0.1.0-to-0.2.0-20261006-120000") });
    const opened = await gate(f);
    expect(await opened.gate.status()).toBeNull();
    await opened.gate.beforePrepare(ctx());
    expect(f.calls()).toEqual([]);
  }
  // A record of an update to another version than the recorded one is still reported.
  const f = fixture({ recorded: "0.2.0" });
  writeState(f, { stage: "failed", failedStage: "backup", errorCode: "UPDATE_BACKUP_FAILED", from: "0.2.0", to: "0.3.0" });
  expect(await (await gate(f)).gate.status()).toMatchObject({ stage: "failed", to: "0.3.0" });
});

test("a folder that appears under the chosen name before the backup makes it is not this run's: the run fails and leaves it", async () => {
  const f = fixture();
  let readings = 0;
  // The clock is read to name the folder, then for the record that names it; the folder appears in between.
  const now = () => {
    if (++readings === 2) { mkdirSync(join(f.root, FOLDER)); writeFileSync(join(f.root, FOLDER, "theirs"), "keep"); }
    return NOW;
  };
  const { gate: updates } = await gate(f, "0.2.0", { now });
  expect(await rejection(updates.beforePrepare(ctx()))).toMatchObject({ code: "UPDATE_BACKUP_FAILED" });
  expect(readFileSync(join(f.root, FOLDER, "theirs"), "utf8")).toBe("keep");
  expect(f.calls()).toEqual([]);
  expect(f.state()).toMatchObject({ stage: "failed", failedStage: "backup" });
  expect(f.state()).not.toHaveProperty("backupPath");
});

test("a failed backup whose folder cannot be removed keeps it in the record, and the next run removes it", async () => {
  const f = fixture();
  f.mode({ export: "fail" });
  const held = async () => { throw Object.assign(new Error("in use"), { code: "EBUSY" }); };
  const { gate: updates } = await gate(f, "0.2.0", { remove: held });
  expect(await rejection(updates.beforePrepare(ctx()))).toMatchObject({ code: "UPDATE_BACKUP_FAILED" });
  const left = join(f.root, FOLDER);
  expect(listing(left)).toEqual(["bara.sqlite"]);
  expect(f.state()).toMatchObject({ stage: "failed", failedStage: "backup", backupPath: left });
  // It is no backup: the screen hears that the backup failed, with no folder.
  expect(await updates.status()).toMatchObject({ stage: "failed", failedStage: "backup", backupPath: null });
  f.mode({});
  await (await gate(f)).gate.beforePrepare(ctx());
  // Removed first, so the new backup takes the same name.
  expect(listing(f.root)).toEqual([FOLDER]);
  expect(listing(left)).toEqual(["bara.sqlite", "portable", UPDATE_BACKUP_FILE]);
  expect(f.state()).toMatchObject({ stage: "migrating", backupPath: left });
});

test("the gate is busy while its backup runs and until a start that passed with an update has ended", async () => {
  const f = fixture();
  const { gate: updates } = await gate(f);
  expect(updates.busy).toBe(false);
  const passing = updates.beforePrepare(ctx());
  expect(updates.busy).toBe(true);
  await passing;
  // `managed-prepare` may now be migrating.
  expect(updates.busy).toBe(true);
  await updates.started();
  expect(updates.busy).toBe(false);
  for (const end of [(g: UpdateGate) => g.failed(new Error("x")), async (g: UpdateGate) => g.cancelled()]) {
    const opened = await gate(fixture());
    await opened.gate.beforePrepare(ctx());
    expect(opened.gate.busy).toBe(true);
    await end(opened.gate);
    expect(opened.gate.busy).toBe(false);
  }
  // A start with no update never is.
  const same = await gate(fixture({ recorded: "0.2.0" }));
  await same.gate.beforePrepare(ctx());
  expect(same.gate.busy).toBe(false);
});

test("only the newest finished pre-update backups are kept; unfinished, foreign and linked entries are never touched", async () => {
  const f = fixture();
  const outside = scratch("outside");
  writeFileSync(join(outside, "precious"), "keep");
  finishedBackup(f, "0.0.7-to-0.0.8-20260901-000000", "2026-09-01T00:00:00.000Z");
  finishedBackup(f, "0.0.8-to-0.1.0-20260915-000000", "2026-09-15T00:00:00.000Z");
  finishedBackup(f, "0.0.9-to-0.1.0-20260920-000000", "2026-09-20T00:00:00.000Z");
  mkdirSync(join(f.root, "0.0.6-to-0.0.7-20260801-000000"));
  mkdirSync(join(f.root, "my-notes"));
  writeFileSync(join(f.root, "my-notes", UPDATE_BACKUP_FILE), JSON.stringify({ format: 1, createdAt: "2020-01-01T00:00:00.000Z" }));
  symlinkSync(outside, join(f.root, "0.0.5-to-0.0.6-20260701-000000"), process.platform === "win32" ? "junction" : "dir");
  await (await gate(f)).gate.beforePrepare(ctx());
  expect(listing(f.root)).toEqual(["0.0.5-to-0.0.6-20260701-000000", "0.0.6-to-0.0.7-20260801-000000", "0.0.9-to-0.1.0-20260920-000000",
    FOLDER, "my-notes"].sort());
  expect(PRE_UPDATE_KEEP).toBe(2);
  expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
});

test("concurrent starts share one backup; a request that stops waiting leaves it running, and closing stops it", async () => {
  const f = fixture();
  const { gate: updates } = await gate(f);
  const [a, b] = [ctx(), ctx()];
  await Promise.all([updates.beforePrepare(a), updates.beforePrepare(b)]);
  expect(f.calls()).toEqual(["snapshot", "export", "verify"]);
  expect([a.stages, b.stages]).toEqual([["update-backup", "prepare"], ["update-backup", "prepare"]]);

  // A slow snapshot: the first request is cancelled (or hits its time limit) while it runs, the second joins it.
  const g = fixture();
  g.mode({ snapshot: "hang" });
  const slow = await gate(g);
  const cancelled = new AbortController();
  const waiting = rejection(slow.gate.beforePrepare(ctx(cancelled.signal)));
  for (let i = 0; i < 200 && !g.calls().includes("snapshot"); i++) await Bun.sleep(25);
  cancelled.abort();
  expect(await waiting).toMatchObject({ name: "AbortError" });
  const joined = rejection(slow.gate.beforePrepare(ctx()));
  expect(g.calls()).toEqual(["snapshot"]);
  expect(listing(g.root)).toEqual([FOLDER]);
  // Quitting aborts the backup and removes its partial folder; the record still says it was cut off while backing up.
  await slow.gate.close();
  expect(await joined).toMatchObject({ name: "AbortError" });
  expect(listing(g.root)).toEqual([]);
  expect(g.state()).toMatchObject({ stage: "backup", backupPath: join(g.root, FOLDER) });
  expect(g.calls()).toEqual(["snapshot"]);
}, 30_000);

test("the record is read leniently and the texts stay within the host's message limit", () => {
  const base = { format: 1, from: "0.1.0", to: "0.2.0", stage: "migrating", recordUpdatedAt: null, updatedAt: "2026-10-06T00:00:00.000Z" };
  expect(parseUpdateState(base)).toEqual(base as UpdateState);
  for (const bad of [null, [], { ...base, format: 2 }, { ...base, stage: "done" }, { ...base, failedStage: "server" }, { ...base, backupPath: 3 },
    { ...base, recordUpdatedAt: 5 }, { ...base, updatedAt: "later" }, { ...base, from: null }])
    expect(parseUpdateState(bad)).toBeNull();
  const path = resolve("C:/Users/사용자/AppData/Local/com.bara.pet/memory/backups/pre-update", FOLDER);
  const text = fitted((cause) => messages.updateErrors.UPDATE_START_FAILED(cause, path), "가".repeat(300));
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_000);
  expect(text).toContain(path);
  expect(text).toContain("…");
  const short = fitted(messages.updateErrors.UPDATE_BACKUP_FAILED, "짧은 원인");
  expect(short).toBe(messages.updateErrors.UPDATE_BACKUP_FAILED("짧은 원인"));
  expect(fitted(messages.updateErrors.UPDATE_BACKUP_FAILED, undefined)).toBe(messages.updateErrors.UPDATE_BACKUP_FAILED(undefined));
});

function realFixture(): Fixture {
  const f = fixture();
  rmSync(join(f.paths.resourceDir, "core"), { recursive: true });
  mkdirSync(join(f.paths.resourceDir, "core", "apps"), { recursive: true });
  symlinkSync(memoryApp, join(f.paths.resourceDir, "core", "apps", "memory"), process.platform === "win32" ? "junction" : "dir");
  rmSync(f.db); rmSync(`${f.db}-wal`);
  rmSync(join(f.memoryData, "assets"), { recursive: true });
  mkdirSync(join(f.memoryData, "assets", "content"), { recursive: true });
  const create = join(f.dir, "create-db.ts");
  writeFileSync(create, `import { openMemoryDatabase } from ${JSON.stringify(join(memoryApp, "src", "db", "migrations.ts"))};
const db = openMemoryDatabase(process.argv[2]);
db.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('업데이트 전 기억 하나', '{}')");
db.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('업데이트 전 기억 둘', '{}')");
db.close();`);
  const made = Bun.spawnSync([process.execPath, create, f.db], { cwd: memoryApp, stderr: "pipe" });
  expect({ exit: made.exitCode, stderr: made.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
  return f;
}

test.skipIf(!realScripts)("the real snapshot, export and check back up a live database before an update", async () => {
  const f = realFixture();
  const { gate: updates } = await gate(f);
  const folder = join(f.root, FOLDER);
  const snapshot = join(folder, "bara.sqlite");
  expect(await updates.beforePrepare(ctx())).toBe(snapshot);
  const record = JSON.parse(readFileSync(join(folder, UPDATE_BACKUP_FILE), "utf8"));
  // The snapshot is of a database the memory app just created, so its version is the memory app's current one.
  const { CURRENT_SCHEMA_VERSION } = await import(pathToFileURL(join(memoryApp, "src", "db", "migrations.ts")).href) as { CURRENT_SCHEMA_VERSION: number };
  expect(record).toMatchObject({ from: "0.1.0", to: "0.2.0", dbSnapshot: { file: "bara.sqlite", schemaVersion: CURRENT_SCHEMA_VERSION }, counts: { memories: 2, attachments: 0 } });
  expect(record.portable.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(listing(folder)).toEqual(["bara.sqlite", "portable", UPDATE_BACKUP_FILE]);
  expect(listing(join(folder, "portable"))).toContain("manifest.json");
  expect(f.state()).toMatchObject({ stage: "migrating", backupPath: folder });
  expect(dirname(folder)).toBe(f.root);

  await updates.failed(serviceError("INSTALL_SERVER_EXITED", messages.installService.localServerExited));
  expect(await updates.beforePrepare(ctx())).toBe(snapshot);
  expect(listing(f.root)).toEqual([FOLDER]);
  // A valid older state can name its own finished folder relatively; setup still needs an absolute CLI path.
  const previousCwd = process.cwd();
  try {
    process.chdir(f.dir); // The Windows temp directory can be on a different drive from the repository.
    writeState(f, { stage: "backed-up", backupPath: relative(process.cwd(), folder) });
    const relativeState = await gate(f);
    expect(await relativeState.gate.beforePrepare(ctx())).toBe(snapshot);
    // A missing old backup is still the candidate: setup must validate it, never replace it with migrated data.
    rmSync(folder, { recursive: true, force: true });
    const resumed = await gate(f);
    expect(await resumed.gate.beforePrepare(ctx())).toBe(snapshot);
    expect(listing(f.root)).toEqual([]);

    await resumed.gate.started();
    expect(await resumed.gate.beforePrepare(ctx())).toBeUndefined();
    expect(await (await gate(f)).gate.beforePrepare(ctx())).toBeUndefined();
  } finally { process.chdir(previousCwd); }
}, 120_000);

test.skipIf(!realScripts)("an update whose database disappears supplies no pre-update snapshot", async () => {
  const f = realFixture();
  const { gate: updates, maintenance } = await gate(f);
  expect(maintenance.updatePending).toBe(true);
  rmSync(f.db);
  expect(await updates.beforePrepare(ctx())).toBeUndefined();
  expect(f.state()).toBeNull();
  expect(listing(f.root)).toBeNull();
}, 120_000);
