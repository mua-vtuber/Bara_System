import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RequestContext, RuntimePaths } from "../shared/contracts.ts";
import { DpapiVault } from "../../tests/e2e/dpapi-vault.ts";
import { messages } from "../ui/messages.ts";
import { BACKUP_MARGIN_BYTES, BackupService, backupFolderName, freshDestination, managedSources, removeStaging, removeUnpublished } from "./backup.ts";
import { ConfigStore } from "./config.ts";
import type { FreeSpace } from "./install/disk-space.ts";

// `backup.export` runs the core's exporter as a real process. These tests give it a test-only stand-in at the path
// the packaged core has (`<resources>/core/apps/memory/scripts/portable-memory.ts`), run by this Bun, that keeps
// the exporter's contract (a new `--out` folder, its manifest as the last stdout line, errors on stderr, nonzero
// exit on failure) only as far as each test needs. The last test runs the real exporter on a real database.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pet-backup-${name}-`));
  roots.push(root);
  return root;
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

const ctx = (signal = new AbortController().signal): RequestContext => ({ signal, progress() {} });
const NOW = new Date(2026, 9, 7, 9, 5, 3);
const MANIFEST = { format: "bara-memory", version: 1,
  collections: { memories: { file: "collections/memories.json", count: 3, sha256: "" }, archivedMemories: { file: "collections/archivedMemories.json", count: 9, sha256: "" } },
  attachments: [{ sha256: "a", extension: "png", byteSize: 1, file: "attachments/content/a.png" }, { sha256: "b", extension: "pdf", byteSize: 1, file: "attachments/content/b.pdf" }] };

/** The stand-in's shared start: its arguments, recorded in `<resources>/exporter-args.json`, and the `--out` folder. */
const STUB_HEAD = `
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
writeFileSync(join(process.cwd(), "..", "..", "..", "exporter-args.json"), JSON.stringify({ cwd: process.cwd(), args }));
const staging = join(dirname(out), "." + basename(out) + ".export-Ab12Cd");
`;
const SUCCEEDS = `${STUB_HEAD}
mkdirSync(out);
writeFileSync(join(out, "manifest.json"), ${JSON.stringify(JSON.stringify(MANIFEST))});
console.error("checking archive");
process.stdout.write(${JSON.stringify(JSON.stringify(MANIFEST))} + "\\n");
`;
const FAILS = `${STUB_HEAD}
mkdirSync(staging); writeFileSync(join(staging, "half.json"), "{");
console.error("reading collections");
console.error("portable-memory: Source asset hash/size mismatch");
process.exit(1);
`;
const HANGS = `${STUB_HEAD}
mkdirSync(staging); writeFileSync(join(staging, "half.json"), "{");
await Bun.sleep(60_000);
`;
/** Exits 0 with a published folder but a last stdout line that is not the manifest. */
const PRINTS_NOISE = `${STUB_HEAD}
mkdirSync(out);
writeFileSync(join(out, "manifest.json"), ${JSON.stringify(JSON.stringify(MANIFEST))});
process.stdout.write("done\\n");
`;

interface Fixture { dir: string; paths: RuntimePaths; memoryData: string; db: string; backupDir: string; config: ConfigStore }

/** A Pet data folder holding a finished local install (`managed-install.json`, the core's settings, a database with
 * its write-ahead log and attachments), a fake core holding `exporter`, and a backup folder that does not exist yet. */
