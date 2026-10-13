import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PET_VERSION } from "../../shared/version.ts";
import { MAINTENANCE_FILE, classifyRun, compareVersions, dbSchemaVersionOf, openMaintenance, readPayloadInfo,
  type MaintenanceRecord } from "./manifest.ts";

let root: string, dataDir: string, resourceDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bara-maintenance-"));
  dataDir = join(root, "data"); resourceDir = join(root, "res");
  mkdirSync(resourceDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(dataDir, MAINTENANCE_FILE);
const paths = () => ({ dataDir, resourceDir });
const clock = (iso = "2026-10-06T00:00:00.000Z") => ({ now: () => new Date(iso) });
function record(overrides: Partial<MaintenanceRecord> = {}): MaintenanceRecord {
  return { format: 1, installationId: "authored-installation", appVersion: "0.1.0", settingsFormat: 1, dbSchemaVersion: 7,
    payload: null, paths: { dataDir, resourceDir }, updatedAt: "2026-10-01T00:00:00.000Z", ...overrides };
}
function put(value: unknown): string {
  mkdirSync(dataDir, { recursive: true });
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(file(), text);
  return text;
}

test("compareVersions orders MAJOR.MINOR.PATCH numerically and rejects anything else", () => {
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
  expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  for (const bad of ["", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "1.2.3+build", "01.2.3", "1.2.-3", "1.2.x", " 1.2.3",
    "99999999999999999999.0.0"]) {
    expect(() => compareVersions(bad, "1.0.0")).toThrow();
    expect(() => compareVersions("1.0.0", bad)).toThrow();
  }
  expect(() => compareVersions(undefined as unknown as string, "1.0.0")).toThrow();
});

test("classifyRun separates first run, same version, update, downgrade and an unreadable record", () => {
  expect(classifyRun(null, "0.1.0")).toBe("first-run");
  expect(classifyRun(record({ appVersion: "0.1.0" }), "0.1.0")).toBe("same-version");
  expect(classifyRun(record({ appVersion: "0.1.0" }), "0.2.0")).toBe("update");
  expect(classifyRun(record({ appVersion: "0.2.0" }), "0.1.9")).toBe("downgrade");
  expect(classifyRun("unreadable", "0.1.0")).toBe("unreadable");
  expect(classifyRun("read-failed", "0.1.0")).toBe("read-failed");
});

test("classifyRun reports an app version it cannot order as unversioned instead of throwing", () => {
  for (const bad of ["0.2.0-rc.1", "0.2.0+build", "v0.2.0", "1.2", "", "01.2.3"]) {
    for (const read of [null, record(), "unreadable", "read-failed"] as const) expect(classifyRun(read, bad)).toBe("unversioned");
  }
});

test("the app's own package.json version is plain MAJOR.MINOR.PATCH, so a pre-release build fails here and not in production", () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as { version: unknown };
  expect(typeof packageJson.version).toBe("string");
  expect(packageJson.version as string).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  expect(PET_VERSION).toBe(packageJson.version as string);
  expect(() => compareVersions(PET_VERSION, PET_VERSION)).not.toThrow();
  expect(classifyRun(null, PET_VERSION)).toBe("first-run");
});

