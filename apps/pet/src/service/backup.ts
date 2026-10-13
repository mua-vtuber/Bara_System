import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BackupJobState, BackupResult, RequestContext, RuntimePaths } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { BackgroundJob } from "./background-job.ts";
import type { ConfigStore } from "./config.ts";
import { fitted, serviceError } from "./errors.ts";
import { causeOf } from "./fetch-failure.ts";
import { bytesUnder, freeBytesAt, type FreeSpace } from "./install/disk-space.ts";
import { failedStepStderr, runCaptured } from "./install/process.ts";

/** Longest one export may run. It reads the whole database and copies every attachment, so a large store on a
 * slow disk takes minutes; this only bounds a run that hangs, and the screen's "중단" ends it sooner. */
export const BACKUP_EXPORT_TIMEOUT_MS = 60 * 60_000;
/** Room kept beyond the copy itself: the archive's JSON is larger than the rows it holds, and the drive keeps working. */
export const BACKUP_MARGIN_BYTES = 200_000_000;
/** The bound on a portable-memory command's stdout. Its one result line carries the archive's manifest, which lists
 * every attachment (about 190 bytes each), so a store with more than about 5,000 attachments would pass the default
 * 1 MB bound of `runCaptured`; 64 MiB covers some 300,000 attachments. */
export const PORTABLE_RESULT_MAX_BYTES = 64 * 1024 * 1024;
/** Same-second backups get `-2`, `-3`, ...; past this many something else is filling the folder, so stop looking. */
const MAX_NAME_ATTEMPTS = 1_000;

/** The manifest fields read back from the exporter (apps/memory/src/portable/format.ts `PortableManifestV1`). */
export interface ExportManifest { collections: Record<string, { count: number }>; attachments: unknown[] }

const two = (value: number) => String(value).padStart(2, "0");
/** `YYYYMMDD-HHmmss` in local time, the time the user sees on the clock. */
export function localStamp(now: Date): string {
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}
/** `bara-backup-YYYYMMDD-HHmmss`, the time the user pressed the button. */
export function backupFolderName(now: Date): string {
  return `bara-backup-${localStamp(now)}`;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** A name under `root` nothing holds yet: `base`, then `base-2`, `base-3`, ...; null past `MAX_NAME_ATTEMPTS`. */
export async function uniqueDestination(root: string, base: string): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = join(root, attempt === 1 ? base : `${base}-${attempt}`);
    if (!(await exists(candidate))) return candidate;
  }
  return null;
}

/** A name under `root` nothing holds yet: the time's name, then `-2`, `-3`, ... The exporter itself refuses a
 * destination that exists, so a folder made between this check and its start fails the run, never merges. */
export async function freshDestination(root: string, now: Date): Promise<string> {
  const destination = await uniqueDestination(root, backupFolderName(now));
  if (destination === null) throw serviceError("BACKUP_FAILED", messages.backupErrors.BACKUP_FAILED(undefined));
  return destination;
}

/** The exporter writes into `.<name>.export-XXXXXX` next to its destination (Node's `mkdtemp`) and publishes from
 * there; a run that is killed leaves it behind. Only that pattern for this one destination is removed: never the
 * destination itself, another backup's staging folder or anything a link points at. */
export async function removeStaging(root: string, folderName: string): Promise<void> {
  const prefix = `.${folderName}.export-`;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(entry.name.slice(prefix.length))) continue;
    await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** The exporter publishes by copying the staged files into the destination and writing `manifest.json` last, so a run
 * killed during that copy leaves a destination without its manifest: a folder that looks like a backup but is not one.
 * `freshDestination` chose a name that did not exist, so a manifest-less folder there is this run's own leftover and is
 * removed; a link or a folder with a manifest is never touched. */
export async function removeUnpublished(destination: string): Promise<void> {
  const stats = await lstat(destination).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) return;
  if (await lstat(join(destination, "manifest.json")).then(() => true, () => false)) return;
  await rm(destination, { recursive: true, force: true }).catch(() => {});
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, resolve(candidate));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

/** The database and attachment folder of the Pet's own managed install, as its server opens them. The settings file
 * is read as data, without running `managed-prepare`, which would open and migrate the database. Both paths must
 * pass the checks `managed-prepare` applies before it starts the server (absolute, inside the managed root). The
 * attachment folder is the managed root's `assets`: `managed-prepare` hands the server that folder as
 * `BARA_ASSET_DIR`, which overrides the settings' `assets.dir`. */
export async function managedSources(memoryData: string): Promise<{ db: string; assets: string }> {
  const invalid = () => serviceError("BACKUP_SETTINGS_INVALID", messages.backupErrors.BACKUP_SETTINGS_INVALID);
  let settings: { db?: { path?: unknown }; assets?: { dir?: unknown } } | null;
  try { settings = JSON.parse(await readFile(join(memoryData, "config", "memory-settings.json"), "utf8")); }
  catch { throw invalid(); }
  const db = settings?.db?.path, assets = settings?.assets?.dir;
  if (typeof db !== "string" || typeof assets !== "string" || ![db, assets].every((path) => isAbsolute(path) && inside(memoryData, path)))
    throw invalid();
  return { db: resolve(db), assets: join(memoryData, "assets") };
}

