/**
 * Server-side helper of the Pet's remote install "백업에서 시작" (docs/decisions/2026-10-08-single-deploy-path-spec.md 4.2, 4.3).
 * Runs inside a release (`<release>/bun apps/setup/src/managed-restore.ts ...`) on the managed data root
 * `managed-prepare` lays out (`managedLayout`). Results are one JSON line on stdout; errors go to stderr, exit 1.
 * The work folder names are a contract with apps/pet/src/service/install/remote-restore.ts.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { PORTABLE_RESTORE_RECEIPT, parseRestoreReceipt, type RestoreReceipt } from "../../memory/src/db/portable-restore-gate.ts";
import { managedLayout } from "../../memory/src/settings/managed-layout.ts";
import { withLogsOnStderr } from "./managed-prepare.ts";

export const RESTORE_WORK_DIR = "restore-work";
export const RESTORE_TARGET_DIR = "target";
/** Written when a swap succeeds: which backup this data folder was restored from, so a rerun of the same install
 * finishes instead of refusing a folder that now holds memories (spec 4.3). */
export const RESTORED_MARKER = ".bara-restored-from";
/** Prefix of the folder in the data root that keeps this install's empty database and attachment folder after a swap.
 * Nothing is deleted: spec 4.3 allows clearing only those, and they are moved aside rather than discarded. */
export const REPLACED_DIR_PREFIX = "replaced-before-restore-";
const MARKER_FORMAT = 1;
/** File names inside `portable-memory.ts restore`'s output (apps/memory/src/portable/restore.ts). */
const RESTORED_DB = "memory.sqlite";
const RESTORED_ASSETS = "assets";
const CONTENT_DIR = "content";
const SQLITE_COMPANIONS = ["-wal", "-shm"] as const;
/** Tables whose rows are memories: live and archived. A database holding only archived memories is not empty. */
const MEMORY_TABLES = ["knowledge_nodes", "knowledge_nodes_archive"] as const;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function readMarker(dataRoot: string): string | null {
  const path = join(dataRoot, RESTORED_MARKER);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as { format?: unknown; fingerprint?: unknown };
  if (value.format !== MARKER_FORMAT || typeof value.fingerprint !== "string" || !FINGERPRINT.test(value.fingerprint))
    throw new Error(`${RESTORED_MARKER} is not readable`);
  return value.fingerprint;
}

export interface Inspection { memories: number | null; contentFiles: number; restoredFingerprint: string | null }

