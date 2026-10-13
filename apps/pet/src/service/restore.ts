import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackupJobState, LastRestore, RequestContext, RestoreBackupKind, RestoreEntry, RestoreListing, RestoreResult,
  RuntimePaths } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { BACKUP_MARGIN_BYTES, failureCause, localStamp, managedSources, memoryApp, PORTABLE_RESULT_MAX_BYTES,
  uniqueDestination } from "./backup.ts";
import { BackgroundJob } from "./background-job.ts";
import type { ConfigStore } from "./config.ts";
import { fitted, serviceError } from "./errors.ts";
import { causeOf } from "./fetch-failure.ts";
import { publicError } from "./protocol.ts";
import { bytesUnder, freeBytesAt, type FreeSpace } from "./install/disk-space.ts";
import { MODEL_PREFETCH_IDLE_MS } from "./install/limits.ts";
import { runCaptured } from "./install/process.ts";
import { parseProgressLine, PROGRESS_LINES_ENV } from "./install/progress-line.ts";
import type { RemoteRestoreSource } from "./install/remote-restore.ts";
import { managedDatabase, PRE_UPDATE_FOLDER, UPDATE_BACKUP_FILE, VERIFY_TIMEOUT_MS } from "./maintenance/upgrade.ts";
import { markStarted, readRestoreJournal, recoverRestore, renameWithRetry, SQLITE_COMPANIONS, SwitchFailed, switchIn,
  writeRestoreJournal, type Rename, type RestoreCounts, type RestoreExpect, type RestoreJournal, type RestoreMove } from "./restore-journal.ts";

// Restoring the store kept on this PC from a backup (`backup.list`, `backup.restore`). The order keeps the current
// memories untouched until the restored ones are complete and checked:
//
// 1. The chosen backup is found again by its id in a fresh listing (the screen never sends a path). From this moment
//    until the restore ends, a save is refused (it answers that it was not saved and its text stays in the input box),
//    and so is every other request that needs the server and a start of the local server (`RESTORE_RUNNING`).
// 2. The memory server is stopped at once, in the connection queue, so work already talking to it finishes first. It
//    stays stopped for the whole restore, the checks below included: a memory saved while the restore runs would be
//    in the store that is about to be moved aside, so it would vanish from the restored store without a word.
// 3. The backup is read back with `portable-memory.ts verify`, the drive is checked for room, and the models the
//    restore needs are fetched or checked (`prefetch-core-models.ts`, as the installer runs it). Nothing has changed.
// 4. `portable-memory.ts restore` builds the restored store in `memory/restore-work/target`, on the store's own drive
//    so the switch is renames. It recomputes every search vector, so it can take long; its checkpoints let a restore
//    that was cancelled, failed or cut off go on from where it stopped when the same backup is chosen again.
// 5. The counts it restored are compared with the backup's manifest, then the switch (`restore-journal.ts`) moves the
//    current database (with its companion files) and attachment folder into `memory/before-restore-<time>` and the
//    restored ones in, recorded step by step. The restored attachment folder moves as a whole: it carries the new
//    pairing marker its database records (apps/memory `assets/asset-folder-pairing.ts`).
// 6. The server starts through the normal connection path (preparation, then start). The folder with the previous
//    memories is kept; only the user removes it.
//
// A cancel or failure before the switch restarts the server on the untouched store (not when the app is quitting).
// The restore is the service's job (`BackgroundJob`), not the request's: a screen that leaves ends only its wait, a
// settings screen opened again joins it (`backup.status`, `backup.join`), and only `cancel` (the screen's "중단") or
// quitting stops it. Settings, sign-in tokens, AI keys and drafts are files and storage this never touches.

export const RESTORE_WORK_FOLDER = "restore-work";
const JOB_FILE = "job.json";
const TARGET = "target";
const BEFORE_PREFIX = "before-restore-";
const MANUAL_FOLDER = /^bara-backup-\d{8}-\d{6}(?:-\d+)?$/;
/** Entries listed, newest first; older backups are left out of the screen's list. */
export const RESTORE_LIST_LIMIT = 100;
/** The restore writes a progress line for every batch of 8 vectors, every attachment and every phase, so a long
 * silence means it hangs. The longest quiet stretches are loading a model from disk and checking all rows at the
 * end in one pass, both minutes at most; this only stops a run that is stuck, not a long one. */