test("an unversioned app does not throw, writes nothing and leaves an existing record byte for byte", async () => {
  for (const bad of ["0.2.0-rc.1", "0.2.0+build", "next"]) {
    // No file: nothing is created, not even the data folder.
    const fresh = await openMaintenance(paths(), bad, { ...clock(), uuid: () => "never-used" });
    expect(fresh.run).toBe("unversioned");
    expect(fresh.record).toBeNull();
    expect(fresh.status).toEqual({ run: "unversioned", appVersion: bad, recordedVersion: null, installationId: null });
    await fresh.recordDbSchema(4);
    expect(existsSync(dataDir)).toBe(false);

    // A readable record keeps its installation id in the report and its bytes on disk.
    const text = put(record({ appVersion: "0.1.0" }));
    const known = await openMaintenance(paths(), bad, clock());
    expect(known.run).toBe("unversioned");
    expect(known.status).toEqual({ run: "unversioned", appVersion: bad, recordedVersion: "0.1.0", installationId: "authored-installation" });
    await known.recordDbSchema(9);
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);

    // An unreadable record stays as it is and reports no id.
    const garbage = put("{ from a newer app");
    const unknown = await openMaintenance(paths(), bad, clock());
    expect(unknown.status).toEqual({ run: "unversioned", appVersion: bad, recordedVersion: null, installationId: null });
    expect(readFileSync(file(), "utf8")).toBe(garbage);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a record written with a pre-release appVersion is unreadable and never overwritten by a plain-version app", async () => {
  for (const appVersion of ["0.2.0-rc.1", "0.2.0+build", "v0.2.0"]) {
    const text = put({ ...record(), appVersion });
    const opened = await openMaintenance(paths(), "0.2.0", clock());
    expect(opened.run).toBe("unreadable");
    expect(opened.status).toEqual({ run: "unreadable", appVersion: "0.2.0", recordedVersion: null, installationId: null });
    await opened.recordDbSchema(5);
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  }
});

test("a first run creates the record and installationId, and later runs keep the id and the schema version", async () => {
  const first = await openMaintenance(paths(), "0.1.0", { ...clock(), uuid: () => "id-1" });
  expect(first.run).toBe("first-run");
  expect(first.recordedVersion).toBeNull();
  expect(first.status).toEqual({ run: "first-run", appVersion: "0.1.0", recordedVersion: null, installationId: "id-1" });
  const written = JSON.parse(readFileSync(file(), "utf8")) as MaintenanceRecord;
  expect(written).toEqual({ format: 1, installationId: "id-1", appVersion: "0.1.0", settingsFormat: 1, dbSchemaVersion: null,
    payload: null, paths: { dataDir, resourceDir }, updatedAt: "2026-10-06T00:00:00.000Z" });
  await first.recordDbSchema(3);

  const same = await openMaintenance(paths(), "0.1.0", { ...clock("2026-10-07T00:00:00.000Z"), uuid: () => "id-2" });
  expect(same.run).toBe("same-version");
  expect(same.status.installationId).toBe("id-1");
  expect(same.record).toMatchObject({ installationId: "id-1", dbSchemaVersion: 3, updatedAt: "2026-10-07T00:00:00.000Z" });

  // An update over the managed database is recorded only once it completes (`completeUpdate`), never at start.
  const before = readFileSync(file(), "utf8");
  const update = await openMaintenance(paths(), "0.2.0", { ...clock("2026-10-08T00:00:00.000Z"), uuid: () => "id-3", existingData: true });
  expect(update.run).toBe("update");
  expect(update.updatePending).toBe(true);
  expect(update.status).toEqual({ run: "update", appVersion: "0.2.0", recordedVersion: "0.1.0", installationId: "id-1" });
  expect(readFileSync(file(), "utf8")).toBe(before);
  await update.completeUpdate();
  expect(update.updatePending).toBe(false);
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ installationId: "id-1", appVersion: "0.2.0", dbSchemaVersion: 3,
    updatedAt: "2026-10-08T00:00:00.000Z" });
  expect((await openMaintenance(paths(), "0.2.0")).run).toBe("same-version");
});

test("an update that never completes leaves the old record, so the next start is still an update", async () => {
  const text = put(record({ appVersion: "0.1.0", dbSchemaVersion: 7 }));
  const opened = await openMaintenance(paths(), "0.2.0", { ...clock(), uuid: () => "unused", existingData: true });
  // The prepare of the new version reports its schema: kept for the completion, not written beside the old version.
  await opened.recordDbSchema(8);
  expect(readFileSync(file(), "utf8")).toBe(text);
  expect(opened.record).toEqual(record({ appVersion: "0.1.0", dbSchemaVersion: 7 }));
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  const next = await openMaintenance(paths(), "0.2.0", { ...clock(), existingData: true });
  expect({ run: next.run, pending: next.updatePending, recorded: next.recordedVersion }).toEqual({ run: "update", pending: true, recorded: "0.1.0" });
  // Completing writes the new version with the schema the prepare reported; later schemas are written at once.
  await opened.completeUpdate();
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ appVersion: "0.2.0", dbSchemaVersion: 8, installationId: "authored-installation" });
  await opened.recordDbSchema(9);
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ appVersion: "0.2.0", dbSchemaVersion: 9 });
  await opened.completeUpdate();
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
});