function fixture(exporter: string | null, options: { backupDir?: boolean; settings?: unknown } = {}): Fixture {
  const dir = scratch("fixture");
  const dataDir = join(dir, "data"), resourceDir = join(dir, "resources"), backupDir = join(dir, "Documents", "Bara 백업");
  const memoryData = join(dataDir, "memory");
  const db = join(memoryData, "db", "bara.sqlite");
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(db, Buffer.alloc(1_000));
  writeFileSync(`${db}-wal`, Buffer.alloc(500));
  mkdirSync(join(memoryData, "assets", "content"), { recursive: true });
  writeFileSync(join(memoryData, "assets", "content", "a.png"), Buffer.alloc(200));
  writeFileSync(join(memoryData, "assets", "bara-asset-pairing.json"), Buffer.alloc(50));
  mkdirSync(join(memoryData, "config"), { recursive: true });
  writeFileSync(join(memoryData, "config", "memory-settings.json"), JSON.stringify(options.settings ??
    { db: { path: db, host: "127.0.0.1", port: 41031 }, assets: { dir: join(memoryData, "assets") }, backup: { dir: join(memoryData, "backups") } }));
  writeFileSync(join(memoryData, "managed-install.json"), JSON.stringify({ version: 1, phase: "complete", port: 41031 }));
  if (exporter !== null) {
    const script = join(resourceDir, "core", "apps", "memory", "scripts", "portable-memory.ts");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, exporter);
  }
  const paths: RuntimePaths = { dataDir, resourceDir, bunPath: process.execPath, ...(options.backupDir === false ? {} : { backupDir }) };
  return { dir, paths, memoryData, db, backupDir, config: new ConfigStore(paths, new DpapiVault()) };
}

const enough: FreeSpace = async () => 1_000 * 1_000_000_000;
const service = (f: Fixture, freeSpace: FreeSpace = enough, updating?: () => boolean) =>
  new BackupService(f.config, f.paths, { freeSpace, now: () => NOW, updating });
const listing = (folder: string) => existsSync(folder) ? readdirSync(folder).sort() : null;

test("a backup folder is named for the local time it was made", () => {
  expect(backupFolderName(NOW)).toBe("bara-backup-20261007-090503");
  expect(backupFolderName(new Date(2027, 0, 1, 23, 59, 59))).toBe("bara-backup-20270101-235959");
});

test("a name already taken, by a folder or a file, moves on to -2, -3, ...", async () => {
  const root = scratch("names");
  expect(await freshDestination(root, NOW)).toBe(join(root, "bara-backup-20261007-090503"));
  mkdirSync(join(root, "bara-backup-20261007-090503"));
  expect(await freshDestination(root, NOW)).toBe(join(root, "bara-backup-20261007-090503-2"));
  writeFileSync(join(root, "bara-backup-20261007-090503-2"), "");
  expect(await freshDestination(root, NOW)).toBe(join(root, "bara-backup-20261007-090503-3"));
});

test("the store's paths come from its settings only when both are absolute and inside the managed folder", async () => {
  const f = fixture(null);
  expect(await managedSources(f.memoryData)).toEqual({ db: f.db, assets: join(f.memoryData, "assets") });
  const settingsFile = join(f.memoryData, "config", "memory-settings.json");
  const outside = join(f.dir, "elsewhere", "bara.sqlite");
  for (const settings of [
    { db: { path: outside }, assets: { dir: join(f.memoryData, "assets") } },
    { db: { path: f.db }, assets: { dir: join(f.dir, "elsewhere") } },
    { db: { path: join(f.memoryData, "..", "other", "bara.sqlite") }, assets: { dir: join(f.memoryData, "assets") } },
    { db: { path: "db/bara.sqlite" }, assets: { dir: join(f.memoryData, "assets") } },
    { db: { path: f.db } },
    { db: { path: 7 }, assets: { dir: join(f.memoryData, "assets") } },
    null,
  ]) {
    writeFileSync(settingsFile, JSON.stringify(settings));
    expect(await rejection(managedSources(f.memoryData))).toMatchObject({ code: "BACKUP_SETTINGS_INVALID" });
  }
  writeFileSync(settingsFile, "{ not json");
  expect(await rejection(managedSources(f.memoryData))).toMatchObject({ code: "BACKUP_SETTINGS_INVALID" });
  rmSync(settingsFile);
  expect(await rejection(managedSources(f.memoryData))).toMatchObject({ code: "BACKUP_SETTINGS_INVALID" });
});