export const RESTORE_IDLE_MS = 30 * 60_000;
/** Bytes the restored database takes per search-index row beyond the rows themselves, derived from the schema's
 * vector sizes: a text vector is bge-m3's 1024 float32 values (4,096 bytes), an image or concept-name vector
 * SigLIP's 768 (3,072 bytes). Each is counted twice, for sqlite-vec's chunk tables and rowid maps and for the
 * full-text and trigram indexes the same rows get. */
export const TEXT_INDEX_ALLOWANCE = 2 * 1024 * 4;
export const IMAGE_INDEX_ALLOWANCE = 2 * 768 * 4;
/** Collections that get a text vector (`apps/memory/src/portable/restore-indexes.ts` `families`). Images are among
 * `memories` too; counting them twice only asks for more room. */
const TEXT_INDEXED = ["memories", "concepts", "people", "entities", "chunkSummaries", "relationSummaries"];
const IMAGE_INDEXED = ["concepts", "images"];

/** The manifest fields read from a backup (apps/memory `src/portable/format.ts` `PortableManifestV1`). */
interface ArchiveManifest { createdAt: string; collections: Record<string, { count: number }>; attachments: Array<{ byteSize: number }> }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseManifest(value: unknown): ArchiveManifest | null {
  if (!isObject(value) || value.format !== "bara-memory" || value.version !== 1 || typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt)) || !isObject(value.collections) || !Array.isArray(value.attachments)) return null;
  const collections = value.collections as Record<string, unknown>;
  if (!Object.values(collections).every((entry) => isObject(entry) && Number.isSafeInteger(entry.count) && (entry.count as number) >= 0) ||
      !collections.memories) return null;
  if (!value.attachments.every((entry) => isObject(entry) && Number.isSafeInteger(entry.byteSize))) return null;
  return value as unknown as ArchiveManifest;
}

const countOf = (manifest: ArchiveManifest, name: string) => manifest.collections[name]?.count ?? 0;
export function manifestCounts(manifest: ArchiveManifest): RestoreCounts {
  return { memories: countOf(manifest, "memories"), archived: countOf(manifest, "archivedMemories"), attachments: manifest.attachments.length };
}

/** Free bytes a restore of `archiveBytes` (the backup folder, attachments included) needs on the store's drive: the
 * restored database (about the backup's rows plus its search indexes, `TEXT_INDEX_ALLOWANCE`) and attachments, twice,
 * since the restore builds them in its working folder and then publishes a copy beside it before removing the first,
 * plus a margin. The switch itself is renames and takes no room. */
export function restoreSpaceNeeded(archiveBytes: number, manifest: ArchiveManifest): number {
  const rows = (names: string[]) => names.reduce((sum, name) => sum + countOf(manifest, name), 0);
  const restored = archiveBytes + rows(TEXT_INDEXED) * TEXT_INDEX_ALLOWANCE + rows(IMAGE_INDEXED) * IMAGE_INDEX_ALLOWANCE;
  return 2 * restored + BACKUP_MARGIN_BYTES;
}

/** The opaque id of a backup: its kind and folder name (unique under that kind's folder), hashed. */
export function entryId(kind: RestoreBackupKind, name: string): string {
  return createHash("sha256").update(`${kind}\0${name}`).digest("hex").slice(0, 32);
}

/** The model folders the core's scripts use, derived from the managed data root exactly as `managed-prepare` hands
 * them to the server (`BARA_HF_CACHE_DIR`, `BARA_KIWI_MODEL_DIR`), without running it: it would open the database. */
export function modelEnv(memoryData: string): Record<string, string> {
  return { BARA_HF_CACHE_DIR: join(memoryData, "models", "hf-cache"), BARA_KIWI_MODEL_DIR: join(memoryData, "models", "kiwi-model") };
}