test("an update without the managed database (remote or not installed here) is recorded at start: there is nothing to back up", async () => {
  put(record({ appVersion: "0.1.0", dbSchemaVersion: 7 }));
  const opened = await openMaintenance(paths(), "0.2.0", { ...clock(), existingData: false });
  expect({ run: opened.run, pending: opened.updatePending }).toEqual({ run: "update", pending: false });
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ appVersion: "0.2.0", dbSchemaVersion: 7 });
  expect((await openMaintenance(paths(), "0.2.0")).run).toBe("same-version");
});

test("a first run over an existing database is deferred like an update; without one it is recorded at start", async () => {
  const deferred = await openMaintenance(paths(), "0.2.0", { ...clock(), uuid: () => "id-new", existingData: true });
  expect({ run: deferred.run, pending: deferred.updatePending, record: deferred.record }).toEqual({ run: "first-run", pending: true, record: null });
  expect(deferred.status).toEqual({ run: "first-run", appVersion: "0.2.0", recordedVersion: null, installationId: null });
  await deferred.recordDbSchema(47);
  expect(existsSync(file())).toBe(false);
  expect((await openMaintenance(paths(), "0.2.0", { existingData: true })).run).toBe("first-run");
  await deferred.completeUpdate();
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ installationId: "id-new", appVersion: "0.2.0", dbSchemaVersion: 47 });
  expect(deferred.status.installationId).toBe("id-new");

  rmSync(dataDir, { recursive: true, force: true });
  const fresh = await openMaintenance(paths(), "0.2.0", { ...clock(), uuid: () => "id-fresh", existingData: false });
  expect(fresh.updatePending).toBe(false);
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ installationId: "id-fresh", appVersion: "0.2.0" });
  // Completing a run that was never deferred changes nothing.
  const text = readFileSync(file(), "utf8");
  await fresh.completeUpdate();
  expect(readFileSync(file(), "utf8")).toBe(text);
});

test("only update and first-run-over-data are pending; same-version, downgrade and unreadable runs never are", async () => {
  put(record({ appVersion: "0.2.0" }));
  for (const [version, existingData] of [["0.2.0", true], ["0.1.0", true]] as const) {
    const opened = await openMaintenance(paths(), version, { existingData });
    expect(opened.updatePending).toBe(false);
    await opened.completeUpdate();
  }
  expect(JSON.parse(readFileSync(file(), "utf8")).appVersion).toBe("0.2.0");
  const text = put({ format: 2 });
  const unreadable = await openMaintenance(paths(), "0.2.0", { existingData: true });
  expect({ run: unreadable.run, pending: unreadable.updatePending }).toEqual({ run: "unreadable", pending: false });
  await unreadable.completeUpdate();
  expect(readFileSync(file(), "utf8")).toBe(text);
});

test("a completion whose write fails ends the pending state for this run but leaves the next start an update", async () => {
  const text = put(record({ appVersion: "0.1.0" }));
  const failingRename = {
    readFile: async (path: string) => readFileSync(path, "utf8"),
    writeFile: async (path: string, data: string) => { writeFileSync(path, data); },
    rename: async () => { throw new Error("locked"); },
    unlink: async (path: string) => { rmSync(path, { force: true }); },
    mkdir: async () => {},
  };
  const opened = await openMaintenance(paths(), "0.2.0", { fs: failingRename });
  await expect(opened.completeUpdate()).rejects.toThrow("locked");
  expect(opened.updatePending).toBe(false);
  expect(readFileSync(file(), "utf8")).toBe(text);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  expect((await openMaintenance(paths(), "0.2.0")).run).toBe("update");
});