test("only memories kept on this PC are backed up: another server's connection is refused before anything runs", async () => {
  const f = fixture(SUCCEEDS);
  await f.config.save({ connection: { mode: "existing", baseUrl: "http://127.0.0.1:41999" } });
  const error = await rejection(service(f).export(ctx()));
  expect(error).toMatchObject({ code: "BACKUP_NOT_LOCAL", publicMessage: messages.backupErrors.BACKUP_NOT_LOCAL });
  expect(existsSync(join(f.paths.resourceDir, "exporter-args.json"))).toBe(false);
  expect(listing(f.backupDir)).toBeNull();
});

test("a local install that is not finished, or has lost its database, is not backed up", async () => {
  const f = fixture(SUCCEEDS);
  const journal = join(f.memoryData, "managed-install.json");
  const notReady = { code: "BACKUP_NOT_READY", publicMessage: messages.backupErrors.BACKUP_NOT_READY };
  writeFileSync(journal, JSON.stringify({ version: 1, phase: "preparing", port: 41031 }));
  expect(await rejection(service(f).export(ctx()))).toMatchObject(notReady);
  writeFileSync(journal, "{ broken");
  expect(await rejection(service(f).export(ctx()))).toMatchObject(notReady);
  rmSync(journal);
  expect(await rejection(service(f).export(ctx()))).toMatchObject(notReady);
  writeFileSync(journal, JSON.stringify({ version: 1, phase: "complete", port: 41031 }));
  rmSync(f.db);
  expect(await rejection(service(f).export(ctx()))).toMatchObject(notReady);
  expect(existsSync(join(f.paths.resourceDir, "exporter-args.json"))).toBe(false);
});

test("without a backup folder from the host nothing is written anywhere", async () => {
  const f = fixture(SUCCEEDS, { backupDir: false });
  const error = await rejection(service(f).export(ctx()));
  expect(error).toMatchObject({ code: "BACKUP_FOLDER_UNAVAILABLE", publicMessage: messages.backupErrors.BACKUP_FOLDER_UNAVAILABLE });
  expect(existsSync(join(f.paths.resourceDir, "exporter-args.json"))).toBe(false);
});

test("a low drive stops the backup before it writes, with the database, its log and the attachments counted", async () => {
  const f = fixture(SUCCEEDS);
  // 1,000 database bytes + 500 log bytes + 250 attachment-folder bytes, plus the margin.
  const needed = 1_000 + 500 + 250 + BACKUP_MARGIN_BYTES;
  const free = BACKUP_MARGIN_BYTES;
  const asked: string[] = [];
  const error = await rejection(service(f, async (path) => { asked.push(path); return free; }).export(ctx()));
  expect(error).toMatchObject({ code: "BACKUP_DISK_LOW", publicMessage: messages.backupErrors.BACKUP_DISK_LOW(needed - free, free) });
  expect(asked).toEqual([f.backupDir]);
  expect(listing(f.backupDir)).toBeNull();
  expect(existsSync(join(f.paths.resourceDir, "exporter-args.json"))).toBe(false);
  // The same rounding as the install's free-space text: still needed rounds up, free rounds down.
  expect(messages.backupErrors.BACKUP_DISK_LOW(1_234_567_890, 987_654_321)).toContain("0.9GB");
  expect(messages.backupErrors.BACKUP_DISK_LOW(1_234_567_890, 987_654_321)).toContain("1.3GB");
  // Exactly enough, or a drive that cannot be read, goes ahead.
  expect(await service(f, async () => needed).export(ctx())).toMatchObject({ memories: 3 });
  expect(await service(f, async () => null).export(ctx())).toMatchObject({ folderName: "bara-backup-20261007-090503-2" });
});

