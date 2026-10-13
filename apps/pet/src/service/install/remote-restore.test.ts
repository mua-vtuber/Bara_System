import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tarExecutable } from "../../../scripts/release-bundle.ts";
import { prepareManagedMemory } from "../../../../setup/src/managed-prepare.ts";
import { messages } from "../../ui/messages.ts";
import { REMOTE_EXTRACT_TIMEOUT_MS, RESTORE_DIGEST_TIMEOUT_MS, RESTORE_EXTRACT_TIMEOUT_MS, SSH_COMMAND_TIMEOUT_MS } from "./limits.ts";
import { ShellReleaseHost, type ShellLimit, type ShellTransport } from "./release-host.ts";
import { packBackup, parseInspection, planRemoteRestore, restoreAndSwap, uploadForRestore, type RemoteRestoreRun,
  type RemoteRestoreSource } from "./remote-restore.ts";
import { localTransport, writeBunWrapper } from "./test-utils/local-host.ts";

const F = "a".repeat(64), G = "b".repeat(64);
const EMPTY = { memories: null, contentFiles: 0, restoredFingerprint: null };
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error as { code?: string; message?: string }; } throw new Error("expected a failure"); };
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); },
  (error: unknown) => error as { code?: string; message?: string });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `bara-${name}-`)); dirs.push(dir); return dir; };
const ctx = () => ({ signal: new AbortController().signal, progress: () => {} });

test("a fresh target starts, and leftover work of the same backup resumes", () => {
  expect(planRemoteRestore(EMPTY, null, false, F, "/srv/data/restore-work")).toEqual({ kind: "start" });
  expect(planRemoteRestore({ ...EMPTY, memories: 0 }, { fingerprint: F }, true, F, "/srv/data/restore-work")).toEqual({ kind: "resume" });
});

test("a target already restored from the same backup goes on to the rest of the install", () => {
  expect(planRemoteRestore({ memories: 12, contentFiles: 3, restoredFingerprint: F }, null, false, F, "/w")).toEqual({ kind: "done" });
});

test("a target holding memories, attachments or another backup's restore is refused", () => {
  for (const inspection of [{ ...EMPTY, memories: 1 }, { ...EMPTY, contentFiles: 1 }, { ...EMPTY, restoredFingerprint: G }]) {
    const refused = failure(() => planRemoteRestore(inspection, null, false, F, "/w"));
    expect(refused.code).toBe("RESTORE_TARGET_NOT_EMPTY");
    // The count the server reports includes archived memories, and the text says so.
    expect(refused.message).toContain("보관");
  }
});

test("leftover work of another backup, or without its record, is refused and names the folder", () => {
  for (const job of [{ fingerprint: G }, null]) {
    const refused = failure(() => planRemoteRestore(EMPTY, job, true, F, "/srv/data/restore-work"));
    expect(refused.code).toBe("RESTORE_WORK_OTHER_BACKUP");
    expect(refused.message).toContain("/srv/data/restore-work");
  }
});

test("the server's inspection is read strictly", () => {
  expect(parseInspection('{"memories":0,"contentFiles":0,"restoredFingerprint":null}')).toEqual({ memories: 0, contentFiles: 0, restoredFingerprint: null });
  for (const bad of ["", "{}", '{"memories":"x","contentFiles":0,"restoredFingerprint":null}', `{"memories":0,"contentFiles":0,"restoredFingerprint":"zz"}`,
    '{"memories":-1,"contentFiles":0,"restoredFingerprint":null}', '{"memories":0,"contentFiles":-1,"restoredFingerprint":null}'])
    expect(failure(() => parseInspection(bad)).code).toBe("RELEASE_STEP_OUTPUT_INVALID");
});

function writeBackup(dir: string, memories = 1, archived = 0): string {
  const archive = join(dir, "bara-backup-20261008-120000");
  mkdirSync(join(archive, "attachments", "content"), { recursive: true });
  writeFileSync(join(archive, "manifest.json"), JSON.stringify({ format: "bara-memory",
    collections: { memories: { count: memories }, archivedMemories: { count: archived } }, attachments: [{ sha256: "c".repeat(64), extension: "png" }] }));
  writeFileSync(join(archive, "attachments", "content", "0.png"), "picture");
  return archive;
}
const sourceOf = (archive: string, memories = 1, archived = 0): RemoteRestoreSource =>
  ({ id: "0".repeat(32), name: "bara-backup-20261008-120000", archive, fingerprint: F, counts: { memories, archived, attachments: 1 } });