test("the real clock and uuid make a valid record for the current app version", async () => {
  const opened = await openMaintenance(paths(), PET_VERSION);
  expect(opened.record?.installationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Date.parse(opened.record!.updatedAt)).toBeGreaterThan(0);
  expect((await openMaintenance(paths(), PET_VERSION)).run).toBe("same-version");
});

test("a downgrade is reported and never overwrites the record", async () => {
  const text = put(record({ appVersion: "0.3.0" }));
  const opened = await openMaintenance(paths(), "0.2.0", clock());
  expect(opened.run).toBe("downgrade");
  expect(opened.status).toEqual({ run: "downgrade", appVersion: "0.2.0", recordedVersion: "0.3.0", installationId: "authored-installation" });
  await opened.recordDbSchema(99);
  expect(readFileSync(file(), "utf8")).toBe(text);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
});

test("a corrupt record (not JSON, empty or not an object) counts as none: a first run that replaces it", async () => {
  for (const bad of ["not json {", "", "   ", "\0".repeat(200), "[]", "null", "7", '"text"']) {
    put(bad);
    const opened = await openMaintenance(paths(), "0.2.0", { ...clock(), uuid: () => "new-installation" });
    expect(opened.status).toEqual({ run: "first-run", appVersion: "0.2.0", recordedVersion: null, installationId: "new-installation" });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ appVersion: "0.2.0", installationId: "new-installation" });
    // Over the managed database it is deferred like an update, so the database is backed up first.
    put(bad);
    const deferred = await openMaintenance(paths(), "0.2.0", { ...clock(), existingData: true });
    expect({ run: deferred.run, pending: deferred.updatePending }).toEqual({ run: "first-run", pending: true });
    expect(readFileSync(file(), "utf8")).toBe(bad);
    await deferred.completeUpdate();
    expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ appVersion: "0.2.0" });
  }
});

test("an unreadable record (a JSON object of a wrong shape or a newer format) is kept as it is", async () => {
  const cases: unknown[] = [
    {},
    record({ format: 2 as unknown as 1 }),
    { ...record(), format: 2, futureField: { anything: true } },
    record({ settingsFormat: 2 as unknown as 1 }),
    record({ appVersion: "next" }),
    record({ appVersion: "0.2.0-rc.1" }),
    record({ appVersion: "0.2.0+build" }),
    record({ installationId: "" }),
    record({ dbSchemaVersion: -1 }),
    record({ dbSchemaVersion: 1.5 }),
    { ...record(), payload: { schemaVersion: "1", sourceCommit: null } },
    { ...record(), paths: { dataDir } },
    { ...record(), updatedAt: "yesterday" },
  ];
  for (const bad of cases) {
    const text = put(bad);
    const opened = await openMaintenance(paths(), "0.1.0", clock());
    expect(opened.run).toBe("unreadable");
    expect(opened.record).toBeNull();
    expect(opened.status).toEqual({ run: "unreadable", appVersion: "0.1.0", recordedVersion: null, installationId: null });
    await opened.recordDbSchema(5);
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  }
});

test("a path that cannot be read as a file is a failed read, not a first run and not unreadable", async () => {
  mkdirSync(file(), { recursive: true });
  const opened = await openMaintenance(paths(), "0.1.0", clock());
  expect(opened.run).toBe("read-failed");
  expect(opened.record).toBeNull();
  expect(opened.status).toEqual({ run: "read-failed", appVersion: "0.1.0", recordedVersion: null, installationId: null });
  await opened.recordDbSchema(5);
  expect(existsSync(join(file(), "x"))).toBe(false);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
});

