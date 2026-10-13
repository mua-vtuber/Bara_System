import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RestoreBackupKind } from "../shared/contracts.ts";

// The restore journal (`<dataDir>/restore-state.json`). Putting a restored store in place moves the current store's
// files aside and the restored ones in, one rename at a time. A crash, a power cut or a forced quit can stop that
// anywhere, so every step is planned and recorded before it is taken, and every start of the local memory server
// reads the record first (`RestoreService.beforeStart`, also once when the service starts) and finishes or undoes a
// switch that was cut off before anything opens the database.
//
// Stages, in order:
// - `restoring`: the restore runs into its own folder; the store has not been touched. A start that finds it (the app
//   ended mid-restore) marks it `interrupted` and starts on the store as it is.
// - `swapping`: the moves are recorded (`moves`, in order) and are being made. A start that finds it makes the moves
//   that are left and checks the result; if a move or the check fails it rolls back instead.
// - `rolling-back`: a switch failed and its moves are being undone, last first. A start that finds it goes on undoing.
// - `swapped`: every move is made and the restored files were checked; the server has not started on them yet.
// - `complete` once the server started on the restored store; `rolled-back`, `interrupted`, `cancelled` and `failed`
//   end a restore that left the store as it was. These are kept only to tell the settings screen how the last one went.
//
// A move is a rename on the same drive (both ends are inside the managed `memory` folder), so it either happened or
// did not. Which moves are made is decided from what is on disk, for the whole plan before anything moves
// (`planForward`, `planBackward`): the source there and the destination free means "not yet", the destination there
// means "done", and a state no prefix of the plan can explain stops everything untouched. Every rename checks its
// two ends again right before it. Nothing is ever overwritten or deleted, so neither direction can lose the store
// from before the restore, and finishing or undoing twice is the same as once.

export const RESTORE_STATE_FILE = "restore-state.json";
export const RESTORE_STAGES = ["restoring", "swapping", "rolling-back", "swapped", "complete", "rolled-back", "interrupted", "cancelled", "failed"] as const;
export type RestoreStage = (typeof RESTORE_STAGES)[number];
/** A record in one of these stages tells how a restore ended; a start has nothing left to do for it. */
const ENDED: ReadonlySet<RestoreStage> = new Set(["complete", "rolled-back", "interrupted", "cancelled", "failed"]);
/** SQLite's companion files of a database (`-wal` holds committed changes not yet copied into the file). */
export const SQLITE_COMPANIONS = ["-wal", "-shm", "-journal"] as const;

export interface RestoreMove { from: string; to: string }
/** What the restored files must be once in place, from the restore's own receipt (`portable-restore.json`). */
export interface RestoreExpect {
  db: { sha256: string; byteSize: number };
  pairing: { sha256: string; byteSize: number };
  attachments: number;
  attachmentBytes: number;
}
export interface RestoreCounts { memories: number; archived: number; attachments: number }

export interface RestoreJournal {
  format: 1;
  stage: RestoreStage;
  backup: { kind: RestoreBackupKind; name: string; createdAt: string };
  startedAt: string;
  updatedAt: string;
  /** The folder the store from before the restore goes to (`memory/before-restore-YYYYMMDD-HHmmss`). */
  beforePath?: string;
  moves?: RestoreMove[];
  /** The live database and attachment folder the moves put the restored files at. */
  live?: { db: string; assets: string };
  expect?: RestoreExpect;
  counts?: RestoreCounts;
  errorCode?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const hashed = (value: unknown) => isObject(value) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) && count(value.byteSize);

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
}

/** A valid record whose every path lies inside `memoryData`, or null. A record naming a path elsewhere is not
 * acted on: the journal only ever moves the managed store's own files. */
