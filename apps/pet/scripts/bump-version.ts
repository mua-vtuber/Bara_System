import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SEMANTIC_VERSION } from "./check-release-version";

/**
 * Every place the Pet and memory server release version is written. The Pet decides whether to update a remote
 * server from the memory server version it carries, so both move together; the two lock files carry the same
 * numbers and the release bundle refuses a lock that disagrees with its manifest ("unapproved dependency/version").
 * Each entry finds its one version line by a pattern, so the rest of the file (formatting, line endings) is untouched.
 */
export const VERSION_SOURCES: readonly { path: string; pattern: RegExp }[] = [
  { path: "apps/pet/package.json", pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: "apps/pet/src-tauri/tauri.conf.json", pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: "apps/pet/src-tauri/Cargo.toml", pattern: /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/ },
  { path: "apps/pet/src-tauri/Cargo.lock", pattern: /(\nname = "bara-pet"\r?\nversion = ")([^"]+)(")/ },
  { path: "apps/memory/package.json", pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: "bun.lock", pattern: /("apps\/memory":\s*\{\s*"name":\s*"memory",\s*"version":\s*")([^"]+)(")/ },
];

const DEFAULT_ROOT = resolve(import.meta.dir, "../../..");

/** The version each source holds now. A file or version line that cannot be found stops with its path. */
export function readVersions(root = DEFAULT_ROOT): { path: string; version: string }[] {
  return VERSION_SOURCES.map(({ path, pattern }) => {
    let text: string;
    try { text = readFileSync(resolve(root, path), "utf8"); }
    catch (error) { throw new Error(`${path}: cannot read (${error instanceof Error ? error.message : String(error)})`); }
    const match = pattern.exec(text);
    if (!match) throw new Error(`${path}: version line not found`);
    return { path, version: match[2]! };
  });
}

/**
 * Sets every source to `next`. Nothing is written unless all sources read cleanly, hold the same version, and
 * `next` is a valid semantic version different from it; afterwards every source is read back.
 */
export function bumpVersion(next: string, root = DEFAULT_ROOT): { from: string; to: string } {
  if (!SEMANTIC_VERSION.test(next)) throw new Error(`expected a semantic version such as 0.1.6, received ${JSON.stringify(next)}`);
  const current = readVersions(root);
  const from = current[0]!.version;
  if (current.some(({ version }) => version !== from)) {
    throw new Error(`versions disagree, nothing changed: ${current.map(({ path, version }) => `${path}=${version}`).join(", ")}`);
  }
  if (next === from) throw new Error(`already at ${from}, nothing changed`);
  const updated = VERSION_SOURCES.map(({ path, pattern }) => {
    const text = readFileSync(resolve(root, path), "utf8");
    return { path, text: text.replace(pattern, (_all, head: string, _old: string, tail: string) => `${head}${next}${tail}`) };
  });
  for (const { path, text } of updated) writeFileSync(resolve(root, path), text);
  const after = readVersions(root);
  const wrong = after.filter(({ version }) => version !== next);
  if (wrong.length) throw new Error(`version not applied: ${wrong.map(({ path, version }) => `${path}=${version}`).join(", ")}`);
  return { from, to: next };
}

if (import.meta.main) {
  try {
    const next = process.argv[2];
    if (!next) throw new Error("usage: bun run version:bump <version>   (예: bun run version:bump 0.1.6)");
    const { from, to } = bumpVersion(next, process.argv[3] ?? DEFAULT_ROOT);
    console.log(`버전을 ${from} 에서 ${to} 로 올렸습니다: ${VERSION_SOURCES.map(({ path }) => path).join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
