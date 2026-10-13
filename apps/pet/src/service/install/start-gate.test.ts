import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BUNDLED_BUN_VERSION } from "../../shared/bundled-runtime.ts";
import type { RequestContext } from "../../shared/contracts.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { ConfigStore } from "../config.ts";
import { serviceError } from "../errors.ts";
import { MAINTENANCE_FILE, openMaintenance } from "../maintenance/manifest.ts";
import { UPDATE_BACKUP_FILE, UPDATE_STATE_FILE, UpdateGate } from "../maintenance/upgrade.ts";
import { InstallManager, type StartGate } from "./index.ts";
import { availableManagedPort } from "./net.ts";

// Where `InstallManager` calls its start gate (`maintenance/upgrade.ts` `UpdateGate`): before `managed-prepare` opens
// the database, and with any later failure of the same start. The payload passes `verifyRuntime` with a copy of the
// running Bun as `runtime/bun.exe` and test-only stand-ins for the core CLIs, which record each run. The server start
// itself is not reached successfully here (no stand-in server). Storing a token needs Windows DPAPI
// (`tests/e2e/dpapi-vault.ts`), so the runs below that need none ("prepare on this PC" resuming a complete install
// without a stored token) run on any platform; the reuse of an install with a stored token runs on Windows only.

const windowsOnly = test.skipIf(process.platform !== "win32");
const memoryApp = resolve(import.meta.dir, "../../../../memory");
const snapshotScript = join(memoryApp, "scripts", "db-snapshot.ts");
const realSnapshot = existsSync(snapshotScript) && existsSync(join(memoryApp, "node_modules", "sqlite-vec"));

const PREPARE = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { "data-dir": { type: "string" }, port: { type: "string" }, "pre-update-snapshot": { type: "string" } } });
const root = values["data-dir"];
const port = Number(values.port);
appendFileSync(join(root, "..", "prepare-runs.log"), port + "\\n");
appendFileSync(join(root, "..", "prepare-args.log"), JSON.stringify(Bun.argv.slice(2)) + "\\n");
const db = join(root, "db", "bara.sqlite");
const env = { MEMORY_SETTINGS_PATH: join(root, "config", "memory-settings.json"), MEMORY_DB_PATH: db,
  MEMORY_PORT: String(port), MEMORY_HOST: "127.0.0.1", SSE_TOKEN_PATH: join(root, "tokens", "sse-tokens.json"),
  BARA_KIWI_MODEL_DIR: join(root, "models", "kiwi-model"), TZ: "UTC" };
process.stdout.write(JSON.stringify({ port, settingsPath: env.MEMORY_SETTINGS_PATH, schemaVersion: 47, env }) + "\\n");
`;
const CLIENT_TOKEN = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { url: { type: "string" },
  "tokens-file": { type: "string" }, fresh: { type: "boolean" }, "read-existing": { type: "boolean" } } });
const file = values["tokens-file"];
appendFileSync(join(dirname(file), "..", "..", "client-token-runs.log"), (values.fresh ? "fresh" : "read-existing") + "\\n");
if (values.fresh) {
  mkdirSync(dirname(file), { recursive: true });
  const issue = () => crypto.randomUUID() + crypto.randomUUID();
  writeFileSync(file, JSON.stringify({ version: 2, tokens: { pet: issue(), dashboard: issue() } }));
}
const tokens = JSON.parse(readFileSync(file, "utf8")).tokens;
process.stdout.write(JSON.stringify({ clientToken: tokens.pet, ownerToken: tokens.dashboard }) + "\\n");
`;
const NO_MODELS = "// Test stand-in: the tests need no model files.\n";
/** Exits at once: the start after a passed gate fails, which is what these tests look at. */
const SERVER = "process.exit(3);\n";

let payload = "";
beforeAll(() => {
  payload = mkdtempSync(join(tmpdir(), "pet-start-gate-payload-"));
  const crtDlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
  const contents: Record<string, string> = {
    "core/apps/setup/src/managed-prepare.ts": PREPARE, "core/apps/memory/src/index.ts": SERVER,
    "core/apps/setup/src/client-token.ts": CLIENT_TOKEN, "core/apps/setup/src/managed-models.ts": NO_MODELS,
    "core/apps/memory/scripts/prefetch-core-models.ts": NO_MODELS,
  };
  for (const name of ["linux/bun-x64", "linux/bun-arm64", "server-source.tar.gz", "core/apps/setup/src/managed-restore.ts"]) contents[name] = name;
  for (const name of [...crtDlls, "CRT-NOTICE.txt"])
    for (const prefix of ["runtime", "core/node_modules/onnxruntime-node/bin/napi-v6/win32/x64"]) contents[`${prefix}/${name}`] = `${prefix}/${name}`;
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(contents)) {
    mkdirSync(dirname(join(payload, name)), { recursive: true });
    writeFileSync(join(payload, name), text);
    files[name] = createHash("sha256").update(text).digest("hex");
  }
  copyFileSync(process.execPath, join(payload, "runtime", "bun.exe"));
  files["runtime/bun.exe"] = createHash("sha256").update(readFileSync(join(payload, "runtime", "bun.exe"))).digest("hex");
  writeFileSync(join(payload, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, bunVersion: BUNDLED_BUN_VERSION,
    sourceCommit: "a".repeat(40), files, vcRuntime: { sourceVersion: "14.51.36231", dlls: crtDlls,
      fileVersions: Object.fromEntries(crtDlls.map((name) => [name, "14.51.36247.0"])), deployment: "app-local" } }));
});
afterAll(() => { if (payload) rmSync(payload, { recursive: true, force: true }); });

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