test("a finished export reports its folder and counts, and runs the exporter on the store's own files", async () => {
  const f = fixture(SUCCEEDS);
  const result = await service(f).export(ctx());
  const folder = join(f.backupDir, "bara-backup-20261007-090503");
  // `memories` counts the live memories only, not the trashed ones the archive also keeps.
  expect(result).toEqual({ folder, folderName: "bara-backup-20261007-090503", memories: 3, attachments: 2 });
  const run = JSON.parse(readFileSync(join(f.paths.resourceDir, "exporter-args.json"), "utf8"));
  expect(resolve(run.cwd)).toBe(join(f.paths.resourceDir, "core", "apps", "memory"));
  expect(run.args).toEqual(["export", "--db", f.db, "--assets", join(f.memoryData, "assets"), "--out", folder]);
  expect(messages.backup.done(result.folderName, result.memories, result.attachments))
    .toBe("백업을 만들었어요: Bara 백업\\bara-backup-20261007-090503 (기억 3개, 첨부 2개)");
  // A second backup in the same second gets its own folder; the first is left as it was.
  expect((await service(f).export(ctx())).folderName).toBe("bara-backup-20261007-090503-2");
  expect(listing(f.backupDir)).toEqual(["bara-backup-20261007-090503", "bara-backup-20261007-090503-2"]);
});

test("a published folder whose result line cannot be read is still reported from its manifest", async () => {
  const f = fixture(PRINTS_NOISE);
  expect(await service(f).export(ctx())).toMatchObject({ memories: 3, attachments: 2 });
});

test("a failed export says nothing was changed, names the exporter's last error line and removes only its staging folder", async () => {
  const f = fixture(FAILS);
  mkdirSync(f.backupDir, { recursive: true });
  // Another backup's staging folder, an unrelated hidden folder and a file shaped like staging stay.
  const kept = [".bara-backup-20261007-090503-2.export-Zz99Yy", ".bara-backup-20261001-000000.export-Ab12Cd", ".keep"];
  for (const name of kept) mkdirSync(join(f.backupDir, name));
  writeFileSync(join(f.backupDir, ".bara-backup-20261007-090503.export-file00"), "not a folder");
  const error = await rejection(service(f).export(ctx()));
  const text = messages.backupErrors.BACKUP_FAILED("portable-memory: Source asset hash/size mismatch");
  expect(error).toMatchObject({ code: "BACKUP_FAILED", publicMessage: text });
  expect(text).toBe("백업을 만들지 못했어요(portable-memory: Source asset hash/size mismatch). 기억은 아무것도 바뀌지 않았어요. 다시 시도해 주세요.");
  expect(listing(f.backupDir)).toEqual([...kept, ".bara-backup-20261007-090503.export-file00"].sort());
  // Without an error line the text reads without a cause.
  expect(messages.backupErrors.BACKUP_FAILED(undefined)).toBe("백업을 만들지 못했어요. 기억은 아무것도 바뀌지 않았어요. 다시 시도해 주세요.");
});

test("a long cause is shortened so the failure text stays within the host's message limit", async () => {
  // The native host drops a service error text over 1000 UTF-8 bytes (`MAX_SERVICE_MESSAGE`); a Hangul cause of the
  // exporter's full cause length (300 code points, 3 bytes each) would pass it.
  const f = fixture(`${STUB_HEAD}
console.error("첨부".repeat(200));
process.exit(1);
`);
  const error = await rejection(service(f).export(ctx())) as { code: string; publicMessage: string };
  expect(error.code).toBe("BACKUP_FAILED");
  expect(Buffer.byteLength(error.publicMessage, "utf8")).toBeLessThanOrEqual(1_000);
  expect(error.publicMessage).toStartWith("백업을 만들지 못했어요(첨부첨부");
  expect(error.publicMessage).toContain("…). 기억은 아무것도 바뀌지 않았어요. 다시 시도해 주세요.");
});

test("no backup starts while an update is being finished: its backup copies the store or preparation may migrate it", async () => {
  const f = fixture(SUCCEEDS);
  let updating = true;
  const backups = service(f, enough, () => updating);
  expect(await rejection(backups.export(ctx()))).toMatchObject({ code: "BACKUP_UPDATE_RUNNING", publicMessage: messages.backupErrors.BACKUP_UPDATE_RUNNING });
  expect(listing(f.backupDir)).toBeNull();
  expect(existsSync(join(f.paths.resourceDir, "exporter-args.json"))).toBe(false);
  updating = false;
  expect(await backups.export(ctx())).toMatchObject({ memories: 3 });
});

