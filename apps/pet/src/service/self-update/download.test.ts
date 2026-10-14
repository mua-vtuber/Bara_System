import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProgressDetail, ProgressStage, RequestContext } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { ServiceError } from "../errors.ts";
import { junction } from "../test-utils/junction.ts";
import { downloadVerified, type DownloadDeps, type InstallerFile } from "./download.ts";
import type { CleanupFailure } from "./updates-dir.ts";

// Every download comes from a real loopback HTTP server (`Bun.serve`).
const NAME = "Bara.Pet_0.1.9_x64-setup.exe";
const BYTES = new Uint8Array(randomBytes(256 * 1024));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function serve(respond: () => Response) {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return respond(); } });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/download/v0.1.9/${NAME}`, hits: () => hits };
}
function context(signal = new AbortController().signal) {
  const frames: Array<[ProgressStage, ProgressDetail | undefined]> = [];
  const ctx: RequestContext = { signal, progress: (stage, detail) => { frames.push([stage, detail]); } };
  return { ctx, frames };
}
const file = (url: string, overrides: Partial<InstallerFile> = {}): InstallerFile =>
  ({ assetName: NAME, url, size: BYTES.length, sha256: sha256(BYTES), ...overrides });
const dirOf = () => join(mkdtempSync(join(tmpdir(), "bara-download-")), "updates");
/** What a download needs besides the file: the cleanup failures it records land in `recorded`. */
function recorder(overrides: Omit<Partial<DownloadDeps>, "recordCleanupFailure"> = {}) {
  const recorded: CleanupFailure[] = [];
  const deps: DownloadDeps = { recordCleanupFailure: async (failure) => { recorded.push(failure); }, ...overrides };
  return { deps, recorded };
}
const locked = async (path: string) => { throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" }); };
async function failure(run: Promise<unknown>): Promise<ServiceError> {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
}

test("a complete download is checked, renamed from .partial and reports its bytes", async () => {
  const server = serve(() => new Response(BYTES));
  const dir = dirOf();
  const { ctx, frames } = context();
  const path = await downloadVerified(file(server.url), dir, ctx, recorder().deps);
  expect(path).toBe(join(dir, NAME));
  expect(readdirSync(dir)).toEqual([NAME]);
  expect(sha256(new Uint8Array(readFileSync(path)))).toBe(sha256(BYTES));
  expect(frames[0]).toEqual(["self-update-download", { part: 1, parts: 1, loaded: 0, total: BYTES.length }]);
  expect(frames.at(-2)).toEqual(["self-update-download", { part: 1, parts: 1, loaded: BYTES.length, total: BYTES.length }]);
  expect(frames.at(-1)).toEqual(["self-update-verify", undefined]);
});

test("a digest mismatch removes the file and names the expected and the actual digest", async () => {
  const server = serve(() => new Response(BYTES));
  const dir = dirOf();
  const error = await failure(downloadVerified(file(server.url, { sha256: "0".repeat(64) }), dir, context().ctx, recorder().deps));
  expect(error.code).toBe("SELF_UPDATE_DIGEST_MISMATCH");
  expect(error.publicMessage).toContain("0".repeat(64));
  expect(error.publicMessage).toContain(sha256(BYTES));
  expect(error.publicMessage).toContain(messages.selfUpdate.partialRemoved);
  expect(readdirSync(dir)).toEqual([]);
});

test("a size mismatch removes the file, whether fewer or more bytes came", async () => {
  const fewer = serve(() => new Response(BYTES));
  const dir = dirOf();
  expect((await failure(downloadVerified(file(fewer.url, { size: BYTES.length + 10 }), dir, context().ctx, recorder().deps))).code).toBe("SELF_UPDATE_SIZE_MISMATCH");
  expect(readdirSync(dir)).toEqual([]);
  expect((await failure(downloadVerified(file(fewer.url, { size: BYTES.length - 10 }), dir, context().ctx, recorder().deps))).code).toBe("SELF_UPDATE_SIZE_MISMATCH");
  expect(readdirSync(dir)).toEqual([]);
});

test("a connection cut in the middle leaves no file", async () => {
  // A raw loopback socket reset after 1000 bytes: Bun.serve reports a stream error to the client as a clean end, which
  // would only surface as a size mismatch, so the cut has to happen on the connection itself.
  const cutter = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(socket) {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BYTES.length}\r\nConnection: close\r\n\r\n`);
      socket.write(BYTES.subarray(0, 1000));
      setTimeout(() => socket.terminate(), 20);
    },
    open() {}, close() {}, error() {},
  } });
  servers.push(cutter);
  const dir = dirOf();
  const error = await failure(downloadVerified(file(`http://127.0.0.1:${cutter.port}/download/v0.1.9/${NAME}`), dir, context().ctx, recorder().deps));
  // Depending on where the reset surfaces, the runtime's error is classified as a network error or stays unclassified; neither is a size mismatch.
  expect(["SELF_UPDATE_DOWNLOAD_NETWORK", "SELF_UPDATE_DOWNLOAD_UNEXPECTED"]).toContain(error.code);
  expect(readdirSync(dir)).toEqual([]);
});