test("a transient I/O error reading an existing record is read-failed, never overwrites, and the next start recovers", async () => {
  for (const code of ["EBUSY", "EPERM", "EACCES", "EIO"]) {
    const text = put(record({ appVersion: "0.1.0" }));
    const writes: string[] = [];
    const locked = {
      readFile: async () => { throw Object.assign(new Error(code), { code }); },
      writeFile: async (path: string) => { writes.push(path); },
      rename: async (from: string) => { writes.push(from); },
      unlink: async () => {},
      mkdir: async () => { writes.push("mkdir"); },
    };
    const failed = await openMaintenance(paths(), "0.2.0", { fs: locked });
    expect(failed.run).toBe("read-failed");
    expect(failed.status).toEqual({ run: "read-failed", appVersion: "0.2.0", recordedVersion: null, installationId: null });
    await failed.recordDbSchema(8);
    expect(writes).toEqual([]);
    expect(readFileSync(file(), "utf8")).toBe(text);

    // The lock is gone on the next start: the real record is read and updated normally.
    const retried = await openMaintenance(paths(), "0.2.0", clock());
    expect(retried.run).toBe("update");
    expect(retried.status).toMatchObject({ recordedVersion: "0.1.0", installationId: "authored-installation" });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a run whose read failed reads the record again on request and becomes what it then finds", async () => {
  const text = put(record({ appVersion: "0.1.0" }));
  let locked = true;
  const fs = {
    readFile: async (path: string) => { if (locked) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return readFileSync(path, "utf8"); },
    writeFile: async (path: string, data: string) => { writeFileSync(path, data, { flag: "wx" }); },
    rename: async (from: string, to: string) => { renameSync(from, to); },
    unlink: async (path: string) => { rmSync(path, { force: true }); },
    mkdir: async () => {},
  };
  const opened = await openMaintenance(paths(), "0.2.0", { ...clock(), fs, existingData: true });
  await opened.reread(true);
  expect({ run: opened.run, pending: opened.updatePending }).toEqual({ run: "read-failed", pending: false });
  locked = false;
  await opened.reread(true);
  expect({ run: opened.run, pending: opened.updatePending, recorded: opened.recordedVersion }).toEqual({ run: "update", pending: true, recorded: "0.1.0" });
  expect(opened.status).toEqual({ run: "update", appVersion: "0.2.0", recordedVersion: "0.1.0", installationId: "authored-installation" });
  expect(readFileSync(file(), "utf8")).toBe(text);
  await opened.completeUpdate();
  expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ appVersion: "0.2.0", installationId: "authored-installation" });
  // Only a failed read is read again.
  put(record({ appVersion: "0.3.0" }));
  await opened.reread(true);
  expect(opened.run).toBe("update");
  // Without the managed database a found update is recorded at once, as at start.
  put(record({ appVersion: "0.1.0" }));
  locked = true;
  const remote = await openMaintenance(paths(), "0.2.0", { ...clock(), fs });
  locked = false;
  await remote.reread(false);
  expect({ run: remote.run, pending: remote.updatePending }).toEqual({ run: "update", pending: false });
  expect(JSON.parse(readFileSync(file(), "utf8")).appVersion).toBe("0.2.0");
});

test("only a missing file is a first run: ENOENT is first-run and any other error code is read-failed", async () => {
  const failing = (code?: string) => ({
    readFile: async () => { throw Object.assign(new Error("x"), code ? { code } : {}); },
    writeFile: async () => {}, rename: async () => {}, unlink: async () => {}, mkdir: async () => {},
  });
  expect((await openMaintenance(paths(), "0.1.0", { fs: failing("ENOENT") })).run).toBe("first-run");
  expect((await openMaintenance(paths(), "0.1.0", { fs: failing("ENOTDIR") })).run).toBe("read-failed");
  expect((await openMaintenance(paths(), "0.1.0", { fs: failing() })).run).toBe("read-failed");
});

test("a first run means no record yet, not no data: existing data without maintenance.json still reports first-run", async () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "pet-settings.json"), "{}");
  const opened = await openMaintenance(paths(), "0.1.0", clock());
  expect(opened.run).toBe("first-run");
  expect(readdirSync(dataDir).sort()).toEqual([MAINTENANCE_FILE, "pet-settings.json"]);
});