test("a backup folder is packed into one archive whose digest is its bytes' and whose files come back unchanged", async () => {
  const dir = scratch("pack");
  const archive = writeBackup(dir);
  const packed = await packBackup(sourceOf(archive), join(dir, "scratch"), ctx());
  expect(packed.sha256).toBe(createHash("sha256").update(readFileSync(packed.file)).digest("hex"));
  const out = join(dir, "out"); mkdirSync(out);
  // Windows' own bsdtar: Git Bash's GNU tar first on PATH cannot read a `C:\` path.
  expect(Bun.spawnSync([tarExecutable(), "-xzf", packed.file, "-C", out]).exitCode).toBe(0);
  expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(readFileSync(join(archive, "manifest.json"), "utf8"));
  expect(readFileSync(join(out, "attachments", "content", "0.png"), "utf8")).toBe("picture");
}, 30_000); // Two real tar.exe runs on a temporary folder; on a hosted Windows runner they went past the 5s default.

test("a backup folder that cannot be packed stops before anything is sent and leaves no partial archive", async () => {
  const dir = scratch("pack-missing");
  const refused = await rejection(packBackup(sourceOf(join(dir, "gone")), join(dir, "scratch"), ctx()));
  expect(refused.code).toBe("RESTORE_PACK_FAILED");
  expect(readdirSync(join(dir, "scratch"))).toEqual([]);
});

// spec 4.4 on real files and processes (Linux/WSL: the steps run as `sh` scripts, as over SSH). The release runs this
// checkout's real `managed-restore.ts`, `tar` and `sha256sum`; only `portable-memory.ts restore` is a test stand-in,
// since the real one computes bge-m3 vectors (see remote-restore.integration.test.ts for that run). The stand-in keeps
// the restore's contract: a staging folder beside `--out` while it runs, `--resume` needed to go on from it, a published
// folder with a complete receipt, one JSON result line with `counts` on stdout.
const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const PORTABLE_STANDIN = `
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const archive = value("--archive"), out = value("--out");
const control = JSON.parse(readFileSync(process.env.STANDIN_CONTROL, "utf8"));
appendFileSync(process.env.STANDIN_LOG, JSON.stringify(args) + "\\n");
const stage = join(dirname(out), "." + basename(out) + ".portable-restore");
if (existsSync(stage) && !args.includes("--resume")) { console.error("portable-memory: Restore stage exists; use resume"); process.exit(1); }
mkdirSync(stage, { recursive: true });
console.error("[rows] 1/2");
if (control.interrupt) { console.error("portable-memory: Interrupted by SIGTERM"); process.exit(1); }
const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(join(out, "assets", "content"), { recursive: true });
const db = new Database(join(out, "memory.sqlite"));
db.run("CREATE TABLE knowledge_nodes (id INTEGER PRIMARY KEY, content TEXT)");
db.run("CREATE TABLE knowledge_nodes_archive (id INTEGER PRIMARY KEY, content TEXT)");
for (let i = 0; i < manifest.collections.memories.count; i++) db.run("INSERT INTO knowledge_nodes(content) VALUES ('m')");
for (let i = 0; i < manifest.collections.archivedMemories.count; i++) db.run("INSERT INTO knowledge_nodes_archive(content) VALUES ('a')");
db.close();
const files = { "memory.sqlite": { sha256: sha(readFileSync(join(out, "memory.sqlite"))), byteSize: readFileSync(join(out, "memory.sqlite")).length } };
const put = (file, text) => { writeFileSync(join(out, file), text); files[file] = { sha256: sha(text), byteSize: Buffer.byteLength(text) }; };
put("assets/bara-asset-pairing.json", "{}");
for (const a of manifest.attachments) put("assets/content/" + a.sha256 + "." + a.extension, "picture");
writeFileSync(join(out, "portable-restore.json"), JSON.stringify({ format: "bara-portable-restore", version: 1, operationId: randomUUID(),
  archiveFingerprint: control.fingerprint, modelFingerprint: "d".repeat(64), destination: out, pairingId: randomUUID(), status: "complete", elapsedMs: 1, files }));
rmSync(stage, { recursive: true });
const counts = { memories: manifest.collections.memories.count + (control.miscount ? 1 : 0), archivedMemories: manifest.collections.archivedMemories.count };
process.stdout.write(JSON.stringify({ destination: out, counts, indexCounts: {}, attachmentBytes: 7, elapsedMs: 1 }) + "\\n");
`;

interface Server { run: RemoteRestoreRun; data: string; incoming: string; control(value: Record<string, unknown>): void; calls(): string[][] }

/** A release folder on this machine that runs this checkout (its own `bun`, links to the repository's apps and packages)
 * with the restore stand-in in place of `apps/memory/scripts/portable-memory.ts`. */
