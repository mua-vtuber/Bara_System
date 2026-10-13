import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_BUN_VERSION } from "../../shared/bundled-runtime.ts";
import type { ConnectionSettings, RequestContext, RuntimePaths } from "../../shared/contracts.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { messages } from "../../ui/messages.ts";
import { MemoryClient } from "../client.ts";
import { ConfigStore } from "../config.ts";
import { InstallManager } from "./index.ts";
import { availableManagedPort } from "./net.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

/** Await a rejection on the main event loop (see local-server.test.ts). */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

// Test-only stand-ins for the core CLIs and server (apps/setup/PET-INTEGRATION.md), run by a copy of the
// real Bun as real processes. They keep the core's contract only as far as these tests need, and each
// run records itself in the test's data folder so the tests count real processes.
const PREPARE = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true,
  options: { "data-dir": { type: "string" }, port: { type: "string" } } });
const root = values["data-dir"];
const port = Number(values.port);
appendFileSync(join(root, "..", "prepare-runs.log"), port + "\\n");
// Like the core CLI: opening the database creates it when it is missing.
mkdirSync(join(root, "db"), { recursive: true });
const db = join(root, "db", "bara.sqlite");
if (!existsSync(db)) writeFileSync(db, "");
const env = { MEMORY_SETTINGS_PATH: join(root, "config", "memory-settings.json"), MEMORY_DB_PATH: db,
  MEMORY_PORT: String(port), MEMORY_HOST: "127.0.0.1", SSE_TOKEN_PATH: join(root, "tokens", "sse-tokens.json"),
  BARA_KIWI_MODEL_DIR: join(root, "models", "kiwi-model"), TZ: "UTC" };
process.stdout.write(JSON.stringify({ port, settingsPath: env.MEMORY_SETTINGS_PATH, schemaVersion: 1, env }) + "\\n");
`;
const SERVER = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const env = process.env;
appendFileSync(join(dirname(env.MEMORY_DB_PATH), "..", "..", "server-starts.log"), process.pid + "\\n");
// Like the core: a missing token file is created at start holding only the dashboard token.
if (!existsSync(env.SSE_TOKEN_PATH)) {
  mkdirSync(dirname(env.SSE_TOKEN_PATH), { recursive: true });
  writeFileSync(env.SSE_TOKEN_PATH, JSON.stringify({ version: 2, tokens: { dashboard: crypto.randomUUID() } }));
}
const pet = JSON.parse(readFileSync(env.SSE_TOKEN_PATH, "utf8")).tokens.pet;
Bun.serve({ hostname: "127.0.0.1", port: Number(env.MEMORY_PORT), fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ ok: true });
  if (path !== "/client-info") return new Response("not found", { status: 404 });
  if (!pet || request.headers.get("authorization") !== "Bearer " + pet) return new Response("denied", { status: 401 });
  return Response.json({ protocolVersion: 1, version: "test", captureKinds: [], capabilities: [] });
} });
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
  // Like the core CLI: an existing token file is never replaced.
  if (existsSync(file)) process.exit(1);
  mkdirSync(dirname(file), { recursive: true });
  const issue = () => crypto.randomUUID() + crypto.randomUUID();
  writeFileSync(file, JSON.stringify({ version: 2, tokens: { pet: issue(), dashboard: issue() } }));
}
const tokens = JSON.parse(readFileSync(file, "utf8")).tokens;
if (!tokens.pet || !tokens.dashboard) process.exit(1);
process.stdout.write(JSON.stringify({ clientToken: tokens.pet, ownerToken: tokens.dashboard }) + "\\n");
`;
/** No model files are needed by these tests. */
const NO_MODELS = "// Test stand-in: the tests need no model files.\n";

let payload: string;

/** A payload that passes `verifyRuntime`: a copy of the running Bun, the stand-ins, and data files. */
beforeAll(() => {
  if (process.platform !== "win32") return;
  payload = mkdtempSync(join(tmpdir(), "pet-local-payload-"));
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
  mkdirSync(join(payload, "runtime"), { recursive: true });
  copyFileSync(process.execPath, join(payload, "runtime", "bun.exe"));
  files["runtime/bun.exe"] = createHash("sha256").update(readFileSync(join(payload, "runtime", "bun.exe"))).digest("hex");
  writeFileSync(join(payload, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, bunVersion: BUNDLED_BUN_VERSION,
    sourceCommit: "a".repeat(40), files, vcRuntime: { sourceVersion: "14.51.36231", dlls: crtDlls,
      fileVersions: Object.fromEntries(crtDlls.map((name) => [name, "14.51.36247.0"])), deployment: "app-local" } }));
});
afterAll(() => { if (payload) rmSync(payload, { recursive: true, force: true }); });