test("writing leaves no temporary file and no secret-shaped fields", async () => {
  const opened = await openMaintenance(paths(), "0.1.0");
  await opened.recordDbSchema(2);
  await opened.recordDbSchema(3);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  expect(Object.keys(JSON.parse(readFileSync(file(), "utf8"))).sort()).toEqual(
    ["appVersion", "dbSchemaVersion", "format", "installationId", "paths", "payload", "settingsFormat", "updatedAt"]);
});

test("a failed write removes its temporary file, leaves the previous record intact and does not stop the app", async () => {
  const text = put(record({ appVersion: "0.1.0" }));
  const failingRename = {
    readFile: async (path: string) => readFileSync(path, "utf8"),
    writeFile: async (path: string, data: string) => { writeFileSync(path, data); },
    rename: async () => { throw new Error("disk full"); },
    unlink: async (path: string) => { rmSync(path, { force: true }); },
    mkdir: async () => {},
  };
  const opened = await openMaintenance(paths(), "0.2.0", { fs: failingRename });
  // The run is still reported; the record shown is the one actually on disk.
  expect(opened.status).toMatchObject({ run: "update", appVersion: "0.2.0", recordedVersion: "0.1.0" });
  expect(opened.record?.appVersion).toBe("0.1.0");
  expect(readFileSync(file(), "utf8")).toBe(text);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
});

test.each([7, 8])("an update reporting schema %i saves the current app metadata once it completes", async (schema) => {
  const previous = record({ paths: { dataDir: "old-data", resourceDir: "old-resources" } });
  const text = put(previous);
  const sourceCommit = "a".repeat(40);
  writeFileSync(join(resourceDir, "payload-manifest.json"), JSON.stringify({ schemaVersion: 2, sourceCommit }));
  const blocked = `${file()}.blocked-write.tmp`;
  mkdirSync(blocked);

  const opened = await openMaintenance(paths(), "0.2.0", { ...clock(), uuid: () => "blocked-write", existingData: true });
  expect(opened.record).toEqual(previous);
  expect(readFileSync(file(), "utf8")).toBe(text);
  rmdirSync(blocked);

  // The update stays unrecorded until it completes; then the current metadata is written with the reported schema.
  await opened.recordDbSchema(schema);
  expect(readFileSync(file(), "utf8")).toBe(text);
  await opened.completeUpdate();
  expect(opened.record).toEqual({ ...previous, appVersion: "0.2.0", dbSchemaVersion: schema,
    payload: { schemaVersion: 2, sourceCommit }, paths: paths(), updatedAt: "2026-10-06T00:00:00.000Z" });
  expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual(opened.record);
  expect(opened.status).toEqual({ run: "update", appVersion: "0.2.0", recordedVersion: "0.1.0", installationId: "authored-installation" });
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  expect((await openMaintenance(paths(), "0.1.0")).run).toBe("downgrade");
});

test("a first run retries its failed initial write with the original installation id", async () => {
  const blocked = `${file()}.blocked-write.tmp`;
  mkdirSync(blocked, { recursive: true });
  const ids = ["new-installation", "blocked-write", "retry-write"];
  const opened = await openMaintenance(paths(), "0.1.0", { ...clock(), uuid: () => ids.shift()! });
  expect(opened.record).toBeNull();
  expect(opened.status.installationId).toBeNull();
  expect(existsSync(file())).toBe(false);
  rmdirSync(blocked);

  await opened.recordDbSchema(3);
  expect(opened.record).toMatchObject({ installationId: "new-installation", appVersion: "0.1.0", dbSchemaVersion: 3 });
  expect(opened.status.installationId).toBe("new-installation");
  expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual(opened.record);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  expect((await openMaintenance(paths(), "0.1.0")).status.installationId).toBe("new-installation");
});

