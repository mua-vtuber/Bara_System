import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, RuntimePaths, SshConnection } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import type { ReleaseRecord } from "./release-record.ts";
import { ShellReleaseHost } from "./release-host.ts";
import { decideServerUpdate, keptServerStatus, RemoteServerUpdater, STOPPED_CODES, updateFailure } from "./remote-update.ts";
import { replaceServer, type ProbedServer } from "./server-component.ts";
import { FileUnitInstaller, localTransport, ProcessControl } from "./test-utils/local-host.ts";
import { buildServerFixture } from "./test-utils/release-fixture.ts";
import type { PayloadManifest } from "./runtime.ts";

const record = (appVersion: string, origin: "pet" | "dev" = "pet"): ReleaseRecord => ({ format: 1, component: "server", appVersion,
  sourceSha: "a".repeat(64), origin, commit: origin === "dev" ? "b".repeat(40) : null, installedAt: "2026-10-08T00:00:00.000Z" });

test("only a Pet whose server version is higher updates", () => {
  expect(decideServerUpdate("0.2.0", record("0.1.0"))).toEqual({ kind: "update", from: "0.1.0", to: "0.2.0" });
  expect(decideServerUpdate("0.2.0", record("0.2.0"))).toEqual({ kind: "keep" });
  expect(decideServerUpdate("0.2.0", record("0.3.0"))).toEqual({ kind: "keep" });
});

test("a dev build of the same version is left alone even if its content differs", () => {
  expect(decideServerUpdate("0.2.0", record("0.2.0", "dev"))).toEqual({ kind: "keep" });
  expect(decideServerUpdate("0.3.0", record("0.2.0", "dev"))).toEqual({ kind: "update", from: "0.2.0", to: "0.3.0" });
});

test("a server a Pet installed before release records is updated", () => {
  expect(decideServerUpdate("0.2.0", null)).toEqual({ kind: "update", from: null, to: "0.2.0" });
});

test("a failure keeps its whole public message; only the codes that leave the service stopped count as stopped", () => {
  const schema = serviceError("RELEASE_SCHEMA_CHANGED", messages.releaseErrors.RELEASE_SCHEMA_CHANGED("원인", "/srv/data/backups/pre-migration", "/srv/releases/0123456789abcdef"));
  expect(updateFailure(schema, "0.1.0", "0.2.0")).toEqual({ state: "failed", from: "0.1.0", to: "0.2.0", code: "RELEASE_SCHEMA_CHANGED",
    message: schema.publicMessage, stopped: true });
  expect(updateFailure(schema, "0.1.0", "0.2.0").message).toContain("/srv/data/backups/pre-migration");
  for (const code of ["RELEASE_START_FAILED", "RELEASE_ROLLBACK_FAILED", "RELEASE_SCHEMA_CHANGED", "RELEASE_RECOVERY_FAILED", "RELEASE_NOT_RUNNING"])
    expect(STOPPED_CODES.has(code)).toBe(true);
  const rolledBack = serviceError("RELEASE_ROLLED_BACK", messages.releaseErrors.RELEASE_ROLLED_BACK("원인"));
  expect(updateFailure(rolledBack, "0.1.0", "0.2.0")).toMatchObject({ code: "RELEASE_ROLLED_BACK", stopped: false });
  expect(updateFailure(new Error("plain"), null, null)).toMatchObject({ code: "INTERNAL", stopped: false, to: null });
});

const ssh: SshConnection = { host: "server.test", port: 22, user: "bara", keyPath: "C:/keys/id", fingerprint: "SHA256:x", serverPath: "/srv/bara", serverPort: 3001 };
const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress: () => {} });

async function payloadDir(withVersion: boolean): Promise<{ dir: string; paths: RuntimePaths }> {
  const dir = await mkdtemp(join(tmpdir(), "bara-remote-update-"));
  if (withVersion) {
    await mkdir(join(dir, "core", "apps", "memory"), { recursive: true });
    await writeFile(join(dir, "core", "apps", "memory", "package.json"), JSON.stringify({ version: "0.2.0" }));
  }
  return { dir, paths: { dataDir: join(dir, "data"), resourceDir: dir, bunPath: join(dir, "bun.exe") } };
}

