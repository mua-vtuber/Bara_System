import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkPlaced, markStarted, readRestoreJournal, recoverRestore, RESTORE_STATE_FILE, SwitchFailed, switchIn, writeRestoreJournal,
  type Rename, type RestoreExpect, type RestoreJournal, type RestoreMove } from "./restore-journal.ts";

// The switch and its recovery work on real files in a temporary data folder. A "crash" at a given point is the files
// and the record as the switch left them there; the next start's `recoverRestore` must then finish or undo the switch
// so that the store is whole and nothing is lost.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const NOW = () => new Date("2026-10-07T09:05:03.000Z");

const ORIGINAL = { db: "original database", wal: "original log", shm: "original index", pairing: "{\"format\":1,\"pairingId\":\"old\"}", attachment: "old picture" };
const RESTORED = { db: "restored database", pairing: "{\"format\":1,\"pairingId\":\"new\"}", attachments: { "x.png": "restored picture", "y.pdf": "restored document" } };

interface Fixture { dataDir: string; memoryData: string; live: { db: string; assets: string }; before: string; target: string; moves: RestoreMove[]; journal: RestoreJournal }

const digest = (text: string) => ({ sha256: createHash("sha256").update(text).digest("hex"), byteSize: Buffer.byteLength(text) });

/** A store on this PC (database with its log and index, attachment folder) and a finished restore in its working
 * folder, with the switch planned the way `RestoreService` plans it. */
function fixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "pet-restore-journal-"));
  roots.push(dataDir);
  const memoryData = join(dataDir, "memory");
  const live = { db: join(memoryData, "db", "bara.sqlite"), assets: join(memoryData, "assets") };
  mkdirSync(dirname(live.db), { recursive: true });
  writeFileSync(live.db, ORIGINAL.db); writeFileSync(`${live.db}-wal`, ORIGINAL.wal); writeFileSync(`${live.db}-shm`, ORIGINAL.shm);
  mkdirSync(join(live.assets, "content"), { recursive: true });
  writeFileSync(join(live.assets, "bara-asset-pairing.json"), ORIGINAL.pairing);
  writeFileSync(join(live.assets, "content", "a.png"), ORIGINAL.attachment);
  const target = join(memoryData, "restore-work", "target");
  mkdirSync(join(target, "assets", "content"), { recursive: true });
  writeFileSync(join(target, "memory.sqlite"), RESTORED.db);
  writeFileSync(join(target, "assets", "bara-asset-pairing.json"), RESTORED.pairing);
  for (const [name, text] of Object.entries(RESTORED.attachments)) writeFileSync(join(target, "assets", "content", name), text);
  writeFileSync(join(target, "portable-restore.json"), "{}");
  const before = join(memoryData, "before-restore-20261007-090503");
  const moves: RestoreMove[] = [
    { from: live.db, to: join(before, "db", "bara.sqlite") },
    { from: `${live.db}-wal`, to: join(before, "db", "bara.sqlite-wal") },
    { from: `${live.db}-shm`, to: join(before, "db", "bara.sqlite-shm") },
    { from: live.assets, to: join(before, "assets") },
    { from: join(target, "memory.sqlite"), to: live.db },
    { from: join(target, "assets"), to: live.assets },
  ];
  const attachments = Object.values(RESTORED.attachments);
  const expect: RestoreExpect = { db: digest(RESTORED.db), pairing: digest(RESTORED.pairing), attachments: attachments.length,
    attachmentBytes: attachments.reduce((sum, text) => sum + Buffer.byteLength(text), 0) };
  const journal: RestoreJournal = { format: 1, stage: "restoring", backup: { kind: "manual", name: "bara-backup-20261001-120000", createdAt: "2026-10-01T03:00:00.000Z" },
    startedAt: "2026-10-07T09:00:00.000Z", updatedAt: "2026-10-07T09:00:00.000Z", beforePath: before, moves, live, expect,
    counts: { memories: 3, archived: 1, attachments: 2 } };
  return { dataDir, memoryData, live, before, target, moves, journal };
}

const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
const stage = (f: Fixture) => (JSON.parse(readFileSync(join(f.dataDir, RESTORE_STATE_FILE), "utf8")) as RestoreJournal).stage;
const tree = (folder: string): string[] => !existsSync(folder) ? [] : readdirSync(folder, { recursive: true, encoding: "utf8" }).map(String).sort();

/** The store before the restore, untouched. */
function expectOriginal(f: Fixture): void {
  expect(read(f.live.db)).toBe(ORIGINAL.db);
  expect(read(`${f.live.db}-wal`)).toBe(ORIGINAL.wal);
  expect(read(`${f.live.db}-shm`)).toBe(ORIGINAL.shm);
  expect(read(join(f.live.assets, "bara-asset-pairing.json"))).toBe(ORIGINAL.pairing);
  expect(tree(join(f.live.assets, "content"))).toEqual(["a.png"]);
  // The restored files are back where the restore published them, for a resumed attempt.
  expect(read(join(f.target, "memory.sqlite"))).toBe(RESTORED.db);
  expect(tree(join(f.target, "assets", "content"))).toEqual(["x.png", "y.pdf"]);
}

