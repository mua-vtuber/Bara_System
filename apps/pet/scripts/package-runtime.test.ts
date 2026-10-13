import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, assertCleanCoreTree, assertOutputOutsideCore, assertRepositoryLayout, isRuntimeSource,
  listTrackedRuntimeFiles, packageRuntime, pruneDependencySnapshots, prunePackagedDependencySnapshots } from "./package-runtime.ts";

// The two integration tests below package the repository this script lives in: a modified tracked
// runtime file there makes `assertCleanCoreTree` fail and names the file.
const core = REPO_ROOT;
const output = join(tmpdir(), `bara-runtime-test-${randomUUID()}`);
afterAll(async () => { await rm(output, { recursive: true, force: true }); });

test("tracked source allowlist keeps server code and drops private/test state", () => {
  expect(isRuntimeSource("apps/memory/src/server.ts")).toBe(true);
  expect(isRuntimeSource("LICENSE")).toBe(true);
  expect(isRuntimeSource("apps/memory/src/db/schema.sql")).toBe(true);
  expect(isRuntimeSource("apps/setup/src/managed-prepare.ts")).toBe(true);
  expect(isRuntimeSource("apps/setup/PET-INTEGRATION.md")).toBe(true);
  for (const path of [".git/config", "apps/memory/data/tokens.json", "apps/memory/src/server.test.ts",
    "apps/memory/test-fixtures/sandbox.txt", "apps/memory/node_modules/sqlite-vec/index.js", "apps/memory/assets/models/secret.bin"])
    expect(isRuntimeSource(path)).toBe(false);
});

test("portable CLI and the pre-update snapshot ship while their tests, fixtures and unrelated scripts stay excluded", () => {
  expect(isRuntimeSource("apps/memory/scripts/portable-memory.ts")).toBe(true);
  expect(isRuntimeSource("apps/memory/scripts/db-snapshot.ts")).toBe(true);
  expect(isRuntimeSource("apps/memory/scripts/db-snapshot.test.ts")).toBe(false);
  expect(isRuntimeSource("apps/memory/src/portable/test-fixtures/restore-fixture.ts")).toBe(false);
  expect(isRuntimeSource("apps/memory/scripts/portable-memory.test.ts")).toBe(false);
  expect(isRuntimeSource("apps/memory/scripts/portable-memory.int.test.ts")).toBe(false);
  expect(isRuntimeSource("apps/memory/scripts/restore-backup.ts")).toBe(true);
  expect(isRuntimeSource("apps/memory/scripts/restore-backup.test.ts")).toBe(false);
});

test("temporary package output must be an owned source-only test directory", async () => {
  const unowned = join(tmpdir(), `bara-runtime-unowned-${randomUUID()}`);
  await expect(packageRuntime({ coreRoot: REPO_ROOT, outputRoot: unowned,
    sourceOnly: true, testOutput: true })).rejects.toThrow("Runtime output must stay under Pet resources");
  expect(existsSync(unowned)).toBe(false);
});

test("the output folder may not be the repository root or a folder the payload is copied from", () => {
  const root = REPO_ROOT;
  expect(() => assertOutputOutsideCore(root, root)).toThrow("Runtime output must be outside Core source");
  expect(() => assertOutputOutsideCore(root, root)).toThrow(root);
  expect(() => assertOutputOutsideCore(root, join(root, "apps", "memory", "x"))).toThrow("inside apps/memory");
  expect(() => assertOutputOutsideCore(root, join(root, "apps", "memory"))).toThrow("inside apps/memory");
  expect(() => assertOutputOutsideCore(root, join(root, "apps", "setup"))).toThrow("inside apps/setup");
  expect(() => assertOutputOutsideCore(root, join(root, "apps", "pet", "resources"))).not.toThrow();
  expect(() => assertOutputOutsideCore(root, join(tmpdir(), "bara-runtime-test-elsewhere"))).not.toThrow();
});

