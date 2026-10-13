import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PublicSettings } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { BackupService } from "./backup.ts";
import { RESTORE_STATE_FILE } from "./restore-journal.ts";
import { entryId } from "./restore.ts";
import { ctx, enough, expectUntouched, fixture, harness, idOf, MANUAL_NEW, MANUAL_OLD,
  NOW, PRE_UPDATE, read, rejection, removeScratchRoots, restoreRunning, steps } from "./test-utils/restore-harness.ts";

// `backup.restore` around a run, with the stand-ins of `test-utils/restore-harness.ts`: the service owns the restore
// (callers that leave or join), how its end is reported, quitting while it runs, settings backups during it, the
// remote install's backup list, and one test with the real exporter, check, restore and `managed-prepare` on real
// databases.

afterEach(removeScratchRoots);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(25);
  if (!check()) throw new Error("the condition never held");
}

test("the restore is the service's: a caller that leaves ends only its wait, and one that joins gets the stage and the result", async () => {
  const f = fixture();
  f.mode({ restore: "wait" });
  const h = harness(f);
  const id = await idOf(h, MANUAL_OLD);
  const controller = new AbortController();
  const first = ctx(controller.signal);
  const leaving = rejection(h.service.restore({ id }, first));
  await restoreRunning(f);
  // The settings screen goes away: its wait ends, the restore does not.
  controller.abort();
  expect(await leaving).toBe(controller.signal.reason);
  expect(h.service.active).toBe(true);
  expect(h.service.holdingServer).toBe(true);
  expect(h.events).toEqual(["stop"]);
  expect(f.journal()).toMatchObject({ stage: "restoring" });
  // The screen opened again finds the restore at its stage and joins it; the stage comes again first.
  expect(h.service.status()).toEqual({ state: "running", startedAt: NOW.toISOString(), stage: "restore-data" });
  const second = ctx();
  const joined = h.service.join(second);
  expect(second.stages).toEqual(["restore-data"]);
  f.release();
  const result = await joined;
  expect(result).toMatchObject({ backupName: MANUAL_OLD, memories: 3, attachments: 2, resumed: false });
  expect(second.stages).toEqual(["restore-data", "restore-switch", "server"]);
  expect(h.events).toEqual(["stop", "start"]);
  // The joined screen received the outcome, so it is not reported again.
  expect(h.service.status()).toBeNull();
  expect(await h.service.join(ctx())).toEqual(result);
}, 20_000);

test("how a restore ended while no screen waited is reported once to the next status", async () => {
  const f = fixture();
  f.mode({ restore: "wait-fail" });
  const h = harness(f);
  expect(h.service.status()).toBeNull();
  const controller = new AbortController();
  const leaving = rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx(controller.signal)));
  await restoreRunning(f);
  controller.abort();
  await leaving;
  f.release();
  await until(() => !h.service.active);
  expect(h.service.status()).toEqual({ state: "failed", startedAt: NOW.toISOString(), endedAt: NOW.toISOString(),
    error: { code: "RESTORE_FAILED", message: messages.restoreErrors.RESTORE_FAILED("portable-memory: Embedding unavailable or invalid: index:vec_nodes") } });
  expect(h.service.status()).toBeNull();
  // Stopping a restore that is not running stops nothing.
  expect(h.service.cancel()).toBe(false);
}, 20_000);

test("from the restore's start saves are refused: the server stops before the backup is read and stays stopped through the checks", async () => {
  const f = fixture();
  f.mode({ verify: "wait" });
  let stepsBeforeStop = -1, heldBeforeStop = false;
  const h = harness(f, { onStop: () => { stepsBeforeStop = steps(f).length; heldBeforeStop = h.service.holdingServer; } });
  const running = h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx());
  await until(() => steps(f).includes("verify"));
  // Held from the very start, before the stop ran, and the stop came before the backup was read.
  expect(heldBeforeStop).toBe(true);
  expect(stepsBeforeStop).toBe(0);
  expect(h.service.active).toBe(true);
  expect(h.events).toEqual(["stop"]);
  // A save (the router asks the start gate) is refused while the backup is being read, and nothing reaches the store.
  expect(await rejection(h.service.beforeStart())).toMatchObject({ code: "RESTORE_RUNNING" });
  expect(h.running()).toBe(false);
  f.release();
  expect(await running).toMatchObject({ memories: 3 });
  expect(h.events).toEqual(["stop", "start"]);
  // The store moved aside is exactly the store from before the restore began.
  const before = join(f.memoryData, "before-restore-20261007-090503");
  expect(read(join(before, "db", "bara.sqlite"))).toBe("current database");
  expect(read(join(before, "db", "bara.sqlite-wal"))).toBe("current log");
}, 20_000);