/** Records each call with the number of `managed-prepare` runs seen at that moment. */
class RecordingGate implements StartGate {
  readonly events: string[] = [];
  constructor(private readonly prepareRuns: () => number, private readonly before: (ctx: RequestContext) => Promise<void> = async () => {}) {}
  async beforePrepare(ctx: RequestContext): Promise<undefined> { this.events.push(`before@${this.prepareRuns()}`); await this.before(ctx); return undefined; }
  async started() { this.events.push("started"); }
  async failed(error: unknown) {
    const code = (error as { code?: string }).code;
    this.events.push(`failed:${code}@${this.prepareRuns()}`);
    return code?.startsWith("UPDATE_") ? error : Object.assign(serviceError("UPDATE_START_FAILED", "wrapped"), { cause: error });
  }
  cancelled() { this.events.push("cancelled"); }
}

/** The Pet's complete local install with its database; `token` also stores the client token (Windows only),
 * `tokens` writes the token file too. */
async function installed(tokens: boolean, storeToken = false) {
  const dir = mkdtempSync(join(tmpdir(), "pet-start-gate-"));
  const paths = { dataDir: dir, resourceDir: payload, bunPath: join(payload, "runtime", "bun.exe") };
  const memory = join(dir, "memory");
  const port = await availableManagedPort();
  const config = new ConfigStore(paths, new DpapiVault());
  const token = randomUUID() + randomUUID();
  await config.save({ connection: { mode: "local", baseUrl: `http://127.0.0.1:${port}` }, ...(storeToken ? { token } : {}) });
  mkdirSync(join(memory, "db"), { recursive: true });
  const db = new Database(join(memory, "db", "bara.sqlite"));
  db.run("CREATE TABLE schema_version(version INTEGER NOT NULL)");
  db.run("INSERT INTO schema_version VALUES (47)");
  db.close();
  writeFileSync(join(memory, "managed-install.json"), JSON.stringify({ version: 1, phase: "complete", port }));
  if (tokens) {
    mkdirSync(join(memory, "tokens"), { recursive: true });
    writeFileSync(join(memory, "tokens", "sse-tokens.json"), JSON.stringify({ version: 2, tokens: { pet: token, dashboard: randomUUID() } }));
  }
  const lines = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean) : [];
  return { dir, paths, config, prepareRuns: () => lines("prepare-runs.log").length,
    prepareArgs: () => lines("prepare-args.log").map((line) => JSON.parse(line) as string[]), tokenRuns: () => lines("client-token-runs.log") };
}

const ctx = (signal = new AbortController().signal): RequestContext => ({ signal, progress() {} });