async function server(dir: string, shell: ShellTransport = localTransport()): Promise<Server> {
  const release = join(dir, "server", "releases", "0123456789abcdef");
  mkdirSync(join(release, "apps", "memory", "scripts"), { recursive: true });
  await writeBunWrapper(release);
  for (const name of ["node_modules", "package.json"]) symlinkSync(join(REPO, name), join(release, name));
  symlinkSync(join(REPO, "apps", "setup"), join(release, "apps", "setup"));
  for (const name of readdirSync(join(REPO, "apps", "memory")))
    if (name !== "scripts") symlinkSync(join(REPO, "apps", "memory", name), join(release, "apps", "memory", name));
  const control = join(dir, "control.json"), log = join(dir, "calls.log");
  writeFileSync(join(release, "apps", "memory", "scripts", "portable-memory.ts"), PORTABLE_STANDIN);
  writeFileSync(control, JSON.stringify({ fingerprint: F }));
  const data = join(dir, "server", "data"), incoming = join(dir, "server", "incoming");
  mkdirSync(data, { recursive: true });
  // The stand-in's control and log files reach it the way the unit's environment would: exported before each script.
  const wrapped: ShellTransport = { run: (script, step, limit) => shell.run(`export STANDIN_CONTROL='${control}' STANDIN_LOG='${log}'; ${script}`, step, limit),
    send: (file, remote, timeoutMs) => shell.send(file, remote, timeoutMs) };
  return { data, incoming,
    run: { shell: wrapped, host: new ShellReleaseHost(wrapped), release, data, incoming, scratchDir: join(dir, "scratch"), ctx: ctx() },
    control: (value) => writeFileSync(control, JSON.stringify({ fingerprint: F, ...value })),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [] };
}

