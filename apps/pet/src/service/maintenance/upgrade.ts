import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { UPDATE_STAGES, type MaintenanceRun, type RequestContext, type RuntimePaths, type UpdateStage,
  type UpdateStatus } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { BACKUP_MARGIN_BYTES, failureCause, fileSize, localStamp, managedSources, memoryApp, PORTABLE_RESULT_MAX_BYTES,
  runPortableExport, storeBytes, uniqueDestination, type ExportManifest } from "../backup.ts";
import { fitted, serviceError, type ServiceError } from "../errors.ts";
import { causeOf } from "../fetch-failure.ts";
import { freeBytesAt, type FreeSpace } from "../install/disk-space.ts";
import { runCaptured } from "../install/process.ts";
import { publicError } from "../protocol.ts";
import type { Maintenance } from "./manifest.ts";

// The update gate (plan stage 7B). A new app version must not let `managed-prepare` open the local memory database,
// which applies pending migrations, before that database is backed up twice: a SQLite snapshot (`db-snapshot.ts`,
// fast to put back with the same version) and the text-format export (`portable-memory.ts`, readable by any later
// version), the export read back and checked before anything goes on. `update-state.json` records how far an
// update got, so a start after a crash or a failure can tell "not backed up yet" (back up again) from "may already
// be migrated" (never take a second "pre-update" copy of half-updated data; go on and report the first one).

export const UPDATE_STATE_FILE = "update-state.json";
/** Written last into a finished pre-update backup folder: a folder without it is not a backup. */
export const UPDATE_BACKUP_FILE = "update-backup.json";
/** Finished pre-update backups kept; older ones are removed after a new one is complete. */
export const PRE_UPDATE_KEEP = 2;
/** `db-snapshot.ts` copies the whole database once and checks the copy; this only bounds a run that hangs. */
export const SNAPSHOT_TIMEOUT_MS = 30 * 60_000;
/** `portable-memory.ts verify` reads the archive back and hashes every attachment. */
export const VERIFY_TIMEOUT_MS = 30 * 60_000;
/** A record this app cannot trust to protect the database: the data may belong to a newer app. */
const UNSAFE_RUNS: ReadonlySet<MaintenanceRun> = new Set(["downgrade", "unreadable", "read-failed"]);
/** `<from>-to-<to>-YYYYMMDD-HHmmss[-n]`; the pruning and leftover removal touch nothing else. */
export const PRE_UPDATE_FOLDER = /^(?:unknown|\d+\.\d+\.\d+)-to-\d+\.\d+\.\d+-\d{8}-\d{6}(?:-\d+)?$/;
const SNAPSHOT_FILE = "bara.sqlite";
const PORTABLE_FOLDER = "portable";

export type UnsafeRun = "downgrade" | "unreadable" | "read-failed";

export interface UpdateState {
  format: 1;
  /** The recorded app version, or `unknown` for data an app from before `maintenance.json` left. */
  from: string;
  to: string;
  stage: UpdateStage;
  /** At `backup` the folder being written (a later start removes it when it never finished), also kept at `failed`
   * in `backup` when removing it failed; after that the finished backup. */
  backupPath?: string;
  failedStage?: "backup" | "migrating";
  errorCode?: string;
  /** `updatedAt` of `maintenance.json` when this update began (null without a record). It changes only when an app
   * records itself, so a different value later means another app ran on this data in between (an older version
   * put back after a failed update) and the backup no longer holds what that app wrote. */
  recordUpdatedAt: string | null;
  updatedAt: string;
}