/** The last stdout line as JSON, or null. */
function lastJson(stdout: string): unknown {
  try { return JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { return null; }
}

async function realFolder(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => null);
  return !!stats?.isDirectory() && !stats.isSymbolicLink();
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

interface Found extends Omit<RestoreEntry, "resumable"> { archive: string }
interface Job { format: 1; entryId: string; archive: string; fingerprint: string; appVersion: string }
interface Verified { fingerprint: string; manifest: ArchiveManifest }

export type RestoreBlocker = "RESTORE_UPDATE_RUNNING" | "RESTORE_BACKUP_RUNNING" | "RESTORE_CONNECTION_BUSY";

/** What the restore needs from the rest of the service (`router.ts`). */
export interface RestoreDeps {
  /** Runs `work` in the connection queue, after the connection work before it (`PetService.withConnection`). */
  exclusive<T>(ctx: RequestContext, work: () => Promise<T>): Promise<T>;
  /** Stops the local memory server and waits until it has released the store's files. */
  stopServer(): Promise<void>;
  /** Starts the local memory server through the normal connection path (`InstallManager.ensureConnection`). */
  startServer(ctx: RequestContext): Promise<void>;
  /** Why a restore cannot start now (an update is being finished, a backup is being made, connection work or the
   * startup check runs), or null. */
  blocker(): RestoreBlocker | null;
}

export interface RestoreOptions {
  /** This app's version: a restore cut off by another version is not resumed (its model or recipe may differ). */
  appVersion: string;
  /** Tests pass a fixed reading, clock and rename. */
  freeSpace?: FreeSpace;
  now?: () => Date;
  rename?: Rename;
}

export class RestoreService {
  private readonly job: BackgroundJob<RestoreResult>;
  /** A restore holds the server: it is stopped (or about to be), saves and starts are refused until it ends. */
  private holding = false;
  /** The app is quitting (`service.drain` began): a restore that ends now does not start the server again. */
  private quitting = false;
  private readonly closing = new AbortController();
  private readonly memoryData: string;
  private readonly work: string;
  private readonly target: string;
  private readonly freeSpace: FreeSpace;
  private readonly now: () => Date;
  private readonly rename: Rename;

  constructor(private readonly config: Pick<ConfigStore, "load">, private readonly paths: RuntimePaths,
    private readonly deps: RestoreDeps, private readonly options: RestoreOptions) {
    this.memoryData = join(paths.dataDir, "memory");
    this.work = join(this.memoryData, RESTORE_WORK_FOLDER);
    this.target = join(this.work, TARGET);
    this.freeSpace = options.freeSpace ?? freeBytesAt;
    this.now = options.now ?? (() => new Date());
    this.rename = options.rename ?? renameWithRetry;
    this.job = new BackgroundJob<RestoreResult>(messages.restore.cancelled, this.now);
  }

  /** A restore runs (from its start until the server started again). */
  get active(): boolean { return this.job.running; }
  /** A restore holds the server stopped: from its start until its switch is done or it gave up. */
  get holdingServer(): boolean { return this.holding; }

  /** `backup.list`: the backups a restore can use, newest first, and how the last restore ended. `remote-install` is the
   * remote install's "백업에서 시작" list (spec 4.1): it needs no store on this PC and offers no resume and no last
   * restore. The restore button's own rule (a finished install on this PC) is unchanged. */
  async list(scope: "restore" | "remote-install" = "restore"): Promise<RestoreListing> {
    if (scope === "remote-install")
      return { entries: (await this.entries()).map(({ archive: _archive, ...entry }) => ({ ...entry, resumable: false })), last: null };
    await this.assertLocalStore();
    const job = await this.readJob();
    const resumable = job !== null && job.appVersion === this.options.appVersion && await realFolder(this.work) ? job.entryId : null;
    const entries = (await this.entries()).map(({ archive: _archive, ...entry }) => ({ ...entry, resumable: entry.id === resumable }));
    return { entries, last: await this.lastRestore() };
  }

  /** `install.remote` with "백업에서 시작": the chosen backup found again by its id and read back on this PC before
   * anything is uploaded (spec 4.2). Needs no store on this PC; restoring on this PC stays `restore`'s alone. */
  async remoteSource(id: unknown, ctx: RequestContext): Promise<RemoteRestoreSource> {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw serviceError("RESTORE_BACKUP_MISSING", messages.restoreErrors.RESTORE_BACKUP_MISSING);
    const entry = (await this.entries()).find((found) => found.id === id);
    if (!entry) throw serviceError("RESTORE_BACKUP_MISSING", messages.restoreErrors.RESTORE_BACKUP_MISSING);
    ctx.progress("restore-verify");
    const verified = await this.verify(entry.archive, ctx);
    return { id: entry.id, name: entry.name, archive: entry.archive, fingerprint: verified.fingerprint, counts: manifestCounts(verified.manifest) };
  }

  /** `backup.restore`: see the order at the top of this file. The answer is the starting caller's wait on the job. */
  async restore(params: Record<string, unknown>, ctx: RequestContext): Promise<RestoreResult> {
    const id = params.id;
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw serviceError("RESTORE_BACKUP_MISSING", messages.restoreErrors.RESTORE_BACKUP_MISSING);
    this.assertStartable();
    if ((await this.config.load()).connection.mode !== "local")
      throw serviceError("RESTORE_NOT_LOCAL", messages.restoreErrors.RESTORE_NOT_LOCAL);
    const entry = (await this.entries()).find((found) => found.id === id);
    if (!entry) throw serviceError("RESTORE_BACKUP_MISSING", messages.restoreErrors.RESTORE_BACKUP_MISSING);
    // Again: another restore, a backup or connection work may have begun while the list was read.
    this.assertStartable();
    this.holding = true;
    return this.job.start(async (jobCtx) => {
      try { return await this.run(entry, jobCtx); } finally { this.holding = false; }
    }, ctx);
  }

  /** `backup.status`: the restore that runs, or how the last one ended when no screen has seen it yet. */
  status(): BackupJobState<RestoreResult> | null { return this.job.snapshot(); }
  /** `backup.join`: waits for the restore that runs (its latest stage first), or receives how the last one ended. */
  join(ctx: RequestContext): Promise<RestoreResult> { return this.job.join(ctx); }
  /** `backup.cancel`: the screen's "중단". Stops the restore up to its switch; the switch and the start after it go on. */
  cancel(): boolean { return this.job.cancel(); }

  private assertStartable(): void {
    if (this.job.running) throw serviceError("RESTORE_BUSY", messages.restoreErrors.RESTORE_BUSY);
    const blocker = this.deps.blocker();
    if (blocker) throw serviceError(blocker, messages.restoreErrors[blocker]);
  }

  /** Runs before every start of the local server looks at the store (`InstallManager`'s start gate): refuses while a
   * restore holds the server stopped, and otherwise finishes or undoes a switch a crash cut off. */
  async beforeStart(): Promise<void> {
    if (this.holding) throw serviceError("RESTORE_RUNNING", messages.restoreErrors.RESTORE_RUNNING);
    await this.recover();
  }

  /** The local server started: a switched store is now in use (`complete`). */
  async started(): Promise<void> { await markStarted(this.paths.dataDir, this.now).catch(() => false); }

  /** Quitting began (`service.drain`): running work may still finish, but a restore that ends from now on leaves the
   * server stopped instead of starting it again; the quit closes what runs. */
  drain(): void { this.quitting = true; }

  /** Quitting: a restart after a stopped restore is not begun any more, then a restore still running is stopped (its
   * record says cancelled, so the next start offers to resume it) and given a moment to end. */
  async close(): Promise<void> {
    this.quitting = true;
    this.closing.abort();
    await this.job.close();
  }

  private async recover(): Promise<void> {
    try { await recoverRestore(this.paths.dataDir, this.now, this.rename); }
    catch (error) {
      const journal = await readRestoreJournal(this.paths.dataDir).catch(() => null);
      const before = journal && journal !== "invalid" ? journal.beforePath ?? null : null;
      const cause = error instanceof SwitchFailed ? error.original : error;
      throw serviceError("RESTORE_RECOVERY_FAILED", fitted((text) => messages.restoreErrors.RESTORE_RECOVERY_FAILED(text, before), causeOf(cause)));
    }
  }

  /** Only a finished local install has a store this PC holds (the same rule as the settings backup). */
  private async assertLocalStore(): Promise<{ db: string; assets: string }> {
    if ((await this.config.load()).connection.mode !== "local")
      throw serviceError("RESTORE_NOT_LOCAL", messages.restoreErrors.RESTORE_NOT_LOCAL);
    const notReady = () => serviceError("RESTORE_NOT_READY", messages.restoreErrors.RESTORE_NOT_READY);
    const journal = await readJson(join(this.memoryData, "managed-install.json")) as { phase?: unknown } | null;
    if (journal?.phase !== "complete") throw notReady();
    let sources: { db: string; assets: string };
    try { sources = await managedSources(this.memoryData); }
    catch { throw serviceError("RESTORE_SETTINGS_INVALID", messages.restoreErrors.RESTORE_SETTINGS_INVALID); }
    // The switch moves the managed database `managed-prepare` requires; settings naming another file are not this store.
    if (resolve(sources.db) !== managedDatabase(this.paths.dataDir))
      throw serviceError("RESTORE_SETTINGS_INVALID", messages.restoreErrors.RESTORE_SETTINGS_INVALID);
    if ((await lstat(sources.db).catch(() => null))?.isFile() !== true) throw notReady();
    return sources;
  }

  /** The backups on disk: the settings backups under the host's backup folder (`bara-backup-*` with `manifest.json`)
   * and the finished pre-update backups (`memory/backups/pre-update/*` with `update-backup.json` and `portable/`).
   * Anything else there, a link, or a folder whose records cannot be read is left out. */
  private async entries(): Promise<Found[]> {
    const found: Found[] = [];
    const folders = async (root: string, pattern: RegExp) => {
      let names: string[];
      try { names = await readdir(root); } catch { return []; }
      const real: string[] = [];
      for (const name of names) if (pattern.test(name) && await realFolder(join(root, name))) real.push(name);
      return real;
    };
    const add = async (kind: RestoreBackupKind, name: string, archive: string, createdAt: string | null) => {
      if (!(await realFolder(archive))) return;
      const manifest = parseManifest(await readJson(join(archive, "manifest.json")));
      if (!manifest) return;
      const counts = manifestCounts(manifest);
      found.push({ id: entryId(kind, name), kind, name, archive, createdAt: createdAt ?? manifest.createdAt,
        memories: counts.memories, attachments: counts.attachments });
    };
    if (this.paths.backupDir) {
      for (const name of await folders(this.paths.backupDir, MANUAL_FOLDER)) await add("manual", name, join(this.paths.backupDir, name), null);
    }
    const preUpdate = join(this.memoryData, "backups", "pre-update");
    for (const name of await folders(preUpdate, PRE_UPDATE_FOLDER)) {
      const record = await readJson(join(preUpdate, name, UPDATE_BACKUP_FILE)) as { format?: unknown; createdAt?: unknown } | null;
      if (record?.format !== 1 || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) continue;
      await add("pre-update", name, join(preUpdate, name, "portable"), record.createdAt);
    }
    found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
    return found.slice(0, RESTORE_LIST_LIMIT);
  }

  private async lastRestore(): Promise<LastRestore | null> {
    const journal = await readRestoreJournal(this.paths.dataDir).catch(() => null);
    if (journal === null || journal === "invalid") return null;
    const outcome = journal.stage === "complete" || journal.stage === "swapped" || journal.stage === "rolled-back" ||
      journal.stage === "interrupted" ? journal.stage : null;
    if (outcome === null) return null;
    const switched = outcome === "complete" || outcome === "swapped";
    return { outcome, at: journal.updatedAt, backupName: journal.backup.name, beforeFolder: switched ? journal.beforePath ?? null : null,
      memories: switched ? journal.counts?.memories ?? null : null, attachments: switched ? journal.counts?.attachments ?? null : null };
  }

  private async readJob(): Promise<Job | null> {
    const value = await readJson(join(this.work, JOB_FILE)) as Partial<Job> | null;
    if (!value || value.format !== 1 || typeof value.entryId !== "string" || typeof value.archive !== "string" ||
        typeof value.fingerprint !== "string" || typeof value.appVersion !== "string") return null;
    return value as Job;
  }

  /** Removes the working folder of an earlier restore (another backup, another version, or no record of its own).
   * Only the managed store's own `restore-work` folder, never through a link. */
  private async discardWork(): Promise<void> {
    const stats = await lstat(this.work).catch(() => null);
    if (!stats) return;
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("restore working folder is not a folder");
    await rm(this.work, { recursive: true, force: true });
  }

  private async run(entry: Found, ctx: RequestContext): Promise<RestoreResult> {
    const at = () => this.now().toISOString();
    let base: RestoreJournal | null = null;
    let switched: RestoreJournal | null = null;
    let counts: RestoreCounts, resume: boolean;
    try {
      // First, before any check that can take minutes (the model download): from the restore's start on, saves are
      // refused (`holding`), and the server stops in the connection queue so a request already talking to it finishes.
      await this.deps.exclusive(ctx, () => this.deps.stopServer());
      // A switch an earlier run left half done is finished or undone first; the store must be whole before it moves.
      await this.recover();
      const sources = await this.assertLocalStore();
      ctx.progress("restore-verify");
      const verified = await this.verify(entry.archive, ctx);
      counts = manifestCounts(verified.manifest);
      const job = await this.readJob();
      resume = job !== null && job.entryId === entry.id && job.archive === entry.archive && job.fingerprint === verified.fingerprint &&
        job.appVersion === this.options.appVersion && await realFolder(this.work);
      await this.assertSpace(entry.archive, verified.manifest, resume);
      ctx.signal.throwIfAborted();
      if (!resume) {
        try { await this.discardWork(); }
        catch (error) { throw serviceError("RESTORE_FAILED", fitted(messages.restoreErrors.RESTORE_FAILED, causeOf(error))); }
      }
      await this.prefetch(ctx);
      ctx.signal.throwIfAborted();
      const record: RestoreJournal = base = { format: 1, stage: "restoring", backup: { kind: entry.kind, name: entry.name, createdAt: entry.createdAt },
        startedAt: at(), updatedAt: at(), counts };
      try {
        await writeRestoreJournal(this.paths.dataDir, record, this.rename);
        await mkdir(this.work, { recursive: true });
        await writeFile(join(this.work, JOB_FILE), JSON.stringify({ format: 1, entryId: entry.id, archive: entry.archive,
          fingerprint: verified.fingerprint, appVersion: this.options.appVersion } satisfies Job));
      } catch (error) {
        throw await this.ended(record, serviceError("RESTORE_STATE_UNWRITABLE", fitted(messages.restoreErrors.RESTORE_STATE_UNWRITABLE, causeOf(error))));
      }
      const expect = await this.restoreInto(entry.archive, record, counts, ctx);
      ctx.progress("restore-switch");
      const beforePath = await uniqueDestination(this.memoryData, `${BEFORE_PREFIX}${localStamp(this.now())}`);
      if (beforePath === null) throw await this.ended(record, serviceError("RESTORE_SWITCH_FAILED", messages.restoreErrors.RESTORE_SWITCH_FAILED(undefined)));
      const live = { db: managedDatabase(this.paths.dataDir), assets: join(this.memoryData, "assets") };
      try {
        switched = await switchIn(this.paths.dataDir, { ...record, beforePath, moves: await this.plan(sources.db, live, beforePath), live, expect },
          this.now, this.rename);
      } catch (error) {
        if (error instanceof SwitchFailed && !error.rolledBack)
          throw serviceError("RESTORE_ROLLBACK_FAILED", fitted((text) => messages.restoreErrors.RESTORE_ROLLBACK_FAILED(text, beforePath), causeOf(error.original)));
        throw serviceError("RESTORE_SWITCH_FAILED", fitted(messages.restoreErrors.RESTORE_SWITCH_FAILED,
          causeOf(error instanceof SwitchFailed ? error.original : error)));
      }
      // The working folder now holds only the restore's receipt; the store from before is in `beforePath`.
      await this.discardWork().catch(() => {});
    } catch (error) {
      // The store is as it was (or a start will finish undoing the switch): the server comes back on it. The record
      // says how this run ended first, so that start does not take it for a restore a crash cut off.
      if (base) await this.settle(base, error, ctx);
      this.holding = false;
      await this.restart();
      throw error;
    }
    this.holding = false;
    ctx.progress("server");
    // Started on the service's own signal: the switch is done, so a late cancel must not leave the server stopped.
    const startCtx: RequestContext = { signal: this.closing.signal, progress: ctx.progress };
    try { await this.deps.exclusive(startCtx, () => this.deps.startServer(startCtx)); }
    catch (error) {
      throw serviceError("RESTORE_START_FAILED", fitted((text) => messages.restoreErrors.RESTORE_START_FAILED(text, switched!.beforePath!),
        failureCause(error) ?? causeOf(error)));
    }
    return { backupName: entry.name, kind: entry.kind, ...counts, beforeFolder: switched.beforePath!, resumed: resume };
  }

  /** Reads the backup back (`portable-memory.ts verify`): every collection's hash and count, the references and every
   * attachment's bytes. Nothing changes until it passes. */
  private async verify(archive: string, ctx: RequestContext): Promise<Verified> {
    let stdout: string;
    try {
      ({ stdout } = await runCaptured([this.paths.bunPath, "scripts/portable-memory.ts", "verify", "--archive", archive], ctx,
        { cwd: memoryApp(this.paths), timeoutMs: VERIFY_TIMEOUT_MS, stepName: messages.restore.verifyStep, maxStdoutBytes: PORTABLE_RESULT_MAX_BYTES }));
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      throw serviceError("RESTORE_VERIFY_FAILED", fitted(messages.restoreErrors.RESTORE_VERIFY_FAILED, failureCause(error)));
    }
    const result = lastJson(stdout) as { valid?: unknown; fingerprint?: unknown; manifest?: unknown } | null;
    const manifest = parseManifest(result?.manifest);
    if (result?.valid !== true || typeof result.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(result.fingerprint) || !manifest)
      throw serviceError("RESTORE_VERIFY_FAILED", messages.restoreErrors.RESTORE_VERIFY_FAILED(messages.restore.verifyUnreadable));
    return { fingerprint: result.fingerprint, manifest };
  }

  /** Stops with `RESTORE_DISK_LOW` before anything changes when the store's drive cannot take the restore
   * (`restoreSpaceNeeded`). A resumed restore already holds part of that in its working folder; a fresh one frees what
   * an earlier one left. A drive that cannot be read is not a reason to block. */
  private async assertSpace(archive: string, manifest: ArchiveManifest, resume: boolean): Promise<void> {
    const free = await this.freeSpace(this.memoryData);
    if (free === null) return;
    const kept = await bytesUnder(this.work);
    const available = resume ? free : free + kept;
    const needed = Math.max(0, restoreSpaceNeeded(await bytesUnder(archive), manifest) - (resume ? kept : 0));
    if (available < needed) throw serviceError("RESTORE_DISK_LOW", messages.restoreErrors.RESTORE_DISK_LOW(needed - available, available));
  }

  /** The models the restore computes vectors with, fetched (or found in the cache) the way the installer does, with
   * its download progress. The server still runs: this reads and writes only the model cache. */
  private async prefetch(ctx: RequestContext): Promise<void> {
    ctx.progress("models");
    try {
      await runCaptured([this.paths.bunPath, "scripts/prefetch-core-models.ts"], ctx, {
        cwd: memoryApp(this.paths), env: { ...modelEnv(this.memoryData), [PROGRESS_LINES_ENV]: "1" },
        idleTimeoutMs: MODEL_PREFETCH_IDLE_MS, stepName: messages.restore.modelsStep,
        onLine: (line) => { const detail = parseProgressLine(line); if (detail) ctx.progress("models", detail); return detail !== null; },
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      throw serviceError("RESTORE_MODELS_FAILED", fitted(messages.restoreErrors.RESTORE_MODELS_FAILED, failureCause(error)));
    }
  }

  /** Runs `portable-memory.ts restore` into the working folder (always `--resume`: it starts fresh when there is
   * nothing to resume, and a working folder from another backup was removed before) and checks what it restored
   * against the backup's manifest. Returns what the switch must find in place. A failure or cancel is recorded and
   * leaves the working folder for the next attempt. */
  private async restoreInto(archive: string, base: RestoreJournal, counts: RestoreCounts, ctx: RequestContext): Promise<RestoreExpect> {
    ctx.progress("restore-data");
    let stdout: string;
    try {
      ({ stdout } = await runCaptured([this.paths.bunPath, "scripts/portable-memory.ts", "restore", "--archive", archive,
        "--out", this.target, "--model", "bge-m3", "--resume"], ctx, { cwd: memoryApp(this.paths), env: modelEnv(this.memoryData),
        idleTimeoutMs: RESTORE_IDLE_MS, stepName: messages.restore.restoreStep, maxStdoutBytes: PORTABLE_RESULT_MAX_BYTES }));
    } catch (error) {
      if (ctx.signal.aborted) { await this.record(base, "cancelled"); throw error; }
      throw await this.ended(base, serviceError("RESTORE_FAILED", fitted(messages.restoreErrors.RESTORE_FAILED, failureCause(error))));
    }
    const report = lastJson(stdout) as { dbPath?: unknown; assetDir?: unknown; counts?: Record<string, unknown> } | null;
    const receipt = await readJson(join(this.target, "portable-restore.json")) as { status?: unknown; files?: unknown } | null;
    const files = isObject(receipt?.files) ? receipt.files as Record<string, { sha256?: unknown; byteSize?: unknown }> : null;
    const digest = (name: string) => {
      const file = files?.[name];
      return file && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.byteSize)
        ? { sha256: file.sha256, byteSize: file.byteSize as number } : null;
    };
    const db = digest("memory.sqlite"), pairing = digest("assets/bara-asset-pairing.json");
    if (!report || report.dbPath !== join(this.target, "memory.sqlite") || report.assetDir !== join(this.target, "assets") ||
        !isObject(report.counts) || receipt?.status !== "complete" || !files || !db || !pairing)
      throw await this.ended(base, serviceError("RESTORE_RESULT_UNREADABLE", messages.restoreErrors.RESTORE_RESULT_UNREADABLE));
    const attachments = Object.keys(files).filter((name) => name.startsWith("assets/content/"));
    const attachmentBytes = attachments.reduce((sum, name) => sum + (digest(name)?.byteSize ?? 0), 0);
    if (report.counts.memories !== counts.memories || (report.counts.archivedMemories ?? 0) !== counts.archived ||
        attachments.length !== counts.attachments)
      throw await this.ended(base, serviceError("RESTORE_COUNT_MISMATCH", messages.restoreErrors.RESTORE_COUNT_MISMATCH));
    return { db, pairing, attachments: attachments.length, attachmentBytes };
  }

  /** The switch's moves, in order: the current database, the companion files it has and its attachment folder into
   * `beforePath`, then the restored database and attachment folder into their places. */
  private async plan(db: string, live: { db: string; assets: string }, beforePath: string): Promise<RestoreMove[]> {
    const exists = async (path: string) => (await lstat(path).catch(() => null)) !== null;
    const moves: RestoreMove[] = [{ from: db, to: join(beforePath, "db", "bara.sqlite") }];
    for (const suffix of SQLITE_COMPANIONS) if (await exists(db + suffix)) moves.push({ from: db + suffix, to: join(beforePath, "db", `bara.sqlite${suffix}`) });
    if (await exists(live.assets)) moves.push({ from: live.assets, to: join(beforePath, "assets") });
    moves.push({ from: join(this.target, "memory.sqlite"), to: live.db }, { from: join(this.target, "assets"), to: live.assets });
    return moves;
  }

  /** A run that ended before its switch began and left its record at `restoring` (a step failed that records no end of
   * its own, such as reading the drive for the switch's plan) is recorded as failed, or cancelled when it was stopped.
   * Only a record a crash left at `restoring` is the next start's to mark `interrupted`. A switch records its own end. */
  private async settle(base: RestoreJournal, error: unknown, ctx: RequestContext): Promise<void> {
    const journal = await readRestoreJournal(this.paths.dataDir).catch(() => null);
    if (journal === null || journal === "invalid" || journal.stage !== "restoring" || journal.startedAt !== base.startedAt) return;
    const code = publicError(error).code;
    if (ctx.signal.aborted && code === "INTERNAL") await this.record(base, "cancelled");
    else await this.record(base, "failed", code);
  }

  /** Records that a restore failed with the store untouched, and returns `error` to throw. Recorded before the
   * server starts again, so that start does not take the record of a running restore for one a crash cut off. */
  private async ended(base: RestoreJournal, error: Error & { code?: string }): Promise<Error> {
    await this.record(base, "failed", error.code);
    return error;
  }

  private async record(base: RestoreJournal, stage: "failed" | "cancelled", errorCode?: string): Promise<void> {
    await writeRestoreJournal(this.paths.dataDir, { ...base, stage, updatedAt: this.now().toISOString(), ...(errorCode ? { errorCode } : {}) },
      this.rename).catch(() => {});
  }

  /** Starts the server again after a restore that did not switch, on the service's own signal (the restore may be the
   * one that was stopped). A start that fails is not reported here: the next save or connection check starts the
   * server again and says why it cannot. Not once quitting began (`drain`, `close`): nothing is started then. */
  private async restart(): Promise<void> {
    if (this.quitting || this.closing.signal.aborted) return;
    const ctx: RequestContext = { signal: this.closing.signal, progress: () => {} };
    await this.deps.exclusive(ctx, () => this.deps.startServer(ctx)).catch(() => {});
  }
}