export function parseRestoreJournal(value: unknown, memoryData: string): RestoreJournal | null {
  if (!isObject(value) || value.format !== 1 || !RESTORE_STAGES.includes(value.stage as RestoreStage)) return null;
  const backup = value.backup;
  if (!isObject(backup) || (backup.kind !== "manual" && backup.kind !== "pre-update") || typeof backup.name !== "string" ||
      typeof backup.createdAt !== "string") return null;
  if (typeof value.startedAt !== "string" || typeof value.updatedAt !== "string") return null;
  const root = resolve(memoryData);
  const ours = (path: unknown) => typeof path === "string" && isAbsolute(path) && resolve(path) === path && inside(root, path);
  if (value.beforePath !== undefined && !ours(value.beforePath)) return null;
  if (value.moves !== undefined && (!Array.isArray(value.moves) ||
      !value.moves.every((move) => isObject(move) && ours(move.from) && ours(move.to) && move.from !== move.to))) return null;
  if (value.live !== undefined && (!isObject(value.live) || !ours(value.live.db) || !ours(value.live.assets))) return null;
  if (value.expect !== undefined && (!isObject(value.expect) || !hashed(value.expect.db) || !hashed(value.expect.pairing) ||
      !count(value.expect.attachments) || !count(value.expect.attachmentBytes))) return null;
  if (value.counts !== undefined && (!isObject(value.counts) || !count(value.counts.memories) || !count(value.counts.archived) ||
      !count(value.counts.attachments))) return null;
  if (value.errorCode !== undefined && typeof value.errorCode !== "string") return null;
  // A switch needs its plan: without one a start could not tell what to finish or undo.
  if (["swapping", "rolling-back", "swapped"].includes(value.stage as string) &&
      (value.moves === undefined || value.beforePath === undefined || value.live === undefined || value.expect === undefined)) return null;
  return value as unknown as RestoreJournal;
}

/** Windows denies a rename for a moment while a scanner or the search indexer holds a file; such a refusal is tried
 * again a few times (about 16 seconds in all) before it counts as a failure. */
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
export type Rename = (from: string, to: string) => Promise<void>;
export const renameWithRetry: Rename = async (from, to) => {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 8 || !RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await delay(Math.min(100 * 2 ** attempt, 5_000));
    }
  }
};

export function journalPath(dataDir: string): string { return join(dataDir, RESTORE_STATE_FILE); }

