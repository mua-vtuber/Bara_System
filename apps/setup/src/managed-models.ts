/** Kiwi dictionary prefetch without relying on a system tar executable. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { createInstallProgress, progressLinesEnabled } from "../../memory/src/tools/install-progress.ts";

const URL = "https://github.com/bab2min/Kiwi/releases/download/v0.23.0/kiwi_model_v0.23.0_base.tgz";
export const KIWI_ARCHIVE_SHA256 = "355a006ab0bd4dec171cdca8e0b0d951e82bd5bc5993265421d8961876f20430";
export const KIWI_FILES = ["combiningRule.txt", "default.dict", "extract.mdl", "multi.dict", "sj.morph",
  "typo.dict", "cong.mdl", "nounchr.mdl", "dialect.dict"] as const;

export async function installKiwiArchive(bytes: Uint8Array, modelDir: string, digest = KIWI_ARCHIVE_SHA256): Promise<void> {
  if (!isAbsolute(modelDir)) throw new Error("model directory must be absolute");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest) throw new Error("Kiwi model digest mismatch");
  const files = await new Bun.Archive(bytes).files();
  const entries = new Map<string, Uint8Array>();
  for (const name of KIWI_FILES) {
    const entry = files.get(`models/cong/base/${name}`) ?? files.get(`./models/cong/base/${name}`);
    if (!entry) throw new Error(`Kiwi model is missing ${name}`);
    entries.set(name, new Uint8Array(await entry.arrayBuffer()));
  }
  mkdirSync(modelDir, { recursive: true });
  for (const [name, data] of entries) {
    const temporary = join(modelDir, `.${name}.${randomUUID()}.tmp`);
    writeFileSync(temporary, data);
    renameSync(temporary, join(modelDir, name));
  }
}

/**
 * Read a response body into one buffer, reporting (loaded, total) after every chunk.
 * `total` is the content-length header, or 0 when it is absent or invalid.
 */
export async function readBodyWithProgress(
  response: Response,
  onProgress: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const header = Number(response.headers.get("content-length"));
  const total = Number.isSafeInteger(header) && header > 0 ? header : 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(bytes.byteLength, total);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function prefetchManagedKiwi(
  modelDir: string,
  // Progress lines only when the Pet installer reads them (BARA_INSTALL_PROGRESS=1), never in a CLI terminal.
  writeLine: (line: string) => void = (line) => { if (progressLinesEnabled()) process.stdout.write(line + "\n"); },
): Promise<void> {
  if (KIWI_FILES.every((name) => existsSync(join(modelDir, name)))) return;
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`Kiwi model download failed (${response.status})`);
  // One download part; progress lines go to stdout, one per line, before the final ready line.
  const part = createInstallProgress({ parts: 1, write: writeLine }).startPart(1);
  const bytes = await readBodyWithProgress(response, (loaded, total) => part.setFile("kiwi", loaded, total));
  part.finish();
  await installKiwiArchive(bytes, modelDir);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true,
      options: { "model-dir": { type: "string" } } });
    if (!values["model-dir"]) throw new Error("--model-dir is required");
    await prefetchManagedKiwi(values["model-dir"]);
    process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  } catch {
    process.stderr.write("Kiwi model preparation failed; check download and model directory\n");
    process.exitCode = 1;
  }
}
