import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimePaths } from "../../shared/contracts.ts";
import { MANAGED_ENV_KEYS, PET_UNIT_MARKER, parseRemoteFacts, planRemoteInstall } from "./remote-probe.ts";
import { ShellReleaseHost } from "./release-host.ts";
import { bundledServerDraft, replaceServer, serverUnitNeedsRewrite, serverUnitText, type ProbedServer } from "./server-component.ts";
import { buildServerFixture } from "./test-utils/release-fixture.ts";
import { FileUnitInstaller, localTransport, ProcessControl } from "./test-utils/local-host.ts";
import type { PayloadManifest } from "./runtime.ts";

const ROOT = "/home/bara/.local/share/bara-pet-server";
function managedEnv(root: string, port: number): Record<string, string> {
  const data = `${root}/data`;
  return { MEMORY_SETTINGS_PATH: `${data}/config/memory-settings.json`, MEMORY_DB_PATH: `${data}/db/bara.sqlite`, MEMORY_PORT: String(port),
    MEMORY_HOST: "127.0.0.1", BARA_SECRETS_PATH: `${data}/config/secrets.json`, BARA_ASSET_DIR: `${data}/assets`,
    BARA_HF_CACHE_DIR: `${data}/models/hf-cache`, BARA_KIWI_MODEL_DIR: `${data}/models/kiwi-model`,
    SSE_TOKEN_PATH: `${data}/tokens/sse-tokens.json`, TZ: "Asia/Seoul" };
}
/** The `Environment` property `systemctl show` prints for a unit text. */
function shownEnvironment(unit: string): string {
  return unit.split("\n").filter((line) => line.startsWith("Environment=")).map((line) => line.slice("Environment=".length)).join(" ");
}

test("the server unit runs whatever current names and carries every managed path", () => {
  const unit = serverUnitText("bara", ROOT, managedEnv(ROOT, 3001));
  expect(unit.split("\n")[0]).toBe(PET_UNIT_MARKER);
  expect(unit).toContain(`WorkingDirectory=${ROOT}/current/apps/memory`);
  expect(unit).toContain(`ExecStart=${ROOT}/current/bun run src/index.ts`);
  expect(unit).toContain(`Environment=MEMORY_STATIC=${ROOT}/current/apps/memory/web`);
  for (const key of MANAGED_ENV_KEYS) expect(unit).toContain(`Environment=${key}=`);
  const { TZ: _dropped, ...missing } = managedEnv(ROOT, 3001);
  expect(() => serverUnitText("bara", ROOT, missing)).toThrow();
});

test("the probe reads the unit it writes as the Pet's server on the link", () => {
  const facts = parseRemoteFacts(["bara-pet-frame-begin", ...Object.entries({ os: "Linux", machine: "aarch64", sudo: "yes", ubuntu: "yes",
    systemd: "yes", tools_missing: "", server_path: ROOT, core_unit: "absent", core_active: "inactive", core_deploy_timer: "absent",
    pet_unit: "owned", pet_active: "active", pet_enabled: "enabled", pet_main_pid: "77", pet_env: shownEnvironment(serverUnitText("bara", ROOT, managedEnv(ROOT, 3001))),
    path: "owned", marker: "complete", current: `${ROOT}/releases/0123456789abcdef`, release_intact: "yes", listener_count: "1", listener_pids: "77" })
    .map(([key, value]) => `${key}=${value}`), "bara-pet-frame-end"].join("\n"));
  const plan = planRemoteInstall(facts, { serverPort: 3001 });
  expect(plan).toMatchObject({ kind: "connect", server: { release: `${ROOT}/releases/0123456789abcdef`, unitOnLink: true } });
});

