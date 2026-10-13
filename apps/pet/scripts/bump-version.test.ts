import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bumpVersion, readVersions, VERSION_SOURCES } from "./bump-version";

const REPO = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A temporary root holding copies of the repository's real version files. */
function copyOfRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bara-bump-"));
  roots.push(root);
  for (const { path } of VERSION_SOURCES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPO, path), join(root, path));
  }
  return root;
}

test("the repository's version files all hold one version today", () => {
  const versions = readVersions(REPO);
  expect(versions.map(({ path }) => path)).toEqual(VERSION_SOURCES.map(({ path }) => path));
  expect(new Set(versions.map(({ version }) => version)).size).toBe(1);
});

test("bumping changes only the version line of every file, keeping everything else byte for byte", () => {
  const root = copyOfRepo();
  const from = readVersions(root)[0]!.version;
  const before = VERSION_SOURCES.map(({ path }) => readFileSync(join(root, path), "utf8"));
  expect(bumpVersion("9.8.7", root)).toEqual({ from, to: "9.8.7" });
  expect(readVersions(root).every(({ version }) => version === "9.8.7")).toBe(true);
  VERSION_SOURCES.forEach(({ path }, index) => {
    const after = readFileSync(join(root, path), "utf8");
    expect(after.length - before[index]!.length).toBe("9.8.7".length - from.length);
    expect(after.split(from).length).toBeLessThanOrEqual(before[index]!.split(from).length);
  });
});

test("Cargo dependency versions and other lock packages are not touched", () => {
  const root = copyOfRepo();
  const lockBefore = readFileSync(join(root, "bun.lock"), "utf8");
  const cargoBefore = readFileSync(join(root, "apps/pet/src-tauri/Cargo.lock"), "utf8");
  bumpVersion("9.8.7", root);
  const changedLines = (before: string, after: string) => {
    const a = before.split("\n"), b = after.split("\n");
    return a.filter((line, index) => line !== b[index]);
  };
  expect(changedLines(lockBefore, readFileSync(join(root, "bun.lock"), "utf8"))).toHaveLength(1);
  expect(changedLines(cargoBefore, readFileSync(join(root, "apps/pet/src-tauri/Cargo.lock"), "utf8"))).toHaveLength(1);
});

test("files that disagree stop the bump before anything is written, naming each file and value", () => {
  const root = copyOfRepo();
  const path = join(root, "apps/memory/package.json");
  writeFileSync(path, readFileSync(path, "utf8").replace(/"version":\s*"[^"]+"/, '"version": "5.5.5"'));
  const snapshot = VERSION_SOURCES.map(({ path: p }) => readFileSync(join(root, p), "utf8"));
  expect(() => bumpVersion("9.8.7", root)).toThrow(/versions disagree.*apps\/memory\/package.json=5\.5\.5/);
  VERSION_SOURCES.forEach(({ path: p }, index) => expect(readFileSync(join(root, p), "utf8")).toBe(snapshot[index]!));
});

test("a missing file or version line stops with its path", () => {
  const root = copyOfRepo();
  rmSync(join(root, "bun.lock"));
  expect(() => bumpVersion("9.8.7", root)).toThrow("bun.lock: cannot read");
  const other = copyOfRepo();
  writeFileSync(join(other, "apps/pet/src-tauri/Cargo.lock"), "[[package]]\nname = \"other\"\nversion = \"1.0.0\"\n");
  expect(() => bumpVersion("9.8.7", other)).toThrow("apps/pet/src-tauri/Cargo.lock: version line not found");
});

test("an invalid or unchanged version is refused", () => {
  const root = copyOfRepo();
  const current = readVersions(root)[0]!.version;
  for (const bad of ["", "1.2", "v1.2.3", "01.2.3"]) expect(() => bumpVersion(bad, root)).toThrow("semantic version");
  expect(() => bumpVersion(current, root)).toThrow(`already at ${current}`);
});

test("the CLI reports the change and fails without a version", () => {
  const root = copyOfRepo();
  const script = join(import.meta.dir, "bump-version.ts");
  const missing = Bun.spawnSync([process.execPath, script]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("usage");
  const ok = Bun.spawnSync([process.execPath, script, "9.8.7", root]);
  expect(ok.exitCode).toBe(0);
  expect(readVersions(root).every(({ version }) => version === "9.8.7")).toBe(true);
});
