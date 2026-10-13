import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { messages } from "../ui/messages.ts";
import { BACKUP_MARGIN_BYTES } from "./backup.ts";
import { writeRestoreJournal, type RestoreJournal } from "./restore-journal.ts";
import { entryId, IMAGE_INDEX_ALLOWANCE, restoreSpaceNeeded, TEXT_INDEX_ALLOWANCE, type RestoreBlocker } from "./restore.ts";
import { ctx, expectUntouched, fixture, harness, idOf, manifest, MANUAL_NEW, MANUAL_OLD,
  NOW, PRE_UPDATE, read, rejection, removeScratchRoots, restoreRunning, steps } from "./test-utils/restore-harness.ts";

// `backup.restore` with the test-only stand-ins of the core scripts and of the server (`test-utils/restore-harness.ts`):
// the backup list, the checks before a restore, and one restore run from start to switch, including its failures and
// cancellation. What happens around a restore (who waits for it, reporting, quitting, a real core) is in
// `restore-lifecycle.test.ts`.

afterEach(removeScratchRoots);

test("the list holds the settings backups and the finished pre-update backups, newest first, without a path", async () => {
  const f = fixture();
  const listing = await harness(f).service.list();
  expect(listing).toEqual({ last: null, entries: [
    { id: entryId("pre-update", PRE_UPDATE), kind: "pre-update", name: PRE_UPDATE, createdAt: "2026-10-06T00:00:00.000Z", memories: 4, attachments: 1, resumable: false },
    { id: entryId("manual", MANUAL_NEW), kind: "manual", name: MANUAL_NEW, createdAt: "2026-10-04T23:00:00.000Z", memories: 5, attachments: 0, resumable: false },
    { id: entryId("manual", MANUAL_OLD), kind: "manual", name: MANUAL_OLD, createdAt: "2026-10-01T03:00:00.000Z", memories: 3, attachments: 2, resumable: false },
  ] });
  for (const entry of listing.entries) expect(entry.id).toMatch(/^[0-9a-f]{32}$/);
  // Neither the data folder nor the backup folder reaches the screen.
  expect(JSON.stringify(listing)).not.toContain(f.dir);
  // Without the host's backup folder only the pre-update backups are listed.
  const without = harness({ ...f, paths: { ...f.paths, backupDir: undefined } });
  expect((await without.service.list()).entries.map((entry) => entry.name)).toEqual([PRE_UPDATE]);
});

test("only a finished install on this PC lists or restores, and nothing runs for any other connection", async () => {
  const f = fixture();
  for (const mode of ["existing", "remote"] as const) {
    const h = harness(f, { mode });
    expect(await rejection(h.service.list())).toMatchObject({ code: "RESTORE_NOT_LOCAL", publicMessage: messages.restoreErrors.RESTORE_NOT_LOCAL });
    expect(await rejection(h.service.restore({ id: entryId("manual", MANUAL_OLD) }, ctx())))
      .toMatchObject({ code: "RESTORE_NOT_LOCAL" });
  }
  writeFileSync(join(f.memoryData, "managed-install.json"), JSON.stringify({ version: 1, phase: "preparing", port: 41031 }));
  expect(await rejection(harness(f).service.list())).toMatchObject({ code: "RESTORE_NOT_READY", publicMessage: messages.restoreErrors.RESTORE_NOT_READY });
  writeFileSync(join(f.memoryData, "managed-install.json"), JSON.stringify({ version: 1, phase: "complete", port: 41031 }));
  // Settings that name a database other than the managed one are not this store.
  writeFileSync(join(f.memoryData, "config", "memory-settings.json"), JSON.stringify(
    { db: { path: join(f.memoryData, "db", "other.sqlite") }, assets: { dir: f.assets } }));
  expect(await rejection(harness(f).service.list())).toMatchObject({ code: "RESTORE_SETTINGS_INVALID" });
  expect(f.calls()).toEqual([]);
  expectUntouched(f);
});