/** `memories` is the live plus archived memory rows, or `null` when the data root has no database yet. */
export function inspectManagedData(dataDir: string): Inspection {
  const { root, dbPath, assetDir } = managedLayout(dataDir);
  let memories: number | null = null;
  if (existsSync(dbPath)) {
    const sqlite = new Database(dbPath, { readonly: true });
    try {
      memories = 0;
      for (const table of MEMORY_TABLES)
        memories += (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally { sqlite.close(); }
  }
  const content = join(assetDir, CONTENT_DIR);
  return { memories, contentFiles: existsSync(content) ? readdirSync(content).length : 0, restoredFingerprint: readMarker(root) };
}

function stamp(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

function readCompleteReceipt(target: string, input: SwapInput): RestoreReceipt {
  const path = join(target, PORTABLE_RESTORE_RECEIPT);
  if (!existsSync(path)) throw new Error(`${RESTORE_WORK_DIR}/${RESTORE_TARGET_DIR}/${PORTABLE_RESTORE_RECEIPT} is missing; run the restore first`);
  const receipt = parseRestoreReceipt(JSON.parse(readFileSync(path, "utf8")));
  if (receipt.status !== "complete") throw new Error(`the restore is not complete (status ${receipt.status})`);
  if (receipt.destination !== target) throw new Error(`the restore receipt names another destination than ${RESTORE_WORK_DIR}/${RESTORE_TARGET_DIR}`);
  if (receipt.archiveFingerprint !== input.fingerprint) throw new Error("the restored archive is not the chosen backup");
  const restored = Object.keys(receipt.files).filter((name) => name.startsWith(`${RESTORED_ASSETS}/${CONTENT_DIR}/`)).length;
  if (restored !== input.attachments) throw new Error(`restored ${restored} attachments, the backup lists ${input.attachments}`);
  const db = join(target, RESTORED_DB);
  if (!existsSync(db) || statSync(db).size !== receipt.files[RESTORED_DB]!.byteSize)
    throw new Error(`${RESTORE_WORK_DIR}/${RESTORE_TARGET_DIR}/${RESTORED_DB} does not match the restore receipt`);
  return receipt;
}

/** Undo `done` in reverse. A move that cannot be undone is named in the error, so nothing is left unaccounted for. */
function rollBack(done: Array<[string, string]>, cause: unknown): never {
  const stuck: string[] = [];
  for (const [from, to] of [...done].reverse()) {
    try { renameSync(to, from); } catch (error) { stuck.push(`${to} -> ${from}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (stuck.length > 0) throw new Error(`the swap failed (${reason}) and these moves could not be undone: ${stuck.join("; ")}`, { cause });
  throw new Error(`the swap failed and was undone: ${reason}`, { cause });
}

export interface SwapInput { dataDir: string; fingerprint: string; attachments: number; now: Date }
export interface SwapResult { db: string; assets: string; replaced: string }

export function swapRestored(input: SwapInput): SwapResult {
  const { root, dbPath, assetDir } = managedLayout(input.dataDir);
  const work = join(root, RESTORE_WORK_DIR), target = join(work, RESTORE_TARGET_DIR);
  readCompleteReceipt(target, input);
  const live = inspectManagedData(root);
  if ((live.memories ?? 0) > 0 || live.contentFiles > 0) throw new Error("the target data folder already holds memories");
  const replaced = join(root, `${REPLACED_DIR_PREFIX}${stamp(input.now)}`);
  const replacedDb = join(replaced, "db");
  mkdirSync(replaced); // not recursive: an existing folder of the same name is never mixed into
  mkdirSync(replacedDb);
  const moves: Array<[string, string]> = [];
  for (const suffix of ["", ...SQLITE_COMPANIONS])
    if (existsSync(dbPath + suffix)) moves.push([dbPath + suffix, join(replacedDb, `bara.sqlite${suffix}`)]);
  if (existsSync(assetDir)) moves.push([assetDir, join(replaced, RESTORED_ASSETS)]);
  for (const suffix of ["", ...SQLITE_COMPANIONS]) {
    const restored = join(target, RESTORED_DB + suffix);
    if (suffix === "" || existsSync(restored)) moves.push([restored, dbPath + suffix]);
  }
  moves.push([join(target, RESTORED_ASSETS), assetDir]);
  const done: Array<[string, string]> = [];
  try {
    for (const [from, to] of moves) { renameSync(from, to); done.push([from, to]); }
    const marker = join(root, RESTORED_MARKER), staged = `${marker}.tmp`;
    writeFileSync(staged, JSON.stringify({ format: MARKER_FORMAT, fingerprint: input.fingerprint, at: input.now.toISOString() }));
    renameSync(staged, marker);
  } catch (error) {
    // The aside folders hold nothing once every move is undone; removing an empty folder discards no data.
    try { rollBack(done, error); } finally {
      for (const folder of [replacedDb, replaced]) if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
    }
  }
  // What remains of the work folder is the restore receipt: the restored data now lives in the managed layout.
  rmSync(work, { recursive: true, force: true });
  return { db: dbPath, assets: assetDir, replaced };
}

function parseCount(value: string | undefined): number {
  const count = value === undefined || !/^\d+$/.test(value) ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(count)) throw new Error("--attachments must be a count of attachments");
  return count;
}

if (import.meta.main) {
  try {
    const [command, ...rest] = Bun.argv.slice(2);
    if (command !== "inspect" && command !== "swap") throw new Error("Expected command: inspect or swap");
    const { values } = parseArgs({ args: rest, strict: true,
      options: { "data-dir": { type: "string" }, fingerprint: { type: "string" }, attachments: { type: "string" } } });
    const dataDir = values["data-dir"];
    if (!dataDir) throw new Error("--data-dir is required");
    if (!isAbsolute(dataDir)) throw new Error("--data-dir must be an absolute path");
    const result = withLogsOnStderr(() => {
      if (command === "inspect") return inspectManagedData(dataDir);
      const fingerprint = values.fingerprint;
      if (fingerprint === undefined || !FINGERPRINT.test(fingerprint)) throw new Error("--fingerprint must be 64 hex digits");
      return swapRestored({ dataDir, fingerprint, attachments: parseCount(values.attachments), now: new Date() });
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`managed-restore: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