/** The record, null when there is none, or "invalid" when the file is there but cannot be used. */
export async function readRestoreJournal(dataDir: string): Promise<RestoreJournal | null | "invalid"> {
  let text: string;
  try { text = await readFile(journalPath(dataDir), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return parseRestoreJournal(JSON.parse(text), join(dataDir, "memory")) ?? "invalid"; } catch { return "invalid"; }
}

/** Writes the record so that a crash leaves either the old or the new one: a new file is written and flushed to the
 * drive, then renamed over the record. */
export async function writeRestoreJournal(dataDir: string, journal: RestoreJournal, rename: Rename = renameWithRetry): Promise<void> {
  const file = journalPath(dataDir);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export class MoveConflict extends Error {
  constructor(readonly path: string, readonly kind: "both" | "neither" | "companion") {
    super(kind === "both" ? `both ends of a move exist: ${path}` : kind === "neither" ? `neither end of a move exists: ${path}`
      : `a database companion file is in the way: ${path}`);
    this.name = "MoveConflict";
  }
}

/** Which of `moves` are left to make, in order, decided from what is on disk before anything moves (so a plan that
 * cannot be finished moves nothing). Moves are made in order, so the ones made are a prefix: a move whose destination
 * is there is made; when its source is there too, that must be because a later move (made as well) put something new
 * at the same path, as the restored database takes the current one's place. A move with its source there and its
 * destination free is left to make; anything else stops the plan. */
function planForward(moves: readonly RestoreMove[], exists: Map<string, boolean>): number[] {
  const state = new Map(exists);
  const todo: number[] = [];
  moves.forEach((move, index) => {
    const [source, target] = [state.get(move.from)!, state.get(move.to)!];
    if (target) {
      if (source && !moves.slice(index + 1).some((later) => later.to === move.from)) throw new MoveConflict(move.to, "both");
      return;
    }
    if (!source) throw new MoveConflict(move.from, "neither");
    todo.push(index);
    state.set(move.from, false); state.set(move.to, true);
  });
  return todo;
}

/** The same for undoing, last move first: a move whose source is back is undone (when its destination is there too,
 * an earlier move's undo put the original back at that path); a move whose destination is there and source free is
 * left to undo. */
function planBackward(moves: readonly RestoreMove[], exists: Map<string, boolean>): number[] {
  const state = new Map(exists);
  const todo: number[] = [];
  for (let index = moves.length - 1; index >= 0; index--) {
    const move = moves[index]!;
    const [source, target] = [state.get(move.from)!, state.get(move.to)!];
    if (source) {
      if (target && !moves.slice(0, index).some((earlier) => earlier.from === move.to)) throw new MoveConflict(move.from, "both");
      continue;
    }
    if (!target) throw new MoveConflict(move.to, "neither");
    todo.push(index);
    state.set(move.to, false); state.set(move.from, true);
  }
  return todo;
}

async function existing(moves: readonly RestoreMove[]): Promise<Map<string, boolean>> {
  const state = new Map<string, boolean>();
  for (const path of moves.flatMap((move) => [move.from, move.to])) if (!state.has(path)) state.set(path, await present(path));
  return state;
}

/** One rename, checked again on disk right before it: the source there, the destination free, and, before a database
 * is put in place, none of its companion files there (SQLite would read another database's write-ahead log into it). */
async function moveOne(from: string, to: string, rename: Rename, database: boolean): Promise<void> {
  if (!(await present(from))) throw new MoveConflict(from, "neither");
  if (await present(to)) throw new MoveConflict(to, "both");
  if (database) for (const suffix of SQLITE_COMPANIONS) if (await present(to + suffix)) throw new MoveConflict(to + suffix, "companion");
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

/** Makes the moves that are not made yet. */
export async function makeMoves(moves: readonly RestoreMove[], rename: Rename = renameWithRetry): Promise<void> {
  for (const index of planForward(moves, await existing(moves))) {
    const move = moves[index]!;
    await moveOne(move.from, move.to, rename, move.to.endsWith(".sqlite"));
  }
}

/** Undoes the moves that are made, last first. */
export async function undoMoves(moves: readonly RestoreMove[], rename: Rename = renameWithRetry): Promise<void> {
  for (const index of planBackward(moves, await existing(moves))) {
    const move = moves[index]!;
    await moveOne(move.to, move.from, rename, false);
  }
}

/** sha256 and size of a file, read as a stream (a database can be gigabytes). */
export async function fileDigest(path: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); byteSize += (chunk as Buffer).byteLength; }
  return { sha256: hash.digest("hex"), byteSize };
}

async function contentFiles(folder: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += (await lstat(join(folder, entry.name))).size;
  }
  return { files, bytes };
}

/** Throws unless the files now at the live paths are the ones the restore checked and published: the database byte
 * for byte, the attachment folder's pairing marker byte for byte (the database records the same pairing number,
 * apps/memory `assets/asset-folder-pairing.ts`), and as many attachment files with as many bytes as it published. */
export async function checkPlaced(live: { db: string; assets: string }, expect: RestoreExpect): Promise<void> {
  const same = (a: { sha256: string; byteSize: number }, b: { sha256: string; byteSize: number }) => a.sha256 === b.sha256 && a.byteSize === b.byteSize;
  if (!same(await fileDigest(live.db), expect.db)) throw new Error("the database in place is not the restored one");
  if (!same(await fileDigest(join(live.assets, "bara-asset-pairing.json")), expect.pairing)) throw new Error("the attachment folder in place is not the restored one");
  const content = expect.attachments === 0 && !(await present(join(live.assets, "content")))
    ? { files: 0, bytes: 0 } : await contentFiles(join(live.assets, "content"));
  if (content.files !== expect.attachments || content.bytes !== expect.attachmentBytes) throw new Error("the attachments in place are not the restored ones");
}

/** Removes the before-restore folder when a rollback left it empty (only empty folders: `rmdir`, never recursive). */
export async function removeIfEmpty(beforePath: string): Promise<void> {
  await rmdir(join(beforePath, "db")).catch(() => {});
  await rmdir(beforePath).catch(() => {});
}

export class SwitchFailed extends Error {
  constructor(readonly original: unknown, readonly rolledBack: boolean) {
    super(rolledBack ? "the switch failed and was rolled back" : "the switch failed and could not be rolled back");
    this.name = "SwitchFailed";
  }
}