test("the backup is found by its id in a fresh listing: an unknown id or a path from the caller restores nothing", async () => {
  const f = fixture();
  const h = harness(f);
  for (const id of ["", "x", "0".repeat(32), entryId("manual", "bara-backup-20261002-000000"), entryId("manual", "my copy"), 7, null])
    expect(await rejection(h.service.restore({ id }, ctx()))).toMatchObject({ code: "RESTORE_BACKUP_MISSING", publicMessage: messages.restoreErrors.RESTORE_BACKUP_MISSING });
  expect(f.calls()).toEqual([]);
  // Extra fields naming a folder are ignored: the archive is the listed one.
  await h.service.restore({ id: await idOf(h, MANUAL_OLD), archive: join(f.dir, "elsewhere"), path: join(f.dir, "elsewhere") }, ctx());
  expect(f.calls().find((call) => call.step === "verify")?.archive).toBe(join(f.backupDir, MANUAL_OLD));
  // A backup removed after it was listed is not found either.
  const id = await idOf(h, MANUAL_NEW);
  rmSync(join(f.backupDir, MANUAL_NEW), { recursive: true });
  expect(await rejection(h.service.restore({ id }, ctx()))).toMatchObject({ code: "RESTORE_BACKUP_MISSING" });
});

test("no restore starts while an update is finished, a backup is made or connection work runs", async () => {
  const f = fixture();
  let blocker: RestoreBlocker | null = null;
  const h = harness(f, { blocker: () => blocker });
  const id = await idOf(h, MANUAL_OLD);
  for (const code of ["RESTORE_UPDATE_RUNNING", "RESTORE_BACKUP_RUNNING", "RESTORE_CONNECTION_BUSY"] as const) {
    blocker = code;
    expect(await rejection(h.service.restore({ id }, ctx()))).toMatchObject({ code, publicMessage: messages.restoreErrors[code] });
  }
  expect(f.calls()).toEqual([]);
  expect(h.events).toEqual([]);
  expectUntouched(f);
});

test("a backup that does not read back whole is refused before anything changes, and the server comes back", async () => {
  const f = fixture();
  f.mode({ verify: "fail" });
  const h = harness(f);
  const error = await rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
  expect(error).toMatchObject({ code: "RESTORE_VERIFY_FAILED",
    publicMessage: messages.restoreErrors.RESTORE_VERIFY_FAILED("portable-memory: Collection hash mismatch: memories") });
  expect(steps(f)).toEqual(["verify"]);
  expect(h.events).toEqual(["stop", "start"]);
  expect(h.service.holdingServer).toBe(false);
  expect(f.journal()).toBeNull();
  expectUntouched(f);
});

test("a drive without room for the restore stops it before anything changes; an unreadable drive goes ahead", async () => {
  const f = fixture();
  const archive = join(f.backupDir, MANUAL_OLD);
  const archiveBytes = readFileSync(join(archive, "manifest.json")).byteLength;
  // 3 memories get a text vector each; no concepts, people or images.
  const needed = 2 * (archiveBytes + 3 * TEXT_INDEX_ALLOWANCE) + BACKUP_MARGIN_BYTES;
  const value = manifest("2026-10-01T03:00:00.000Z", 3, 1, 2) as Parameters<typeof restoreSpaceNeeded>[1];
  expect(restoreSpaceNeeded(archiveBytes, value)).toBe(needed);
  const asked: string[] = [];
  const h = harness(f, { freeSpace: async (path) => { asked.push(path); return BACKUP_MARGIN_BYTES; } });
  const error = await rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
  expect(error).toMatchObject({ code: "RESTORE_DISK_LOW", publicMessage: messages.restoreErrors.RESTORE_DISK_LOW(needed - BACKUP_MARGIN_BYTES, BACKUP_MARGIN_BYTES) });
  expect(asked).toEqual([f.memoryData]);
  expect(steps(f)).toEqual(["verify"]);
  expect(h.events).toEqual(["stop", "start"]);
  expectUntouched(f);
  // The allowance follows the schema's vector sizes: bge-m3's 1024 and SigLIP's 768 float32 values, counted twice.
  expect([TEXT_INDEX_ALLOWANCE, IMAGE_INDEX_ALLOWANCE]).toEqual([2 * 1024 * 4, 2 * 768 * 4]);
  const rich = manifest("2026-10-01T03:00:00.000Z", 10, 0, 0, { concepts: 4, people: 2, entities: 1, chunkSummaries: 3, relationSummaries: 0, images: 5 });
  expect(restoreSpaceNeeded(1_000, rich as Parameters<typeof restoreSpaceNeeded>[1]))
    .toBe(2 * (1_000 + 20 * TEXT_INDEX_ALLOWANCE + 9 * IMAGE_INDEX_ALLOWANCE) + BACKUP_MARGIN_BYTES);
  expect(await harness(f, { freeSpace: async () => null }).service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx())).toMatchObject({ memories: 3 });
});

