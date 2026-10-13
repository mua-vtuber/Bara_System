import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { LICENSE_TEXTS_MODULE, type LicenseTexts } from "../src/ui/license-texts-module.ts";
import { REPO_ROOT } from "./release-bundle.ts";
import { spineLicensePath } from "./ui-assets.ts";

/** Bara's additional permission for the Spine combination, kept at the monorepo root next to `LICENSE`. */
export const BARA_LICENSE_EXCEPTION_FILE = "LICENSE-EXCEPTION.md";
const PLUGIN_NAMESPACE = "bara-license-texts";

/** Where each license text the settings screen shows is read from: the repository's own exception file and the
 * license file the installed Spine runtime package ships. These files are the only copies; nothing is pasted into
 * the UI source. */
export function licenseSources(petRoot: string, repoRoot = REPO_ROOT): Record<keyof LicenseTexts, string> {
  return { baraException: join(repoRoot, BARA_LICENSE_EXCEPTION_FILE), spineRuntimes: spineLicensePath(petRoot) };
}

/** Reads every license text verbatim. A missing or blank source fails the build with its path, so the installer
 * never ships an empty license section. */
export async function readLicenseTexts(sources: Record<keyof LicenseTexts, string>): Promise<LicenseTexts> {
  const texts = {} as LicenseTexts;
  for (const key of Object.keys(sources) as (keyof LicenseTexts)[]) {
    const path = sources[key];
    if (!existsSync(path)) throw new Error(`License text source is missing: ${path}`);
    const text = await readFile(path, "utf8");
    if (!text.trim()) throw new Error(`License text source is empty: ${path}`);
    texts[key] = text;
  }
  return texts;
}

/** The JavaScript the virtual module resolves to: one string export per text, JSON-escaped. */
export function licenseTextsSource(texts: LicenseTexts): string {
  return (Object.keys(texts) as (keyof LicenseTexts)[]).map(key => `export const ${key} = ${JSON.stringify(texts[key])};`).join("\n");
}

/** Lets the UI bundle import the texts read at build time as `LICENSE_TEXTS_MODULE`. */
export function licenseTextsPlugin(texts: LicenseTexts): BunPlugin {
  return {
    name: PLUGIN_NAMESPACE,
    setup(build) {
      const filter = new RegExp(`^${LICENSE_TEXTS_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      build.onResolve({ filter }, args => ({ path: args.path, namespace: PLUGIN_NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: PLUGIN_NAMESPACE }, () => ({ contents: licenseTextsSource(texts), loader: "js" }));
    },
  };
}
