/** Build the offline Pet runtime payload. No private Git access is needed after packaging. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { packageCrt } from "./package-crt.ts";
import { ASSETS, BUN_VERSION, CORE_RUNTIME_DIRS, REPO_ROOT, archiveSource, assertCleanCoreTree, downloadAsset, hashFile, run,
  stageServerSource } from "./release-bundle.ts";
export { REPO_ROOT, assertCleanCoreTree, isRuntimeSource, listTrackedRuntimeFiles } from "./release-bundle.ts";

/** Files that must exist under `REPO_ROOT` for it to be the Bara repository this Pet package belongs to. */
const REPO_MARKERS = ["apps/memory/package.json", "apps/pet/package.json"];
const RESOURCE_ENTRIES = new Set(["core", "runtime", "linux", "service", "server-source.tar.gz", "payload-manifest.json"]);
/** Stop when `repoRoot` is not the Bara repository: names the first marker file that is missing. */
export function assertRepositoryLayout(repoRoot: string): void {
  for (const marker of REPO_MARKERS) {
    const path = join(repoRoot, marker);
    if (!existsSync(path)) throw new Error(`Repository root is missing ${path}; run package:runtime from apps/pet inside the Bara repository`);
  }
}

/** The runtime payload is written under Pet resources, which sits inside the repository, so the output
 * must not be the repository root or any folder the payload is copied from: the build clears its output. */
export function assertOutputOutsideCore(coreRoot: string, outputRoot: string): void {
  const core = resolve(coreRoot), output = resolve(outputRoot);
  if (output === core) throw new Error(`Runtime output must be outside Core source: ${output} is the repository root`);
  for (const dir of CORE_RUNTIME_DIRS) {
    const offset = relative(resolve(core, dir), output);
    if (offset === "" || (!offset.startsWith("..") && !isAbsolute(offset)))
      throw new Error(`Runtime output must be outside Core source: ${output} is inside ${dir}`);
  }
}

async function collectHashes(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isSymbolicLink()) throw new Error(`Non-relocatable runtime link: ${path}`);
    if (item.isDirectory()) Object.assign(result, await collectHashes(root, path));
    else if (item.isFile()) result[path.split(sep).join("/")] = await hashFile(join(root, path));
  }
  return result;
}

/** Hoisted install still links the workspace package itself. Source imports are
 * relative, so remove only those known links after verifying their targets.
 * Reject every other link before manifest publication. */
export async function removeWorkspaceLinks(coreDir: string): Promise<void> {
  for (const [name, expected] of [["node_modules/memory", "apps/memory"],
    ["node_modules/@bara/setup", "apps/setup"]] as const) {
    const path = join(coreDir, name);
    if (!existsSync(path)) continue;
    const info = await lstat(path);
    if (!info.isSymbolicLink()) continue;
    if (resolve(await realpath(path)) !== resolve(coreDir, expected))
      throw new Error(`Unexpected workspace link target: ${name}`);
    await rmdir(path);
  }
}

/** Jimp ships test image snapshots in its production dependency. They are not
 * runtime assets and their long names exceed Windows' default installed path
 * limit. Keep fonts and other package images intact. */
async function dependencySnapshotFiles(coreDir: string): Promise<{ dirs: string[]; files: string[] }> {
  const modules = resolve(coreDir, "node_modules");
  const dirs: string[] = [], files: string[] = [];
  if (!existsSync(modules)) return { dirs, files };
  if ((await lstat(modules)).isSymbolicLink()) throw new Error(`Runtime dependency link: ${modules}`);
  const canonicalModules = await realpath(modules);
  const inside = (root: string, path: string) => {
    const offset = relative(root, path);
    return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
  };
  async function visit(path: string, snapshot: boolean): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, item.name);
      if (!inside(modules, child)) throw new Error(`Dependency path escapes node_modules: ${child}`);
      if (item.isSymbolicLink()) throw new Error(`Runtime dependency link: ${child}`);
      if (item.isDirectory()) {
        const isSnapshot = snapshot || item.name === "__image_snapshots__";
        if (!snapshot && isSnapshot) dirs.push(child);
        await visit(child, isSnapshot);
      } else if (snapshot && item.isFile()) {
        files.push(`core/${relative(coreDir, child).split(sep).join("/")}`);
      }
    }
  }
  await visit(modules, false);
  for (const dir of dirs) {
    if (!inside(modules, dir) || (await lstat(dir)).isSymbolicLink() ||
        !inside(canonicalModules, await realpath(dir)))
      throw new Error(`Unsafe dependency snapshot directory: ${dir}`);
  }
  return { dirs, files: files.sort() };
}

export async function pruneDependencySnapshots(coreDir: string): Promise<string[]> {
  const snapshots = await dependencySnapshotFiles(coreDir);
  for (const dir of snapshots.dirs) await rm(dir, { recursive: true });
  return snapshots.files;
}

/** Repair a packaged payload without redownloading Bun. Verify all affected
 * manifest entries before touching files, then publish the manifest atomically. */
