import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareManagedMemory } from "../../../../setup/src/managed-prepare.ts";
import { ShellReleaseHost } from "./release-host.ts";
import { restoreAndSwap, uploadForRestore, type RemoteRestoreSource } from "./remote-restore.ts";
import { localTransport, writeBunWrapper } from "./test-utils/local-host.ts";

// spec 4.4: "WSL에서 실제 글 형식 백업으로 2~5번을 끝까지 실행". Real exporter, verify, restore (bge-m3 vectors), managed-prepare and
// managed-restore on real SQLite files. It takes up to about 30 minutes (the first run downloads bge-m3), so it runs only
// with BARA_HEAVY_TESTS=1 on Linux/WSL; the default suite stays fast. remote-restore.test.ts covers the same steps on real
// processes with a restore stand-in. Attachment hashes and search results are checked on the real A1 backup (plan Task 15).
const HEAVY = process.env.BARA_HEAVY_TESTS === "1";
const RUNS = HEAVY && process.platform !== "win32";
if (!RUNS)
  console.log(`remote-restore.integration.test.ts skipped: ${process.platform === "win32" ? "needs Linux/WSL" : "set BARA_HEAVY_TESTS=1"} ` +
    "(real bge-m3 restore, up to 30 minutes)");

const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MEMORY_APP = join(REPO, "apps", "memory");
const scratch: string[] = [];
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }); });

function bun(args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync([process.execPath, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
const lastJson = (text: string) => JSON.parse(text.trim().split("\n").at(-1)!);

describe.skipIf(!RUNS)("백업에서 시작 on real files, SQLite and bge-m3 (Linux/WSL, heavy)", () => {
  test("a real portable backup fills a fresh managed data folder, and a rerun finds it done", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bara-remote-restore-")); scratch.push(dir);
    const sourceData = join(dir, "source");
    prepareManagedMemory({ dataDir: sourceData, port: 39_101 });
    const db = new Database(join(sourceData, "db", "bara.sqlite"));
    for (const text of ["첫 기억", "둘째 기억", "셋째 기억"]) db.run("INSERT INTO knowledge_nodes(content) VALUES (?)", [text]);
    db.close();
    const backup = join(dir, "bara-backup-20261008-120000");
    bun(["scripts/portable-memory.ts", "export", "--db", join(sourceData, "db", "bara.sqlite"), "--assets", join(sourceData, "assets"), "--out", backup], MEMORY_APP);
    const verified = lastJson(bun(["scripts/portable-memory.ts", "verify", "--archive", backup], MEMORY_APP));
    const source: RemoteRestoreSource = { id: "0".repeat(32), name: "bara-backup-20261008-120000", archive: backup, fingerprint: verified.fingerprint,
      counts: { memories: verified.manifest.collections.memories.count, archived: verified.manifest.collections.archivedMemories?.count ?? 0,
        attachments: verified.manifest.attachments.length } };
    // A release folder that runs this checkout: its own `bun` plus links to the repository's apps and installed packages.
    const release = join(dir, "server", "releases", "0123456789abcdef");
    await mkdir(release, { recursive: true });
    await writeBunWrapper(release);
    for (const name of ["apps", "node_modules", "package.json"]) await symlink(join(REPO, name), join(release, name));
    const data = join(dir, "server", "data"), incoming = join(dir, "server", "incoming");
    await mkdir(data, { recursive: true });
    const run = { shell: localTransport(), host: new ShellReleaseHost(localTransport()), release, data, incoming,
      scratchDir: join(dir, "scratch"), ctx: { signal: new AbortController().signal, progress: () => {} } };
    const plan = await uploadForRestore(run, source);
    expect(plan).toEqual({ kind: "start" });
    const prepared = prepareManagedMemory({ dataDir: data, port: 39_102 });
    // Test-only: reuse a model cache the developer already has instead of downloading bge-m3 again.
    const env = { ...prepared.env, ...(process.env.BARA_HF_CACHE_DIR ? { BARA_HF_CACHE_DIR: process.env.BARA_HF_CACHE_DIR } : {}) };
    bun(["scripts/prefetch-core-models.ts"], MEMORY_APP, env);
    const swapped = await restoreAndSwap(run, source, plan, env, async () => {});
    expect(swapped && existsSync(join(swapped.replaced, "db", "bara.sqlite"))).toBe(true);
    const restored = new Database(join(data, "db", "bara.sqlite"), { readonly: true });
    expect((restored.query("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }).n).toBe(3);
    restored.close();
    expect(await uploadForRestore(run, source)).toEqual({ kind: "done" });
  }, 1_800_000);
});
