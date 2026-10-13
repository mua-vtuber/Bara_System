import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_SECRET_STAGING_DIR, adapterLayout, adapterUnitName, adapterUnitText, deployAdapter, removeAdapter } from "./adapter-component.ts";
import { ShellReleaseHost } from "./release-host.ts";
import { replaceRelease, type ReleaseBundle } from "./release-swap.ts";
import { buildAdapterFixture, buildServerFixture, type FixtureBundle } from "./test-utils/release-fixture.ts";
import { FileUnitInstaller, localTransport, ProcessControl } from "./test-utils/local-host.ts";

const ROOT = "/home/bara/.local/share/bara-pet-server";
const TIMING = { healthWaitMs: 15_000, slowMaxMs: 15_000, surviveMs: 1_500, pollMs: 200 };
const ctx = { signal: new AbortController().signal, progress: () => {} };
const code = (error: unknown) => (error as { code?: string }).code;

test("an adapter's unit, folders and environment follow the spec's layout", () => {
  expect(adapterUnitName("discord")).toBe("bara-adapter-discord.service");
  expect(() => adapterUnitName("../x")).toThrow();
  const layout = adapterLayout(ROOT, "discord");
  expect(layout).toEqual({ root: `${ROOT}/adapters/discord`, data: `${ROOT}/adapters/discord/data`, incoming: `${ROOT}/adapters/discord/incoming` });
  const unit = adapterUnitText({ name: "discord", user: "bara", layout, workDir: "apps/bot-discord", startFile: "src/index.ts", serverPort: 3001, timeZone: "Asia/Seoul" });
  expect(unit).toContain(`WorkingDirectory=${ROOT}/adapters/discord/current/apps/bot-discord`);
  expect(unit).toContain(`ExecStart=${ROOT}/adapters/discord/current/bun run src/index.ts`);
  expect(unit).toContain(`Environment=BARA_ADAPTER_DATA_DIR=${ROOT}/adapters/discord/data`);
  expect(unit).toContain("Environment=MEMORY_API_URL=http://127.0.0.1:3001");
  expect(unit).toContain("Environment=TZ=Asia/Seoul");
});

