import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { snapshotDatabase } from "../../memory/scripts/db-snapshot.ts";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from "../../memory/src/db/migrations.ts";
import type { ManagedPrepared } from "./managed-prepare.ts";

const nextVersion = CURRENT_SCHEMA_VERSION + 1;
let fixtureDir: string;
let prepareScript: string;
let sandbox: string;
let root: string;
let database: string;
let snapshot: string;

/** Run the unchanged preparation/SQLite engine with one next-version migration as data.
 * Only these temporary source copies get that migration; production files and module state stay untouched. */
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "bara-prepare-code-"));
  const migrationsSource = resolve(import.meta.dir, "../../memory/src/db/migrations.ts");
  const migrationFixture = join(fixtureDir, "migrations.ts");
  function sourceWithAbsoluteImports(file: string): string {
    return readFileSync(file, "utf8").replace(/from "([^"]+)"/g, (whole, specifier: string) => {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return whole;
      const target = specifier.startsWith(".") ? resolve(dirname(file), specifier) : Bun.resolveSync(specifier, dirname(file));
      return `from ${JSON.stringify(target.replaceAll("\\", "/"))}`;
    });
  }
  const migrations = sourceWithAbsoluteImports(migrationsSource).replace("export const CURRENT_SCHEMA_VERSION =",
    `MIGRATIONS.push({ version: ${nextVersion}, name: "snapshot-test", up(db) {
      db.run("CREATE TABLE snapshot_test_migrated (id INTEGER PRIMARY KEY)");
    } });\nexport const CURRENT_SCHEMA_VERSION =`);
  writeFileSync(migrationFixture, migrations);
  prepareScript = join(fixtureDir, "managed-prepare.ts");
  writeFileSync(prepareScript, sourceWithAbsoluteImports(join(import.meta.dir, "managed-prepare.ts"))
    .replaceAll(migrationsSource.replaceAll("\\", "/"), migrationFixture.replaceAll("\\", "/")));
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "bara-prepare-snapshot-"));
  root = join(sandbox, "managed");
  database = join(root, "db", "bara.sqlite");
  const db = openMemoryDatabase(database);
  try { db.run("INSERT INTO knowledge_nodes(content) VALUES ('keep this memory')"); }
  finally { db.close(); }
  snapshot = join(root, "backups", "pre-update", "test", "bara.sqlite");
  mkdirSync(dirname(snapshot), { recursive: true });
  expect(snapshotDatabase({ db: database, out: snapshot }).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function runPrepare(candidate?: string) {
  const child = Bun.spawnSync([process.execPath, prepareScript, "--data-dir", root, "--port", "44123",
    ...(candidate === undefined ? [] : ["--pre-update-snapshot", candidate])], { stdout: "pipe", stderr: "pipe" });
  const output = new TextDecoder().decode(child.stdout);
  const error = new TextDecoder().decode(child.stderr);
  expect(child.exitCode, error).toBe(0);
  expect(output.trim().split("\n")).toHaveLength(1);
  expect((JSON.parse(output) as ManagedPrepared).schemaVersion).toBe(nextVersion);
  const db = new Database(database, { readonly: true });
  try {
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'snapshot_test_migrated'").get()).not.toBeNull();
    expect(db.query("SELECT content FROM knowledge_nodes").get()).toEqual({ content: "keep this memory" });
  } finally { db.close(); }
  return error;
}

function expectPreMigrationSnapshot(): void {
  const folder = join(root, "backups", "pre-migration");
  const files = readdirSync(folder);
  expect(files).toHaveLength(1);
  const db = new Database(join(folder, files[0]!), { readonly: true });
  try {
    expect(db.query("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'snapshot_test_migrated'").get()).toBeNull();
    expect(db.query("SELECT content FROM knowledge_nodes").get()).toEqual({ content: "keep this memory" });
  } finally { db.close(); }
}

test("a verified pre-update snapshot avoids a second copy while the pending migration runs", () => {
  const before = readFileSync(snapshot);
  expect(runPrepare(snapshot)).not.toContain("pre-update snapshot ignored");
  expect(existsSync(join(root, "backups", "pre-migration"))).toBe(false);
  expect(readFileSync(snapshot)).toEqual(before);
});

test("without the optional argument preparation still snapshots before migrating", () => {
  const error = runPrepare();
  expect(error).toContain("[pre-migration] snapshot:");
  expect(error).not.toContain("pre-update snapshot ignored");
  expectPreMigrationSnapshot();
});

for (const invalid of ["missing", "outside", "relative", "directory", "symlink", "parent-link-outside", "live-database",
  "different-version", "unreadable-sqlite", "missing-schema", "empty-schema"] as const) {
  test(`an invalid pre-update snapshot (${invalid}) logs to stderr and keeps the pre-migration copy`, () => {
    let candidate = snapshot;
    let reason: string;
    switch (invalid) {
      case "missing": rmSync(dirname(snapshot), { recursive: true }); reason = "regular file"; break;
      case "outside":
        candidate = join(sandbox, "outside.sqlite");
        snapshotDatabase({ db: database, out: candidate }); reason = "inside"; break;
      case "relative": candidate = "backups/pre-update/test/bara.sqlite"; reason = "absolute"; break;
      case "directory": candidate = dirname(snapshot); reason = "regular file"; break;
      case "symlink":
        candidate = join(root, "linked.sqlite");
        // Windows file symlinks need extra privileges; a junction is a real link without them.
        symlinkSync(process.platform === "win32" ? dirname(snapshot) : snapshot, candidate,
          process.platform === "win32" ? "junction" : "file"); reason = "regular file"; break;
      case "live-database": candidate = database; reason = "separate"; break;
      case "parent-link-outside": {
        const outside = join(sandbox, "outside");
        mkdirSync(outside);
        snapshotDatabase({ db: database, out: join(outside, "bara.sqlite") });
        const link = join(root, "linked-folder");
        symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
        candidate = join(link, "bara.sqlite"); reason = "inside"; break;
      }
      case "unreadable-sqlite": writeFileSync(snapshot, "not a SQLite file"); reason = "read"; break;
      default: {
        const copy = new Database(snapshot);
        try {
          if (invalid === "different-version") copy.run("UPDATE schema_version SET version = ?", [nextVersion]);
          else if (invalid === "missing-schema") copy.run("DROP TABLE schema_version");
          else copy.run("DELETE FROM schema_version");
        } finally { copy.close(); }
        reason = invalid === "different-version" ? "version" : "read";
      }
    }
    const error = runPrepare(candidate);
    expect(error).toContain("pre-update snapshot ignored");
    expect(error).toContain(reason);
    expectPreMigrationSnapshot();
  });
}