test("a folder that is not the Bara repository is rejected with the missing path named", async () => {
  expect(() => assertRepositoryLayout(REPO_ROOT)).not.toThrow();
  const dir = await mkdtemp(join(tmpdir(), "bara-repo-layout-"));
  try {
    expect(() => assertRepositoryLayout(dir)).toThrow(join(dir, "apps", "memory", "package.json"));
    await mkdir(join(dir, "apps", "memory"), { recursive: true });
    await writeFile(join(dir, "apps", "memory", "package.json"), "{}");
    expect(() => assertRepositoryLayout(dir)).toThrow(join(dir, "apps", "pet", "package.json"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real Core git listing has required runtime files and no tests", async () => {
  const files = await listTrackedRuntimeFiles(core);
  expect(files).toContain("apps/memory/src/index.ts");
  expect(files).toContain("LICENSE");
  expect(files).toContain("apps/setup/src/client-token.ts");
  expect(files).toContain("apps/setup/PET-INTEGRATION.md");
  expect(files.every((path) => !path.includes(".test.") && !path.includes("node_modules"))).toBe(true);
});

test("source-only payload contains built dashboard and excludes data and dependencies", async () => {
  await packageRuntime({ coreRoot: core, outputRoot: output, sourceOnly: true, testOutput: true });
  expect(existsSync(join(output, "core", "apps", "memory", "web", "dashboard", "dashboard-entry.js"))).toBe(true);
  const bytes = await Bun.file(join(output, "server-source.tar.gz")).bytes();
  expect([...bytes.slice(0, 2)]).toEqual([0x1f, 0x8b]);
  const archive = new Bun.Archive(bytes);
  const names = [...(await archive.files()).keys()];
  expect(names).toContain("apps/memory/src/index.ts");
  expect(names).toContain("LICENSE");
  expect(names).toContain("apps/setup/PET-INTEGRATION.md");
  expect(names).toContain("apps/memory/web/dashboard/dashboard-entry.js");
  expect(names.some((name) => name.includes("node_modules") || name.includes(".test.") || name.includes("/data/"))).toBe(false);
}, 60_000); // Builds the real dashboard and runs Bun's lockfile pruning process.

test("production dependency snapshots are pruned without removing runtime fonts or images", async () => {
  const root = await mkdtemp(join(tmpdir(), "bara-snapshot-prune-"));
  try {
    const coreDir = join(root, "core");
    const packageDir = join(coreDir, "node_modules", "@jimp", "plugin-print");
    const snapshot = join(packageDir, "src", "__image_snapshots__", "long-test-only-image.png");
    const font = join(packageDir, "fonts", "open-sans.fnt");
    const image = join(packageDir, "images", "glyph.png");
    for (const path of [snapshot, font, image]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, path);
    }
    const files: Record<string, string> = {};
    for (const path of [snapshot, font, image]) {
      const key = `core/${path.slice(coreDir.length + 1).replaceAll("\\", "/")}`;
      files[key] = new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
    }
    await writeFile(join(root, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, files }));
    expect(await prunePackagedDependencySnapshots(root)).toBe(1);
    const patched = JSON.parse(await readFile(join(root, "payload-manifest.json"), "utf8")) as { files: Record<string, string> };
    expect(Object.keys(patched.files)).toHaveLength(2);
    expect(existsSync(snapshot)).toBe(false);
    expect(existsSync(font)).toBe(true);
    expect(existsSync(image)).toBe(true);
    expect(await pruneDependencySnapshots(coreDir)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manifest mismatch leaves packaged snapshot and manifest untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "bara-snapshot-mismatch-"));
  try {
    const snapshot = join(root, "core", "node_modules", "jimp", "__image_snapshots__", "example.png");
    await mkdir(join(snapshot, ".."), { recursive: true });
    await writeFile(snapshot, "fixture");
    const manifest = join(root, "payload-manifest.json");
    await writeFile(manifest, JSON.stringify({ files: { "core/node_modules/jimp/__image_snapshots__/example.png": "invalid" } }));
    const before = await readFile(manifest, "utf8");
    await expect(prunePackagedDependencySnapshots(root)).rejects.toThrow("hash differs");
    expect(existsSync(snapshot)).toBe(true);
    expect(await readFile(manifest, "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The clean-tree check runs against real Git repositories in temporary folders.
const coreRepos: string[] = [];
afterAll(async () => { for (const dir of coreRepos) await rm(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  const child = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(child.stderr)}`);
}

const CORE_FILES: Record<string, string> = {
  "package.json": "{}", "bun.lock": "lock", LICENSE: "license",
  "apps/memory/package.json": "{}", "apps/memory/src/index.ts": "export {};",
  "apps/setup/package.json": "{}",
  // Tracked, but rebuilt by `build:dashboard` on every packaging run.
  "apps/memory/web/dashboard/api-fetch.js": "built",
  "docs/notes.md": "notes",
};

async function createCore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bara-core-clean-"));
  coreRepos.push(dir);
  git(dir, "init");
  git(dir, "config", "core.autocrlf", "false");
  for (const [path, text] of Object.entries(CORE_FILES)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "runtime files");
  return dir;
}

test("a clean Core checkout passes the clean-tree check", async () => {
  const dir = await createCore();
  expect(() => assertCleanCoreTree(dir)).not.toThrow();
});

test("a modified tracked runtime file stops packaging and is named", async () => {
  const dir = await createCore();
  await writeFile(join(dir, "apps/memory/src/index.ts"), "export const changed = true;");
  expect(() => assertCleanCoreTree(dir)).toThrow("apps/memory/src/index.ts");
  expect(() => assertCleanCoreTree(dir)).toThrow("1 uncommitted change(s)");
});

test("a staged but uncommitted runtime change and a deleted runtime file also stop packaging", async () => {
  const dir = await createCore();
  await writeFile(join(dir, "package.json"), '{"changed":true}');
  git(dir, "add", "package.json");
  await rm(join(dir, "apps/setup/package.json"));
  expect(() => assertCleanCoreTree(dir)).toThrow("package.json");
  expect(() => assertCleanCoreTree(dir)).toThrow("apps/setup/package.json");
});

test("the message lists only the first changed files and the total count", async () => {
  const dir = await createCore();
  for (let index = 0; index < 7; index++) await writeFile(join(dir, `apps/memory/src/file-${index}.ts`), "x");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "more files");
  for (let index = 0; index < 7; index++) await writeFile(join(dir, `apps/memory/src/file-${index}.ts`), "y");
  expect(() => assertCleanCoreTree(dir)).toThrow("7 uncommitted change(s)");
  expect(() => assertCleanCoreTree(dir)).toThrow("file-0.ts");
  expect(() => assertCleanCoreTree(dir)).toThrow(", ...");
  expect(() => assertCleanCoreTree(dir)).not.toThrow("file-6.ts");
});

test("a rebuilt generated dashboard file does not count as a change", async () => {
  const dir = await createCore();
  expect(Bun.spawnSync(["git", "ls-files", "apps/memory/web/dashboard/api-fetch.js"], { cwd: dir, stdout: "pipe" }).stdout.toString().trim())
    .toBe("apps/memory/web/dashboard/api-fetch.js");
  await writeFile(join(dir, "apps/memory/web/dashboard/api-fetch.js"), "rebuilt");
  expect(() => assertCleanCoreTree(dir)).not.toThrow();
});

test("untracked new files and changes outside the runtime paths do not stop packaging", async () => {
  const dir = await createCore();
  await writeFile(join(dir, "apps/memory/src/new-file.ts"), "export {};");
  await writeFile(join(dir, "docs/notes.md"), "edited notes");
  expect(() => assertCleanCoreTree(dir)).not.toThrow();
});

test("a folder that is not a Git checkout is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bara-core-nogit-"));
  coreRepos.push(dir);
  expect(() => assertCleanCoreTree(dir)).toThrow("git failed");
});

// WP-PFIX-6: the `assertCleanCoreTree` tests above never call `packageRuntime`, so they stay green if the
// call is removed from it. Here `packageRuntime` itself runs against a real Core repository whose tracked
// file was modified, with an output folder that already holds a file: it must stop with the path named,
// before it deletes or writes anything in that folder.
test("packageRuntime stops on a modified tracked Core file, names it, and keeps the existing output folder", async () => {
  const dir = await createCore();
  await writeFile(join(dir, "apps/memory/src/index.ts"), "export const changed = true;");
  const outputRoot = join(tmpdir(), `bara-runtime-test-${randomUUID()}`);
  coreRepos.push(outputRoot); // removed by the afterAll above
  await mkdir(outputRoot, { recursive: true });
  const marker = join(outputRoot, "previous-output.txt");
  await writeFile(marker, "previous package output");
  const error = await packageRuntime({ coreRoot: dir, outputRoot, sourceOnly: true, testOutput: true })
    .then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("apps/memory/src/index.ts");
  expect((error as Error).message).toContain("1 uncommitted change(s)");
  expect(await readFile(marker, "utf8")).toBe("previous package output");
  expect(existsSync(join(outputRoot, "core"))).toBe(false);
});
