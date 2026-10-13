import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { messages } from "../../ui/messages.ts";
import { ShellReleaseHost } from "./release-host.ts";
import { MANAGED_HOST } from "./remote-probe.ts";
import { replaceRelease, type ComponentTarget, type ReleaseBundle, type ReplaceTiming } from "./release-swap.ts";
import { buildAdapterFixture, buildServerFixture, type AdapterBehavior, type FixtureBundle, type ModelBehavior,
  type ServerBehavior } from "./test-utils/release-fixture.ts";
import { localTransport, ProcessControl } from "./test-utils/local-host.ts";

const TIMING: ReplaceTiming = { healthWaitMs: 15_000, slowMaxMs: 15_000, surviveMs: 1_500, pollMs: 200 };
const ctx = { signal: new AbortController().signal, progress: () => {} };
const code = (error: unknown) => (error as { code?: string }).code;

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: MANAGED_HOST, port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("test server has no port");
  return port;
}

function asBundle(built: FixtureBundle, component: string, version: string): ReleaseBundle {
  return { archive: built.archive, bun: built.bun, bunSha: built.bunSha,
    record: { component, appVersion: version, sourceSha: built.sourceSha, origin: "dev", commit: "c".repeat(40) } };
}

describe.skipIf(process.platform === "win32")("replaceRelease on real files and processes (Linux/WSL)", () => {
  let dir = "", root = "", db = "", port = 0;
  let control: ProcessControl;
  const host = new ShellReleaseHost(localTransport());

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bara-swap-"));
    root = join(dir, "server");
    db = join(root, "data", "db", "bara.sqlite");
    await mkdir(join(root, "data", "db"), { recursive: true });
    const sqlite = new Database(db);
    sqlite.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    sqlite.run("INSERT INTO schema_version VALUES (50)");
    sqlite.close();
    port = await freePort();
    control = new ProcessControl({ root, workDir: "apps/memory", args: ["run", "src/index.ts"],
      env: { MEMORY_PORT: String(port), MEMORY_DB_PATH: db } });
  });
  afterEach(async () => { await control.stop(); await rm(dir, { recursive: true, force: true }); });

  const models = () => ({ kiwi: join(root, "data", "models", "kiwi-model"), hf: join(root, "data", "models", "hf-cache") });
  const serverEnv = (): Record<string, string> =>
    ({ MEMORY_PORT: String(port), MEMORY_DB_PATH: db, BARA_KIWI_MODEL_DIR: models().kiwi, BARA_HF_CACHE_DIR: models().hf });
  const target = (env: Record<string, string> = serverEnv()): ComponentTarget => ({ root, control,
    check: { kind: "server", port, db, snapshotDir: join(root, "data", "backups", "pre-migration"), env } });
  async function bundle(version: string, behavior: ServerBehavior = "serve", modelStep: ModelBehavior = "ok"): Promise<ReleaseBundle> {
    return asBundle(await buildServerFixture(dir, version, behavior, modelStep), "server", version);
  }
  const replace = (b: ReleaseBundle) => replaceRelease(host, target(), b, ctx, { timing: TIMING });
  const health = async () => (await fetch(`http://${MANAGED_HOST}:${port}/health`)).json();
  const current = () => host.readLink(join(root, "current"));

  test("a first replace installs, links current and serves the new version", async () => {
    expect(await replace(await bundle("0.1.0"))).toMatchObject({ kind: "replaced", previous: null, reused: false });
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
    const record = JSON.parse(await readFile(join(root, "current", "release.json"), "utf8"));
    expect(record).toMatchObject({ format: 1, component: "server", appVersion: "0.1.0", origin: "dev" });
  });

  test("the new version's dictionary and models are prepared, with the server's environment, before the switch", async () => {
    await replace(await bundle("0.1.0"));
    await replace(await bundle("0.2.0"));
    expect(await readFile(join(models().kiwi, "dictionary.txt"), "utf8")).toBe("0.2.0");
    expect(await readFile(join(models().hf, "model.txt"), "utf8")).toBe("0.2.0");
  });

  test("a model step that fails stops before the running version is touched", async () => {
    await replace(await bundle("0.1.0"));
    const before = await current();
    const pid = control.pid;
    expect(code(await replace(await bundle("0.2.0", "serve", "fail")).catch((e) => e))).toBe("RELEASE_MODELS_FAILED");
    expect(await current()).toBe(before);
    expect(control.pid).toBe(pid);
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
    expect(await host.exists(join(root, ".bara-release-lock"))).toBe(false);
  });

  test("a server environment without a model folder stops with that key named and the running version untouched", async () => {
    await replace(await bundle("0.1.0"));
    const before = await current();
    const { BARA_HF_CACHE_DIR: _dropped, ...partial } = serverEnv();
    const failed = await replaceRelease(host, target(partial), await bundle("0.2.0"), ctx, { timing: TIMING }).catch((e) => e);
    expect(code(failed)).toBe("RELEASE_ENV_INCOMPLETE");
    expect((failed as Error).message).toContain("BARA_HF_CACHE_DIR");
    expect(await current()).toBe(before);
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("a new version that cannot start is rolled back to the running one", async () => {
    await replace(await bundle("0.1.0"));
    const before = await current();
    expect(code(await replace(await bundle("0.2.0", "crash")).catch((e) => e))).toBe("RELEASE_ROLLED_BACK");
    expect(await current()).toBe(before);
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("a version that changed the schema and failed is left stopped with the snapshot folder named", async () => {
    await replace(await bundle("0.1.0"));
    const failed = await replace(await bundle("0.2.0", "migrate-then-crash")).catch((e) => e);
    expect(code(failed)).toBe("RELEASE_SCHEMA_CHANGED");
    expect((failed as Error).message).toContain(join(root, "data", "backups", "pre-migration"));
    expect((await control.state()).active).not.toBe("active");
  });

  test("the schema-changed error names the previous release folder to go back to", async () => {
    await replace(await bundle("0.1.0"));
    const previous = await current();
    const failed = await replace(await bundle("0.2.0", "migrate-then-crash")).catch((e) => e);
    expect(code(failed)).toBe("RELEASE_SCHEMA_CHANGED");
    expect((failed as Error).message).toContain(previous!);
  });

  test("the same bundle again after a schema-changed failure says the service is stopped and does not start it", async () => {
    await replace(await bundle("0.1.0"));
    const broken = await bundle("0.2.0", "migrate-then-crash");
    expect(code(await replace(broken).catch((e) => e))).toBe("RELEASE_SCHEMA_CHANGED");
    const again = await replace(broken).catch((e) => e);
    expect(code(again)).toBe("RELEASE_NOT_RUNNING");
    expect((again as Error).message).toContain(join(root, "data", "backups", "pre-migration"));
    expect((again as Error).message).toContain("apps/memory/README.md");
    expect((await control.state()).active).not.toBe("active");
    expect(control.pid).toBeNull();
  });

  test("a cancellation while the new version is being checked still runs the recovery and says where it ended", async () => {
    await replace(await bundle("0.1.0"));
    const before = await current();
    const oldPid = control.pid;
    const controller = new AbortController();
    // Cancel once the new release's process is seen running (after stop, switch and start), while its check still waits:
    // `slow-serve` answers only after SLOW_START_MS.
    const watcher = setInterval(() => { if (control.pid !== null && control.pid !== oldPid) { clearInterval(watcher); controller.abort(); } }, 20);
    const cancelling = { signal: controller.signal, progress: () => {} };
    const failed = await replaceRelease(host, target(), await bundle("0.2.0", "slow-serve"), cancelling, { timing: TIMING })
      .catch((e) => e).finally(() => clearInterval(watcher));
    expect(controller.signal.aborted).toBe(true);
    expect(code(failed)).toBe("RELEASE_ROLLED_BACK");
    expect((failed as Error).message).toContain(messages.releaseErrors.cancelled);
    expect(await current()).toBe(before);
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
    expect(await host.exists(join(root, ".bara-release-lock"))).toBe(false);
  });

  test("a cancellation right after the new version passed its check keeps it current and running", async () => {
    await replace(await bundle("0.1.0"));
    const controller = new AbortController();
    // The real local transport, cancelling the replace the moment the health step has read a healthy answer: the check
    // returns success with the signal already aborted.
    const base = localTransport();
    const cancelOnHealthy = new ShellReleaseHost({ send: base.send, run: async (script, stepName, limit) => {
      const out = await base.run(script, stepName, limit);
      if (stepName === messages.releaseSteps.health && out.includes("\"ok\":true")) controller.abort();
      return out;
    } });
    const result = await replaceRelease(cancelOnHealthy, target(), await bundle("0.2.0"),
      { signal: controller.signal, progress: () => {} }, { timing: TIMING });
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ kind: "replaced", cancelledAfterCheck: true });
    expect(await current()).toBe((result as { release: string }).release);
    expect(await health()).toEqual({ ok: true, version: "0.2.0" });
    expect((await control.state()).active).toBe("active");
  });

  test("a replace that is not cancelled reports no late cancellation", async () => {
    expect(await replace(await bundle("0.1.0"))).toMatchObject({ kind: "replaced", cancelledAfterCheck: false });
  });

  test("an error from the health check after the switch goes through the recovery", async () => {
    await replace(await bundle("0.1.0"));
    const before = await current();
    const failed = await replace(await bundle("0.2.0", "unreadable-health")).catch((e) => e);
    expect(code(failed)).toBe("RELEASE_ROLLED_BACK");
    expect((failed as Error).message).toContain("fixture bun -e broken");
    expect(await current()).toBe(before);
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("an error inside the recovery ends stopped, with its cause and the folder current points to", async () => {
    await replace(await bundle("0.1.0"));
    const failed = await replace(await bundle("0.2.0", "crash-unreadable-schema")).catch((e) => e);
    expect(code(failed)).toBe("RELEASE_RECOVERY_FAILED");
    const link = await current();
    expect((failed as Error).message).toContain(link!);
    expect((failed as Error).message).toContain("fixture bun -e broken");
    expect((await control.state()).active).not.toBe("active");
  });

  const stickLockAtService = () => ({ signal: new AbortController().signal, progress: (stage: string) => {
    if (stage === "service") writeFileSync(join(root, ".bara-release-lock", "stuck"), "x");
  } });

  test("a finished replace whose lock cannot be removed still reports success, with the leftover lock", async () => {
    const result = await replaceRelease(host, target(), await bundle("0.1.0"), stickLockAtService(), { timing: TIMING });
    expect(result).toMatchObject({ kind: "replaced", leftoverLock: join(root, ".bara-release-lock") });
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("a failed replace whose lock cannot be removed keeps its own error and adds the leftover lock", async () => {
    const failed = await replaceRelease(host, target(), await bundle("0.1.0", "crash"), stickLockAtService(), { timing: TIMING })
      .catch((e) => e);
    expect(code(failed)).toBe("RELEASE_START_FAILED");
    expect((failed as Error).message).toContain(join(root, ".bara-release-lock"));
  });

  test("without a previous release a failed start stays stopped", async () => {
    expect(code(await replace(await bundle("0.1.0", "crash")).catch((e) => e))).toBe("RELEASE_START_FAILED");
    expect((await control.state()).active).not.toBe("active");
  });

  test("a held lock stops the replace before anything changes", async () => {
    await replace(await bundle("0.1.0"));
    const before = await current();
    await mkdir(join(root, ".bara-release-lock"));
    const busy = await replace(await bundle("0.2.0")).catch((e) => e);
    expect(code(busy)).toBe("RELEASE_BUSY");
    expect((busy as Error).message).toContain(join(root, ".bara-release-lock"));
    expect(await current()).toBe(before);
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("a bundle whose digest does not match is refused and current is untouched", async () => {
    const bad = await bundle("0.1.0");
    bad.record = { ...bad.record, sourceSha: "f".repeat(64) };
    expect(code(await replace(bad).catch((e) => e))).toBe("RELEASE_DIGEST_MISMATCH");
    expect(await current()).toBeNull();
    expect(await host.exists(join(root, ".bara-release-lock"))).toBe(false);
  });

  test("the same bundle again changes nothing and keeps the running process", async () => {
    const same = await bundle("0.1.0");
    await replace(same);
    const pid = control.pid;
    expect(await replace(same)).toMatchObject({ kind: "unchanged" });
    expect(control.pid).toBe(pid);
  });

  test("only the running and the previous release directories are kept", async () => {
    for (const version of ["0.1.0", "0.2.0", "0.3.0"]) await replace(await bundle(version));
    expect((await readdir(join(root, "releases"))).length).toBe(2);
  });

  // F2: a slow ARM boot (search model load, pre-migration snapshot) can answer `/health` after `healthWaitMs`. The
  // timings are shortened here; production uses RELEASE_HEALTH_WAIT_MS and RELEASE_HEALTH_SLOW_MAX_MS.
  describe("a server slower than the normal health wait", () => {
    const slow: ReplaceTiming = { ...TIMING, healthWaitMs: 1_000, slowMaxMs: 15_000 };

    test("is still waited for while it stays active without restarting, and says it is still starting", async () => {
      const stages: string[] = [];
      const watching = { signal: new AbortController().signal, progress: (stage: string) => { stages.push(stage); } };
      const result = await replaceRelease(host, target(), await bundle("0.1.0", "slow-serve"), watching, { timing: slow });
      expect(result).toMatchObject({ kind: "replaced", previous: null });
      expect(await health()).toEqual({ ok: true, version: "0.1.0" });
      expect(stages.filter((stage) => stage === "server")).toEqual(["server"]);
    });

    test("is given up at the slow cap", async () => {
      const capped: ReplaceTiming = { ...slow, slowMaxMs: 2_000 };
      const failed = await replaceRelease(host, target(), await bundle("0.1.0", "slow-serve"), ctx, { timing: capped })
        .catch((e) => e);
      expect(code(failed)).toBe("RELEASE_START_FAILED");
      expect((failed as Error).message).toContain(messages.releaseErrors.noAnswer);
    });

    test("is not waited for any longer once it restarted", async () => {
      control = new ProcessControl({ root, workDir: "apps/memory", args: ["run", "src/index.ts"],
        env: { MEMORY_PORT: String(port), MEMORY_DB_PATH: db }, restartOnFailure: true });
      const began = Date.now();
      const failed = await replaceRelease(host, target(), await bundle("0.1.0", "crash-later-then-hang"), ctx, { timing: slow })
        .catch((e) => e);
      expect(code(failed)).toBe("RELEASE_START_FAILED");
      const text = messages.releaseErrors;
      expect([text.restarted(1), text.notActive("activating")].some((why) => (failed as Error).message.includes(why))).toBe(true);
      expect(Date.now() - began).toBeLessThan(slow.slowMaxMs);
    });
  });

  test("the same bundle again while its service is restarting (activating) waits for it instead of failing", async () => {
    control = new ProcessControl({ root, workDir: "apps/memory", args: ["run", "src/index.ts"],
      env: { MEMORY_PORT: String(port), MEMORY_DB_PATH: db }, restartOnFailure: true, restartDelayMs: 1_500 });
    const same = await bundle("0.1.0");
    await replace(same);
    process.kill(control.pid!, "SIGKILL");
    while ((await control.state()).active !== "activating") await Bun.sleep(20);
    expect(await replace(same)).toMatchObject({ kind: "unchanged" });
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });

  test("a complete release directory is reused instead of uploaded again", async () => {
    const first = await bundle("0.1.0"), second = await bundle("0.2.0");
    await replace(first);
    await replace(second);
    expect(await replace(first)).toMatchObject({ kind: "replaced", reused: true });
    expect(await health()).toEqual({ ok: true, version: "0.1.0" });
  });
});

describe.skipIf(process.platform === "win32")("replaceRelease of an adapter (Linux/WSL)", () => {
  let dir = "", root = "", data = "";
  let control: ProcessControl;
  const host = new ShellReleaseHost(localTransport());

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bara-swap-adapter-"));
    root = join(dir, "adapter");
    data = join(dir, "adapter-data");
    await mkdir(data, { recursive: true });
    control = new ProcessControl({ root, workDir: "apps/fixture-adapter", args: ["run", "src/index.ts"],
      env: { BARA_ADAPTER_DATA_DIR: data } });
  });
  afterEach(async () => { await control.stop(); await rm(dir, { recursive: true, force: true }); });

  const target = (): ComponentTarget => ({ root, control, check: { kind: "adapter" } });
  const bundle = async (version: string, behavior: AdapterBehavior) =>
    asBundle(await buildAdapterFixture(dir, version, behavior), "fixture-adapter", version);
  const replace = (b: ReleaseBundle) => replaceRelease(host, target(), b, ctx, { timing: TIMING });

  test("an adapter that stays up counts as started and runs from the new release", async () => {
    const result = await replace(await bundle("0.1.0", "stay"));
    expect(result).toMatchObject({ kind: "replaced", previous: null, reused: false });
    expect((await control.state()).active).toBe("active");
    expect(Number(await readFile(join(data, "started.txt"), "utf8"))).toBe(control.pid!);
  });

  test("an adapter that exits on start is rolled back to the running one", async () => {
    await replace(await bundle("0.1.0", "stay"));
    const before = await host.readLink(join(root, "current"));
    expect(code(await replace(await bundle("0.2.0", "crash")).catch((e) => e))).toBe("RELEASE_ROLLED_BACK");
    expect(await host.readLink(join(root, "current"))).toBe(before);
    expect((await control.state()).active).toBe("active");
  });
});