test("a restore that ends while the app quits does not start the server again", async () => {
  const f = fixture();
  f.mode({ restore: "wait-fail" });
  const h = harness(f);
  const controller = new AbortController();
  const running = rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx(controller.signal)));
  await restoreRunning(f);
  // The drain begins and cancels the request; the restore then fails on its own before the service closes.
  h.service.drain();
  controller.abort();
  await running;
  f.release();
  await until(() => !h.service.active);
  expect(h.events).toEqual(["stop"]);
  expect(h.running()).toBe(false);
  expect(f.journal()).toMatchObject({ stage: "failed", errorCode: "RESTORE_FAILED" });
  await h.service.close();
  expect(h.events).toEqual(["stop"]);
  expectUntouched(f);
}, 20_000);

test("a failure between the restore and the switch is recorded as failed, not taken for a restore a crash cut off", async () => {
  const f = fixture();
  // The switch's first record cannot be written (a full or failing drive): the record would stay at `restoring`.
  const h = harness(f, { rename: async (from, to) => {
    if (to.endsWith(RESTORE_STATE_FILE) && readFileSync(from, "utf8").includes('"stage": "swapping"'))
      throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    await rename(from, to);
  } });
  const error = await rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
  expect(error).toMatchObject({ code: "RESTORE_SWITCH_FAILED" });
  expect(h.events).toEqual(["stop", "start"]);
  expect(f.journal()).toMatchObject({ stage: "failed", errorCode: "RESTORE_SWITCH_FAILED" });
  // The restart did not mark it interrupted, so the screen does not say the app ended mid-restore.
  expect((await h.service.list()).last).toBeNull();
  expectUntouched(f);
});

test("a settings backup is refused while a restore runs", async () => {
  const f = fixture();
  let restoring = true;
  const backups = new BackupService({ load: async () => ({ connection: { mode: "local" } }) as unknown as PublicSettings }, f.paths,
    { restoring: () => restoring, freeSpace: enough });
  expect(await rejection(backups.export(ctx()))).toMatchObject({ code: "BACKUP_RESTORE_RUNNING", publicMessage: messages.backupErrors.BACKUP_RESTORE_RUNNING });
  restoring = false;
  expect(backups.busy).toBe(false);
});

// The real portable-memory commands (apps/memory, as the runtime package ships it under `core`) and the real
// `managed-prepare` on real databases. The model download is not reachable offline, so the backup holds what the
// restore can rebuild without a model: trashed memories and an attachment (their rows get no vector), and the model
// step is a stand-in. Live memories would need bge-m3.
const memoryRoot = resolve(import.meta.dir, "..", "..", "..", "memory");
const setupPrepare = resolve(import.meta.dir, "..", "..", "..", "setup", "src", "managed-prepare.ts");
const realCore = existsSync(join(memoryRoot, "scripts", "portable-memory.ts")) && existsSync(join(memoryRoot, "node_modules", "sqlite-vec")) && existsSync(setupPrepare);