const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });
const issueToken = () => randomUUID() + randomUUID();

interface Pet {
  dir: string; paths: RuntimePaths; config: ConfigStore; port: number; connection: ConnectionSettings;
  database: string; tokenFile: string;
  writeJournal(phase: "preparing" | "complete"): void; journal(): unknown;
  writeDatabase(): void; writeTokens(pet: string): void; filePetToken(): string;
  prepareRuns(): number[]; serverStarts(): number[]; tokenRuns(): string[];
}

/** A Pet data folder on its own port; nothing is written until a test asks for it. */
async function pet(): Promise<Pet> {
  const dir = mkdtempSync(join(tmpdir(), "pet-local-lifecycle-"));
  const paths = { dataDir: dir, resourceDir: payload, bunPath: join(payload, "runtime", "bun.exe") };
  const memory = join(dir, "memory");
  const journalFile = join(memory, "managed-install.json");
  const database = join(memory, "db", "bara.sqlite");
  const tokenFile = join(memory, "tokens", "sse-tokens.json");
  const port = await availableManagedPort();
  const lines = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean) : [];
  const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  return { dir, paths, config: new ConfigStore(paths, new DpapiVault()), port,
    connection: { mode: "local", baseUrl: `http://127.0.0.1:${port}` }, database, tokenFile,
    writeJournal: (phase) => write(journalFile, JSON.stringify({ version: 1, phase, port })),
    journal: () => JSON.parse(readFileSync(journalFile, "utf8")),
    writeDatabase: () => write(database, ""),
    writeTokens: (petToken) => write(tokenFile, JSON.stringify({ version: 2, tokens: { pet: petToken, dashboard: issueToken() } })),
    filePetToken: () => JSON.parse(readFileSync(tokenFile, "utf8")).tokens.pet,
    prepareRuns: () => lines("prepare-runs.log").map(Number), serverStarts: () => lines("server-starts.log").map(Number),
    tokenRuns: () => lines("client-token-runs.log") };
}

/** The Pet's complete local install: install record, database, token file and the stored token. */
async function installed(): Promise<Pet> {
  const setup = await pet();
  const token = issueToken();
  await setup.config.save({ connection: setup.connection, token });
  setup.writeJournal("complete");
  setup.writeDatabase();
  setup.writeTokens(token);
  return setup;
}