test("a first run whose record cannot be written claims no installation id", async () => {
  const readOnly = {
    readFile: async (path: string) => readFileSync(path, "utf8"),
    writeFile: async () => { throw new Error("read-only"); },
    rename: async () => {},
    unlink: async () => {},
    mkdir: async () => {},
  };
  const opened = await openMaintenance(paths(), "0.1.0", { fs: readOnly });
  expect(opened.status).toEqual({ run: "first-run", appVersion: "0.1.0", recordedVersion: null, installationId: null });
  expect(existsSync(file())).toBe(false);
});

test("recordDbSchema persists, survives a restart, and rejects invalid values", async () => {
  const opened = await openMaintenance(paths(), "0.1.0", clock());
  await opened.recordDbSchema(12);
  expect(opened.record?.dbSchemaVersion).toBe(12);
  expect(JSON.parse(readFileSync(file(), "utf8")).dbSchemaVersion).toBe(12);
  await Promise.all([opened.recordDbSchema(13), opened.recordDbSchema(14)]);
  expect(JSON.parse(readFileSync(file(), "utf8")).dbSchemaVersion).toBe(14);
  expect(readdirSync(dataDir)).toEqual([MAINTENANCE_FILE]);
  expect((await openMaintenance(paths(), "0.1.0")).record?.dbSchemaVersion).toBe(14);
  await expect(opened.recordDbSchema(-1)).rejects.toThrow();
  await expect(opened.recordDbSchema(1.5)).rejects.toThrow();
  expect(JSON.parse(readFileSync(file(), "utf8")).dbSchemaVersion).toBe(14);
});

test("dbSchemaVersionOf parses managed-prepare's schemaVersion: present, absent or invalid", () => {
  const prepared = (extra: Record<string, unknown>) => JSON.parse(JSON.stringify({ port: 3101, settingsPath: "s", env: {}, ...extra }));
  expect(dbSchemaVersionOf(prepared({ schemaVersion: 11 }).schemaVersion)).toBe(11);
  expect(dbSchemaVersionOf(prepared({ schemaVersion: 0 }).schemaVersion)).toBe(0);
  expect(dbSchemaVersionOf(prepared({}).schemaVersion)).toBeNull();
  for (const bad of [-1, 1.5, "3", null, true, {}, [3], Number.MAX_SAFE_INTEGER + 2]) {
    expect(dbSchemaVersionOf(prepared({ schemaVersion: bad }).schemaVersion)).toBeNull();
  }
  expect(dbSchemaVersionOf(Number.NaN)).toBeNull();
  expect(dbSchemaVersionOf(Infinity)).toBeNull();
});

test("payload information comes from the packaged manifest and is null when it is missing or unusable", async () => {
  expect(await readPayloadInfo(resourceDir)).toBeNull();
  const commit = "b".repeat(40);
  writeFileSync(join(resourceDir, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, sourceCommit: commit, files: { "a": "x" } }));
  expect(await readPayloadInfo(resourceDir)).toEqual({ schemaVersion: 1, sourceCommit: commit });
  writeFileSync(join(resourceDir, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, sourceCommit: "not-a-commit" }));
  expect(await readPayloadInfo(resourceDir)).toEqual({ schemaVersion: 1, sourceCommit: null });
  writeFileSync(join(resourceDir, "payload-manifest.json"), "{ broken");
  expect(await readPayloadInfo(resourceDir)).toBeNull();
  writeFileSync(join(resourceDir, "payload-manifest.json"), JSON.stringify({ sourceCommit: commit }));
  expect(await readPayloadInfo(resourceDir)).toBeNull();

  writeFileSync(join(resourceDir, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, sourceCommit: commit }));
  const opened = await openMaintenance(paths(), "0.1.0");
  expect(opened.record?.payload).toEqual({ schemaVersion: 1, sourceCommit: commit });
});

test("a run with no packaged manifest records payload as null", async () => {
  const opened = await openMaintenance(paths(), "0.1.0");
  expect(opened.record?.payload).toBeNull();
});
