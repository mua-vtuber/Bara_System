import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BARA_LICENSE_EXCEPTION_FILE, licenseSources, licenseTextsPlugin, readLicenseTexts } from "../scripts/license-texts.ts";
import { REPO_ROOT } from "../scripts/release-bundle.ts";
import { spineLicensePath } from "../scripts/ui-assets.ts";
import { LICENSE_TEXTS_MODULE } from "../src/ui/license-texts-module.ts";

// The license texts the settings screen shows are read at build time from the real files and nowhere else.
const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "bara-license-texts-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

test("the sources are the repository's LICENSE-EXCEPTION.md and the installed Spine runtime's LICENSE", () => {
  expect(licenseSources(root)).toEqual({ baraException: join(REPO_ROOT, BARA_LICENSE_EXCEPTION_FILE), spineRuntimes: spineLicensePath(root) });
});

test("each text is read verbatim from its source file", async () => {
  const sources = licenseSources(root);
  const texts = await readLicenseTexts(sources);
  expect(texts.baraException).toBe(await readFile(sources.baraException, "utf8"));
  expect(texts.spineRuntimes).toBe(await readFile(sources.spineRuntimes, "utf8"));
  expect(texts.spineRuntimes).toContain("Spine Runtimes License Agreement");
  expect(texts.baraException).toContain("Additional permission");
});

test("a missing source stops the build with its path", async () => {
  const missing = join(scratch, "no-such-dir", BARA_LICENSE_EXCEPTION_FILE);
  const sources = { ...licenseSources(root), baraException: missing };
  await expect(readLicenseTexts(sources)).rejects.toThrow(`License text source is missing: ${missing}`);
});

test("a blank source stops the build with its path instead of showing an empty section", async () => {
  const blank = join(scratch, "blank-LICENSE");
  await writeFile(blank, " \n\t\n");
  const sources = { ...licenseSources(root), spineRuntimes: blank };
  await expect(readLicenseTexts(sources)).rejects.toThrow(`License text source is empty: ${blank}`);
});

test("the build plugin resolves the virtual module to the exact texts", async () => {
  const texts = await readLicenseTexts(licenseSources(root));
  const entry = join(scratch, "entry.ts");
  await writeFile(entry, `export { baraException, spineRuntimes } from "${LICENSE_TEXTS_MODULE}";\n`);
  const outdir = join(scratch, "out");
  const result = await Bun.build({ entrypoints: [entry], outdir, target: "bun", format: "esm", minify: true, plugins: [licenseTextsPlugin(texts)] });
  expect(result.success).toBe(true);
  const built = await import(result.outputs[0]!.path);
  expect({ baraException: built.baraException, spineRuntimes: built.spineRuntimes }).toEqual(texts);
});