windowsOnly("requests reuse the verified local server: one managed-prepare per server start, none per request", async () => {
  const setup = await installed();
  const first = new InstallManager(setup.config, setup.paths);
  try {
    for (let request = 0; request < 3; request++) await first.ensureConnection(ctx());
    expect(setup.prepareRuns()).toEqual([setup.port]);
    expect(setup.serverStarts()).toHaveLength(1);
  } finally { await first.close(); }
  // The next service process (app restart) starts the server again and prepares once more.
  const second = new InstallManager(setup.config, setup.paths);
  try {
    for (let request = 0; request < 2; request++) await second.ensureConnection(ctx());
    expect(setup.prepareRuns()).toEqual([setup.port, setup.port]);
    expect(setup.serverStarts()).toHaveLength(2);
  } finally {
    await second.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 90_000);

// WP-PFIX-4: the credential route check lets requests through only while the server this service
// started and verified runs; after it stops, the next request is refused before anything is sent.
windowsOnly("requests reach the verified local server and stop being sent once it is gone", async () => {
  const setup = await installed();
  const manager = new InstallManager(setup.config, setup.paths);
  const client = new MemoryClient(setup.config, manager.routes);
  try {
    expect(await client.info()).toEqual({ connected: false, message: messages.connectionErrors.LOCAL_SERVER_UNVERIFIED });
    await manager.ensureConnection(ctx());
    // The stand-in server answers only with the stored token; a protocol version means it was reached.
    expect((await client.info()).protocolVersion).toBe(1);
    await manager.close();
    expect(await client.info()).toEqual({ connected: false, message: messages.connectionErrors.LOCAL_SERVER_UNVERIFIED });
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 60_000);

windowsOnly("a complete install whose database is gone stops before preparing and never creates an empty one", async () => {
  const setup = await pet();
  const token = issueToken();
  await setup.config.save({ connection: setup.connection, token });
  setup.writeJournal("complete");
  setup.writeTokens(token);
  const manager = new InstallManager(setup.config, setup.paths);
  try {
    expect(await rejection(manager.ensureConnection(ctx()))).toMatchObject({ code: "INSTALL_DATA_MISSING" });
    // "Prepare on this PC" reuses the install, so it stops with the same cause instead of resuming.
    expect(await rejection(manager.local(ctx()))).toMatchObject({ code: "INSTALL_DATA_MISSING" });
    expect({ prepared: setup.prepareRuns(), started: setup.serverStarts(), database: existsSync(setup.database) })
      .toEqual({ prepared: [], started: [], database: false });
    expect(setup.journal()).toEqual({ version: 1, phase: "complete", port: setup.port });
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 60_000);

windowsOnly("resuming a complete install without a token checks the database before the record is rewritten", async () => {
  const setup = await pet();
  await setup.config.save({ connection: setup.connection });
  setup.writeJournal("complete");
  const manager = new InstallManager(setup.config, setup.paths);
  try {
    expect(await rejection(manager.local(ctx()))).toMatchObject({ code: "INSTALL_DATA_MISSING" });
    expect(setup.prepareRuns()).toEqual([]);
    expect(setup.journal()).toEqual({ version: 1, phase: "complete", port: setup.port });
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 60_000);

windowsOnly("a missing token file stops the restart before the server could create a dashboard-only one", async () => {
  const setup = await pet();
  await setup.config.save({ connection: setup.connection, token: issueToken() });
  setup.writeJournal("complete");
  setup.writeDatabase();
  const manager = new InstallManager(setup.config, setup.paths);
  try {
    expect(await rejection(manager.ensureConnection(ctx()))).toMatchObject({ code: "INSTALL_TOKENS_MISSING" });
    expect({ prepared: setup.prepareRuns(), started: setup.serverStarts(), tokenFile: existsSync(setup.tokenFile) })
      .toEqual({ prepared: [setup.port], started: [], tokenFile: false });
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 60_000);

windowsOnly("preparing on this PC again issues a missing token file anew and connects", async () => {
  const setup = await pet();
  await setup.config.save({ connection: setup.connection, token: issueToken() });
  setup.writeJournal("complete");
  setup.writeDatabase();
  const manager = new InstallManager(setup.config, setup.paths);
  try {
    const result = await manager.local(ctx());
    expect(result.connection).toEqual(setup.connection);
    expect(setup.tokenRuns()).toEqual(["fresh"]);
    expect((await setup.config.snapshot()).token).toBe(setup.filePetToken());
    expect(setup.journal()).toEqual({ version: 1, phase: "complete", port: setup.port });
    expect(setup.serverStarts()).toHaveLength(1);
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 90_000);

windowsOnly("preparing on this PC again reads back the install's own token after the stored one was rejected", async () => {
  const setup = await installed();
  // The stored token no longer matches the installer-owned token file.
  await setup.config.save({ connection: setup.connection, token: issueToken() });
  const manager = new InstallManager(setup.config, setup.paths);
  try {
    const started = performance.now();
    const result = await manager.local(ctx());
    // The rejected token ended the first readiness wait at once instead of after its 120-second limit.
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(result.connection).toEqual(setup.connection);
    expect(setup.tokenRuns()).toEqual(["read-existing"]);
    expect((await setup.config.snapshot()).token).toBe(setup.filePetToken());
    expect(setup.journal()).toEqual({ version: 1, phase: "complete", port: setup.port });
    expect({ prepared: setup.prepareRuns().length, started: setup.serverStarts().length }).toEqual({ prepared: 2, started: 2 });
    await manager.ensureConnection(ctx());
    expect({ prepared: setup.prepareRuns().length, started: setup.serverStarts().length }).toEqual({ prepared: 2, started: 2 });
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 90_000);

windowsOnly("a remote connection with a token blocks local preparation even when an old local install record exists", async () => {
  const setup = await pet();
  const remote: ConnectionSettings = { mode: "remote", baseUrl: setup.connection.baseUrl,
    ssh: { host: "memory.example.org", port: 22, user: "ubuntu", keyPath: join(setup.dir, "key") } };
  await setup.config.save({ connection: remote, token: issueToken() });
  setup.writeJournal("complete");
  setup.writeDatabase();
  const manager = new InstallManager(setup.config, setup.paths);
  try {
    expect(await rejection(manager.local(ctx()))).toMatchObject({ code: "INSTALL_EXISTING_CONNECTION" });
    expect(setup.prepareRuns()).toEqual([]);
    const after = await setup.config.snapshot();
    expect({ connection: after.settings.connection, hasToken: after.settings.hasToken }).toEqual({ connection: remote, hasToken: true });
    expect(setup.journal()).toEqual({ version: 1, phase: "complete", port: setup.port });
  } finally {
    await manager.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 60_000);
