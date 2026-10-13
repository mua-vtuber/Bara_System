import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareManagedMemory } from "./managed-prepare.ts";
import { inspectManagedData, REPLACED_DIR_PREFIX, RESTORED_MARKER, swapRestored } from "./managed-restore.ts";

const FINGERPRINT = "a".repeat(64);
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-managed-restore-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A managed data root `managed-prepare` made (real schema, empty), with `memories` rows. */
function managed(root: string, memories = 0): string {
  prepareManagedMemory({ dataDir: root, port: 39_001 });
  const db = new Database(join(root, "db", "bara.sqlite"));
  for (let i = 0; i < memories; i++) db.run("INSERT INTO knowledge_nodes(content) VALUES (?)", [`기억 ${i}`]);
  db.close();
  return root;
}

/** `restore-work/target` as `portable-memory.ts restore` leaves it: a database with `memories` rows, attachments and a
 * complete receipt for `fingerprint`. */
function restoredTarget(data: string, memories: number, attachments: number, fingerprint = FINGERPRINT): void {
  const source = managed(join(dir, `source-${randomUUID()}`), memories);
  const target = join(data, "restore-work", "target");
  mkdirSync(join(target, "assets", "content"), { recursive: true });
  copyFileSync(join(source, "db", "bara.sqlite"), join(target, "memory.sqlite"));
  const files: Record<string, { sha256: string; byteSize: number }> = {};
  const put = (name: string, bytes: string) => { writeFileSync(join(target, name), bytes); files[name] = { sha256: sha(bytes), byteSize: Buffer.byteLength(bytes) }; };
  put("assets/bara-asset-pairing.json", JSON.stringify({ format: 1, pairingId: randomUUID() }));
  for (let i = 0; i < attachments; i++) put(`assets/content/${sha(`a${i}`)}.png`, `attachment ${i}`);
  const db = readFileSync(join(target, "memory.sqlite"));
  files["memory.sqlite"] = { sha256: sha(db), byteSize: db.byteLength };
  writeFileSync(join(target, "portable-restore.json"), JSON.stringify({ format: "bara-portable-restore", version: 1, operationId: randomUUID(),
    archiveFingerprint: fingerprint, modelFingerprint: "c".repeat(64), destination: target, pairingId: randomUUID(), status: "complete", elapsedMs: 1, files }));
}

/** The folders the swap moved this install's empty database and attachment folder into. */
const replacedDirs = (data: string) => readdirSync(data).filter((name) => name.startsWith(REPLACED_DIR_PREFIX));

test("a folder with no database reads as no memories and no attachments", () => {
  expect(inspectManagedData(join(dir, "data"))).toEqual({ memories: null, contentFiles: 0, restoredFingerprint: null });
});

test("the prepared empty database counts zero, and each stored memory counts", () => {
  const data = managed(join(dir, "data"));
  expect(inspectManagedData(data)).toEqual({ memories: 0, contentFiles: 0, restoredFingerprint: null });
  const db = new Database(join(data, "db", "bara.sqlite"));
  db.run("INSERT INTO knowledge_nodes(content) VALUES ('하나')");
  db.close();
  expect(inspectManagedData(data).memories).toBe(1);
});

test("archived memories count too, so a database holding only archived memories is not empty", () => {
  const data = managed(join(dir, "data"));
  const db = new Database(join(data, "db", "bara.sqlite"));
  db.run(`INSERT INTO knowledge_nodes_archive(id, content, memory_type, source_type, importance, confidence, created_at, last_accessed_at)
    VALUES (7, '보관된 기억', 'fact', 'chat', 0.5, 0.5, '2026-01-01', '2026-01-01')`);
  db.close();
  expect(inspectManagedData(data).memories).toBe(1);
  restoredTarget(data, 2, 0);
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 0, now: new Date() })).toThrow("already holds memories");
});