test.skipIf(!realSnapshot)("managed-prepare receives a real pre-update snapshot only for a pending update", async () => {
  for (const recorded of ["0.1.0", "0.2.0"]) {
    const setup = await installed(true);
    const memory = join(setup.dir, "memory");
    const backupPath = join(memory, "backups", "pre-update", "0.1.0-to-0.2.0-20261008-090000");
    const snapshot = join(backupPath, "bara.sqlite");
    const updatedAt = "2026-10-08T00:00:00.000Z";
    mkdirSync(backupPath, { recursive: true });
    const made = Bun.spawnSync([process.execPath, snapshotScript,
      "--db", join(memory, "db", "bara.sqlite"), "--out", snapshot], { stderr: "pipe" });
    expect({ exit: made.exitCode, stderr: made.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(made.stdout.toString());
    expect(result).toMatchObject({ path: snapshot, schemaVersion: 47 });
    writeFileSync(join(backupPath, UPDATE_BACKUP_FILE), JSON.stringify({ format: 1, createdAt: updatedAt,
      dbSnapshot: { file: "bara.sqlite", bytes: result.bytes, schemaVersion: result.schemaVersion } }));
    writeFileSync(join(setup.dir, MAINTENANCE_FILE), JSON.stringify({ format: 1, installationId: "fixture", appVersion: recorded,
      settingsFormat: 1, dbSchemaVersion: 47, payload: null, paths: setup.paths, updatedAt }));
    writeFileSync(join(setup.dir, UPDATE_STATE_FILE), JSON.stringify({ format: 1, from: "0.1.0", to: "0.2.0",
      stage: "backed-up", backupPath, recordUpdatedAt: updatedAt, updatedAt }));
    const maintenance = await openMaintenance(setup.paths, "0.2.0", { existingData: true });
    const gate = new UpdateGate({ paths: setup.paths, maintenance });
    const manager = new InstallManager(setup.config, setup.paths, async () => {}, async () => 1e12, gate);
    try {
      await rejection(manager.local(ctx())); // The fixture server exits after preparation.
      expect(setup.prepareArgs()).toHaveLength(1);
      const args = setup.prepareArgs()[0]!;
      if (recorded === "0.1.0") expect(args.slice(-2)).toEqual(["--pre-update-snapshot", snapshot]);
      else expect(args).not.toContain("--pre-update-snapshot");
    } finally { await manager.close(); await gate.close(); rmSync(setup.dir, { recursive: true, force: true }); }
  }
}, 120_000);

test("a gate that refuses stops the start before managed-prepare runs, and its error reaches the caller as it is", async () => {
  const setup = await installed(true);
  const refusal = serviceError("UPDATE_VERSION_UNSAFE", "newer data");
  const gate = new RecordingGate(setup.prepareRuns, async () => { throw refusal; });
  const manager = new InstallManager(setup.config, setup.paths, async () => {}, async () => 1e12, gate);
  try {
    expect(await rejection(manager.local(ctx()))).toBe(refusal);
    expect(gate.events).toEqual(["before@0", "failed:UPDATE_VERSION_UNSAFE@0"]);
    expect(setup.prepareRuns()).toBe(0);
  } finally { await manager.close(); rmSync(setup.dir, { recursive: true, force: true }); }
}, 60_000);

test("a failure after the gate passed is handed to it, and the start fails with what it returns", async () => {
  const setup = await installed(false);
  const gate = new RecordingGate(setup.prepareRuns);
  const manager = new InstallManager(setup.config, setup.paths, async () => {}, async () => 1e12, gate);
  try {
    // Preparation, the models and the token run; the stand-in server exits at once.
    const error = await rejection(manager.local(ctx()));
    expect(error).toMatchObject({ code: "UPDATE_START_FAILED", cause: { code: expect.stringMatching(/^[A-Z_]+$/) } });
    expect(setup.tokenRuns()).toEqual(["fresh"]);
    expect(gate.events).toHaveLength(2);
    expect(gate.events[0]).toBe("before@0");
    expect(gate.events[1]).toMatch(/^failed:[A-Z_]+@1$/);
  } finally { await manager.close(); rmSync(setup.dir, { recursive: true, force: true }); }
}, 60_000);

windowsOnly("'prepare on this PC' still repairs a lost token file when the gate named that failure", async () => {
  const setup = await installed(false, true);
  const gate = new RecordingGate(setup.prepareRuns);
  const manager = new InstallManager(setup.config, setup.paths, async () => {}, async () => 1e12, gate);
  try {
    // The reused install's start fails on the missing token file; the repair path issues one and starts again. The
    // stand-in server exits at once, so that start fails too, and the gate is told.
    const error = await rejection(manager.local(ctx()));
    expect(error).toMatchObject({ code: "UPDATE_START_FAILED" });
    expect(setup.tokenRuns()).toEqual(["fresh"]);
    expect(gate.events.slice(0, 3)).toEqual(["before@0", "failed:INSTALL_TOKENS_MISSING@1", "before@1"]);
    expect(gate.events).toHaveLength(4);
    expect(gate.events[3]).toMatch(/^failed:[A-Z_]+@2$/);
    expect(gate.events).not.toContain("started");
  } finally { await manager.close(); rmSync(setup.dir, { recursive: true, force: true }); }
}, 60_000);

test("a cancel while the gate runs stays a cancel and is not handed to the gate as a failure", async () => {
  const setup = await installed(true);
  const controller = new AbortController();
  const gate = new RecordingGate(setup.prepareRuns, async (run) => { controller.abort(); run.signal.throwIfAborted(); });
  const manager = new InstallManager(setup.config, setup.paths, async () => {}, async () => 1e12, gate);
  try {
    expect(await rejection(manager.local(ctx(controller.signal)))).toMatchObject({ name: "AbortError" });
    expect(gate.events).toEqual(["before@0", "cancelled"]);
    expect(setup.prepareRuns()).toBe(0);
  } finally { await manager.close(); rmSync(setup.dir, { recursive: true, force: true }); }
}, 60_000);