test("a restore stops the server, restores into its own folder, switches, starts the server again and reports the counts", async () => {
  const f = fixture();
  let stepsBeforeStop = -1;
  const h = harness(f, { onStop: () => { stepsBeforeStop = steps(f).length; } });
  const id = await idOf(h, MANUAL_OLD);
  const request = ctx();
  const result = await h.service.restore({ id }, request);
  const before = join(f.memoryData, "before-restore-20261007-090503");
  expect(result).toEqual({ backupName: MANUAL_OLD, kind: "manual", memories: 3, archived: 1, attachments: 2, beforeFolder: before, resumed: false });
  expect(messages.restore.done(result.memories, result.attachments, result.beforeFolder))
    .toBe(`되살렸어요: 기억 3개·첨부 2개. 되살리기 전의 기억은 이 폴더에 그대로 있어요: ${before}`);
  // The order: stop, check, models, restore, start. The server stops before the backup is even read, so nothing can
  // be saved into the store that is about to move aside while the checks and the model download run.
  expect(steps(f)).toEqual(["verify", "models", "restore"]);
  expect(stepsBeforeStop).toBe(0);
  expect(h.events).toEqual(["stop", "start"]);
  expect(request.stages).toEqual(["restore-verify", "models", "models", "restore-data", "restore-switch", "server"]);
  expect(request.details).toEqual([{ part: 1, parts: 4, loaded: 5_000_000, total: 10_000_000 }]);
  const [models, restore] = [f.calls()[1]!, f.calls()[2]!];
  expect(models).toMatchObject({ hfCache: join(f.memoryData, "models", "hf-cache"), lines: "1" });
  expect(restore).toMatchObject({ archive: join(f.backupDir, MANUAL_OLD), hfCache: join(f.memoryData, "models", "hf-cache"),
    kiwi: join(f.memoryData, "models", "kiwi-model"), stageExisted: false });
  expect(restore.args).toEqual(["restore", "--archive", join(f.backupDir, MANUAL_OLD), "--out", join(f.memoryData, "restore-work", "target"),
    "--model", "bge-m3", "--resume"]);
  // The restored store is in place, its attachment folder whole with its own pairing marker.
  expect(read(f.db)).toBe(`restored from ${join(f.backupDir, MANUAL_OLD)}`);
  for (const suffix of ["-wal", "-shm"]) expect(existsSync(f.db + suffix)).toBe(false);
  expect(readdirSync(join(f.assets, "content")).length).toBe(2);
  expect(read(join(f.assets, "bara-asset-pairing.json"))).toContain("11111111-2222-4333-8444-555555555555");
  // The store from before is kept as a whole, its log and index with its database.
  expect(read(join(before, "db", "bara.sqlite"))).toBe("current database");
  expect(read(join(before, "db", "bara.sqlite-wal"))).toBe("current log");
  expect(read(join(before, "db", "bara.sqlite-shm"))).toBe("current index");
  expect(readdirSync(join(before, "assets", "content"))).toEqual(["a.png"]);
  // Settings and the install record are not touched; the working folder is gone; the record says complete.
  expect(JSON.parse(read(join(f.memoryData, "config", "memory-settings.json"))!).db.path).toBe(f.db);
  expect(existsSync(join(f.memoryData, "restore-work"))).toBe(false);
  expect(f.journal()).toMatchObject({ stage: "complete", beforePath: before, counts: { memories: 3, archived: 1, attachments: 2 } });
  expect((await h.service.list()).last).toEqual({ outcome: "complete", at: NOW.toISOString(), backupName: MANUAL_OLD, beforeFolder: before,
    memories: 3, attachments: 2 });
  // A second restore keeps the first one's before-restore folder and takes a new name.
  const again = await h.service.restore({ id: await idOf(h, PRE_UPDATE) }, ctx());
  expect(again).toMatchObject({ kind: "pre-update", memories: 4, attachments: 1, beforeFolder: `${before}-2` });
  expect(read(join(`${before}-2`, "db", "bara.sqlite"))).toBe(`restored from ${join(f.backupDir, MANUAL_OLD)}`);
  expect(read(join(before, "db", "bara.sqlite"))).toBe("current database");
});