/** The restored store in place, and every file from before in the before-restore folder. */
function expectSwitched(f: Fixture): void {
  expect(read(f.live.db)).toBe(RESTORED.db);
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(f.live.db + suffix)).toBe(false);
  expect(read(join(f.live.assets, "bara-asset-pairing.json"))).toBe(RESTORED.pairing);
  expect(tree(join(f.live.assets, "content"))).toEqual(["x.png", "y.pdf"]);
  expect(read(join(f.before, "db", "bara.sqlite"))).toBe(ORIGINAL.db);
  expect(read(join(f.before, "db", "bara.sqlite-wal"))).toBe(ORIGINAL.wal);
  expect(read(join(f.before, "db", "bara.sqlite-shm"))).toBe(ORIGINAL.shm);
  expect(read(join(f.before, "assets", "bara-asset-pairing.json"))).toBe(ORIGINAL.pairing);
  expect(read(join(f.before, "assets", "content", "a.png"))).toBe(ORIGINAL.attachment);
}

/** The first `count` moves made, as a crash right after them leaves the files. */
function movesMade(f: Fixture, count: number): void {
  for (const move of f.moves.slice(0, count)) { mkdirSync(dirname(move.to), { recursive: true }); renameSync(move.from, move.to); }
}

/** A rename that fails (like a file Windows keeps locked) for the given moves, by source path. */
function failingFor(paths: (from: string, to: string) => boolean): Rename {
  return async (from, to) => {
    if (paths(from, to)) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: "EPERM" });
    await rename(from, to);
  };
}

test("a switch moves the store aside and the restored one in, and the next start then finds nothing to do", async () => {
  const f = fixture();
  const switched = await switchIn(f.dataDir, f.journal, NOW);
  expect(switched.stage).toBe("swapped");
  expect(stage(f)).toBe("swapped");
  expectSwitched(f);
  // Only the record is written next to the data, never a temporary file left behind.
  expect(readdirSync(f.dataDir).sort()).toEqual(["memory", RESTORE_STATE_FILE]);
  expect(await recoverRestore(f.dataDir, NOW)).toBe("switched");
  expectSwitched(f);
  expect(await markStarted(f.dataDir, NOW)).toBe(true);
  expect(stage(f)).toBe("complete");
  expect(await recoverRestore(f.dataDir, NOW)).toBe("none");
  expect(await markStarted(f.dataDir, NOW)).toBe(false);
  expectSwitched(f);
});

test("a crash at any point of the switch is finished by the next start, and a second recovery changes nothing", async () => {
  for (let made = 0; made <= 6; made++) {
    const f = fixture();
    await writeRestoreJournal(f.dataDir, { ...f.journal, stage: "swapping" });
    movesMade(f, made);
    expect(await recoverRestore(f.dataDir, NOW)).toBe("switched");
    expect(stage(f)).toBe("swapped");
    expectSwitched(f);
    // Idempotent: a crash during the recovery itself, or a second start, finds the switch done.
    await writeRestoreJournal(f.dataDir, { ...f.journal, stage: "swapping" });
    expect(await recoverRestore(f.dataDir, NOW)).toBe("switched");
    expectSwitched(f);
  }
});

test("a crash while the restore was still building its copy leaves the store as it was", async () => {
  const f = fixture();
  await writeRestoreJournal(f.dataDir, f.journal);
  expect(await recoverRestore(f.dataDir, NOW)).toBe("interrupted");
  expect(stage(f)).toBe("interrupted");
  expectOriginal(f);
  expect(await recoverRestore(f.dataDir, NOW)).toBe("none");
});

test("a crash after the switch, before the server started, needs no move: the start then records the restore complete", async () => {
  const f = fixture();
  movesMade(f, 6);
  await writeRestoreJournal(f.dataDir, { ...f.journal, stage: "swapped" });
  expect(await recoverRestore(f.dataDir, NOW)).toBe("switched");
  expectSwitched(f);
  expect(await markStarted(f.dataDir, NOW)).toBe(true);
  expect(stage(f)).toBe("complete");
});

test("a failed move undoes the moves made before it: the store is as it was and the restored copy is kept", async () => {
  for (let failing = 0; failing < 6; failing++) {
    const f = fixture();
    const error = await switchIn(f.dataDir, f.journal, NOW, failingFor((from) => from === f.moves[failing]!.from && !from.includes("before-restore")))
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(SwitchFailed);
    expect((error as SwitchFailed).rolledBack).toBe(true);
    expect(stage(f)).toBe("rolled-back");
    expectOriginal(f);
    // The before-restore folder is removed once empty; nothing else of it was ever there.
    expect(existsSync(f.before)).toBe(false);
  }
});

