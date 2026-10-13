import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AppStatus, BackupJobs, ProgressStage, RequestContext, RestoreListing, SaveResult } from "../src/shared/contracts.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { openMaintenance } from "../src/service/maintenance/manifest.ts";
import { PetService } from "../src/service/router.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// The restore inside the whole service (`router.ts`): while it holds the memory server stopped, a save is answered
// as not saved with the restore's own text, a question or connection check is refused, `status` says why the
// server is down, and a settings backup waits. A settings backup in progress keeps a restore from starting. The
// core's scripts are stand-ins in a fake core (`<resources>/core/apps/memory/scripts`); the restore one waits until
// the test cancels it. The token needs the host vault (real DPAPI on Windows), so without one the test is skipped.

const vaultWorks = await new DpapiVault().set("probe", "x").then(() => true, () => false);

const SCRIPTS = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const resources = join(process.cwd(), "..", "..", "..");
if (args[0] === "verify") {
  const archive = value("--archive");
  if (existsSync(join(resources, "hold-verify"))) {
    writeFileSync(join(resources, "verify-started"), "");
    while (existsSync(join(resources, "hold-verify"))) await Bun.sleep(20);
  }
  const manifest = JSON.parse(await Bun.file(join(archive, "manifest.json")).text());
  process.stdout.write(JSON.stringify({ valid: true, directory: archive, fingerprint: "f".repeat(64), manifest }) + "\\n");
} else if (args[0] === "restore") {
  const stage = join(value("--out"), "..", ".target.portable-restore");
  mkdirSync(stage, { recursive: true }); writeFileSync(join(stage, "checkpoint"), "x");
  await Bun.sleep(60_000);
} else if (args[0] === "export") {
  mkdirSync(join(value("--out"), "..", "export-started"), { recursive: true });
  await Bun.sleep(60_000);
}
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pet-service-restore-"));
  const dataDir = join(dir, "data"), resourceDir = join(dir, "resources"), backupDir = join(dir, "Documents", "Bara 백업");
  const memoryData = join(dataDir, "memory");
  const db = join(memoryData, "db", "bara.sqlite");
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(db, "current database");
  mkdirSync(join(memoryData, "assets"), { recursive: true });
  mkdirSync(join(memoryData, "config"), { recursive: true });
  writeFileSync(join(memoryData, "config", "memory-settings.json"), JSON.stringify(
    { db: { path: db, host: "127.0.0.1", port: 41031 }, assets: { dir: join(memoryData, "assets") }, backup: { dir: join(memoryData, "backups") } }));
  writeFileSync(join(memoryData, "managed-install.json"), JSON.stringify({ version: 1, phase: "complete", port: 41031 }));
  const archive = join(backupDir, "bara-backup-20261001-120000");
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, "manifest.json"), JSON.stringify({ format: "bara-memory", version: 1, createdAt: "2026-10-01T03:00:00.000Z",
    collections: { memories: { count: 3 } }, attachments: [] }));
  const scripts = join(resourceDir, "core", "apps", "memory", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "portable-memory.ts"), SCRIPTS);
  writeFileSync(join(scripts, "prefetch-core-models.ts"), "");
  return { dir, db, memoryData, backupDir, paths: { dataDir, resourceDir, bunPath: process.execPath, backupDir } };
}

const ctx = (signal = new AbortController().signal): RequestContext => ({ signal, progress() {} });
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}
async function appears(path: string): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(path); i++) await Bun.sleep(25);
  if (!existsSync(path)) throw new Error(`${path} never appeared`);
}