test.skipIf(!realCore)("the real check, restore and server preparation put a backup's memories and attachment in place", async () => {
  const f = fixture();
  const scripts = join(f.paths.resourceDir, "core", "apps", "memory", "scripts");
  writeFileSync(join(scripts, "portable-memory.ts"), `const { main } = await import(${JSON.stringify(join(memoryRoot, "scripts", "portable-memory.ts"))});
process.exitCode = await main();`);
  rmSync(f.backupDir, { recursive: true });
  mkdirSync(f.backupDir);
  rmSync(join(f.memoryData, "backups"), { recursive: true });
  // Two real databases made the way the core makes them: the current store and the one that is backed up.
  const make = join(f.dir, "make-db.ts");
  writeFileSync(make, `import { openMemoryDatabase } from ${JSON.stringify(join(memoryRoot, "src", "db", "migrations.ts"))};
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
const [file, assets, label, count, attach] = process.argv.slice(2);
const db = openMemoryDatabase(file);
const insert = db.prepare("INSERT INTO knowledge_nodes_archive(id, content, memory_type, source_type, importance, confidence, created_at, last_accessed_at) VALUES(?,?,?,?,?,?,?,?)");
for (let i = 1; i <= Number(count); i++) insert.run(i, label + " " + i, "fact", "auto_capture", 0.5, 0.7, "2026-10-01 10:00:00", "2026-10-01 10:00:00");
if (attach === "1") {
  const bytes = Buffer.from("# 첨부 문서\\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(assets + "/content", { recursive: true });
  writeFileSync(assets + "/content/" + sha + ".md", bytes);
  db.prepare("INSERT INTO asset_files(sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at) VALUES(?,?,?,?,?,?,?)")
    .run(sha, "text", "content/" + sha + ".md", bytes.length, "text/markdown", "a.md", "2026-10-01 10:00:00");
}
db.close();`);
  const run = (args: string[]) => {
    const done = Bun.spawnSync([process.execPath, ...args], { cwd: memoryRoot, stderr: "pipe", stdout: "pipe" });
    expect({ exit: done.exitCode, stderr: done.exitCode === 0 ? "" : done.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
    return done.stdout.toString();
  };
  for (const file of [f.db, `${f.db}-wal`, `${f.db}-shm`]) rmSync(file, { force: true });
  rmSync(f.assets, { recursive: true });
  mkdirSync(f.assets);
  run([make, f.db, f.assets, "지금 기억", "1", "0"]);
  const source = join(f.dir, "source");
  mkdirSync(join(source, "assets"), { recursive: true });
  run([make, join(source, "bara.sqlite"), join(source, "assets"), "백업한 기억", "2", "1"]);
  run([join(memoryRoot, "scripts", "portable-memory.ts"), "export", "--db", join(source, "bara.sqlite"), "--assets", join(source, "assets"),
    "--out", join(f.backupDir, MANUAL_OLD)]);
  // The server start is the real preparation step (it opens and checks the database the way every start does).
  let prepared: { schemaVersion?: number } = {};
  const h = harness(f, { startServer: async () => {
    prepared = JSON.parse(run([setupPrepare, "--data-dir", f.memoryData, "--port", "41031"]).trim().split("\n").at(-1)!);
  } });
  const listing = await h.service.list();
  expect(listing.entries.map((entry) => [entry.name, entry.memories, entry.attachments])).toEqual([[MANUAL_OLD, 0, 1]]);
  const result = await h.service.restore({ id: listing.entries[0]!.id }, ctx());
  expect(result).toMatchObject({ memories: 0, archived: 2, attachments: 1 });
  expect(prepared.schemaVersion).toBeGreaterThan(0);
  const db = new Database(f.db, { readonly: true });
  try {
    expect(db.query("SELECT content FROM knowledge_nodes_archive ORDER BY id").all()).toEqual([{ content: "백업한 기억 1" }, { content: "백업한 기억 2" }]);
    // The database and the attachment folder in place are a pair: the folder's marker carries the database's pairing number.
    const pairing = db.query("SELECT pairing_id FROM asset_folder_pairing WHERE id=1").get() as { pairing_id: string };
    expect(JSON.parse(read(join(f.assets, "bara-asset-pairing.json"))!).pairingId).toBe(pairing.pairing_id);
    // The memory server's own start rule for the attachment folder (apps/memory) lets its start-up clean-up run.
    const rules = await import(join(memoryRoot, "src", "assets", "asset-folder-pairing.ts"));
    const folder = rules.readAssetFolderState({ baseDir: f.assets, listContentNames: () => readdirSync(join(f.assets, "content")) });
    expect(rules.decideAssetFolderPairing({ pairingId: pairing.pairing_id }, folder)).toEqual({ action: "proceed" });
    const asset = db.query("SELECT sha256, asset_path FROM asset_files").get() as { sha256: string; asset_path: string };
    expect(existsSync(join(f.assets, asset.asset_path))).toBe(true);
  } finally { db.close(); }
  // The store from before, with its one memory, waits in the before-restore folder.
  const before = new Database(join(result.beforeFolder, "db", "bara.sqlite"), { readonly: true });
  try { expect(before.query("SELECT content FROM knowledge_nodes_archive").all()).toEqual([{ content: "지금 기억 1" }]); }
  finally { before.close(); }
  expect(f.journal()).toMatchObject({ stage: "complete" });
  expect(existsSync(join(f.memoryData, "restore-work"))).toBe(false);
}, 120_000);

test("the remote install's list needs no store on this PC, and the restore button's rule is unchanged", async () => {
  const f = fixture();
  const h = harness(f, { mode: "remote" });
  const listing = await h.service.list("remote-install");
  expect(listing.entries.map((entry) => entry.name)).toEqual([PRE_UPDATE, MANUAL_NEW, MANUAL_OLD]);
  expect(listing.entries.every((entry) => !entry.resumable)).toBe(true);
  expect(listing.entries.every((entry) => !("archive" in entry))).toBe(true);
  expect(listing.last).toBeNull();
  expect(await rejection(h.service.list())).toMatchObject({ code: "RESTORE_NOT_LOCAL" });
});

test("a remote install's chosen backup is found by its id and read back on this PC first", async () => {
  const f = fixture();
  const h = harness(f, { mode: "remote" });
  const stages: string[] = [];
  const source = await h.service.remoteSource(entryId("manual", MANUAL_OLD), { signal: new AbortController().signal, progress: (stage) => { stages.push(stage); } });
  expect(source).toMatchObject({ name: MANUAL_OLD, archive: join(f.backupDir, MANUAL_OLD), counts: { memories: 3, archived: 1, attachments: 2 } });
  expect(source.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(stages).toEqual(["restore-verify"]);
  expect(steps(f)).toEqual(["verify"]);
  expect(await rejection(h.service.remoteSource("0".repeat(32), ctx()))).toMatchObject({ code: "RESTORE_BACKUP_MISSING" });
  expect(await rejection(h.service.remoteSource("../x", ctx()))).toMatchObject({ code: "RESTORE_BACKUP_MISSING" });
  f.mode({ verify: "fail" });
  expect(await rejection(h.service.remoteSource(entryId("manual", MANUAL_OLD), ctx()))).toMatchObject({ code: "RESTORE_VERIFY_FAILED" });
  expectUntouched(f);
});