test("a download that stops sending is stopped after the stall limit and leaves no file", async () => {
  const server = serve(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(BYTES.subarray(0, 1000)); } }),
    { headers: { "content-length": String(BYTES.length) } }));
  const dir = dirOf();
  expect((await failure(downloadVerified(file(server.url), dir, context().ctx, recorder({ limits: { stallMs: 200 } }).deps))).code).toBe("SELF_UPDATE_DOWNLOAD_STALLED");
  expect(readdirSync(dir)).toEqual([]);
});

test("a cancel stops the download and leaves no file", async () => {
  const server = serve(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(BYTES.subarray(0, 1000)); } }),
    { headers: { "content-length": String(BYTES.length) } }));
  const dir = dirOf();
  const cancel = new AbortController();
  const { ctx } = context(cancel.signal);
  const running = downloadVerified(file(server.url), dir, ctx, recorder().deps);
  setTimeout(() => cancel.abort(), 50);
  expect((await failure(running)).code).toBe("SELF_UPDATE_CANCELLED");
  expect(readdirSync(dir)).toEqual([]);
});

test("a non-2xx answer fails with its status and leaves no file", async () => {
  const server = serve(() => new Response("", { status: 404 }));
  const dir = dirOf();
  const error = await failure(downloadVerified(file(server.url), dir, context().ctx, recorder().deps));
  expect(error.code).toBe("SELF_UPDATE_DOWNLOAD_HTTP");
  expect(error.publicMessage).toContain("404");
  expect(readdirSync(dir)).toEqual([]);
});

test("a file already checked is used again without downloading; a wrong one is downloaded again", async () => {
  const server = serve(() => new Response(BYTES));
  const dir = dirOf();
  await downloadVerified(file(server.url), dir, context().ctx, recorder().deps);
  const again = context();
  await downloadVerified(file(server.url), dir, again.ctx, recorder().deps);
  expect(server.hits()).toBe(1);
  expect(again.frames).toEqual([["self-update-verify", undefined]]);
  writeFileSync(join(dir, NAME), "tampered");
  await downloadVerified(file(server.url), dir, context().ctx, recorder().deps);
  expect(server.hits()).toBe(2);
  expect(sha256(new Uint8Array(readFileSync(join(dir, NAME))))).toBe(sha256(BYTES));
});