test("staging clean-up touches only this destination's staging folders, never a link or the destination", async () => {
  const root = scratch("staging");
  const outside = scratch("outside");
  writeFileSync(join(outside, "precious"), "keep");
  const name = "bara-backup-20261007-090503";
  for (const folder of [name, `.${name}.export-Ab12Cd`, `.${name}.export-Qq34Rr`, `.${name}.export-short`, `.${name}-2.export-Ab12Cd`, `.${name}.export-Ab12Cd.extra`])
    mkdirSync(join(root, folder));
  writeFileSync(join(root, `.${name}.export-Ab12Cd`, "half.json"), "{");
  symlinkSync(outside, join(root, `.${name}.export-Lk56Mn`), process.platform === "win32" ? "junction" : "dir");
  await removeStaging(root, name);
  expect(listing(root)).toEqual([`.${name}-2.export-Ab12Cd`, `.${name}.export-Ab12Cd.extra`, `.${name}.export-Lk56Mn`, `.${name}.export-short`, name].sort());
  expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
  // A missing root is nothing to clean.
  await removeStaging(join(root, "missing"), name);
});

test("a destination left without its manifest by a cut-off publish is removed; a published one, a link or nothing is kept", async () => {
  const root = scratch("unpublished");
  const outside = scratch("unpublished-outside");
  writeFileSync(join(outside, "precious"), "keep");
  const half = join(root, "bara-backup-20261007-090503");
  mkdirSync(join(half, "collections"), { recursive: true });
  writeFileSync(join(half, "collections", "memories.json"), "[]");
  const done = join(root, "bara-backup-20261007-090504");
  mkdirSync(done); writeFileSync(join(done, "manifest.json"), "{}");
  const link = join(root, "bara-backup-20261007-090505");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  for (const folder of [half, done, link, join(root, "missing")]) await removeUnpublished(folder);
  expect(listing(root)).toEqual(["bara-backup-20261007-090504", "bara-backup-20261007-090505"]);
  expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
});

/** Waits until the stand-in has made its staging folder, so a cancel lands while it runs. */
async function stagingAppears(backupDir: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((listing(backupDir) ?? []).some((name) => name.endsWith(".export-Ab12Cd"))) return;
    await Bun.sleep(25);
  }
  throw new Error("the exporter never started");
}

test("one backup runs at a time, and a cancelled one ends as cancelled with its staging folder removed", async () => {
  const f = fixture(HANGS);
  const backups = service(f);
  const first = rejection(backups.export(ctx()));
  await stagingAppears(f.backupDir);
  expect(await rejection(backups.export(ctx()))).toMatchObject({ code: "BACKUP_BUSY", publicMessage: messages.backupErrors.BACKUP_BUSY });
  // The screen's "중단" (`backup.cancel`).
  expect(backups.cancel()).toBe(true);
  const error = await first;
  expect(error).toMatchObject({ code: "CANCELLED", publicMessage: messages.backup.cancelled });
  expect(listing(f.backupDir)).toEqual([]);
  // The slot is free again once the cancelled run has ended.
  writeFileSync(join(f.paths.resourceDir, "core", "apps", "memory", "scripts", "portable-memory.ts"), SUCCEEDS);
  expect(await backups.export(ctx())).toMatchObject({ memories: 3 });
}, 20_000);

