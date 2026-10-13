import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { installKiwiArchive, KIWI_FILES, prefetchManagedKiwi, readBodyWithProgress } from "./managed-models.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bara-kiwi-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("verified tar extracts only required model files under its data directory", async () => {
  const entries = Object.fromEntries(KIWI_FILES.map((name) => [`models/cong/base/${name}`, `content-${name}`]));
  entries["models/cong/base/other.txt"] = "ignored";
  const archivePath = join(dir, "fixture.tar.gz");
  await Bun.write(archivePath, new Bun.Archive(entries, { compress: "gzip" }));
  const bytes = new Uint8Array(readFileSync(archivePath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = join(dir, "model");
  await expect(installKiwiArchive(bytes, target, "wrong")).rejects.toThrow("digest mismatch");
  expect(existsSync(target)).toBe(false);
  await installKiwiArchive(bytes, target, digest);
  for (const name of KIWI_FILES) expect(readFileSync(join(target, name), "utf8")).toBe(`content-${name}`);
  expect(existsSync(join(target, "other.txt"))).toBe(false);
});

function chunkedResponse(chunks: Uint8Array[], headers: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

test("body is streamed with loaded bytes and content-length as total", async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
  const seen: Array<[number, number]> = [];
  const bytes = await readBodyWithProgress(chunkedResponse(chunks, { "content-length": "6" }),
    (loaded, total) => seen.push([loaded, total]));
  expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(seen).toEqual([[3, 6], [5, 6], [6, 6]]);
});

test("missing or invalid content-length reports total 0", async () => {
  for (const headers of [{}, { "content-length": "abc" }, { "content-length": "-4" }] as Array<Record<string, string>>) {
    const seen: Array<[number, number]> = [];
    await readBodyWithProgress(chunkedResponse([new Uint8Array([9, 9])], headers),
      (loaded, total) => seen.push([loaded, total]));
    expect(seen).toEqual([[2, 0]]);
  }
});

test("prefetch emits nothing when every model file already exists", async () => {
  const target = join(dir, "present");
  mkdirSync(target, { recursive: true });
  for (const name of KIWI_FILES) writeFileSync(join(target, name), "x");
  const lines: string[] = [];
  await prefetchManagedKiwi(target, (line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("prefetch writes single-line progress for part 1 of 1 and ends with a full final line", async () => {
  const realFetch = globalThis.fetch;
  const payload = new Uint8Array(1000).fill(7);
  globalThis.fetch = (async () => chunkedResponse([payload.slice(0, 400), payload.slice(400)],
    { "content-length": "1000" })) as unknown as typeof fetch;
  const lines: string[] = [];
  try {
    // The fixture does not match the pinned digest, so installation fails after the download finishes.
    await expect(prefetchManagedKiwi(join(dir, "fresh"), (line) => lines.push(line))).rejects.toThrow("digest mismatch");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(/^@@bara-progress \{"part":1,"parts":1,"loaded":\d+,"total":1000\}$/);
  expect(lines.at(-1)).toBe('@@bara-progress {"part":1,"parts":1,"loaded":1000,"total":1000}');
});