/** Bytes of a regular file; 0 for anything else or a file that cannot be read. */
export async function fileSize(path: string): Promise<number> {
  return lstat(path).then((stats) => stats.isFile() ? stats.size : 0, () => 0);
}

/** Bytes of the store as a backup copies it: the database, its write-ahead log and every attachment. */
export async function storeBytes(sources: { db: string; assets: string }): Promise<number> {
  return await fileSize(sources.db) + await fileSize(`${sources.db}-wal`) + await bytesUnder(sources.assets);
}

/** The managed core's memory app, where its offline scripts run from (`<resources>/core/apps/memory`). */
export function memoryApp(paths: Pick<RuntimePaths, "resourceDir">): string {
  return join(paths.resourceDir, "core", "apps", "memory");
}

/** The manifest the exporter printed as its last stdout line, or, when that cannot be read, the one it published
 * with the archive (it writes that file last, so a published folder always holds it). */
export async function readManifest(stdout: string, destination: string): Promise<ExportManifest | null> {
  const valid = (value: unknown): value is ExportManifest => {
    const manifest = value as ExportManifest | null;
    return !!manifest && typeof manifest.collections === "object" && manifest.collections !== null &&
      Number.isSafeInteger(manifest.collections.memories?.count) && Array.isArray(manifest.attachments);
  };
  const last = stdout.trim().split("\n").at(-1) ?? "";
  for (const read of [async () => last, () => readFile(join(destination, "manifest.json"), "utf8")]) {
    try { const value: unknown = JSON.parse(await read()); if (valid(value)) return value; } catch {}
  }
  return null;
}

/** The cause shown with `BACKUP_FAILED`: a script's last error line, or the step's own limit text. Up to
 * `CAUSE_MAX_CHARS` code points, so a text writing it goes through `fitted` to stay within the host's limit. */
export function failureCause(error: unknown): string | undefined {
  const stderr = failedStepStderr(error);
  if (stderr !== undefined) {
    const line = stderr.trim().split(/\r?\n/).at(-1)?.trim();
    return line ? causeOf(line) : undefined;
  }
  const own = (error as { publicMessage?: unknown } | null)?.publicMessage;
  return typeof own === "string" ? causeOf(own.replace(/[.。]\s*$/, "")) : undefined;
}

/** Runs the core's text-format exporter (`portable-memory.ts export`) into `destination`, a folder that must not exist.
 * A run that fails or is cancelled leaves nothing of its own behind (its staging folder, a destination cut off before
 * its manifest) and rethrows the step's error as it came; the caller names it. The pre-update backup
 * (`maintenance/upgrade.ts`) runs the same exporter. */
export async function runPortableExport(paths: Pick<RuntimePaths, "bunPath" | "resourceDir">, sources: { db: string; assets: string },
  destination: string, ctx: Pick<RequestContext, "signal">, stepName: string): Promise<ExportManifest | null> {
  let output;
  try {
    output = await runCaptured([paths.bunPath, "scripts/portable-memory.ts", "export",
      "--db", sources.db, "--assets", sources.assets, "--out", destination], ctx,
      { cwd: memoryApp(paths), timeoutMs: BACKUP_EXPORT_TIMEOUT_MS, stepName, maxStdoutBytes: PORTABLE_RESULT_MAX_BYTES });
  } catch (error) {
    await removeStaging(dirname(destination), basename(destination));
    await removeUnpublished(destination);
    throw error;
  }
  return readManifest(output.stdout, destination);
}

export interface BackupOptions {
  /** True while the update gate copies the store or a start may be migrating it (`UpdateGate.busy`). */
  updating?: () => boolean;
  /** True while a restore from a backup runs (`restore.ts` `RestoreService.active`): it stops the server and moves
   * the store's files. */
  restoring?: () => boolean;
  /** Tests pass a fixed reading and clock. */
  freeSpace?: FreeSpace;
  now?: () => Date;
}

/** `backup.export`: the memories kept on this PC, written with the core's text-format exporter
 * (`apps/memory/scripts/portable-memory.ts export`) to a new folder under the backup folder the host chose. The
 * memory server keeps running: the exporter reads the database read-only inside one transaction, so it copies one
 * consistent snapshot while the server writes. One backup runs at a time, and none while an update is being
 * finished: its backup is copying the store, or the new version's preparation may be changing its tables.
 *
 * The backup is the service's job (`BackgroundJob`), not the request's: a screen that leaves ends only its wait, a
 * settings screen opened again joins the running backup (`backup.status`, `backup.join`), and only `cancel` (the
 * screen's "중단") or quitting stops it. */
