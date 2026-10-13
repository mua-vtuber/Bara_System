import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TextureAtlas } from "@esotericsoftware/spine-webgl";
import { copyUiAssets, LICENSE_DIR, SPINE_LICENSE_FILE, SPINE_PACKAGE, spineLicensePath } from "../scripts/ui-assets.ts";
import { SQUIRREL_ASSET_DIR, SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, squirrelAssetPath } from "../src/ui/squirrel/asset-paths.ts";

// The build copy of the squirrel export and the Spine license (design sections 3.5 and 11), run against the real
// files into a temporary folder.
const root = resolve(import.meta.dir, "..");
const uiSource = join(root, "src", "ui");
const output = await mkdtemp(join(tmpdir(), "bara-ui-assets-"));
afterAll(() => rm(output, { recursive: true, force: true }));
const copied = await copyUiAssets(root, output);
const pages = new TextureAtlas(await readFile(join(uiSource, squirrelAssetPath(SQUIRREL_ATLAS_FILE)), "utf8")).pages.map(page => page.name);
const squirrelFiles = [SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, ...pages];
/** Where the pet window's page sits in the built folder: `dist/index.html?view=pet`. */
const PET_PAGE = "http://127.0.0.1/index.html?view=pet";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("the atlas, the skeleton and every page image the atlas names are copied byte for byte, and nothing else", async () => {
  expect(pages.length).toBeGreaterThan(0);
  for (const file of squirrelFiles) {
    const original = await readFile(join(uiSource, squirrelAssetPath(file)));
    const copy = await readFile(join(output, squirrelAssetPath(file)));
    expect({ file, size: copy.byteLength, hash: sha256(copy) }).toEqual({ file, size: original.byteLength, hash: sha256(original) });
  }
  expect((await readdir(join(output, SQUIRREL_ASSET_DIR))).sort()).toEqual([...squirrelFiles].sort());
});

test("each file lands where the screen fetches it: the asset-paths.ts path resolved against the pet page", async () => {
  for (const file of squirrelFiles) {
    const fetched = decodeURIComponent(new URL(squirrelAssetPath(file), PET_PAGE).pathname).slice(1);
    expect(copied).toContain(fetched);
    expect((await readFile(join(output, fetched))).byteLength).toBeGreaterThan(0);
  }
});

test("the Spine Runtimes license goes to licenses/ byte for byte, and covers spine-core too", async () => {
  const license = await readFile(spineLicensePath(root));
  expect(license.toString("utf8")).toContain("Spine Runtimes License Agreement");
  const copy = await readFile(join(output, LICENSE_DIR, SPINE_LICENSE_FILE));
  expect(sha256(copy)).toBe(sha256(license));
  expect(copied).toContain(`${LICENSE_DIR}/${SPINE_LICENSE_FILE}`);
  // The bundle also carries spine-core, which the runtime package depends on; one copy is enough only while both
  // packages ship the same text.
  const webglPackage = createRequire(join(root, "package.json")).resolve(`${SPINE_PACKAGE}/package.json`);
  const corePackage = createRequire(webglPackage).resolve("@esotericsoftware/spine-core/package.json");
  expect(sha256(await readFile(join(dirname(corePackage), "LICENSE")))).toBe(sha256(license));
});

test("a page name that is not a plain file name is refused, so no copy or fetch leaves the folder", () => {
  for (const name of ["../bara.png", "sub/bara.png", "sub\\bara.png", "..", ".", ""]) {
    expect(() => squirrelAssetPath(name)).toThrow(RangeError);
  }
  expect(squirrelAssetPath(SQUIRREL_SKELETON_FILE)).toBe(`${SQUIRREL_ASSET_DIR}/${SQUIRREL_SKELETON_FILE}`);
});