test.skipIf(!vaultWorks)("while a restore holds the server stopped, saves, questions and backups are refused with what happened", async () => {
  const s = setup();
  const service = new PetService(s.paths, new DpapiVault(), await openMaintenance(s.paths, PET_VERSION));
  try {
    await service.config.save({ connection: { mode: "local", baseUrl: "http://127.0.0.1:41031" }, token: "c".repeat(40), ownerToken: "o".repeat(40) });
    const listing = await service.dispatch("backup.list", {}, ctx(), []) as RestoreListing;
    expect(listing.entries.map((entry) => entry.name)).toEqual(["bara-backup-20261001-120000"]);
    const restore = rejection(service.dispatch("backup.restore", { id: listing.entries[0]!.id }, ctx(), []));
    await appears(join(s.memoryData, "restore-work", ".target.portable-restore", "checkpoint"));

    const save = await service.dispatch("memory.save", { content: "새 기억", requestId: crypto.randomUUID(), audience: "a" }, ctx(), []) as SaveResult;
    expect(save).toMatchObject({ state: "rejected", message: messages.restore.saveRefused });
    expect(await rejection(service.dispatch("connection.test", {}, ctx(), [])))
      .toMatchObject({ code: "RESTORE_RUNNING", publicMessage: messages.restoreErrors.RESTORE_RUNNING });
    const status = await service.dispatch("status", {}, ctx(), []) as AppStatus;
    expect(status.connection).toEqual({ connected: false, message: messages.restore.serverStopped });
    expect(await rejection(service.dispatch("backup.export", {}, ctx(), []))).toMatchObject({ code: "BACKUP_RESTORE_RUNNING" });
    expect(await rejection(service.dispatch("backup.restore", { id: listing.entries[0]!.id }, ctx(), []))).toMatchObject({ code: "RESTORE_BUSY" });
    // The connection is not changed under the restore; other settings still save.
    expect(await rejection(service.dispatch("settings.save", { connection: { mode: "existing", baseUrl: "http://127.0.0.1:41999" } }, ctx(), [])))
      .toMatchObject({ code: "RESTORE_CONNECTION_LOCKED", publicMessage: messages.restoreErrors.RESTORE_CONNECTION_LOCKED });
    expect(await rejection(service.dispatch("install.local", {}, ctx(), []))).toMatchObject({ code: "RESTORE_CONNECTION_LOCKED" });
    expect(await service.dispatch("settings.save", { autoStart: true }, ctx(), [])).toMatchObject({ autoStart: true });

    // Only the screen's "중단" stops it.
    expect(await service.dispatch("backup.cancel", { kind: "restore" }, ctx(), [])).toEqual({ cancelled: true });
    expect(await restore).toMatchObject({ code: "CANCELLED", publicMessage: messages.restore.cancelled });
    expect(readFileSync(s.db, "utf8")).toBe("current database");
    expect(JSON.parse(readFileSync(join(s.paths.dataDir, "restore-state.json"), "utf8"))).toMatchObject({ stage: "cancelled" });

    // A settings backup in progress keeps a restore from starting.
    const backup = rejection(service.dispatch("backup.export", {}, ctx(), []));
    await appears(join(s.backupDir, "export-started"));
    expect(await rejection(service.dispatch("backup.restore", { id: listing.entries[0]!.id }, ctx(), [])))
      .toMatchObject({ code: "RESTORE_BACKUP_RUNNING", publicMessage: messages.restoreErrors.RESTORE_BACKUP_RUNNING });
    expect(await service.dispatch("backup.cancel", { kind: "export" }, ctx(), [])).toEqual({ cancelled: true });
    expect(await backup).toMatchObject({ code: "CANCELLED", publicMessage: messages.backup.cancelled });
  } finally {
    await service.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!vaultWorks)("a save while the restore still reads the backup is refused, and a screen opened again joins the restore", async () => {
  const s = setup();
  const service = new PetService(s.paths, new DpapiVault(), await openMaintenance(s.paths, PET_VERSION));
  try {
    await service.config.save({ connection: { mode: "local", baseUrl: "http://127.0.0.1:41031" }, token: "c".repeat(40), ownerToken: "o".repeat(40) });
    const listing = await service.dispatch("backup.list", {}, ctx(), []) as RestoreListing;
    writeFileSync(join(s.paths.resourceDir, "hold-verify"), "");
    const screen = new AbortController();
    const leaving = rejection(service.dispatch("backup.restore", { id: listing.entries[0]!.id }, ctx(screen.signal), []));
    await appears(join(s.paths.resourceDir, "verify-started"));
    // The backup is still being read (a model download would be next): the server is already stopped and a save is
    // refused with its text kept in the box, so nothing lands in the store the restore moves aside.
    const save = await service.dispatch("memory.save", { content: "새 기억", requestId: crypto.randomUUID(), audience: "a" }, ctx(), []) as SaveResult;
    expect(save).toMatchObject({ state: "rejected", message: messages.restore.saveRefused });
    expect((await service.dispatch("status", {}, ctx(), []) as AppStatus).connection).toEqual({ connected: false, message: messages.restore.serverStopped });
    // The settings screen goes away: only its wait ends.
    screen.abort();
    await leaving;
    const jobs = await service.dispatch("backup.status", {}, ctx(), []) as BackupJobs;
    expect(jobs).toMatchObject({ export: null, restore: { state: "running", stage: "restore-verify" } });
    // Opened again, it joins the restore and gets its stage first; its "중단" stops it.
    const stages: ProgressStage[] = [];
    const joined = rejection(service.dispatch("backup.join", { kind: "restore" }, { signal: new AbortController().signal, progress: (stage) => stages.push(stage) }, []));
    expect(stages).toEqual(["restore-verify"]);
    expect(await service.dispatch("backup.cancel", { kind: "restore" }, ctx(), [])).toEqual({ cancelled: true });
    expect(await joined).toMatchObject({ code: "CANCELLED", publicMessage: messages.restore.cancelled });
    expect(await service.dispatch("backup.status", {}, ctx(), [])).toEqual({ export: null, restore: null });
    expect(readFileSync(s.db, "utf8")).toBe("current database");
    expect(await rejection(service.dispatch("backup.join", { kind: "other" }, ctx(), []))).toMatchObject({ code: "INVALID_INPUT" });
  } finally {
    await service.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
}, 30_000);