const memoriesIn = (db: string) => {
  const sqlite = new Database(db, { readonly: true });
  try { return (sqlite.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n; } finally { sqlite.close(); }
};

describe.skipIf(process.platform === "win32")("백업에서 시작 over real sh, tar, sha256sum and managed-restore (Linux/WSL)", () => {
  test("the backup's digest and unpacking get limits sized for a multi-gigabyte archive; release bundles keep theirs", async () => {
    const dir = scratch("remote-limits");
    const local = localTransport();
    const limits: Array<{ step: string; limit: ShellLimit }> = [];
    const recording: ShellTransport = { send: local.send, run: (script, step, limit) => { limits.push({ step, limit }); return local.run(script, step, limit); } };
    const s = await server(dir, recording);
    expect(await uploadForRestore(s.run, sourceOf(writeBackup(dir)))).toEqual({ kind: "start" });
    const limitOf = (step: string) => limits.filter((entry) => entry.step === step).map((entry) => entry.limit);
    expect(limitOf(messages.releaseSteps.digest)).toEqual([{ timeoutMs: RESTORE_DIGEST_TIMEOUT_MS }]);
    expect(limitOf(messages.releaseSteps.extract)).toEqual([{ timeoutMs: RESTORE_EXTRACT_TIMEOUT_MS }]);
    expect(RESTORE_DIGEST_TIMEOUT_MS).toBeGreaterThan(SSH_COMMAND_TIMEOUT_MS);
    expect(RESTORE_EXTRACT_TIMEOUT_MS).toBeGreaterThan(REMOTE_EXTRACT_TIMEOUT_MS);
    // The replace procedure's own calls pass no limit and keep the release bundle's.
    limits.length = 0;
    const host = new ShellReleaseHost(recording);
    const archive = join(s.incoming, "again.tar.gz");
    Bun.spawnSync(["tar", "-czf", archive, "-C", writeBackup(scratch("remote-limits-src")), "."]);
    await host.sha256(archive);
    await host.extract(archive, join(dir, "out"));
    expect(limitOf(messages.releaseSteps.digest)).toEqual([{ timeoutMs: SSH_COMMAND_TIMEOUT_MS }]);
    expect(limitOf(messages.releaseSteps.extract)).toEqual([{ timeoutMs: REMOTE_EXTRACT_TIMEOUT_MS }]);
  }, 60_000);

  test("an upload whose bytes changed on the way is refused before anything is unpacked", async () => {
    const dir = scratch("remote-tamper");
    const local = localTransport();
    const tampering: ShellTransport = { run: local.run,
      send: async (file, remote, timeoutMs) => { await local.send(file, remote, timeoutMs); appendFileSync(remote, "x"); } };
    const s = await server(dir, tampering);
    const refused = await rejection(uploadForRestore(s.run, sourceOf(writeBackup(dir))));
    expect(refused.code).toBe("RESTORE_UPLOAD_MISMATCH");
    expect(existsSync(join(s.incoming, "restore-archive"))).toBe(false);
    // The packed file on this PC is gone too.
    expect(readdirSync(join(dir, "scratch"))).toEqual([]);
  }, 60_000);

  test("a restore cut off resumes with --resume on the next run, swaps in, and a third run finds it done", async () => {
    const dir = scratch("remote-resume");
    const s = await server(dir);
    const source = sourceOf(writeBackup(dir, 3, 1), 3, 1);
    expect(await uploadForRestore(s.run, source)).toEqual({ kind: "start" });
    expect(readdirSync(join(s.incoming, "restore-archive")).sort()).toEqual(["attachments", "manifest.json"]);
    const prepared = prepareManagedMemory({ dataDir: s.data, port: 39_103 });
    const stops: string[] = [];
    s.control({ interrupt: true });
    const cut = await rejection(restoreAndSwap(s.run, source, { kind: "start" }, prepared.env, async () => { stops.push("stop"); }));
    expect(cut.code).toBe("RESTORE_REMOTE_FAILED");
    expect(cut.message).toContain("Interrupted");
    // The empty database `managed-prepare` made is still in place: nothing was swapped.
    expect(memoriesIn(join(s.data, "db", "bara.sqlite"))).toBe(0);

    s.control({});
    const plan = await uploadForRestore(s.run, source);
    expect(plan).toEqual({ kind: "resume" });
    const swapped = await restoreAndSwap(s.run, source, plan, prepared.env, async () => { stops.push("stop"); });
    expect(s.calls().map((args) => args.includes("--resume"))).toEqual([false, true]);
    expect(stops).toEqual(["stop", "stop"]);
    expect(memoriesIn(join(s.data, "db", "bara.sqlite"))).toBe(3);
    expect(swapped?.replaced.startsWith(join(s.data, "replaced-before-restore-"))).toBe(true);
    expect(existsSync(join(swapped!.replaced, "db", "bara.sqlite"))).toBe(true);
    expect(existsSync(join(s.data, "restore-work"))).toBe(false);
    expect(existsSync(join(s.incoming, "restore-archive"))).toBe(false);

    // A copy of the backup left unpacked by a run cut off after its upload is removed when the next run finds it done.
    mkdirSync(join(s.incoming, "restore-archive"), { recursive: true });
    writeFileSync(join(s.incoming, "restore-archive", "manifest.json"), "private");
    writeFileSync(join(s.incoming, "restore-archive.tar.gz"), "private");
    expect(await uploadForRestore(s.run, source)).toEqual({ kind: "done" });
    expect(existsSync(join(s.incoming, "restore-archive"))).toBe(false);
    expect(existsSync(join(s.incoming, "restore-archive.tar.gz"))).toBe(false);
    expect(await restoreAndSwap(s.run, source, { kind: "done" }, prepared.env, async () => { stops.push("stop"); })).toBeNull();
    expect(stops).toEqual(["stop", "stop"]);
  }, 120_000);

  test("a restore whose counts differ from the backup is not swapped in, and a target with memories is refused", async () => {
    const dir = scratch("remote-refuse");
    const s = await server(dir);
    const source = sourceOf(writeBackup(dir, 2, 0), 2, 0);
    const plan = await uploadForRestore(s.run, source);
    const prepared = prepareManagedMemory({ dataDir: s.data, port: 39_104 });
    s.control({ miscount: true });
    const miscounted = await rejection(restoreAndSwap(s.run, source, plan, prepared.env, async () => {}));
    expect(miscounted.code).toBe("RESTORE_REMOTE_COUNT_MISMATCH");
    // Rerunning the same backup gives the same counts, so the text names the work folder to remove.
    expect(miscounted.message).toContain(join(s.data, "restore-work"));
    expect(memoriesIn(join(s.data, "db", "bara.sqlite"))).toBe(0);

    // Another data folder that already holds one archived memory: nothing is packed or sent.
    const other = scratch("remote-full");
    const t = await server(other);
    prepareManagedMemory({ dataDir: t.data, port: 39_105 });
    const db = new Database(join(t.data, "db", "bara.sqlite"));
    db.run("INSERT INTO knowledge_nodes_archive(content, memory_type, source_type, importance, confidence, created_at, last_accessed_at) " +
      "VALUES ('archived', 'fact', 'user', 0.5, 1, '2026-10-08', '2026-10-08')");
    db.close();
    const refused = await rejection(uploadForRestore(t.run, sourceOf(writeBackup(other))));
    expect(refused.code).toBe("RESTORE_TARGET_NOT_EMPTY");
    expect(existsSync(t.incoming)).toBe(false);
  }, 120_000);
});