test.skipIf(process.platform !== "win32")("nothing is downloaded into an updates folder that is a junction", async () => {
  const data = mkdtempSync(join(tmpdir(), "bara-download-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "bara-elsewhere-"));
  junction(join(data, "updates"), elsewhere);
  const server = serve(() => new Response(BYTES));
  expect((await failure(downloadVerified(file(server.url), join(data, "updates"), context().ctx, recorder().deps))).code).toBe("SELF_UPDATE_DIR_LINK");
  expect(server.hits()).toBe(0);
  expect(readdirSync(elsewhere)).toEqual([]);
  expect(existsSync(join(elsewhere, NAME))).toBe(false);
});

test("a partial file that cannot be removed keeps the first error, is recorded and is not called removed", async () => {
  const server = serve(() => new Response(BYTES));
  const dir = dirOf();
  const { deps, recorded } = recorder({ remove: locked });
  const error = await failure(downloadVerified(file(server.url, { sha256: "0".repeat(64) }), dir, context().ctx, deps));
  expect(error.code).toBe("SELF_UPDATE_DIGEST_MISMATCH");
  expect(error.publicMessage).toContain("0".repeat(64));
  expect(error.publicMessage).not.toContain(messages.selfUpdate.partialRemoved);
  expect(error.publicMessage).toContain(messages.selfUpdate.partialKept);
  expect(recorded.map((entry) => entry.code)).toEqual(["SELF_UPDATE_PARTIAL_CLEANUP_FAILED"]);
  expect(recorded[0]!.message).toContain(join(dir, `${NAME}.partial`));
  expect(recorded[0]!.message).toContain("EBUSY");
});

test("a cancel whose partial file cannot be removed is still a cancel", async () => {
  const server = serve(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(BYTES.subarray(0, 1000)); } }),
    { headers: { "content-length": String(BYTES.length) } }));
  const cancel = new AbortController();
  const { deps, recorded } = recorder({ remove: locked });
  const running = downloadVerified(file(server.url), dirOf(), context(cancel.signal).ctx, deps);
  setTimeout(() => cancel.abort(), 50);
  const error = await failure(running);
  expect(error.code).toBe("SELF_UPDATE_CANCELLED");
  expect(error.publicMessage).toContain(messages.selfUpdate.partialKept);
  expect(recorded).toHaveLength(1);
});

test("a wrong earlier file that cannot be removed fails as a write failure naming it", async () => {
  const server = serve(() => new Response(BYTES));
  const dir = dirOf();
  await downloadVerified(file(server.url), dir, context().ctx, recorder().deps);
  writeFileSync(join(dir, NAME), "tampered");
  const error = await failure(downloadVerified(file(server.url), dir, context().ctx, recorder({ remove: locked }).deps));
  expect(error.code).toBe("SELF_UPDATE_WRITE_FAILED");
  expect(error.publicMessage).toContain(join(dir, NAME));
  expect(server.hits()).toBe(1);
});

test("the checked file is renamed with the given rename; a rename that fails removes the partial file", async () => {
  const server = serve(() => new Response(BYTES));
  const dir = dirOf();
  const renames: string[] = [];
  const path = await downloadVerified(file(server.url), dir, context().ctx,
    recorder({ rename: async (from, to) => { renames.push(to); await rename(from, to); } }).deps);
  expect(renames).toEqual([path]);
  await rm(path);
  const error = await failure(downloadVerified(file(server.url), dir, context().ctx, recorder({ rename: locked }).deps));
  expect(error.code).toBe("SELF_UPDATE_WRITE_FAILED");
  expect(error.publicMessage).toContain(messages.selfUpdate.partialRemoved);
  expect(readdirSync(dir)).toEqual([]);
});

test("progress is sent only when the whole percent changes, ending at 100", async () => {
  // 150 chunks of 4 bytes, sent apart so they arrive apart: a whole percent is 6 bytes, so a frame per chunk would
  // repeat percents.
  const small = BYTES.subarray(0, 600);
  const server = serve(() => {
    let sent = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (sent >= small.length) { controller.close(); return; }
        controller.enqueue(small.subarray(sent, sent + 4));
        sent += 4;
        await Bun.sleep(1);
      },
    }), { headers: { "content-length": String(small.length) } });
  });
  const { ctx, frames } = context();
  await downloadVerified(file(server.url, { size: small.length, sha256: sha256(small) }), dirOf(), ctx, recorder().deps);
  const percents = frames.filter(([stage]) => stage === "self-update-download")
    .map(([, detail]) => Math.floor((detail!.loaded * 100) / detail!.total));
  expect(new Set(percents).size).toBe(percents.length);
  expect(percents[0]).toBe(0);
  expect(percents.at(-1)).toBe(100);
}, 15_000); // 150 timer waits on the server side, about 2.5 s on Windows