/** The Pet's managed memory database (the same path `install/index.ts` requires `managed-prepare` to report). */
export function managedDatabase(dataDir: string): string {
  return join(dataDir, "memory", "db", "bara.sqlite");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

/** A valid record, or null for anything else: an unknown record only costs a new backup. */
export function parseUpdateState(value: unknown): UpdateState | null {
  if (!isObject(value) || value.format !== 1 || typeof value.from !== "string" || typeof value.to !== "string" ||
      !UPDATE_STAGES.includes(value.stage as UpdateStage) || !optionalString(value.backupPath) || !optionalString(value.errorCode) ||
      !(value.failedStage === undefined || value.failedStage === "backup" || value.failedStage === "migrating") ||
      !(value.recordUpdatedAt === null || typeof value.recordUpdatedAt === "string") ||
      typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) return null;
  return value as unknown as UpdateState;
}

/** The cause of a failure that a step after the backup ended with: a script's last error line (for
 * `managed-prepare`, its named stop reason), else the error's own public text. */
function startCause(error: unknown): string {
  return failureCause(error) ?? causeOf(publicError(error).message.replace(/[.。]\s*$/, ""));
}

/** A failure inside the backup procedure with its own cause text (read through `failureCause`). */
const stepError = (text: string) => serviceError("UPDATE_BACKUP_STEP", text);

/** Waits for `work` but stops waiting, not the work, when `signal` aborts. */
function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** The last stdout line as JSON, or null. */
function lastJson(stdout: string): unknown {
  try { return JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { return null; }
}

export interface UpdateGateOptions {
  paths: RuntimePaths;
  maintenance: Maintenance;
  /** Tests pass a fixed reading and clock, and a removal that fails. */
  freeSpace?: FreeSpace;
  now?: () => Date;
  remove?: (path: string) => Promise<void>;
}

/** Runs around every start of the Pet's local memory server (`InstallManager`'s start gate):
 *
 * - `beforePrepare` right before `managed-prepare` opens the database. Nothing to do unless this start is a pending
 *   update (`Maintenance.updatePending`: an update, or a first run over data an app before `maintenance.json` left)
 *   and the database exists. A downgrade or a record this app does not know stops here, before the database is
 *   opened; a record that could not be read is read again first. Otherwise it backs up (or resumes an update that
 *   is already past its backup), marks the update `migrating` and returns its SQLite snapshot for setup to validate.
 * - `started` once the server answered: the new version is recorded (`completeUpdate`) and the update `complete`.
 * - `failed` for an error after the backup: the update is `failed` and the error becomes `UPDATE_START_FAILED`,
 *   naming the backup folder.
 *
 * The backup runs once for all callers and on the gate's own signal, not the caller's: a request's time limit
 * (`operation-limits.ts`, 15 minutes for `connection.test`) or its cancel ends that request's wait, while the
 * backup, which a large store can take longer than that, goes on and the next request joins it. Quitting stops it:
 * the drain cancels the requests and `close()` aborts the backup and removes its partial folder. A failure is not
 * kept: the next request starts a new run. */
export class UpdateGate {
  private readonly memoryData: string;
  private readonly database: string;
  private readonly root: string;
  private readonly stateFile: string;
  private readonly freeSpace: FreeSpace;
  private readonly now: () => Date;
  private readonly remove: (path: string) => Promise<void>;
  private readonly controller = new AbortController();
  private loaded: Promise<void> | null = null;
  private state: UpdateState | null = null;
  private writes: Promise<void> = Promise.resolve();
  private flight: Promise<void> | null = null;
  /** This process's update, past its backup, until its server starts or fails. */
  private armed: UpdateState | null = null;
  /** The requests waiting on the shared run, told when a backup really starts (a resumed update makes none). */
  private readonly waiting = new Set<RequestContext>();
  private backingUp = false;
  /** A start passed this gate with an update and has not ended yet: its `managed-prepare` may be migrating. */
  private opening = false;

  constructor(private readonly options: UpdateGateOptions) {
    this.memoryData = join(options.paths.dataDir, "memory");
    this.database = managedDatabase(options.paths.dataDir);
    this.root = join(this.memoryData, "backups", "pre-update");
    this.stateFile = join(options.paths.dataDir, UPDATE_STATE_FILE);
    this.freeSpace = options.freeSpace ?? freeBytesAt;
    this.now = options.now ?? (() => new Date());
    this.remove = options.remove ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  private get maintenance(): Maintenance { return this.options.maintenance; }

  /** A pre-update backup is running, or a start that passed with an update has not ended: the database is being
   * copied or may be being migrated, so the settings screen's backup (`backup.ts`) waits. */
  get busy(): boolean { return this.flight !== null || this.opening; }

  /** Reads `update-state.json` once; afterwards this object's copy is the record. */
  private load(): Promise<void> {
    this.loaded ??= readFile(this.stateFile, "utf8").then((text) => { this.state = parseUpdateState(JSON.parse(text)); }, () => {})
      .catch(() => {});
    return this.loaded;
  }

  /** Saves the record. Writes before the database is opened must succeed (`required`): without them a later start
   * cannot tell whether the database may already be migrated. The others are bookkeeping and never fail a start. */
  private save(next: UpdateState, required: boolean): Promise<void> {
    const write = this.writes.then(() => writeAtomic(this.stateFile, next)).then(() => { this.state = next; });
    this.writes = write.catch(() => {});
    return required ? write : write.catch(() => { this.state = next; });
  }

  async status(): Promise<UpdateStatus | null> {
    await this.load();
    const state = this.state;
    if (!state) return null;
    // The version record already names `to` and nothing is pending: that update finished and only saving `complete`
    // was lost (the app ended between recording the version and that save). Not an unfinished update to report.
    if (state.stage !== "complete" && state.to === this.maintenance.recordedVersion && !this.maintenance.updatePending) return null;
    return { stage: state.stage, from: state.from, to: state.to, backupPath: state.stage === "backup" || state.failedStage === "backup" ? null : state.backupPath ?? null,
      failedStage: state.failedStage ?? null, errorCode: state.errorCode ?? null };
  }

  async beforePrepare(ctx: RequestContext): Promise<string | undefined> {
    const hasData = existsSync(this.database);
    // A record that could not be read at start (a file locked for a moment) is read again, so a retry need not wait
    // for the app to restart; what it holds then decides this start like any other.
    if (this.maintenance.run === "read-failed" && hasData) await this.maintenance.reread(hasData);
    const { run, recordedVersion } = this.maintenance;
    if (UNSAFE_RUNS.has(run) && hasData) {
      throw serviceError("UPDATE_VERSION_UNSAFE",
        messages.updateErrors.UPDATE_VERSION_UNSAFE(run as UnsafeRun, recordedVersion, this.maintenance.status.appVersion));
    }
    if (!this.maintenance.updatePending || !hasData) return;
    this.waiting.add(ctx);
    if (this.backingUp) ctx.progress("update-backup");
    if (!this.flight) {
      const flight = this.pass().finally(() => { if (this.flight === flight) this.flight = null; });
      // Every waiter may have stopped waiting; the outcome still must not surface as an unhandled rejection.
      flight.catch(() => {});
      this.flight = flight;
    }
    try { await waitFor(this.flight, ctx.signal); } finally { this.waiting.delete(ctx); }
    const armed = this.armed;
    if (!armed) return;
    // A resumed update is `migrating` already, unless this version takes over another version's update.
    if (armed.stage !== "migrating" || armed.to !== this.state?.to) {
      const migrating: UpdateState = { ...armed, stage: "migrating", updatedAt: this.now().toISOString() };
      delete migrating.failedStage; delete migrating.errorCode;
      try { await this.save(migrating, true); }
      catch (error) {
        throw serviceError("UPDATE_START_FAILED", fitted((cause) => messages.updateErrors.UPDATE_START_FAILED(cause, armed.backupPath!),
          `${messages.updateBackup.stateUnwritable}: ${causeOf(error)}`));
      }
      this.armed = migrating;
    }
    this.opening = true;
    ctx.progress("prepare");
    return resolve(armed.backupPath!, SNAPSHOT_FILE);
  }

  async started(): Promise<void> {
    this.opening = false;
    const armed = this.armed;
    if (!armed && !this.maintenance.updatePending) return;
    this.armed = null;
    await this.maintenance.completeUpdate().catch(() => {});
    if (!armed) return;
    const complete: UpdateState = { ...armed, stage: "complete", updatedAt: this.now().toISOString() };
    delete complete.failedStage; delete complete.errorCode;
    await this.save(complete, false);
  }

  /** What to throw for `error`, raised after `beforePrepare` by the same start. */
  async failed(error: unknown): Promise<unknown> {
    this.opening = false;
    const armed = this.armed;
    const code = (error as { code?: unknown } | null)?.code;
    if (!armed || (typeof code === "string" && code.startsWith("UPDATE_"))) return error;
    this.armed = null;
    const original = publicError(error);
    await this.save({ ...armed, stage: "failed", failedStage: "migrating", errorCode: original.code, updatedAt: this.now().toISOString() }, false);
    // `cause` keeps the original for a caller that acts on its code (`InstallManager.local` repairs a lost token).
    return Object.assign(serviceError("UPDATE_START_FAILED",
      fitted((cause) => messages.updateErrors.UPDATE_START_FAILED(cause, armed.backupPath!), startCause(error))), { cause: error });
  }

  /** The start that passed was cancelled: it ended (`managed-prepare` was stopped) and the update stays unfinished. */
  cancelled(): void { this.opening = false; }

  async close(): Promise<void> {
    this.controller.abort();
    await this.flight?.catch(() => {});
    await this.writes;
  }

  /** The shared run: resume an update past its backup, or make the backup. */
  private async pass(): Promise<void> {
    await this.load();
    const from = this.maintenance.recordedVersion ?? "unknown";
    const to = this.maintenance.status.appVersion;
    const recordUpdatedAt = this.maintenance.record?.updatedAt ?? null;
    const state = this.state;
    // The data the recorded update started from, untouched by any app since (no app recorded itself in between).
    const sameData = state !== null && state.from === from && state.recordUpdatedAt === recordUpdatedAt;
    const same = sameData && state.to === to;
    if (same && state.stage === "complete") {
      // The server already started on the updated data; only recording the new version had failed.
      await this.maintenance.completeUpdate().catch(() => {});
      return;
    }
    // Past `backed-up` the database may already be migrated: a new "pre-update" copy would hold half-updated data,
    // so the backup made before is the one reported, even when its folder has since been removed. That holds for
    // another target too (a fix release installed over a failed update): the record then names this version.
    if (sameData && state.backupPath && (state.stage === "migrating" || (state.stage === "failed" && state.failedStage === "migrating"))) {
      this.armed = state.to === to ? state : { ...state, to };
      return;
    }
    if (same && state.stage === "backed-up" && state.backupPath && await this.finished(state.backupPath)) {
      this.armed = state;
      return;
    }
    // A folder a run left while backing up: cut off, or failed and its removal failed too.
    if (state?.backupPath && (state.stage === "backup" || state.failedStage === "backup")) await this.removeUnfinished(state.backupPath);
    this.backingUp = true;
    for (const waiter of this.waiting) waiter.progress("update-backup");
    let backupPath: string;
    // The backup the record names is never pruned: it may be the only copy from before an update that went wrong.
    try { backupPath = await this.backup({ format: 1, from, to, recordUpdatedAt }, state?.backupPath); } finally { this.backingUp = false; }
    const backedUp: UpdateState = { format: 1, from, to, stage: "backed-up", backupPath, recordUpdatedAt, updatedAt: this.now().toISOString() };
    try { await this.save(backedUp, true); }
    catch (error) {
      throw serviceError("UPDATE_BACKUP_FAILED", fitted(messages.updateErrors.UPDATE_BACKUP_FAILED,
        `${messages.updateBackup.stateUnwritable}: ${causeOf(error)}`));
    }
    this.armed = backedUp;
  }

  /** Makes and checks the pre-update backup; returns its folder. Any failure removes this run's folder and records
   * `failed` at `backup`: the database was not opened. `keep` is a backup pruning must leave. */
  private async backup(base: Pick<UpdateState, "format" | "from" | "to" | "recordUpdatedAt">, keep: string | undefined): Promise<string> {
    const signal = this.controller.signal;
    let destination: string | null = null;
    try {
      const sources = await managedSources(this.memoryData);
      if (resolve(sources.db) !== this.database) throw stepError(messages.backupErrors.BACKUP_SETTINGS_INVALID);
      await this.assertSpace(sources);
      signal.throwIfAborted();
      await mkdir(this.root, { recursive: true });
      destination = await uniqueDestination(this.root, `${base.from}-to-${base.to}-${localStamp(this.now())}`);
      if (destination === null) throw stepError(messages.updateBackup.noFolderName);
      try { await this.save({ ...base, stage: "backup", backupPath: destination, updatedAt: this.now().toISOString() }, true); }
      catch (error) { destination = null; throw stepError(`${messages.updateBackup.stateUnwritable}: ${causeOf(error)}`); }
      // Not recursive: a folder that appeared since the name was chosen is not this run's and fails the run, untouched.
      try { await mkdir(destination); } catch (error) { destination = null; throw error; }
      const snapshot = await this.snapshot(sources.db, join(destination, SNAPSHOT_FILE), signal);
      const archive = join(destination, PORTABLE_FOLDER);
      const manifest = await runPortableExport(this.options.paths, sources, archive, { signal }, messages.updateBackup.exportStep);
      if (!manifest) throw stepError(messages.updateBackup.exportUnreadable);
      const fingerprint = await this.verify(archive, manifest, signal);
      const counts = { memories: manifest.collections.memories!.count, attachments: manifest.attachments.length };
      await writeAtomic(join(destination, UPDATE_BACKUP_FILE), { format: 1, from: base.from, to: base.to, createdAt: this.now().toISOString(),
        dbSnapshot: { file: SNAPSHOT_FILE, ...snapshot }, portable: { folder: PORTABLE_FOLDER, fingerprint }, counts });
    } catch (error) {
      // A folder that cannot be removed (a file held open on Windows) stays named in the record for the next run to
      // remove; it has no `update-backup.json`, so nothing takes it for a backup meanwhile.
      const left = destination !== null && !(await this.remove(destination).then(() => true, () => false));
      if (signal.aborted) throw error;
      const failure = this.backupFailure(error);
      await this.save({ ...base, stage: "failed", failedStage: "backup", ...(left ? { backupPath: destination! } : {}), errorCode: failure.code,
        updatedAt: this.now().toISOString() }, false);
      throw failure;
    }
    await this.prune(destination, keep);
    return destination;
  }

  private backupFailure(error: unknown): ServiceError {
    if ((error as { code?: unknown } | null)?.code === "UPDATE_BACKUP_DISK_LOW") return error as ServiceError;
    return serviceError("UPDATE_BACKUP_FAILED", fitted(messages.updateErrors.UPDATE_BACKUP_FAILED, failureCause(error)));
  }

  /** The drive holding the backups takes one snapshot (about the database and its log), the portable archive
   * (the rows again, as text, plus every attachment) and a margin. Setup validates and reuses this snapshot for
   * migration protection. A drive that cannot be read is not a reason to block. */
  private async assertSpace(sources: { db: string; assets: string }): Promise<void> {
    const free = await this.freeSpace(this.root);
    if (free === null) return;
    const database = await fileSize(sources.db) + await fileSize(`${sources.db}-wal`);
    const needed = await storeBytes(sources) + database + BACKUP_MARGIN_BYTES;
    if (free < needed) throw serviceError("UPDATE_BACKUP_DISK_LOW", messages.updateErrors.UPDATE_BACKUP_DISK_LOW(needed - free, free));
  }

  private async snapshot(db: string, out: string, signal: AbortSignal): Promise<{ bytes: number; schemaVersion: number }> {
    const { stdout } = await runCaptured([this.options.paths.bunPath, "scripts/db-snapshot.ts", "--db", db, "--out", out], { signal },
      { cwd: memoryApp(this.options.paths), timeoutMs: SNAPSHOT_TIMEOUT_MS, stepName: messages.updateBackup.snapshotStep });
    const result = lastJson(stdout) as { path?: unknown; bytes?: unknown; schemaVersion?: unknown } | null;
    if (!result || result.path !== out || !Number.isSafeInteger(result.bytes) || !Number.isSafeInteger(result.schemaVersion))
      throw stepError(messages.updateBackup.snapshotUnreadable);
    return { bytes: result.bytes as number, schemaVersion: result.schemaVersion as number };
  }

  /** Reads the published archive back (`verify --archive`) and requires the counts the export reported. */
  private async verify(archive: string, exported: ExportManifest, signal: AbortSignal): Promise<string | null> {
    const { stdout } = await runCaptured([this.options.paths.bunPath, "scripts/portable-memory.ts", "verify", "--archive", archive],
      { signal }, { cwd: memoryApp(this.options.paths), timeoutMs: VERIFY_TIMEOUT_MS, stepName: messages.updateBackup.verifyStep,
        maxStdoutBytes: PORTABLE_RESULT_MAX_BYTES });
    const result = lastJson(stdout) as { valid?: unknown; fingerprint?: unknown; manifest?: Partial<ExportManifest> } | null;
    const read = result?.manifest;
    if (result?.valid !== true || !read || !Array.isArray(read.attachments) ||
        read.collections?.memories?.count !== exported.collections.memories!.count || read.attachments.length !== exported.attachments.length)
      throw stepError(messages.updateBackup.verifyMismatch);
    return typeof result.fingerprint === "string" ? result.fingerprint : null;
  }

  /** A pre-update folder directly under the root, named like one, a real folder (never a link). */
  private async ownFolder(path: string): Promise<boolean> {
    if (dirname(resolve(path)) !== this.root || !PRE_UPDATE_FOLDER.test(basename(path))) return false;
    const stats = await lstat(path).catch(() => null);
    return !!stats?.isDirectory() && !stats.isSymbolicLink();
  }

  /** When the folder holds a valid `update-backup.json`, its `createdAt`; else null. */
  private async createdAt(path: string): Promise<string | null> {
    try {
      const value: unknown = JSON.parse(await readFile(join(path, UPDATE_BACKUP_FILE), "utf8"));
      return isObject(value) && value.format === 1 && typeof value.createdAt === "string" ? value.createdAt : null;
    } catch { return null; }
  }

  private async finished(path: string): Promise<boolean> {
    return await this.ownFolder(path) && await this.createdAt(path) !== null;
  }

  /** The folder a run cut off while backing up named in the record: removed unless it is a finished backup. */
  private async removeUnfinished(path: string): Promise<void> {
    if (await this.ownFolder(path) && await this.createdAt(path) === null) await rm(path, { recursive: true, force: true }).catch(() => {});
  }

  /** Keeps the newest `PRE_UPDATE_KEEP` finished backups, `current` always among them, and `keep` besides. Folders
   * without `update-backup.json`, other names and links are never touched. */
  private async prune(current: string, keep: string | undefined): Promise<void> {
    let names: string[];
    try { names = await readdir(this.root); } catch { return; }
    const finished: Array<{ path: string; createdAt: string }> = [];
    for (const name of names) {
      const path = join(this.root, name);
      if (path === current || (keep !== undefined && resolve(path) === resolve(keep)) || !(await this.ownFolder(path))) continue;
      const createdAt = await this.createdAt(path);
      if (createdAt !== null) finished.push({ path, createdAt });
    }
    finished.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.path.localeCompare(a.path));
    for (const old of finished.slice(PRE_UPDATE_KEEP - 1)) await rm(old.path, { recursive: true, force: true }).catch(() => {});
  }
}