// P1: a failed check that left the server as it was never blocks the connection, and is not tried again in this start.
test("a failure that leaves the server running is shown, does not block the connection, and runs once per start", async () => {
  const { dir, paths } = await payloadDir(false);
  try {
    let reads = 0;
    const updater = new RemoteServerUpdater(paths, async () => { reads += 1; return { files: { "server-source.tar.gz": "a".repeat(64) } } as unknown as PayloadManifest; });
    await updater.ensure(ssh, ctx());
    expect(updater.status()).toMatchObject({ state: "failed", code: "PAYLOAD_INVALID", stopped: false, to: null });
    await updater.ensure(ssh, ctx());
    expect(reads).toBe(1);
    updater.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// P1: a failure that left the service stopped fails the connection with its cause, and the next connect checks again.
// The stopped code is raised from the manifest reader here because the whole run classifies by code alone; the real
// replace that raises it runs over SSH (server-component.test.ts covers the replace itself on Linux).
test("a failure that leaves the service stopped fails the connection and the next connect checks again", async () => {
  const { dir, paths } = await payloadDir(true);
  try {
    let reads = 0;
    const stopped = serviceError("RELEASE_START_FAILED", messages.releaseErrors.RELEASE_START_FAILED("원인"));
    const updater = new RemoteServerUpdater(paths, async () => { reads += 1; throw stopped; });
    await expect(updater.ensure(ssh, ctx())).rejects.toBe(stopped);
    expect(updater.status()).toMatchObject({ state: "failed", code: "RELEASE_START_FAILED", stopped: true, message: stopped.publicMessage });
    await expect(updater.ensure(ssh, ctx())).rejects.toBe(stopped);
    expect(reads).toBe(2);
    updater.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function managedEnv(root: string, port: number): Record<string, string> {
  const data = `${root}/data`;
  return { MEMORY_SETTINGS_PATH: `${data}/config/memory-settings.json`, MEMORY_DB_PATH: `${data}/db/bara.sqlite`, MEMORY_PORT: String(port),
    MEMORY_HOST: "127.0.0.1", BARA_SECRETS_PATH: `${data}/config/secrets.json`, BARA_ASSET_DIR: `${data}/assets`,
    BARA_HF_CACHE_DIR: `${data}/models/hf-cache`, BARA_KIWI_MODEL_DIR: `${data}/models/kiwi-model`,
    SSE_TOKEN_PATH: `${data}/tokens/sse-tokens.json`, TZ: "Asia/Seoul" };
}

// Review fix 1: a server an earlier update left stopped on the new version is not reported as current on the next
// connect (the "keep" decision); its cause, with the snapshot folder, stays shown and the service stays stopped.
describe.skipIf(process.platform === "win32")("keep path checks that the server runs (Linux/WSL)", () => {
  const timing = { healthWaitMs: 15_000, slowMaxMs: 15_000, surviveMs: 1_000, pollMs: 200 };
  let dir = "", root = "", control: ProcessControl;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bara-keep-")); root = join(dir, "srv"); });
  afterEach(async () => { await control?.stop(); await rm(dir, { recursive: true, force: true }); });

  async function installed(): Promise<{ host: ShellReleaseHost; probed: Extract<ProbedServer, { kind: "ready" }>; installed: ReleaseRecord }> {
    const env = managedEnv(root, 0);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    env.MEMORY_PORT = String(server.port); server.stop(true);
    await mkdir(join(root, "data", "db"), { recursive: true });
    const sqlite = new Database(env.MEMORY_DB_PATH!); sqlite.run("CREATE TABLE schema_version (version INTEGER NOT NULL)"); sqlite.run("INSERT INTO schema_version VALUES (50)"); sqlite.close();
    control = new ProcessControl({ root, workDir: "apps/memory", args: ["run", "src/index.ts"], env });
    const host = new ShellReleaseHost(localTransport());
    const built = await buildServerFixture(dir, "0.2.0", "serve");
    const probed: Extract<ProbedServer, { kind: "ready" }> = { kind: "ready", host: { serverPath: root, arch: "x64", elevated: false },
      server: { release: `${root}/releases/0000000000000000`, port: Number(env.MEMORY_PORT), tokenFile: env.SSE_TOKEN_PATH!, unitOnLink: true }, env };
    const draft = { component: "server", appVersion: "0.2.0", sourceSha: built.sourceSha, origin: "pet" as const, commit: null };
    const result = await replaceServer({ host, control, units: new FileUnitInstaller(join(dir, "units", "bara-pet-memory.service")), user: "bara" },
      probed, { archive: built.archive, bun: built.bun, bunSha: built.bunSha, record: draft }, ctx(), { timing });
    const running = { ...probed, server: { ...probed.server, release: result.release } };
    return { host, probed: running, installed: { ...draft, format: 1, installedAt: "2026-10-08T00:00:00.000Z" } };
  }

  test("a running server that answers its recorded version is current", async () => {
    const at = await installed();
    expect(await keptServerStatus(at.host, control, at.probed, at.installed, ctx(), timing)).toEqual({ state: "current",
      installed: { appVersion: "0.2.0", origin: "pet", commit: null }, leftoverLock: null, cancelledAfterCheck: false });
  });

  test("a stopped server fails as RELEASE_NOT_RUNNING, counts as stopped, names the snapshot folder and is not started", async () => {
    const at = await installed();
    await control.stop();
    const error = await keptServerStatus(at.host, control, at.probed, at.installed, ctx(), timing).then(() => null, (e: unknown) => e);
    const status = updateFailure(error, null, "0.2.0");
    expect(status).toMatchObject({ state: "failed", code: "RELEASE_NOT_RUNNING", stopped: true });
    expect(status.message).toContain(`${root}/data/backups/pre-migration`);
    expect((await control.state()).active).toBe("inactive");
  });
});