export async function prunePackagedDependencySnapshots(resourceDir: string): Promise<number> {
  const coreDir = resolve(resourceDir, "core");
  const manifestPath = resolve(resourceDir, "payload-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, string> };
  const snapshots = await dependencySnapshotFiles(coreDir);
  const listed = Object.keys(manifest.files).filter((path) =>
    path.startsWith("core/node_modules/") && path.includes("/__image_snapshots__/"));
  if (listed.length !== snapshots.files.length || snapshots.files.some((file) => !listed.includes(file)))
    throw new Error("Snapshot files differ from published manifest");
  for (const file of snapshots.files) {
    if (await hashFile(resolve(resourceDir, file)) !== manifest.files[file])
      throw new Error(`Snapshot hash differs from published manifest: ${file}`);
  }
  for (const dir of snapshots.dirs) await rm(dir, { recursive: true });
  for (const file of snapshots.files) delete manifest.files[file];
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2));
    await rename(temporary, manifestPath);
  } finally { await rm(temporary, { force: true }); }
  return snapshots.files.length;
}

export async function packageRuntime(args: { coreRoot: string; outputRoot: string; sourceOnly?: boolean; testOutput?: boolean }): Promise<void> {
  const coreRoot = resolve(args.coreRoot), outputRoot = resolve(args.outputRoot);
  if (process.versions.bun !== BUN_VERSION) throw new Error(`Build with Bun ${BUN_VERSION}`);
  const resourceRoot = resolve(import.meta.dir, "..", "resources");
  const fromResources = relative(resourceRoot, outputRoot);
  const fromTemporary = relative(resolve(tmpdir()), outputRoot);
  const testOwnedTemporary = args.sourceOnly === true && args.testOutput === true &&
    /^bara-runtime-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromTemporary);
  if ((fromResources.startsWith("..") || isAbsolute(fromResources)) && !testOwnedTemporary)
    throw new Error("Runtime output must stay under Pet resources");
  assertOutputOutsideCore(coreRoot, outputRoot);
  assertCleanCoreTree(coreRoot);
  if (outputRoot === resourceRoot) {
    if (existsSync(outputRoot)) {
      const unexpected = (await readdir(outputRoot)).filter((name) => name !== ".build-downloads" && !RESOURCE_ENTRIES.has(name));
      if (unexpected.length) throw new Error(`Unexpected resources entry: ${unexpected[0]}`);
    }
    for (const name of ["core", "runtime", "linux", ".build-downloads", "server-source.tar.gz", "payload-manifest.json"])
      await rm(join(outputRoot, name), { recursive: true, force: true });
  } else {
    await rm(outputRoot, { recursive: true, force: true });
  }
  await mkdir(outputRoot, { recursive: true });
  const coreDir = join(outputRoot, "core");
  const files = await stageServerSource(coreRoot, coreDir);
  const archive = join(outputRoot, "server-source.tar.gz");
  await archiveSource(coreDir, files, archive);
  if (args.sourceOnly) return;

  const downloadDir = join(outputRoot, ".build-downloads");
  await mkdir(downloadDir, { recursive: true });
  const binaries: Record<string, string> = {};
  for (const [key, asset] of Object.entries(ASSETS)) binaries[key] = await downloadAsset(asset, outputRoot, downloadDir);
  // Isolated workspaces use absolute Windows junction targets that break after
  // the EXE moves to Program Files. Hoisting materializes registry packages.
  run([join(outputRoot, "runtime", "bun.exe"), "install", "--frozen-lockfile", "--production",
    "--linker", "hoisted", "--backend", "copyfile"], coreDir);
  await removeWorkspaceLinks(coreDir);
  await pruneDependencySnapshots(coreDir);
  await rm(downloadDir, { recursive: true, force: true });
  const crt = await packageCrt({ resourceDir: outputRoot, updateManifest: false });
  const manifest = {
    schemaVersion: 1, bunVersion: BUN_VERSION,
    vcRuntime: { sourceVersion: crt.sourceVersion, dlls: crt.dlls,
      fileVersions: crt.fileVersions, deployment: "app-local" },
    releaseArchives: Object.fromEntries(Object.entries(ASSETS).map(([key, asset]) => [key, asset.sha256])),
    sourceCommit: run(["git", "rev-parse", "HEAD"], coreRoot).trim(),
    files: { ...Object.fromEntries(Object.entries(await collectHashes(coreDir, "")).map(([path, hash]) => [`core/${path}`, hash])),
      "server-source.tar.gz": await hashFile(archive),
      "runtime/bun.exe": binaries.windows, "linux/bun-x64": binaries.linuxX64, "linux/bun-arm64": binaries.linuxArm64,
      ...crt.files },
  };
  await writeFile(join(outputRoot, "payload-manifest.json"), JSON.stringify(manifest, null, 2));
  if (outputRoot === resourceRoot) {
    const unexpected = (await readdir(outputRoot)).filter((name) => !RESOURCE_ENTRIES.has(name));
    if (unexpected.length) throw new Error(`Unexpected resources entry: ${unexpected[0]}`);
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true,
      options: { out: { type: "string" }, "source-only": { type: "boolean" } } });
    assertRepositoryLayout(REPO_ROOT);
    await packageRuntime({ coreRoot: REPO_ROOT, outputRoot: values.out || join(import.meta.dir, "..", "resources"), sourceOnly: values["source-only"] });
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
