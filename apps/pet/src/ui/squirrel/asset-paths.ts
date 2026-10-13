/** The folder of the exported squirrel files. It is the same below the UI source (`src/ui`), where the export lives,
 * and below the built page (`dist`), where `scripts/ui-assets.ts` copies it and the screen fetches it. */
export const SQUIRREL_ASSET_DIR = "assets/squirrel";
export const SQUIRREL_ATLAS_FILE = "bara.atlas";
export const SQUIRREL_SKELETON_FILE = "bara.json";

/** The path of one squirrel file relative to the page (and to `src/ui`). The page images are not named here: the atlas
 * names them. A name that is not a plain file name (a folder part or `..`) would read or write outside the folder, so
 * it is refused. */
export function squirrelAssetPath(file: string): string {
  if (!file || file === "." || file === ".." || /[\\/]/.test(file)) throw new RangeError(`"${file}" is not a plain file name in ${SQUIRREL_ASSET_DIR}`);
  return `${SQUIRREL_ASSET_DIR}/${file}`;
}
