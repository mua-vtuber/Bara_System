import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaintenanceRun, MaintenanceStatus, RuntimePaths } from "../../shared/contracts.ts";

/** Written next to the data the Pet owns so a later start can tell a first run from an update, a repair
 * or a downgrade. It holds identifiers and versions only, never a token, key or user content. */
export interface MaintenanceRecord {
  format: 1;
  /** Random, created once on the first run and never changed afterwards. */
  installationId: string;
  /** `PET_VERSION` of the app that last ran with this data. */
  appVersion: string;
  /** The `pet-settings.json` version this app writes. */
  settingsFormat: 1;
  /** Last schema version `managed-prepare` reported for the local server; null if never prepared here. */
  dbSchemaVersion: number | null;
  /** From `resources/payload-manifest.json` when it was readable. */
  payload: { schemaVersion: number; sourceCommit: string | null } | null;
  paths: { dataDir: string; resourceDir: string };
  /** ISO time of the last write. */
  updatedAt: string;
}

export const MAINTENANCE_FILE = "maintenance.json";
export const UNREADABLE = "unreadable" as const;
export const READ_FAILED = "read-failed" as const;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function parts(version: string): [number, number, number] {
  const match = typeof version === "string" ? SEMVER.exec(version) : null;
  const numbers = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
  if (numbers.length !== 3 || !numbers.every(Number.isSafeInteger)) throw new Error("not a MAJOR.MINOR.PATCH version");
  return numbers as [number, number, number];
}
/** Orders two `MAJOR.MINOR.PATCH` versions (-1, 0 or 1). Anything else, including pre-release and
 * build suffixes or leading zeros, throws: a version the Pet cannot order must not be guessed at. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parts(a), right = parts(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}
function isVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value) && parts(value).every(Number.isSafeInteger);
}

export type RunKind = MaintenanceRun;
/** What reading the file gave: a valid record; `null` when there is no file (ENOENT) or the file is corrupt (not
 * JSON, empty, or not a JSON object: a write cut off by a power loss can leave it zero-filled, and the file is
 * rewritten on every start); `"unreadable"` for a JSON object this app cannot validate (including a format, or an
 * `appVersion` that is not plain MAJOR.MINOR.PATCH, that this app does not know), which may come from a newer app;
 * and `"read-failed"` when reading an existing path failed with an I/O error (a transient lock, a permission
 * error, a directory in its place), which says nothing about the content.
 *
 * A corrupt record counts as none: over the managed database that is a first run, deferred like an update, so the
 * database is backed up before it is opened (the backup only reads it, and `managed-prepare` refuses a database a
 * newer app made before it writes anything), and the completed start writes a good record. */
export type ReadResult = MaintenanceRecord | null | typeof UNREADABLE | typeof READ_FAILED;
/** `null` means "no record yet", NOT "no data": an install that predates `maintenance.json` has data and
 * still reports `"first-run"` once. Later stages must not treat `first-run` as an empty installation.
 * A `currentVersion` that is not plain MAJOR.MINOR.PATCH is `"unversioned"` whatever the record holds. */
export function classifyRun(record: ReadResult, currentVersion: string): RunKind {
  if (!isVersion(currentVersion)) return "unversioned";
  if (record === UNREADABLE) return "unreadable";
  if (record === READ_FAILED) return "read-failed";
  if (record === null) return "first-run";
  const order = compareVersions(currentVersion, record.appVersion);
  return order === 0 ? "same-version" : order > 0 ? "update" : "downgrade";
}

/** A non-negative integer from `managed-prepare`'s `schemaVersion`; anything else (absent or invalid)
 * is null, which never fails an install. */
