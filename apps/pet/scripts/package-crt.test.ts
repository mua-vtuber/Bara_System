import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions, discoverReleaseCrtDir, ESSENTIAL_CRT_DLLS, packageCrt, validateCrtNames } from "./package-crt.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-crt-package-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("numeric release ordering and DLL policy reject missing or debug CRTs", () => {
  expect(compareVersions("14.51.36231", "14.9.99999")).toBeGreaterThan(0);
  expect(validateCrtNames([...ESSENTIAL_CRT_DLLS, "concrt140.dll"])).toHaveLength(5);
  expect(() => validateCrtNames(["vcruntime140.dll", "msvcp140.dll"])).toThrow("missing");
  expect(() => validateCrtNames([...ESSENTIAL_CRT_DLLS, "vcruntime140d.dll"])).toThrow("Debug");
});

test("source is a Visual Studio release redist, not System32 or a debug directory", async () => {
  await expect(discoverReleaseCrtDir("C:/Windows/System32")).rejects.toThrow("release");
  await expect(discoverReleaseCrtDir("C:/Program Files/Microsoft Visual Studio/18/Community/VC/Redist/MSVC/14.51.36231/x64/Debug_NonRedist")).rejects.toThrow();
  const release = await discoverReleaseCrtDir();
  expect(release.replaceAll("\\", "/")).toMatch(/\/VC\/Redist\/MSVC\/\d+\.\d+\.\d+\/x64\/Microsoft\.VC\d+\.CRT$/i);
  expect(await discoverReleaseCrtDir(undefined, { VCToolsRedistDir: dirname(dirname(release)) })).toBe(release);
}, 30_000);

test("copies every signed Microsoft x64 CRT locally and updates an existing manifest", async () => {
  const sourceDir = await discoverReleaseCrtDir();
  const native = await packageCrt({ resourceDir: dir, nativeOnly: true, sourceDir });
  expect(native.dlls).toEqual(readdirSync(sourceDir).filter((name) => name.toLowerCase().endsWith(".dll")).sort((a, b) => a.localeCompare(b)));
  expect(native.dlls.length).toBeGreaterThanOrEqual(ESSENTIAL_CRT_DLLS.length);
  for (const name of native.dlls) expect(existsSync(join(dir, "runtime", name))).toBe(true);
  expect(existsSync(join(dir, "core"))).toBe(false);
  const onnx = join(dir, "core", "node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64");
  mkdirSync(onnx, { recursive: true });
  const manifestPath = join(dir, "payload-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, files: { existing: "a".repeat(64) } }));
  const installed = await packageCrt({ resourceDir: dir, sourceDir });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Record<string, string>; vcRuntime: { sourceVersion: string; dlls: string[] } };
  expect(manifest.files.existing).toBe("a".repeat(64));
  expect(manifest.vcRuntime.sourceVersion).toBe(installed.sourceVersion);
  expect(manifest.vcRuntime.dlls).toEqual(installed.dlls);
  for (const name of installed.dlls) {
    expect(existsSync(join(onnx, name))).toBe(true);
    expect(manifest.files[`runtime/${name}`]).toBe(manifest.files[`core/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/${name}`]);
  }
  expect(existsSync(join(dir, "runtime", "CRT-NOTICE.txt"))).toBe(true);
}, 30_000); // Two real Authenticode checks include Windows certificate-service startup.

test("--native-only CLI does not require a Core payload or change a manifest", () => {
  const child = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "package-crt.ts"),
    "--native-only", "--resources", dir], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const result = JSON.parse(child.stdout.toString()) as { sourceVersion: string; dlls: string[] };
  expect(result.dlls).toContain("vcruntime140.dll");
  expect(existsSync(join(dir, "runtime", "msvcp140_1.dll"))).toBe(true);
  expect(existsSync(join(dir, "payload-manifest.json"))).toBe(false);
}, 30_000);
