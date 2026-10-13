import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A semantic version string (also used by `bump-version.ts`). */
export const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Read only the three product versions; dependency versions are unrelated. */
export function checkReleaseVersion(directory = resolve(import.meta.dir, "..")): string {
  const sources = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"];
  const versions = sources.map((source) => {
    try {
      const text = readFileSync(resolve(directory, source), "utf8");
      const manifest = source.endsWith("toml") ? Bun.TOML.parse(text) : JSON.parse(text);
      const version = source.endsWith("toml") ? manifest?.package?.version : manifest?.version;
      if (typeof version !== "string" || !SEMANTIC_VERSION.test(version)) {
        throw new Error(`expected a semantic version string, received ${JSON.stringify(version) ?? "missing"}`);
      }
      return version;
    } catch (error) {
      throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (versions.some((version) => version !== versions[0])) {
    throw new Error(`Pet release version mismatch: ${sources.map((source, index) => `${source}=${versions[index]}`).join(", ")}`);
  }
  return versions[0]!;
}

if (import.meta.main) {
  try {
    console.log(`Pet release version consistent: ${checkReleaseVersion(process.argv[2])}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