export class BackupService {
  private readonly job: BackgroundJob<BackupResult>;
  private readonly memoryData: string;
  private readonly freeSpace: FreeSpace;
  private readonly now: () => Date;

  constructor(private readonly config: Pick<ConfigStore, "load">, private readonly paths: RuntimePaths, private readonly options: BackupOptions = {}) {
    this.memoryData = join(paths.dataDir, "memory");
    this.freeSpace = options.freeSpace ?? freeBytesAt;
    this.now = options.now ?? (() => new Date());
    this.job = new BackgroundJob<BackupResult>(messages.backup.cancelled, this.now);
  }

  /** A backup is being made. */
  get busy(): boolean { return this.job.running; }

  async export(ctx: RequestContext): Promise<BackupResult> {
    if (this.job.running) throw serviceError("BACKUP_BUSY", messages.backupErrors.BACKUP_BUSY);
    if (this.options.updating?.()) throw serviceError("BACKUP_UPDATE_RUNNING", messages.backupErrors.BACKUP_UPDATE_RUNNING);
    if (this.options.restoring?.()) throw serviceError("BACKUP_RESTORE_RUNNING", messages.backupErrors.BACKUP_RESTORE_RUNNING);
    return this.job.start((jobCtx) => this.run(jobCtx), ctx);
  }

  /** `backup.status`: the backup that runs, or how the last one ended when no screen has seen it yet. */
  status(): BackupJobState<BackupResult> | null { return this.job.snapshot(); }
  /** `backup.join`: waits for the backup that runs (its latest stage first), or receives how the last one ended. */
  join(ctx: RequestContext): Promise<BackupResult> { return this.job.join(ctx); }
  /** `backup.cancel`: the screen's "중단". */
  cancel(): boolean { return this.job.cancel(); }
  /** Quitting: a backup still running is stopped and its partial folder removed. */
  close(): Promise<void> { return this.job.close(); }

  /** Only a finished local install has a store this PC holds; `managed-install.json` is the installer's record. */
  private async assertLocalStore(): Promise<{ db: string; assets: string }> {
    if ((await this.config.load()).connection.mode !== "local")
      throw serviceError("BACKUP_NOT_LOCAL", messages.backupErrors.BACKUP_NOT_LOCAL);
    const notReady = () => serviceError("BACKUP_NOT_READY", messages.backupErrors.BACKUP_NOT_READY);
    let journal: { phase?: unknown } | null;
    try { journal = JSON.parse(await readFile(join(this.memoryData, "managed-install.json"), "utf8")); }
    catch { throw notReady(); }
    if (journal?.phase !== "complete") throw notReady();
    const sources = await managedSources(this.memoryData);
    if ((await lstat(sources.db).catch(() => null))?.isFile() !== true) throw notReady();
    return sources;
  }

  /** Stops with `BACKUP_DISK_LOW` before anything is written when the drive cannot take a copy of the database (its
   * write-ahead log included) and every attachment. A drive that cannot be read is not a reason to block. */
  private async assertSpace(root: string, sources: { db: string; assets: string }): Promise<void> {
    const free = await this.freeSpace(root);
    if (free === null) return;
    const needed = await storeBytes(sources) + BACKUP_MARGIN_BYTES;
    if (free < needed) throw serviceError("BACKUP_DISK_LOW", messages.backupErrors.BACKUP_DISK_LOW(needed - free, free));
  }

  private async run(ctx: RequestContext): Promise<BackupResult> {
    const sources = await this.assertLocalStore();
    const root = this.paths.backupDir;
    if (!root) throw serviceError("BACKUP_FOLDER_UNAVAILABLE", messages.backupErrors.BACKUP_FOLDER_UNAVAILABLE);
    await this.assertSpace(root, sources);
    ctx.signal.throwIfAborted();
    try { await mkdir(root, { recursive: true }); }
    catch (error) { throw serviceError("BACKUP_FAILED", fitted(messages.backupErrors.BACKUP_FAILED, causeOf(error))); }
    const destination = await freshDestination(root, this.now());
    const folderName = basename(destination);
    let manifest;
    try { manifest = await runPortableExport(this.paths, sources, destination, ctx, messages.backup.step); }
    catch (error) {
      // A stop ends the job as cancelled (`BackgroundJob`).
      if (ctx.signal.aborted) throw error;
      throw serviceError("BACKUP_FAILED", fitted(messages.backupErrors.BACKUP_FAILED, failureCause(error)));
    }
    if (!manifest) throw serviceError("BACKUP_RESULT_UNREADABLE", messages.backupErrors.BACKUP_RESULT_UNREADABLE(folderName));
    // `memories` counts the store's live memories (`knowledge_nodes`). The archive also keeps `archivedMemories`, the
    // ones moved to the trash (`knowledge_nodes_archive`), which the user no longer counts among their memories.
    return { folder: destination, folderName, memories: manifest.collections.memories!.count, attachments: manifest.attachments.length };
  }
}