export function dbSchemaVersionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validRecord(value: unknown): MaintenanceRecord | null {
  if (!isObject(value) || value.format !== 1 || value.settingsFormat !== 1) return null;
  const { installationId, appVersion, dbSchemaVersion, payload, paths, updatedAt } = value;
  if (typeof installationId !== "string" || installationId.length === 0 || installationId.length > 100) return null;
  if (!isVersion(appVersion)) return null;
  if (dbSchemaVersion !== null && dbSchemaVersionOf(dbSchemaVersion) === null) return null;
  if (payload !== null) {
    if (!isObject(payload) || !Number.isSafeInteger(payload.schemaVersion) ||
        (payload.sourceCommit !== null && typeof payload.sourceCommit !== "string")) return null;
  }
  if (!isObject(paths) || typeof paths.dataDir !== "string" || typeof paths.resourceDir !== "string") return null;
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return null;
  return { format: 1, installationId, appVersion, settingsFormat: 1, dbSchemaVersion: dbSchemaVersion as number | null,
    payload: payload === null ? null : { schemaVersion: payload.schemaVersion as number, sourceCommit: payload.sourceCommit as string | null },
    paths: { dataDir: paths.dataDir, resourceDir: paths.resourceDir }, updatedAt };
}

/** The packaged runtime's own list, read leniently: its integrity is `verifyRuntime`'s job, not this record's. */
export async function readPayloadInfo(resourceDir: string, read: MaintenanceFs["readFile"] = (path) => readFile(path, "utf8")): Promise<MaintenanceRecord["payload"]> {
  try {
    const value: unknown = JSON.parse(await read(join(resourceDir, "payload-manifest.json")));
    if (!isObject(value) || !Number.isSafeInteger(value.schemaVersion)) return null;
    const commit = value.sourceCommit;
    return { schemaVersion: value.schemaVersion as number, sourceCommit: typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null };
  } catch { return null; }
}

export interface MaintenanceFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
export interface MaintenanceDeps {
  now?: () => Date; uuid?: () => string; fs?: MaintenanceFs;
  /** The Pet's managed memory database already exists at start. A first run over it (an install from before this
   * record, or a lost record) is then deferred like an update: the database still has to be backed up first. */
  existingData?: boolean;
}
const realFs: MaintenanceFs = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, { flag: "wx", mode: 0o600 }),
  rename, unlink: (path) => unlink(path),
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
};

export interface Maintenance {
  readonly run: RunKind;
  /** The record as read, or as written for runs that write; null when none exists or it is unreadable. */
  record: MaintenanceRecord | null;
  /** `appVersion` of the record read at start (or by `reread`); null when there is no record, it is unreadable or it
   * could not be read. */
  readonly recordedVersion: string | null;
  /** What `status` reports. */
  status: MaintenanceStatus;
  /** Records the DB schema version of a successful prepare. Does nothing unless this run writes the record
   * (first-run, same-version, update). While an update is pending the value is only kept for `completeUpdate`. */
  recordDbSchema(version: number): Promise<void>;
  /** True while this run is an update (or a first run over existing data) whose new version is not recorded yet. */
  readonly updatePending: boolean;
  /** Records the new version of a pending update; called once the local server started on the updated data
   * (`upgrade.ts`). Ends `updatePending` even when the write fails: the next start then sees the update again and
   * resumes it from `update-state.json` without a new backup. Does nothing for other runs. */
  completeUpdate(): Promise<void>;
  /** Reads the record again after a start whose read failed (`read-failed`) and, when it can be read now, classifies
   * this run from it as if read at start, `existingData` as `MaintenanceDeps.existingData`. Does nothing otherwise. */
  reread(existingData: boolean): Promise<void>;
}

