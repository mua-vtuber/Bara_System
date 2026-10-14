import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseVersion } from "./check-release-version";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(version = "2.3.4") {
  const dir = mkdtempSync(join(tmpdir(), "pet-version-"));
  directories.push(dir);
  mkdirSync(join(dir, "src-tauri"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "src-tauri/tauri.conf.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "src-tauri/Cargo.toml"), `[package]\nname = "pet"\nversion = "${version}"\n[dependencies]\nother = { version = "9.9.9" }\n`);
  return dir;
}
test("matching arbitrary versions ignore Cargo dependency versions", () => {
  expect(checkReleaseVersion(fixture())).toBe("2.3.4");
  expect(checkReleaseVersion(fixture("0.1.0"))).toBe("0.1.0");
});
for (const file of ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"]) {
  test(`${file} mismatch identifies all sources and values`, () => {
    const dir = fixture();
    writeFileSync(join(dir, file), file.endsWith("toml") ? '[package]\nversion = "3.0.0"' : '{"version":"3.0.0"}');
    expect(() => checkReleaseVersion(dir)).toThrow(/package.json.*tauri.conf.json.*Cargo.toml/);
    expect(() => checkReleaseVersion(dir)).toThrow("3.0.0");
  });
  for (const kind of ["missing file", "malformed", "missing version", "invalid version"]) {
    test(`${file}: ${kind} fails with source`, () => {
      const dir = fixture();
      const path = join(dir, file);
      if (kind === "missing file") rmSync(path);
      else writeFileSync(path, kind === "malformed" ? "{ broken" : file.endsWith("toml")
        ? kind === "missing version" ? '[dependencies]\nversion = "2.3.4"' : '[package]\nversion = 123'
        : kind === "missing version" ? '{}' : '{"version":123}');
      expect(() => checkReleaseVersion(dir)).toThrow(file);
    });
  }
}
test("CLI succeeds or fails without changing manifests", () => {
  const dir = fixture();
  const script = join(import.meta.dir, "check-release-version.ts");
  const run = () => Bun.spawnSync([process.execPath, script, dir]);
  expect(run().exitCode).toBe(0);
  writeFileSync(join(dir, "package.json"), '{"version":"4.0.0"}');
  const failed = run();
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr.toString()).toContain("4.0.0");
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("4.0.0");
});
test("package and direct Tauri builds check versions before assets", async () => {
  const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
  const tauri = await Bun.file(join(import.meta.dir, "../src-tauri/tauri.conf.json")).json();
  expect(pkg.scripts.build).toBe("bun run check:release-version && bun run package:runtime && bun run build:service && tauri build && bun run check:native-exe");
  expect(tauri.build.beforeBuildCommand).toBe("bun run check:release-version && bun run build:ui");
});

for (const version of ["", "1.2", "01.2.3", "1.2.3-01", "v1.2.3", " 1.2.3 "]) {
  test(`invalid semantic version ${JSON.stringify(version)} is refused`, () => {
    expect(() => checkReleaseVersion(fixture(version))).toThrow("package.json");
  });
}
test("matching prerelease and build metadata are accepted", () => {
  expect(checkReleaseVersion(fixture("1.2.3-rc.1+build.42"))).toBe("1.2.3-rc.1+build.42");
});
test("CLI defaults to its Pet directory even from another working directory", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "check-release-version.ts")], { cwd: fixture("7.8.9") });
  expect(result.exitCode).toBe(0);
  const expectedVersion = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version;
  expect(result.stdout.toString()).toContain(expectedVersion);
});