test("a failed restore leaves the store untouched, starts the server again and keeps its work for the next attempt", async () => {
  const f = fixture();
  f.mode({ restore: "fail" });
  const h = harness(f);
  const id = await idOf(h, MANUAL_OLD);
  const error = await rejection(h.service.restore({ id }, ctx()));
  expect(error).toMatchObject({ code: "RESTORE_FAILED",
    publicMessage: messages.restoreErrors.RESTORE_FAILED("portable-memory: Embedding unavailable or invalid: index:vec_nodes") });
  expect(h.events).toEqual(["stop", "start"]);
  expect(h.running()).toBe(true);
  expectUntouched(f);
  expect(f.journal()).toMatchObject({ stage: "failed", errorCode: "RESTORE_FAILED" });
  // The same backup is offered to go on from where it stopped; the next attempt resumes.
  const listing = await h.service.list();
  expect(listing.entries.filter((entry) => entry.resumable).map((entry) => entry.name)).toEqual([MANUAL_OLD]);
  expect(listing.last).toBeNull();
  f.mode({});
  const result = await h.service.restore({ id }, ctx());
  expect(result).toMatchObject({ resumed: true, memories: 3 });
  expect(f.calls().filter((call) => call.step === "restore").map((call) => call.stageExisted)).toEqual([false, true]);
});

test("a cancelled restore ends as cancelled with the store untouched and the server started again", async () => {
  const f = fixture();
  f.mode({ restore: "hang" });
  const h = harness(f);
  const id = await idOf(h, MANUAL_OLD);
  const running = rejection(h.service.restore({ id }, ctx()));
  await restoreRunning(f);
  // While the server is held stopped, a save, a question or a connection check is refused at once, and so is a second restore.
  expect(h.service.holdingServer).toBe(true);
  expect(await rejection(h.service.beforeStart())).toMatchObject({ code: "RESTORE_RUNNING", publicMessage: messages.restoreErrors.RESTORE_RUNNING });
  expect(await rejection(h.service.restore({ id }, ctx()))).toMatchObject({ code: "RESTORE_BUSY" });
  expect(f.journal()).toMatchObject({ stage: "restoring" });
  // The screen's "중단" (`backup.cancel`).
  expect(h.service.cancel()).toBe(true);
  const error = await running;
  expect(error).toMatchObject({ code: "CANCELLED", publicMessage: messages.restore.cancelled });
  expect(h.service.cancel()).toBe(false);
  expect(h.events).toEqual(["stop", "start"]);
  expect(h.service.holdingServer).toBe(false);
  await h.service.beforeStart();
  expectUntouched(f);
  expect(f.journal()).toMatchObject({ stage: "cancelled" });
  expect((await h.service.list()).entries.find((entry) => entry.name === MANUAL_OLD)?.resumable).toBe(true);
}, 20_000);

test("another backup chosen after a stopped restore discards that restore's work; the same backup resumes it", async () => {
  const f = fixture();
  f.mode({ restore: "hang" });
  const h = harness(f);
  const running = rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
  await restoreRunning(f);
  h.service.cancel();
  await running;
  f.mode({});
  await h.service.restore({ id: await idOf(h, PRE_UPDATE) }, ctx());
  const restores = f.calls().filter((call) => call.step === "restore");
  expect(restores.map((call) => [call.archive, call.stageExisted])).toEqual([[join(f.backupDir, MANUAL_OLD), false],
    [join(f.preUpdate, PRE_UPDATE, "portable"), false]]);
  expect(read(f.db)).toBe(`restored from ${join(f.preUpdate, PRE_UPDATE, "portable")}`);
}, 20_000);

