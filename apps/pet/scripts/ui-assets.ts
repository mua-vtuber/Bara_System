import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { TextureAtlas } from "@esotericsoftware/spine-webgl";
import { SQUIRREL_ASSET_DIR, SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, squirrelAssetPath } from "../src/ui/squirrel/asset-paths.ts";

/** The UI source folder the squirrel export lives under (`src/ui/assets/squirrel`). */
const UI_SOURCE_DIR = join("src", "ui");
/** The Spine runtime package the pet bundles. It re-exports `@esotericsoftware/spine-core`, which is bundled with it
 * and ships the same license text (`tests/ui-assets.test.ts` checks that), so one copy covers both. */
export const SPINE_PACKAGE = "@esotericsoftware/spine-webgl";
const SPINE_LICENSE_NAME = "LICENSE";
/** Where the built page keeps the license texts of the third-party code it ships. */
export const LICENSE_DIR = "licenses";
export const SPINE_LICENSE_FILE = "spine-runtimes-LICENSE.txt";

/** The license file of the installed Spine runtime package, found through module resolution from the project root. */
export function spineLicensePath(root: string): string {
  return join(dirname(createRequire(join(root, "package.json")).resolve(`${SPINE_PACKAGE}/package.json`)), SPINE_LICENSE_NAME);
}

/** Copies the squirrel export into the built page, byte for byte: the atlas, the skeleton and every page image the atlas
 * names, at the paths `asset-paths.ts` gives the screen. The supplied icon is copied to `assets/app-icon.png`.
 * The Spine Runtimes license goes to `licenses/`, because the
 * minified bundle drops the license comments and the license asks that every redistribution carries its text.
 * Returns the copied files relative to `output`, with `/` separators. A missing file fails the build. */
export async function copyUiAssets(root: string, output: string): Promise<string[]> {
  const source = join(root, UI_SOURCE_DIR, SQUIRREL_ASSET_DIR);
  const atlasText = await readFile(join(source, SQUIRREL_ATLAS_FILE), "utf8");
  const pages = new TextureAtlas(atlasText).pages.map(page => page.name);
  if (!pages.length) throw new Error(`${SQUIRREL_ATLAS_FILE} names no page image`);
  await mkdir(join(output, SQUIRREL_ASSET_DIR), { recursive: true });
  const copied: string[] = [];
  for (const file of [SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, ...pages]) {
    const path = squirrelAssetPath(file);
    await copyFile(join(source, file), join(output, path));
    copied.push(path);
  }
  await mkdir(join(output, LICENSE_DIR), { recursive: true });
  await copyFile(spineLicensePath(root), join(output, LICENSE_DIR, SPINE_LICENSE_FILE));
  copied.push(`${LICENSE_DIR}/${SPINE_LICENSE_FILE}`);
  const icon = "assets/app-icon.png";
  await mkdir(dirname(join(output, icon)), { recursive: true });
  await copyFile(join(root, "art", "squirrel", "icon.png"), join(output, icon));
  copied.push(icon);
  // Notebook materials stay separate from live form text and controls.
  for (const name of ["notebook-shell.png", "index-tab.png"]) {
    const path = `assets/notebook/${name}`;
    await mkdir(dirname(join(output, path)), { recursive: true });
    await copyFile(join(root, UI_SOURCE_DIR, path), join(output, path));
    copied.push(path);
  }
  return copied;
}