/** Puts the restored files in place: records the plan (`swapping`), makes the moves, checks the result and records
 * `swapped`. Any failure undoes the moves made so far (`rolling-back`, then `rolled-back`) and throws `SwitchFailed`;
 * when the undo itself fails the record stays at `rolling-back` for the next start to finish. When even the plan
 * cannot be recorded nothing has moved. */
export async function switchIn(dataDir: string, journal: RestoreJournal, now: () => Date, rename: Rename = renameWithRetry): Promise<RestoreJournal> {
  const at = () => now().toISOString();
  const swapping: RestoreJournal = { ...journal, stage: "swapping", updatedAt: at() };
  await writeRestoreJournal(dataDir, swapping, rename);
  const swapped: RestoreJournal = { ...swapping, stage: "swapped" };
  try {
    await makeMoves(swapping.moves!, rename);
    await checkPlaced(swapping.live!, swapping.expect!);
    // Required: while the record says `swapping` a start would check the database against the restore again, and a
    // server that has since written to it would make that check fail and the switch roll back.
    swapped.updatedAt = at();
    await writeRestoreJournal(dataDir, swapped, rename);
  } catch (error) {
    await rollBack(dataDir, swapping, now, rename, error);
  }
  return swapped;
}

async function rollBack(dataDir: string, journal: RestoreJournal, now: () => Date, rename: Rename, cause: unknown): Promise<never> {
  // The decision is recorded first, so a start after a crash here goes on undoing instead of switching again.
  await writeRestoreJournal(dataDir, { ...journal, stage: "rolling-back", updatedAt: now().toISOString() }, rename).catch(() => {});
  try { await undoMoves(journal.moves!, rename); }
  catch { throw new SwitchFailed(cause, false); }
  await writeRestoreJournal(dataDir, { ...journal, stage: "rolled-back", updatedAt: now().toISOString() }, rename).catch(() => {});
  await removeIfEmpty(journal.beforePath!);
  throw new SwitchFailed(cause, true);
}

export type Recovery = "none" | "interrupted" | "switched" | "rolled-back";

/** What a start does with the record before the store is opened (see the stages above). Throws `SwitchFailed` (not
 * rolled back) when a cut-off switch can be neither finished nor undone: the record then stays as it was, and the
 * start must not go on, since the store may be missing its database and preparation would make a new, empty one. */
export async function recoverRestore(dataDir: string, now: () => Date, rename: Rename = renameWithRetry): Promise<Recovery> {
  const journal = await readRestoreJournal(dataDir);
  if (journal === null || journal === "invalid" || ENDED.has(journal.stage)) return "none";
  const at = () => now().toISOString();
  if (journal.stage === "restoring") {
    await writeRestoreJournal(dataDir, { ...journal, stage: "interrupted", updatedAt: at() }, rename);
    return "interrupted";
  }
  if (journal.stage === "swapped") return "switched";
  if (journal.stage === "rolling-back") {
    try { await undoMoves(journal.moves!, rename); }
    catch (error) { throw new SwitchFailed(error, false); }
    await writeRestoreJournal(dataDir, { ...journal, stage: "rolled-back", updatedAt: at() }, rename);
    await removeIfEmpty(journal.beforePath!);
    return "rolled-back";
  }
  // `swapping`: the restore was checked and published before the switch began, so the switch is finished.
  try {
    await makeMoves(journal.moves!, rename);
    await checkPlaced(journal.live!, journal.expect!);
  } catch (error) {
    try { await rollBack(dataDir, journal, now, rename, error); }
    catch (failed) { if (failed instanceof SwitchFailed && failed.rolledBack) return "rolled-back"; throw failed; }
  }
  await writeRestoreJournal(dataDir, { ...journal, stage: "swapped", updatedAt: at() }, rename);
  return "switched";
}

/** Records that the server started on the restored store (`swapped` → `complete`). Nothing for any other stage. */
export async function markStarted(dataDir: string, now: () => Date): Promise<boolean> {
  const journal = await readRestoreJournal(dataDir).catch(() => null);
  if (journal === null || journal === "invalid" || journal.stage !== "swapped") return false;
  await writeRestoreJournal(dataDir, { ...journal, stage: "complete", updatedAt: now().toISOString() });
  return true;
}
