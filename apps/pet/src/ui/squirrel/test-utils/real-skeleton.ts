import { join } from "node:path";
import { AtlasAttachmentLoader, SkeletonJson, TextureAtlas, type SkeletonData } from "@esotericsoftware/spine-webgl";
import { SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, squirrelAssetPath } from "../asset-paths.ts";

// Test only: never imported by product code. It reads the real export the app ships (src/ui/assets/squirrel) through
// the real Spine classes the app uses. No texture is uploaded: lengths, bounds and slot data do not need one.
// The paths are the ones the build copies and the screen fetches (`asset-paths.ts`), taken below `src/ui`.
const UI_SOURCE_DIR = join(import.meta.dir, "..", "..");

/** The text of the real atlas and skeleton files. */
export async function readRealSkeletonFiles(): Promise<{ atlasText: string; skeletonText: string }> {
  return {
    atlasText: await Bun.file(join(UI_SOURCE_DIR, squirrelAssetPath(SQUIRREL_ATLAS_FILE))).text(),
    skeletonText: await Bun.file(join(UI_SOURCE_DIR, squirrelAssetPath(SQUIRREL_SKELETON_FILE))).text(),
  };
}

/** Skeleton data parsed the way the app parses it. `allowMissingRegions` stays off: a part missing from the atlas throws. */
export function parseSkeletonData(atlasText: string, skeletonText: string): SkeletonData {
  return new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasText))).readSkeletonData(skeletonText);
}

export async function loadRealSkeletonData(): Promise<SkeletonData> {
  const files = await readRealSkeletonFiles();
  return parseSkeletonData(files.atlasText, files.skeletonText);
}