test("the Pet's bundle names its memory app version and source digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bara-draft-"));
  try {
    await mkdir(join(dir, "core", "apps", "memory"), { recursive: true });
    await writeFile(join(dir, "core", "apps", "memory", "package.json"), JSON.stringify({ version: "0.4.0" }));
    const paths: RuntimePaths = { dataDir: join(dir, "data"), resourceDir: dir, bunPath: join(dir, "runtime", "bun.exe") };
    const manifest = { files: { "server-source.tar.gz": "a".repeat(64) } } as unknown as PayloadManifest;
    expect(await bundledServerDraft(paths, manifest)).toEqual({ component: "server", appVersion: "0.4.0", sourceSha: "a".repeat(64), origin: "pet", commit: null });
    await writeFile(join(dir, "core", "apps", "memory", "package.json"), "{}");
    expect(await bundledServerDraft(paths, manifest).catch((e) => e.code)).toBe("PAYLOAD_INVALID");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

describe.skipIf(process.platform === "win32")("replaceServer (Linux/WSL)", () => {
  let dir = "", root = "", control: ProcessControl;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bara-server-")); root = join(dir, "srv"); });
  afterEach(async () => { await control?.stop(); await rm(dir, { recursive: true, force: true }); });

  test("a legacy unit is rewritten to the link, then the release is replaced", async () => {
    const env = managedEnv(root, 0);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    env.MEMORY_PORT = String(server.port); server.stop(true);
    await mkdir(join(root, "data", "db"), { recursive: true });
    const sqlite = new Database(env.MEMORY_DB_PATH!); sqlite.run("CREATE TABLE schema_version (version INTEGER NOT NULL)"); sqlite.run("INSERT INTO schema_version VALUES (50)"); sqlite.close();
    control = new ProcessControl({ root, workDir: "apps/memory", args: ["run", "src/index.ts"], env });
    const units = new FileUnitInstaller(join(dir, "units", "bara-pet-memory.service"));
    const built = await buildServerFixture(dir, "0.2.0", "serve");
    const probed: Extract<ProbedServer, { kind: "ready" }> = { kind: "ready", host: { serverPath: root, arch: "x64", elevated: false },
      server: { release: `${root}/releases/0000000000000000`, port: Number(env.MEMORY_PORT), tokenFile: env.SSE_TOKEN_PATH!, unitOnLink: false }, env };
    const result = await replaceServer({ host: new ShellReleaseHost(localTransport()), control, units, user: "bara" }, probed,
      { archive: built.archive, bun: built.bun, bunSha: built.bunSha, record: { component: "server", appVersion: "0.2.0", sourceSha: built.sourceSha, origin: "pet", commit: null } },
      { signal: new AbortController().signal, progress: () => {} }, { timing: { healthWaitMs: 15_000, slowMaxMs: 15_000, surviveMs: 1_000, pollMs: 200 } });
    expect(result.kind).toBe("replaced");
    expect(await units.read()).toContain(`ExecStart=${root}/current/bun run src/index.ts`);
    expect(await (await fetch(`http://127.0.0.1:${env.MEMORY_PORT}/health`)).json()).toEqual({ ok: true, version: "0.2.0" });
  });
});

test("the server unit tells the memory server where adapters live", () => {
  expect(serverUnitText("bara", ROOT, managedEnv(ROOT, 3001))).toContain(`Environment=BARA_ADAPTERS_DIR=${ROOT}/adapters`);
});

test("a link unit written before the adapters variable is rewritten once, a current one is left alone", () => {
  const ready = (env: Record<string, string>, unitOnLink: boolean) => ({ kind: "ready" as const, host: { serverPath: ROOT, arch: "arm64" as const, elevated: true },
    server: { release: `${ROOT}/releases/0123456789abcdef`, port: 3001, tokenFile: `${ROOT}/data/tokens/sse-tokens.json`, unitOnLink }, env });
  const current = { ...managedEnv(ROOT, 3001), BARA_ADAPTERS_DIR: `${ROOT}/adapters`, BARA_RESTART_ON_EXIT: "1" };
  expect(serverUnitNeedsRewrite(ready(current, true))).toBe(false);
  expect(serverUnitNeedsRewrite(ready(managedEnv(ROOT, 3001), true))).toBe(true);
  expect(serverUnitNeedsRewrite(ready(current, false))).toBe(true);
});

test("the server unit marks the process as restarted by its supervisor, and a unit without that mark is rewritten once", () => {
  expect(serverUnitText("bara", ROOT, managedEnv(ROOT, 3001))).toContain("Environment=BARA_RESTART_ON_EXIT=1");
  const ready = (env: Record<string, string>) => ({ kind: "ready" as const, host: { serverPath: ROOT, arch: "arm64" as const, elevated: true },
    server: { release: `${ROOT}/releases/0123456789abcdef`, port: 3001, tokenFile: `${ROOT}/data/tokens/sse-tokens.json`, unitOnLink: true }, env });
  const withoutMark = { ...managedEnv(ROOT, 3001), BARA_ADAPTERS_DIR: `${ROOT}/adapters` };
  expect(serverUnitNeedsRewrite(ready(withoutMark))).toBe(true);
  expect(serverUnitNeedsRewrite(ready({ ...withoutMark, BARA_RESTART_ON_EXIT: "1" }))).toBe(false);
});