describe.skipIf(process.platform === "win32")("adapters beside the memory server (Linux/WSL)", () => {
  let dir = "", serverRoot = "", port = 0;
  let server: ProcessControl, adapter: ProcessControl, units: FileUnitInstaller;
  const host = new ShellReleaseHost(localTransport());
  const layout = () => adapterLayout(serverRoot, "discord");
  const asBundle = (built: FixtureBundle, component: string, version: string): ReleaseBundle => ({ archive: built.archive, bun: built.bun,
    bunSha: built.bunSha, record: { component, appVersion: version, sourceSha: built.sourceSha, origin: "dev", commit: "d".repeat(40) } });
  const unitInput = () => ({ name: "discord", user: "bara", layout: layout(), workDir: "apps/fixture-adapter", startFile: "src/index.ts", serverPort: port, timeZone: "Asia/Seoul" });
  const deploy = async (version: string, behavior: "stay" | "crash", settingsFile: string | null) => deployAdapter({ host, control: adapter, units,
    unit: unitInput(), bundle: asBundle(await buildAdapterFixture(dir, version, behavior), "discord", version), settingsFile, ctx, options: { timing: TIMING } });
  const serverTarget = () => ({ root: serverRoot, control: server, check: { kind: "server" as const, port, db: join(serverRoot, "data", "db", "bara.sqlite"), snapshotDir: join(serverRoot, "data", "backups", "pre-migration"),
    env: { BARA_KIWI_MODEL_DIR: join(serverRoot, "data", "models", "kiwi-model"), BARA_HF_CACHE_DIR: join(serverRoot, "data", "models", "hf-cache") } } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bara-adapter-"));
    serverRoot = join(dir, "srv");
    await mkdir(join(serverRoot, "data", "db"), { recursive: true });
    const sqlite = new Database(join(serverRoot, "data", "db", "bara.sqlite"));
    sqlite.run("CREATE TABLE schema_version (version INTEGER NOT NULL)"); sqlite.run("INSERT INTO schema_version VALUES (50)"); sqlite.close();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); port = probe.port!; probe.stop(true);
    server = new ProcessControl({ root: serverRoot, workDir: "apps/memory", args: ["run", "src/index.ts"],
      env: { MEMORY_PORT: String(port), MEMORY_DB_PATH: join(serverRoot, "data", "db", "bara.sqlite") } });
    adapter = new ProcessControl({ root: layout().root, workDir: "apps/fixture-adapter", args: ["run", "src/index.ts"], env: { BARA_ADAPTER_DATA_DIR: layout().data } });
    units = new FileUnitInstaller(join(dir, "units", "bara-adapter-discord.service"));
    await replaceRelease(host, serverTarget(), asBundle(await buildServerFixture(dir, "0.1.0", "serve"), "server", "0.1.0"), ctx, { timing: TIMING });
  });
  afterEach(async () => { await adapter.stop(); await server.stop(); await rm(dir, { recursive: true, force: true }); });

  test("a first install without a settings file is refused before anything is created", async () => {
    expect(code(await deploy("0.1.0", "stay", null).catch((e) => e))).toBe("ADAPTER_SETTINGS_REQUIRED");
    expect(await host.exists(layout().root)).toBe(false);
    expect(await units.exists()).toBe(false);
  });

  test("a settings file that does not exist is refused before anything is created", async () => {
    expect(code(await deploy("0.1.0", "stay", join(dir, "nope.json")).catch((e) => e))).toBe("ADAPTER_SETTINGS_MISSING");
    expect(await host.exists(layout().root)).toBe(false);
  });

  test("a settings path that is a folder is refused before anything is created", async () => {
    expect(code(await deploy("0.1.0", "stay", dir).catch((e) => e))).toBe("ADAPTER_SETTINGS_NOT_FILE");
    expect(await host.exists(layout().root)).toBe(false);
  });

  test("the settings file waits in an owner-only folder and no temporary copy remains after success", async () => {
    const settings = join(dir, "s.json"); await writeFile(settings, "{}");
    await deploy("0.1.0", "stay", settings);
    const staging = join(layout().root, ADAPTER_SECRET_STAGING_DIR);
    expect((await stat(staging)).mode & 0o777).toBe(0o700);
    expect(await readdir(staging)).toEqual([]);
  });

  test("when installing the settings file fails, the temporary copy is still removed", async () => {
    const settings = join(dir, "s.json"); await writeFile(settings, "{\"discordToken\":\"secret\"}");
    await mkdir(layout().data, { recursive: true });
    await chmod(layout().data, 0o500);
    await deploy("0.1.0", "stay", settings).then(() => { throw new Error("expected failure"); }, () => {});
    const staging = join(layout().root, ADAPTER_SECRET_STAGING_DIR);
    expect((await stat(staging)).mode & 0o777).toBe(0o700);
    expect(await readdir(staging)).toEqual([]);
  });

  test("a first install puts the settings file in the data folder, owner-only, and starts the adapter", async () => {
    const settings = join(dir, "my-bot-settings.json");
    await writeFile(settings, "{\"discordToken\":\"secret\"}");
    expect(await deploy("0.1.0", "stay", settings)).toMatchObject({ kind: "replaced" });
    const placed = join(layout().data, "bot-settings.json");
    expect(await readFile(placed, "utf8")).toBe("{\"discordToken\":\"secret\"}");
    expect((await stat(placed)).mode & 0o777).toBe(0o600);
    expect(await host.exists(join(layout().data, "started.txt"))).toBe(true);
    expect(await units.read()).toContain("bara-adapter discord");
  });

  test("updating the memory server leaves the adapter's folders and process alone, and the reverse", async () => {
    const settings = join(dir, "s.json"); await writeFile(settings, "{}");
    await deploy("0.1.0", "stay", settings);
    const adapterPid = adapter.pid, adapterFiles = await readdir(layout().root);
    await replaceRelease(host, serverTarget(), asBundle(await buildServerFixture(dir, "0.2.0", "serve"), "server", "0.2.0"), ctx, { timing: TIMING });
    expect(adapter.pid).toBe(adapterPid);
    expect(await readdir(layout().root)).toEqual(adapterFiles);
    const serverPid = server.pid, serverCurrent = await host.readLink(join(serverRoot, "current"));
    await deploy("0.2.0", "stay", null);
    expect(server.pid).toBe(serverPid);
    expect(await host.readLink(join(serverRoot, "current"))).toBe(serverCurrent);
  });

  test("adapter failure rolls back the adapter only", async () => {
    const settings = join(dir, "s.json"); await writeFile(settings, "{}");
    await deploy("0.1.0", "stay", settings);
    const before = await host.readLink(join(layout().root, "current"));
    const serverPid = server.pid;
    expect(code(await deploy("0.2.0", "crash", null).catch((e) => e))).toBe("RELEASE_ROLLED_BACK");
    expect(await host.readLink(join(layout().root, "current"))).toBe(before);
    expect((await adapter.state()).active).toBe("active");
    expect(server.pid).toBe(serverPid);
  });

  test("removing stops the adapter and its registration but keeps the data folder", async () => {
    const settings = join(dir, "s.json"); await writeFile(settings, "{}");
    await deploy("0.1.0", "stay", settings);
    expect(await removeAdapter({ host, control: adapter, units, name: "discord", layout: layout() })).toEqual({ dataDir: layout().data });
    expect((await adapter.state()).active).not.toBe("active");
    expect(await units.exists()).toBe(false);
    expect(await host.exists(join(layout().data, "bot-settings.json"))).toBe(true);
    expect(code(await removeAdapter({ host, control: adapter, units, name: "slack-like", layout: adapterLayout(serverRoot, "slack-like") }).catch((e) => e)))
      .toBe("ADAPTER_NOT_INSTALLED");
  });
});