test("a backup whose contents changed since the stopped restore is not resumed", async () => {
  const f = fixture();
  f.mode({ restore: "fail" });
  const h = harness(f);
  const id = await idOf(h, MANUAL_OLD);
  await rejection(h.service.restore({ id }, ctx()));
  f.mode({ fingerprint: "changed" });
  expect(await h.service.restore({ id }, ctx())).toMatchObject({ resumed: false });
  expect(f.calls().filter((call) => call.step === "restore").map((call) => call.stageExisted)).toEqual([false, false]);
});

test("restored counts that differ from the backup's manifest are not switched in", async () => {
  for (const mode of ["miscount", "lose-attachment"]) {
    const f = fixture();
    f.mode({ restore: mode });
    const h = harness(f);
    const error = await rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
    expect(error).toMatchObject({ code: "RESTORE_COUNT_MISMATCH", publicMessage: messages.restoreErrors.RESTORE_COUNT_MISMATCH });
    expect(h.events).toEqual(["stop", "start"]);
    expectUntouched(f);
    expect(f.journal()).toMatchObject({ stage: "failed", errorCode: "RESTORE_COUNT_MISMATCH" });
  }
});

test("models that cannot be prepared stop the restore before anything changes, and the server comes back", async () => {
  const f = fixture();
  f.mode({ models: "fail" });
  const h = harness(f);
  const error = await rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
  expect(error).toMatchObject({ code: "RESTORE_MODELS_FAILED", publicMessage: messages.restoreErrors.RESTORE_MODELS_FAILED("TypeError: fetch failed") });
  expect(h.events).toEqual(["stop", "start"]);
  expectUntouched(f);
});

test("a switch that fails is rolled back: the store is as it was, the server starts on it, and the restored copy is resumed next time", async () => {
  const f = fixture();
  let locked = true;
  // Windows keeps the restored attachment folder locked (a scanner, an open Explorer window) through every retry.
  const h = harness(f, { rename: async (from, to) => {
    if (locked && from === join(f.memoryData, "restore-work", "target", "assets")) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: "EBUSY" });
    await rename(from, to);
  } });
  const id = await idOf(h, MANUAL_OLD);
  const error = await rejection(h.service.restore({ id }, ctx()));
  expect(error).toMatchObject({ code: "RESTORE_SWITCH_FAILED" });
  expect((error as { publicMessage: string }).publicMessage).toContain("EBUSY");
  expect(h.events).toEqual(["stop", "start"]);
  expectUntouched(f);
  expect(f.journal()).toMatchObject({ stage: "rolled-back" });
  expect((await h.service.list()).last).toMatchObject({ outcome: "rolled-back", beforeFolder: null });
  locked = false;
  expect(await h.service.restore({ id }, ctx())).toMatchObject({ resumed: true, memories: 3 });
  expect(read(f.db)).toBe(`restored from ${join(f.backupDir, MANUAL_OLD)}`);
});

test("a server that does not start on the restored store is reported with the folder of the previous store; the next start completes it", async () => {
  const f = fixture();
  let fail = true;
  const h = harness(f, { startFails: () => fail });
  const error = await rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx()));
  const before = join(f.memoryData, "before-restore-20261007-090503");
  expect(error).toMatchObject({ code: "RESTORE_START_FAILED",
    publicMessage: messages.restoreErrors.RESTORE_START_FAILED(messages.installService.localServerExited.replace(/[.。]\s*$/, ""), before) });
  expect(f.journal()).toMatchObject({ stage: "swapped" });
  expect((await h.service.list()).last).toMatchObject({ outcome: "swapped", beforeFolder: before });
  // The switch stays: the restored store is in place and the next start (a connection check) finishes the restore.
  expect(read(f.db)).toBe(`restored from ${join(f.backupDir, MANUAL_OLD)}`);
  fail = false;
  await h.service.beforeStart();
  await h.service.started();
  expect(f.journal()).toMatchObject({ stage: "complete" });
});

