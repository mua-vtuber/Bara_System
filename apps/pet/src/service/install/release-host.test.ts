import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServiceState, ShellReleaseHost, SystemdControl } from "./release-host.ts";
import { localTransport, writeBunWrapper } from "./test-utils/local-host.ts";

test("systemd's two state lines read as the active state and the restart count", () => {
  expect(parseServiceState("active\n3")).toEqual({ active: "active", restarts: 3 });
  expect(parseServiceState("activating\n0")).toEqual({ active: "activating", restarts: 0 });
  for (const bad of ["", "active", "ACTIVE\n1", "active\nx"]) expect(() => parseServiceState(bad)).toThrow();
});

test("a systemd control takes only a plain unit file name and names a bad one", () => {
  const staging = { scratchDir: tmpdir(), remoteIncoming: "/tmp/incoming" };
  for (const good of ["bara-pet-memory.service", "bara-adapter-discord.service", "x@1.service"])
    expect(new SystemdControl(localTransport(), good, false, staging).unit).toBe(good);
  for (const bad of ["", "bara-pet-memory", "../x.service", "a/b.service", "x.service; rm -rf /", "x .service", ".service"]) {
    let thrown: unknown;
    try { new SystemdControl(localTransport(), bad, false, staging); } catch (error) { thrown = error; }
    expect((thrown as { code?: string }).code).toBe("RELEASE_UNIT_INVALID");
    expect((thrown as Error).message).toContain(`'${bad}'`);
  }
});

describe.skipIf(process.platform === "win32")("ShellReleaseHost runs its scripts on the local sh (Linux/WSL)", () => {
  let dir = "";
  const host = new ShellReleaseHost(localTransport());
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bara-host-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("text round-trips through write and read, and a missing file reads as null", async () => {
    const path = join(dir, "a", "release.json");
    await host.makeDir(join(dir, "a"));
    await host.writeText(path, "{\"x\": \"it's\"}\n");
    expect(await host.readText(path)).toBe("{\"x\": \"it's\"}");
    expect(await host.readText(join(dir, "missing.json"))).toBeNull();
    expect(await host.exists(path)).toBe(true);
    expect(await host.exists(join(dir, "missing.json"))).toBe(false);
  });

  test("the link moves to each new target and reads back", async () => {
    const link = join(dir, "current");
    await host.makeDir(join(dir, "r1")); await host.makeDir(join(dir, "r2"));
    expect(await host.readLink(link)).toBeNull();
    await host.pointLink(link, join(dir, "r1"));
    expect(await host.readLink(link)).toBe(join(dir, "r1"));
    await host.pointLink(link, join(dir, "r2"));
    expect(await host.readLink(link)).toBe(join(dir, "r2"));
  });

  test("the lock is taken once until it is released", async () => {
    const lock = join(dir, ".bara-release-lock");
    expect(await host.lock(lock)).toBe(true);
    expect(await host.lock(lock)).toBe(false);
    await host.unlock(lock);
    expect(await host.lock(lock)).toBe(true);
  });

  test("a lock that cannot be made for another reason fails with the real cause instead of reading as busy", async () => {
    const noParent = await host.lock(join(dir, "missing", ".bara-release-lock")).catch((e) => e);
    expect(noParent).toBeInstanceOf(Error);
    expect(String((noParent as { stderr?: string }).stderr)).toContain("No such file or directory");
    await writeFile(join(dir, "file-lock"), "x");
    const notDir = await host.lock(join(dir, "file-lock")).catch((e) => e);
    expect(notDir).toBeInstanceOf(Error);
    expect(String((notDir as { stderr?: string }).stderr)).toContain("File exists");
  });

  test("only real directories are listed", async () => {
    await mkdir(join(dir, "releases", "a"), { recursive: true });
    await mkdir(join(dir, "releases", "b"));
    await symlink(join(dir, "releases", "a"), join(dir, "releases", "c"));
    await writeFile(join(dir, "releases", "d"), "file");
    expect((await host.listDirs(join(dir, "releases"))).sort()).toEqual(["a", "b"]);
    expect(await host.listDirs(join(dir, "missing"))).toEqual([]);
  });

  test("a releases path that is not a readable directory is an error, not an empty list", async () => {
    await writeFile(join(dir, "releases-file"), "file");
    const notDir = await host.listDirs(join(dir, "releases-file")).catch((e) => e);
    expect((notDir as { code?: string }).code).toBe("RELEASE_NOT_DIRECTORY");
    expect((notDir as Error).message).toContain(join(dir, "releases-file"));
    await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    expect((await host.listDirs(join(dir, "dangling")).catch((e) => e) as { code?: string }).code).toBe("RELEASE_NOT_DIRECTORY");
    if (process.getuid?.() !== 0) { // root reads any directory
      await mkdir(join(dir, "closed", "a"), { recursive: true });
      await chmod(join(dir, "closed"), 0o000);
      try {
        const closed = await host.listDirs(join(dir, "closed")).catch((e) => e);
        expect(closed).toBeInstanceOf(Error);
        expect(String((closed as { stderr?: string }).stderr)).toContain("Permission denied");
      } finally { await chmod(join(dir, "closed"), 0o755); }
    }
  });

  test("an archive is extracted into a fresh directory and its digest is sha256sum's", async () => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "hello.txt"), "hi");
    Bun.spawnSync(["tar", "-czf", join(dir, "x.tar.gz"), "-C", join(dir, "src"), "."]);
    const expected = new Bun.CryptoHasher("sha256").update(await Bun.file(join(dir, "x.tar.gz")).bytes()).digest("hex");
    expect(await host.sha256(join(dir, "x.tar.gz"))).toBe(expected);
    await host.makeDir(join(dir, "out")); await writeFile(join(dir, "out", "stale.txt"), "old");
    await host.extract(join(dir, "x.tar.gz"), join(dir, "out"));
    expect(await Bun.file(join(dir, "out", "hello.txt")).text()).toBe("hi");
    expect(await host.exists(join(dir, "out", "stale.txt"))).toBe(false);
  });

  test("the schema version is the highest schema_version row, and null for a missing database", async () => {
    const bun = await writeBunWrapper(join(dir, "bin"));
    const db = join(dir, "bara.sqlite");
    const sqlite = new Database(db);
    sqlite.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    sqlite.run("INSERT INTO schema_version VALUES (47), (52)");
    sqlite.close();
    expect(await host.schemaVersion(bun, db)).toBe(52);
    expect(await host.schemaVersion(bun, join(dir, "none.sqlite"))).toBeNull();
  });

  test("health is null while nothing listens and the body once a server answers", async () => {
    const bun = await writeBunWrapper(join(dir, "bin"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, version: "0.3.0" }) });
    const port = server.port;
    if (port === undefined) throw new Error("test server has no port");
    expect(await host.health(bun, port)).toEqual({ ok: true, version: "0.3.0" });
    server.stop(true);
    expect(await host.health(bun, port)).toBeNull();
  });
});