test("a backup goes on when its screen leaves: a screen opened again joins it, and quitting stops it", async () => {
  const f = fixture(`${STUB_HEAD}
mkdirSync(staging);
const release = join(process.cwd(), "..", "..", "..", "release");
while (!(await Bun.file(release).exists())) await Bun.sleep(20);
(await import("node:fs")).rmSync(staging, { recursive: true });
mkdirSync(out);
writeFileSync(join(out, "manifest.json"), ${JSON.stringify(JSON.stringify(MANIFEST))});
process.stdout.write(${JSON.stringify(JSON.stringify(MANIFEST))} + "\\n");
`);
  const backups = service(f);
  const controller = new AbortController();
  const leaving = rejection(backups.export(ctx(controller.signal)));
  await stagingAppears(f.backupDir);
  controller.abort();
  expect(await leaving).toBe(controller.signal.reason);
  expect(backups.busy).toBe(true);
  expect(backups.status()).toEqual({ state: "running", startedAt: NOW.toISOString(), stage: null });
  const joined = backups.join(ctx());
  writeFileSync(join(f.paths.resourceDir, "release"), "");
  expect(await joined).toMatchObject({ folderName: "bara-backup-20261007-090503", memories: 3, attachments: 2 });
  expect(backups.status()).toBeNull();
  // Quitting stops a backup that runs, and none starts afterwards.
  writeFileSync(join(f.paths.resourceDir, "core", "apps", "memory", "scripts", "portable-memory.ts"), HANGS);
  const hanging = rejection(backups.export(ctx()));
  await stagingAppears(f.backupDir);
  await backups.close();
  expect(await hanging).toMatchObject({ code: "CANCELLED" });
  expect(listing(f.backupDir)).toEqual(["bara-backup-20261007-090503"]);
  expect(await rejection(backups.export(ctx()))).toMatchObject({ code: "CANCELLED" });
}, 20_000);

// The real exporter (apps/memory, as the runtime package ships it under `core`) against a real database that a
// writer holds open with an uncommitted change, the way the running memory server would.
const memoryApp = resolve(import.meta.dir, "..", "..", "..", "memory");
const realExporter = existsSync(join(memoryApp, "scripts", "portable-memory.ts")) && existsSync(join(memoryApp, "node_modules", "sqlite-vec"));

test.skipIf(!realExporter)("the real exporter backs up a live database: committed memories only, beside a writer", async () => {
  const f = fixture(null);
  mkdirSync(join(f.paths.resourceDir, "core", "apps"), { recursive: true });
  symlinkSync(memoryApp, join(f.paths.resourceDir, "core", "apps", "memory"), process.platform === "win32" ? "junction" : "dir");
  rmSync(f.db); rmSync(`${f.db}-wal`);
  rmSync(join(f.memoryData, "assets"), { recursive: true });
  mkdirSync(join(f.memoryData, "assets", "content"), { recursive: true });
  // The database is made the way the core makes it, by its own `openMemoryDatabase`, in a separate process.
  const create = join(f.dir, "create-db.ts");
  writeFileSync(create, `import { openMemoryDatabase } from ${JSON.stringify(join(memoryApp, "src", "db", "migrations.ts"))};
const db = openMemoryDatabase(process.argv[2]);
db.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('백업할 기억 하나', '{}')");
db.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('백업할 기억 둘', '{}')");
db.close();`);
  const made = Bun.spawnSync([process.execPath, create, f.db], { cwd: memoryApp, stderr: "pipe" });
  expect({ exit: made.exitCode, stderr: made.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
  const writer = new Database(f.db);
  try {
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("BEGIN IMMEDIATE");
    writer.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('아직 저장 중인 기억', '{}')");
    const result = await service(f).export(ctx());
    expect(result).toMatchObject({ folderName: "bara-backup-20261007-090503", memories: 2, attachments: 0 });
    const manifest = JSON.parse(readFileSync(join(result.folder, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ format: "bara-memory", collections: { memories: { count: 2 } } });
    const memories = JSON.parse(readFileSync(join(result.folder, manifest.collections.memories.file), "utf8")) as Array<{ body: string }>;
    expect(memories.map((memory) => memory.body).sort()).toEqual(["백업할 기억 둘", "백업할 기억 하나"]);
    expect(listing(f.backupDir)).toEqual([basename(result.folder)]);
    writer.run("COMMIT");
  } finally { writer.close(); }
}, 60_000);