async function readRecord(path: string, fs: MaintenanceFs): Promise<ReadResult> {
  let text: string;
  try { text = await fs.readFile(path); }
  catch (error) { return (error as { code?: string }).code === "ENOENT" ? null : READ_FAILED; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return isObject(value) ? validRecord(value) ?? UNREADABLE : null;
}

/** Run once at service start. First-run and same-version runs write the record with the current version at
 * once. An update or a first run over the managed database (`existingData`) defers it to `completeUpdate`: recorded at
 * start, an update cut off before its database was backed up and its server started would read as same-version
 * on the next start and skip the backup. A downgrade, an unreadable record, a failed read and an unversioned app write nothing: the file may
 * belong to a newer app, may only be locked for a moment, and the app must never record a version it cannot
 * order (that would leave every later start unable to read its own record). `version` is checked once here
 * and this never throws for a bad version. `first-run` means "no record yet", not "no data". */
export async function openMaintenance(paths: Pick<RuntimePaths, "dataDir" | "resourceDir">, version: string, deps: MaintenanceDeps = {}): Promise<Maintenance> {
  const fs = deps.fs ?? realFs;
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const file = join(paths.dataDir, MAINTENANCE_FILE);
  let run: RunKind = "unversioned", writes = false, completed = true;
  let record: MaintenanceRecord | null = null, pendingRecord: MaintenanceRecord | null = null, recordedVersion: string | null = null;
  const status = (): MaintenanceStatus => ({ run, appVersion: version, recordedVersion, installationId: record?.installationId ?? null });

  let tail: Promise<void> = Promise.resolve();
  async function persist(next: MaintenanceRecord): Promise<void> {
    await fs.mkdir(paths.dataDir);
    const temporary = `${file}.${uuid()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    record = next;
    pendingRecord = null;
  }

  /** Classifies this run from what reading the record gave and writes it at once unless that is deferred. */
  async function settle(read: ReadResult, existingData: boolean): Promise<void> {
    run = classifyRun(read, version);
    writes = run === "first-run" || run === "same-version" || run === "update";
    // Only a managed database needs the backup first; without one (a remote or existing-server connection, or nothing
    // installed yet) there is nothing to protect and the record is written at start as before.
    const deferred = (run === "update" || run === "first-run") && existingData;
    completed = !deferred;
    const known = read === UNREADABLE || read === READ_FAILED ? null : read;
    record = known;
    recordedVersion = known?.appVersion ?? null;
    // A record that cannot be written (a locked or read-only data folder) must not stop the app over bookkeeping:
    // keep this run's metadata for a later prepare to retry, but only report the last successfully saved record.
    if (!writes) return;
    pendingRecord = {
      format: 1, installationId: known ? known.installationId : uuid(), appVersion: version, settingsFormat: 1,
      dbSchemaVersion: known ? known.dbSchemaVersion : null,
      payload: await readPayloadInfo(paths.resourceDir, fs.readFile),
      paths: { dataDir: paths.dataDir, resourceDir: paths.resourceDir }, updatedAt: now().toISOString(),
    };
    if (!deferred) await persist(pendingRecord).catch(() => {});
  }
  await settle(await readRecord(file, fs), deps.existingData === true);
  // Writes are serialized so two prepares (or a prepare and the completion) cannot interleave their temp file and rename.
  const serialized = (write: () => Promise<void>): Promise<void> => {
    const next = tail.then(write);
    tail = next.catch(() => {});
    return next;
  };
  const result: Maintenance = {
    get run() { return run; }, get record() { return record; }, get recordedVersion() { return recordedVersion; },
    get status() { return status(); },
    recordDbSchema(schema: number): Promise<void> {
      const value = dbSchemaVersionOf(schema);
      if (value === null) return Promise.reject(new Error("schema version must be a non-negative integer"));
      if (!writes) return Promise.resolve();
      // A pending update keeps the old record on disk untouched: the new schema is saved with the new version.
      if (!completed) { pendingRecord = { ...pendingRecord!, dbSchemaVersion: value }; return Promise.resolve(); }
      return serialized(async () => {
        const current = pendingRecord ?? record;
        if (!current || (!pendingRecord && current.dbSchemaVersion === value)) return;
        await persist({ ...current, dbSchemaVersion: value, updatedAt: now().toISOString() });
      });
    },
    get updatePending() { return !completed; },
    completeUpdate(): Promise<void> {
      if (!writes) return Promise.resolve();
      completed = true;
      return serialized(async () => {
        if (pendingRecord) await persist({ ...pendingRecord, updatedAt: now().toISOString() });
      });
    },
    async reread(existingData: boolean): Promise<void> {
      if (run !== "read-failed") return;
      const read = await readRecord(file, fs);
      // Serialized like every write: a read-failed run has written nothing, so nothing else is queued.
      if (read !== READ_FAILED) await serialized(() => settle(read, existingData));
    },
  };
  return result;
}
