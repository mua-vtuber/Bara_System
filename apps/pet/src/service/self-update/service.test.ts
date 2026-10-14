import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext } from "../../shared/contracts.ts";
import { SELF_UPDATE } from "../../shared/self-update.ts";
import { ServiceError } from "../errors.ts";
import { notifiedRecordPath } from "./notified-record.ts";
import { SelfUpdateService } from "./service.ts";

// The release API and the release file host are one real loopback server; the notice record is a real file.
const NAME = "Bara.Pet_0.1.9_x64-setup.exe";
const INSTALLER = new Uint8Array(randomBytes(64 * 1024));
const services: SelfUpdateService[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const server of servers.splice(0)) server.stop(true); });

function world(options: { holdDownload?: boolean } = {}) {
  let failing: number | null = null, releases = 0, downloads = 0;
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => { letGo = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/latest") {
      releases++;
      return failing === null ? Response.json(body) : new Response("", { status: failing });
    }
    downloads++;
    if (!options.holdDownload) return new Response(INSTALLER);
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(INSTALLER.subarray(0, 1)); await held; controller.enqueue(INSTALLER.subarray(1)); controller.close();
    } }), { headers: { "content-length": String(INSTALLER.length) } });
  } });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const source = { latestUrl: `${origin}/latest`, downloadBaseUrl: `${origin}/download/` };
  const body: { tag_name: string; assets: object[] } = { tag_name: "v0.1.9", assets: [{ name: NAME, size: INSTALLER.length, browser_download_url: `${source.downloadBaseUrl}v0.1.9/${NAME}`,
    digest: `sha256:${createHash("sha256").update(INSTALLER).digest("hex")}` }] };
  const dataDir = mkdtempSync(join(tmpdir(), "bara-self-update-"));
  const start = () => {
    const paths = { dataDir, resourceDir: dataDir, bunPath: process.execPath };
    const service = new SelfUpdateService({ paths, currentVersion: "0.1.8", source });
    services.push(service);
    return service;
  };
  return { dataDir, start, letGo, releases: () => releases, downloads: () => downloads, fail: (status: number | null) => { failing = status; } };
}
const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress: () => {} });
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500 && !condition(); tries++) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

test("the first start checks at once, a second start does not check again", async () => {
  const w = world();
  const service = w.start();
  service.ensureStarted();
  service.ensureStarted();
  await service.check();
  expect(w.releases()).toBe(1);
  expect(await service.status()).toMatchObject({ check: "available", available: "0.1.9", announce: "0.1.9", failureNoticeId: null });
});

test("acknowledging the notice records it in self-update.json, so a new start does not announce it again", async () => {
  const w = world();
  const first = w.start();
  first.ensureStarted();
  await first.check();
  expect((await first.acknowledge("0.1.9")).announce).toBeNull();
  expect(JSON.parse(readFileSync(notifiedRecordPath(w.dataDir), "utf8"))).toEqual({ format: SELF_UPDATE.recordFormat, notifiedVersion: "0.1.9" });
  expect(existsSync(join(w.dataDir, "pet-settings.json"))).toBe(false);
  first.close();
  const second = w.start();
  second.ensureStarted();
  await second.check();
  expect(await second.status()).toMatchObject({ available: "0.1.9", announce: null });
});

test("a failed check keeps the version found before, and only a new run of failures gets a new notice id", async () => {
  const w = world();
  const service = w.start();
  service.ensureStarted();
  await service.check();
  w.fail(403);
  expect(await service.tick()).toBe("checked");
  expect(await service.status()).toMatchObject({ check: "failed", available: "0.1.9", failureNoticeId: 1, failure: { code: "SELF_UPDATE_HTTP" } });
  await service.tick();
  expect((await service.status()).failureNoticeId).toBe(1);
  w.fail(null);
  await service.tick();
  expect((await service.status()).failureNoticeId).toBeNull();
  w.fail(500);
  await service.tick();
  expect((await service.status()).failureNoticeId).toBe(2);
  const log = readFileSync(join(w.dataDir, SELF_UPDATE.logFileName), "utf8");
  expect(log.match(/SELF_UPDATE_HTTP/g)?.length).toBe(3);
});

test("a scheduled check is skipped while the installer downloads", async () => {
  const w = world({ holdDownload: true });
  const service = w.start();
  service.ensureStarted();
  await service.check();
  const install = service.install("0.1.9", ctx());
  await until(() => w.downloads() === 1);
  expect(service.installing).toBe(true);
  expect(await service.tick()).toBe("skipped");
  expect(w.releases()).toBe(1);
  w.letGo();
  expect((await install).installer).toBe(join(w.dataDir, SELF_UPDATE.updatesDirName, NAME));
});

test("two installs of the same version share one download", async () => {
  const w = world({ holdDownload: true });
  const service = w.start();
  service.ensureStarted();
  await service.check();
  const first = service.install("0.1.9", ctx());
  const second = service.install("0.1.9", ctx());
  await until(() => w.downloads() === 1);
  w.letGo();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(w.downloads()).toBe(1);
  expect(readdirSync(join(w.dataDir, SELF_UPDATE.updatesDirName))).toEqual([NAME]);
});

test("an installer is only downloaded for the version the check found", async () => {
  const w = world();
  const service = w.start();
  service.ensureStarted();
  await service.check();
  const error = await service.install("0.2.0", ctx()).then(() => null, (caught: unknown) => caught);
  expect((error as ServiceError).code).toBe("SELF_UPDATE_NOT_AVAILABLE");
  expect(w.downloads()).toBe(0);
});

test("closing the service stops a download and leaves no partial file", async () => {
  const w = world({ holdDownload: true });
  const service = w.start();
  service.ensureStarted();
  await service.check();
  const install = service.install("0.1.9", ctx()).then(() => null, (caught: unknown) => caught);
  await until(() => w.downloads() === 1);
  service.close();
  expect(await install).toBeInstanceOf(ServiceError);
  expect(readdirSync(join(w.dataDir, SELF_UPDATE.updatesDirName))).toEqual([]);
  w.letGo();
});

test("what an earlier update left in the updates folder is removed when the checks start", async () => {
  const w = world();
  const updates = join(w.dataDir, SELF_UPDATE.updatesDirName);
  mkdirSync(updates);
  writeFileSync(join(updates, "Bara.Pet_0.1.8_x64-setup.exe"), "old");
  writeFileSync(join(updates, `${NAME}.partial`), "half");
  const service = w.start();
  service.ensureStarted();
  await service.check();
  await service.install("0.1.9", ctx());
  expect(readdirSync(updates)).toEqual([NAME]);
});

test("a broken record is logged and reported, and no notice bubble is owed while it is unreadable", async () => {
  const w = world();
  writeFileSync(notifiedRecordPath(w.dataDir), "{broken");
  const service = w.start();
  service.ensureStarted();
  await service.check();
  const status = await service.status();
  expect(status).toMatchObject({ available: "0.1.9", announce: null });
  expect(status.recordError).toContain(notifiedRecordPath(w.dataDir));
  expect(readFileSync(join(w.dataDir, SELF_UPDATE.logFileName), "utf8")).toContain("SELF_UPDATE_RECORD_INVALID");
  await service.status(); // read once per start: the log gets one line, not one per ask
  expect(readFileSync(join(w.dataDir, SELF_UPDATE.logFileName), "utf8").match(/SELF_UPDATE_RECORD_INVALID/g)?.length).toBe(1);
  expect(readFileSync(notifiedRecordPath(w.dataDir), "utf8")).toBe("{broken");
});
