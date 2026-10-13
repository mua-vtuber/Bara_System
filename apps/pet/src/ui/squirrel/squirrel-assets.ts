import { AtlasAttachmentLoader, GLTexture, SkeletonJson, TextureAtlas, type ManagedWebGLRenderingContext, type SkeletonData } from "@esotericsoftware/spine-webgl";
import { SQUIRREL_ATLAS_FILE, SQUIRREL_SKELETON_FILE, squirrelAssetPath } from "./asset-paths.ts";
import { SquirrelError } from "./squirrel-errors.ts";

const MS_PER_SECOND = 1_000;
/** The atlas page is premultiplied already (`pma:true`): the browser must neither multiply the alpha again nor convert
 * the colours while decoding, so the pixels reach the GPU as they were exported (design section 3.1). */
const BITMAP_OPTIONS: ImageBitmapOptions = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
const HTML_FILE = /\.html?$/i;
const HTML_DOCUMENT_START = /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i;
const HTML_PREFIX_BYTES = 512;

/** The parsed export with every atlas page uploaded as a texture (`page.texture`). */
export interface SquirrelAssets { readonly atlas: TextureAtlas; readonly data: SkeletonData }

/** The text of a failure cause, for the `detail` of a `SquirrelError`. */
export function causeText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tauri serves missing paths as index.html with status 200, but also labels a real .atlas as text/html because
 * its extension is unknown. Inspect the body: a MIME type alone cannot tell an absent file from a valid atlas. */
export function isPageInsteadOf(file: string, body: string): boolean {
  return !HTML_FILE.test(file) && HTML_DOCUMENT_START.test(body);
}

/** A failure of `file` whose detail is the file name and, when the error says anything, its cause. */
function fileFailure(code: "ASSET_NETWORK" | "ASSET_PARSE", file: string, error: unknown): SquirrelError {
  const cause = causeText(error).trim();
  return new SquirrelError(code, cause ? `${file}, ${cause}` : file, { cause: error });
}

/** Settles with `work`, or rejects with `onTimeout()` as soon as `signal` aborts. A late settlement of `work` after
 * the deadline lands on an already settled promise, so it is neither lost as an unhandled rejection nor reported. */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal, onTimeout: () => SquirrelError): Promise<T> {
  if (signal.aborted) return Promise.reject(onTimeout());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onTimeout());
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Reads the squirrel files next to the page with `fetch` (design section 7.6), so each failure names its file and
 * cause: an HTTP status, a page sent in place of the file, a refused request, an image that does not decode, or the
 * shared time limit. */
class AssetReader {
  private readonly signal: AbortSignal;
  private readonly timeout: () => SquirrelError;

  constructor(private readonly baseUri: string, timeoutMs: number) {
    this.signal = AbortSignal.timeout(timeoutMs);
    this.timeout = () => new SquirrelError("LOAD_TIMEOUT", String(timeoutMs / MS_PER_SECOND));
  }

  async text(file: string): Promise<string> {
    const response = await this.request(file);
    const text = await this.step(response.text(), error => fileFailure("ASSET_NETWORK", file, error));
    if (isPageInsteadOf(file, text)) throw new SquirrelError("ASSET_MISSING", file);
    return text;
  }

  async image(file: string): Promise<ImageBitmap> {
    const response = await this.request(file);
    const blob = await this.step(response.blob(), error => fileFailure("ASSET_NETWORK", file, error));
    const prefix = await this.step(blob.slice(0, HTML_PREFIX_BYTES).text(), error => fileFailure("ASSET_NETWORK", file, error));
    if (isPageInsteadOf(file, prefix)) throw new SquirrelError("ASSET_MISSING", file);
    return this.step(createImageBitmap(blob, BITMAP_OPTIONS), error => new SquirrelError("IMAGE_DECODE", file, { cause: error }));
  }

  private async request(file: string): Promise<Response> {
    const url = new URL(squirrelAssetPath(file), this.baseUri);
    const response = await this.step(fetch(url, { signal: this.signal }), error => fileFailure("ASSET_NETWORK", file, error));
    if (!response.ok) throw new SquirrelError("ASSET_HTTP", `${file}, HTTP ${response.status}`);
    return response;
  }

  private async step<T>(work: Promise<T>, failure: (error: unknown) => SquirrelError): Promise<T> {
    try {
      return await withDeadline(work, this.signal, this.timeout);
    } catch (error) {
      if (error instanceof SquirrelError) throw error;
      throw this.signal.aborted ? this.timeout() : failure(error);
    }
  }
}

/** Runs one parse step of `file`; whatever it throws becomes `ASSET_PARSE` naming the file and the cause. */
function parse<T>(file: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw fileFailure("ASSET_PARSE", file, error);
  }
}

/** Loads the export in the order of section 7.6: the atlas text, every page image the atlas names (uploaded on the
 * given WebGL context with the atlas filters, so a mipmapped page gets its mipmaps), then the skeleton. A part missing
 * from the atlas throws (`allowMissingRegions` stays off). Everything is bounded by `timeoutMs`. The page bitmaps are
 * kept open: `GLTexture.restore` uploads them again after a lost context comes back. */
export async function loadSquirrelAssets(context: ManagedWebGLRenderingContext, baseUri: string, timeoutMs: number): Promise<SquirrelAssets> {
  const reader = new AssetReader(baseUri, timeoutMs);
  const atlasText = await reader.text(SQUIRREL_ATLAS_FILE);
  const atlas = parse(SQUIRREL_ATLAS_FILE, () => {
    const parsed = new TextureAtlas(atlasText);
    if (!parsed.pages.length) throw new Error("the atlas names no page image");
    for (const page of parsed.pages) squirrelAssetPath(page.name);
    return parsed;
  });
  for (const page of atlas.pages) {
    const bitmap = await reader.image(page.name);
    page.setTexture(new GLTexture(context, bitmap, page.pma));
  }
  const skeletonText = await reader.text(SQUIRREL_SKELETON_FILE);
  const data = parse(SQUIRREL_SKELETON_FILE, () => new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonText));
  return { atlas, data };
}