test("a start finishes a switch a crash cut off before the database is looked at, and refuses one it cannot finish", async () => {
  const f = fixture();
  const before = join(f.memoryData, "before-restore-20261006-235959");
  const target = join(f.memoryData, "restore-work", "target");
  mkdirSync(join(target, "assets", "content"), { recursive: true });
  writeFileSync(join(target, "memory.sqlite"), "restored");
  writeFileSync(join(target, "assets", "bara-asset-pairing.json"), "pairing");
  const digest = (text: string) => ({ sha256: createHash("sha256").update(text).digest("hex"), byteSize: Buffer.byteLength(text) });
  const journal: RestoreJournal = { format: 1, stage: "swapping", backup: { kind: "manual", name: MANUAL_OLD, createdAt: "2026-10-01T03:00:00.000Z" },
    startedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), beforePath: before, live: { db: f.db, assets: f.assets },
    expect: { db: digest("restored"), pairing: digest("pairing"), attachments: 0, attachmentBytes: 0 },
    moves: [{ from: f.db, to: join(before, "db", "bara.sqlite") }, { from: `${f.db}-wal`, to: join(before, "db", "bara.sqlite-wal") },
      { from: `${f.db}-shm`, to: join(before, "db", "bara.sqlite-shm") }, { from: f.assets, to: join(before, "assets") },
      { from: join(target, "memory.sqlite"), to: f.db }, { from: join(target, "assets"), to: f.assets }] };
  await writeRestoreJournal(f.paths.dataDir, journal);
  // Cut off after the database left: a start that looked first would find no database and make an empty one.
  mkdirSync(join(before, "db"), { recursive: true });
  const { renameSync } = await import("node:fs");
  renameSync(f.db, join(before, "db", "bara.sqlite"));
  const h = harness(f);
  await h.service.beforeStart();
  expect(read(f.db)).toBe("restored");
  expect(read(join(before, "db", "bara.sqlite-wal"))).toBe("current log");
  expect(f.journal()).toMatchObject({ stage: "swapped" });
  await h.service.started();
  expect(f.journal()).toMatchObject({ stage: "complete" });
  // A switch whose files no longer fit its record is neither finished nor undone, and the start is refused.
  await writeRestoreJournal(f.paths.dataDir, { ...journal, stage: "rolling-back" });
  writeFileSync(join(target, "memory.sqlite"), "something new");
  const error = await rejection(h.service.beforeStart());
  expect(error).toMatchObject({ code: "RESTORE_RECOVERY_FAILED" });
  expect((error as { publicMessage: string }).publicMessage).toContain(before);
  expect(read(f.db)).toBe("restored");
  expect(read(join(before, "db", "bara.sqlite"))).toBe("current database");
});

test("a restore cut off by quitting is marked interrupted at the next start and offered to resume", async () => {
  const f = fixture();
  f.mode({ restore: "hang" });
  const h = harness(f);
  const controller = new AbortController();
  const running = rejection(h.service.restore({ id: await idOf(h, MANUAL_OLD) }, ctx(controller.signal)));
  await restoreRunning(f);
  // Quitting: the drain cancels the request first (that ends only its wait), then the service closes, which stops
  // the restore without starting the server again.
  h.service.drain();
  controller.abort();
  await running;
  expect(h.service.active).toBe(true);
  await h.service.close();
  expect(h.service.active).toBe(false);
  expect(h.events).toEqual(["stop"]);
  expect(f.journal()).toMatchObject({ stage: "cancelled" });
  // The next run of the app: the record still says the old run was restoring (it was cut off before its record).
  await writeRestoreJournal(f.paths.dataDir, { ...f.journal()!, stage: "restoring" });
  const next = harness(f);
  await next.service.beforeStart();
  expect(f.journal()).toMatchObject({ stage: "interrupted" });
  const listing = await next.service.list();
  expect(listing.last).toMatchObject({ outcome: "interrupted", backupName: MANUAL_OLD });
  expect(listing.entries.find((entry) => entry.name === MANUAL_OLD)?.resumable).toBe(true);
  expectUntouched(f);
}, 20_000);

/** Waits until `check` holds, for a job that ends on its own time. */