test("a restored copy that changed before the switch is caught after the moves and the switch is rolled back", async () => {
  const f = fixture();
  writeFileSync(join(f.target, "memory.sqlite"), "not what the restore published");
  const error = await switchIn(f.dataDir, f.journal, NOW).then(() => null, (reason: unknown) => reason);
  expect(error).toMatchObject({ rolledBack: true });
  expect(read(f.live.db)).toBe(ORIGINAL.db);
  expect(read(join(f.target, "memory.sqlite"))).toBe("not what the restore published");
  expect(stage(f)).toBe("rolled-back");
});

test("a database is never put in place over another database's log: an unplanned companion file stops the switch", async () => {
  const f = fixture();
  // The plan was made without the log, which appeared afterwards.
  const moves = f.moves.filter((move) => !move.from.endsWith("-wal"));
  const error = await switchIn(f.dataDir, { ...f.journal, moves }, NOW).then(() => null, (reason: unknown) => reason);
  expect(error).toMatchObject({ rolledBack: true });
  expectOriginal(f);
});

test("an undo that fails too is left recorded as rolling back, and the next start finishes it", async () => {
  const f = fixture();
  let failUndo = true;
  // The restored database cannot be moved in; then the original database cannot be moved back either.
  const rename = failingFor((from, to) => from === f.moves[4]!.from || (failUndo && to === f.live.db));
  const error = await switchIn(f.dataDir, f.journal, NOW, rename).then(() => null, (reason: unknown) => reason);
  expect(error).toMatchObject({ rolledBack: false });
  expect(stage(f)).toBe("rolling-back");
  // Nothing was deleted: the original database waits in the before-restore folder.
  expect(read(join(f.before, "db", "bara.sqlite"))).toBe(ORIGINAL.db);
  expect(existsSync(f.live.db)).toBe(false);
  failUndo = false;
  expect(await recoverRestore(f.dataDir, NOW)).toBe("rolled-back");
  expect(stage(f)).toBe("rolled-back");
  expectOriginal(f);
});

test("a crash at any point of a rollback is finished by the next start", async () => {
  for (let undone = 0; undone <= 6; undone++) {
    const f = fixture();
    movesMade(f, 6);
    for (const move of [...f.moves].reverse().slice(0, undone)) renameSync(move.to, move.from);
    await writeRestoreJournal(f.dataDir, { ...f.journal, stage: "rolling-back" });
    expect(await recoverRestore(f.dataDir, NOW)).toBe("rolled-back");
    expectOriginal(f);
    expect(await recoverRestore(f.dataDir, NOW)).toBe("none");
  }
});

test("a switch that can be neither finished nor undone stops the start and touches nothing", async () => {
  const f = fixture();
  await writeRestoreJournal(f.dataDir, { ...f.journal, stage: "swapping" });
  movesMade(f, 1);
  // Something made a new database where the original one was moved away from.
  writeFileSync(f.live.db, "an empty database made meanwhile");
  const error = await recoverRestore(f.dataDir, NOW).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(SwitchFailed);
  expect((error as SwitchFailed).rolledBack).toBe(false);
  expect(read(join(f.before, "db", "bara.sqlite"))).toBe(ORIGINAL.db);
  expect(read(f.live.db)).toBe("an empty database made meanwhile");
  expect(stage(f)).toBe("rolling-back");
});

test("a record naming paths outside the managed store, or not a record at all, moves nothing", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "pet-restore-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "precious"), "keep");
  await writeRestoreJournal(f.dataDir, { ...f.journal, stage: "swapping", moves: [{ from: join(outside, "precious"), to: join(f.memoryData, "stolen") }] });
  expect(await readRestoreJournal(f.dataDir)).toBe("invalid");
  expect(await recoverRestore(f.dataDir, NOW)).toBe("none");
  expect(read(join(outside, "precious"))).toBe("keep");
  writeFileSync(join(f.dataDir, RESTORE_STATE_FILE), "\0\0\0\0");
  expect(await recoverRestore(f.dataDir, NOW)).toBe("none");
  // A switch without its plan cannot be finished or undone, so it is not acted on either.
  const { moves: _moves, ...planless } = f.journal;
  await writeRestoreJournal(f.dataDir, { ...planless, stage: "swapping" } as RestoreJournal);
  expect(await readRestoreJournal(f.dataDir)).toBe("invalid");
  expectOriginal(f);
});

test("the placed files are checked byte for byte against the restore's receipt", async () => {
  const f = fixture();
  movesMade(f, 6);
  await checkPlaced(f.live, f.journal.expect!);
  await expect(checkPlaced(f.live, { ...f.journal.expect!, attachments: 3 })).rejects.toThrow();
  await expect(checkPlaced(f.live, { ...f.journal.expect!, pairing: digest(ORIGINAL.pairing) })).rejects.toThrow();
  writeFileSync(join(f.live.assets, "content", "x.png"), "changed");
  await expect(checkPlaced(f.live, f.journal.expect!)).rejects.toThrow();
});