test("the restored database and attachments replace the empty ones, and the folder remembers the backup", () => {
  const data = managed(join(dir, "data"));
  restoredTarget(data, 2, 1);
  const result = swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 1, now: new Date(2026, 9, 8, 12, 0, 0) });
  expect(inspectManagedData(data)).toEqual({ memories: 2, contentFiles: 1, restoredFingerprint: FINGERPRINT });
  expect(existsSync(join(data, "restore-work"))).toBe(false);
  expect(JSON.parse(readFileSync(join(data, RESTORED_MARKER), "utf8")).fingerprint).toBe(FINGERPRINT);
  // The empty database and attachment folder this install made are kept aside, not deleted.
  expect(result.replaced).toBe(join(data, `${REPLACED_DIR_PREFIX}20261008-120000`));
  expect(replacedDirs(data)).toEqual([`${REPLACED_DIR_PREFIX}20261008-120000`]);
  expect(existsSync(join(result.replaced, "db", "bara.sqlite"))).toBe(true);
  expect(existsSync(join(result.replaced, "assets"))).toBe(true);
  const kept = new Database(join(result.replaced, "db", "bara.sqlite"), { readonly: true });
  try { expect((kept.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n).toBe(0); }
  finally { kept.close(); }
});

test("a target that already holds memories is never replaced", () => {
  const data = managed(join(dir, "data"), 1);
  restoredTarget(data, 2, 0);
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 0, now: new Date() })).toThrow("already holds memories");
  expect(inspectManagedData(data).memories).toBe(1);
  expect(existsSync(join(data, "restore-work", "target", "memory.sqlite"))).toBe(true);
  expect(replacedDirs(data)).toEqual([]);
});

test("a restore of another backup or with other attachments is not swapped in", () => {
  const data = managed(join(dir, "data"));
  restoredTarget(data, 2, 1, "b".repeat(64));
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 1, now: new Date() })).toThrow("not the chosen backup");
  rmSync(join(data, "restore-work"), { recursive: true, force: true });
  restoredTarget(data, 2, 1);
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 2, now: new Date() })).toThrow("attachments");
  expect(inspectManagedData(data).memories).toBe(0);
});

test("an unfinished restore or a missing restore is refused by name", () => {
  const data = managed(join(dir, "data"));
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 0, now: new Date() })).toThrow("portable-restore.json");
  restoredTarget(data, 1, 0);
  const receiptPath = join(data, "restore-work", "target", "portable-restore.json");
  writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(readFileSync(receiptPath, "utf8")), status: "incomplete" }));
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 0, now: new Date() })).toThrow("not complete");
  expect(inspectManagedData(data).memories).toBe(0);
});

test("a swap that fails part way puts every moved file back", () => {
  const data = managed(join(dir, "data"));
  restoredTarget(data, 2, 1);
  // The restored attachment folder vanished after the restore: the last move fails after the database moves succeeded.
  rmSync(join(data, "restore-work", "target", "assets"), { recursive: true, force: true });
  expect(() => swapRestored({ dataDir: data, fingerprint: FINGERPRINT, attachments: 1, now: new Date() })).toThrow();
  expect(inspectManagedData(data)).toEqual({ memories: 0, contentFiles: 0, restoredFingerprint: null });
  expect(existsSync(join(data, "assets"))).toBe(true);
  expect(existsSync(join(data, "restore-work", "target", "memory.sqlite"))).toBe(true);
  expect(replacedDirs(data)).toEqual([]);
});

test("the CLI prints the inspection as JSON and fails loudly without its data folder", () => {
  const data = managed(join(dir, "data"));
  const ok = Bun.spawnSync([process.execPath, join(import.meta.dir, "managed-restore.ts"), "inspect", "--data-dir", data], { stdout: "pipe", stderr: "pipe" });
  expect(JSON.parse(ok.stdout.toString())).toEqual({ memories: 0, contentFiles: 0, restoredFingerprint: null });
  const bad = Bun.spawnSync([process.execPath, join(import.meta.dir, "managed-restore.ts"), "inspect"], { stdout: "pipe", stderr: "pipe" });
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("--data-dir");
});

test("the CLI swap names a malformed fingerprint or attachment count", () => {
  const data = managed(join(dir, "data"));
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "managed-restore.ts"), "swap", "--data-dir", data, ...args],
    { stdout: "pipe", stderr: "pipe" });
  const noPrint = run("--attachments", "0");
  expect(noPrint.exitCode).toBe(1);
  expect(noPrint.stderr.toString()).toContain("--fingerprint");
  const noCount = run("--fingerprint", FINGERPRINT);
  expect(noCount.exitCode).toBe(1);
  expect(noCount.stderr.toString()).toContain("--attachments");
  expect(noCount.stdout.toString()).toBe("");
});
