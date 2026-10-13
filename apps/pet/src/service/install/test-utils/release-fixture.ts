import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANAGED_HOST } from "../remote-probe.ts";

// Data fixtures for the replace tests: tiny releases whose start behaves as named. Linux/WSL tests only.
/** `slow-serve` answers only after `SLOW_START_MS`; `unreadable-health` serves, but its release's `bun -e` fails for the
 * `/health` script; `crash-unreadable-schema` exits 1 after making its release's `bun -e` fail for the schema script. */
export type ServerBehavior = "serve" | "crash" | "migrate-then-crash" | "slow-serve" | "unreadable-health" | "crash-unreadable-schema"
  | "crash-later-then-hang";
export const SLOW_START_MS = 4_000;
/** `crash-later-then-hang`: its first run (no `crashed-once` file in the release yet) exits 1 after this long, without
 * ever answering; every later run stays up without answering. With a restarting control it shows one restart. */
export const LATE_CRASH_MS = 1_500;
/** A release holding this file has a `bun` whose `-e` exits 3 when the script contains the file's text. */
const BREAK_FILE = "break-e";
export type AdapterBehavior = "stay" | "crash";
/** The model step's stand-ins: `ok` writes a marker into the folder the real script would fill, `fail` exits 1. */
export type ModelBehavior = "ok" | "fail";
export interface FixtureBundle { archive: string; sourceSha: string; bun: string; bunSha: string }

function dictionarySource(models: ModelBehavior, version: string): string {
  return `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (${JSON.stringify(models)} === "fail") { console.error("dictionary download failed"); process.exit(1); }
const dir = process.argv[process.argv.indexOf("--model-dir") + 1];
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "dictionary.txt"), ${JSON.stringify(version)});
`;
}

function prefetchSource(version: string): string {
  return `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
mkdirSync(process.env.BARA_HF_CACHE_DIR, { recursive: true });
writeFileSync(join(process.env.BARA_HF_CACHE_DIR, "model.txt"), ${JSON.stringify(version)});
console.log("prefetched");
`;
}

function serverSource(behavior: ServerBehavior): string {
  return `import { Database } from "bun:sqlite";
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
const behavior = ${JSON.stringify(behavior)};
if (behavior === "migrate-then-crash") {
  const db = new Database(process.env.MEMORY_DB_PATH);
  db.run("INSERT INTO schema_version VALUES (999)");
  db.close();
  process.exit(1);
}
if (behavior === "crash-unreadable-schema") {
  await Bun.write(new URL("../../../${BREAK_FILE}", import.meta.url), "schema_version");
  process.exit(1);
}
if (behavior === "crash") process.exit(1);
if (behavior === "crash-later-then-hang") {
  const marker = new URL("../../../crashed-once", import.meta.url);
  if (!(await Bun.file(marker).exists())) {
    await Bun.write(marker, "1");
    await Bun.sleep(${LATE_CRASH_MS});
    process.exit(1);
  }
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}
if (behavior === "slow-serve") await Bun.sleep(${SLOW_START_MS});
Bun.serve({ hostname: ${JSON.stringify(MANAGED_HOST)}, port: Number(process.env.MEMORY_PORT),
  fetch: (request) => new URL(request.url).pathname === "/health" ? Response.json({ ok: true, version: pkg.version }) : new Response("not found", { status: 404 }) });
`;
}

function adapterSource(behavior: AdapterBehavior): string {
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (${JSON.stringify(behavior)} === "crash") process.exit(1);
writeFileSync(join(process.env.BARA_ADAPTER_DATA_DIR, "started.txt"), String(process.pid));
setInterval(() => {}, 60_000);
`;
}

function run(argv: string[], cwd: string): void {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`);
}

/** The `bun` a fixture release carries: this test's own Bun, except that `-e` fails (exit 3) for a script containing the
 * text of `<release>/break-e` when that file exists. Installed as `<release>/bun`, so `$0`'s folder is the release. */
async function writeReleaseBun(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "bun");
  await writeFile(path, `#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "-e" ] && [ -f "$here/${BREAK_FILE}" ]; then
  case "$2" in *"$(cat "$here/${BREAK_FILE}")"*) echo "fixture bun -e broken" >&2; exit 3;; esac
fi
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o755 });
  return path;
}

async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }

async function pack(dir: string, name: string, files: Record<string, string>): Promise<FixtureBundle> {
  const stage = join(dir, name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), text);
  }
  run([process.execPath, "install"], stage); // writes the bun.lock a frozen install on the host needs
  const archive = `${stage}.tar.gz`;
  run(["tar", "-czf", archive, "--exclude=./node_modules", "-C", stage, "."], stage);
  const bun = await writeReleaseBun(join(dir, "bun-bin"));
  return { archive, sourceSha: await sha256File(archive), bun, bunSha: await sha256File(bun) };
}

export function buildServerFixture(dir: string, version: string, behavior: ServerBehavior, models: ModelBehavior = "ok"): Promise<FixtureBundle> {
  return pack(dir, `server-${version}-${behavior}-${models}`, {
    "package.json": JSON.stringify({ name: "fixture-root", private: true, workspaces: ["apps/*"] }),
    "apps/memory/package.json": JSON.stringify({ name: "memory", version, private: true }),
    "apps/memory/src/index.ts": serverSource(behavior),
    ...(behavior === "unreadable-health" ? { [BREAK_FILE]: "/health" } : {}),
    "apps/memory/scripts/prefetch-core-models.ts": prefetchSource(version),
    "apps/setup/package.json": JSON.stringify({ name: "@bara/setup", version, private: true }),
    "apps/setup/src/managed-models.ts": dictionarySource(models, version),
  });
}

export function buildAdapterFixture(dir: string, version: string, behavior: AdapterBehavior): Promise<FixtureBundle> {
  return pack(dir, `adapter-${version}-${behavior}`, {
    "package.json": JSON.stringify({ name: "fixture-root", private: true, workspaces: ["apps/*"] }),
    "apps/fixture-adapter/package.json": JSON.stringify({ name: "fixture-adapter", version, private: true, scripts: { start: "bun run src/index.ts" } }),
    "apps/fixture-adapter/src/index.ts": adapterSource(behavior),
  });
}
