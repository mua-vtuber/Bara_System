import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { RequestContext } from "../../shared/contracts.ts";
import { downloadHeaders, downloadPercent, SELF_UPDATE } from "../../shared/self-update.ts";
import { messages } from "../../ui/messages.ts";
import { fitted, ServiceError, serviceError } from "../errors.ts";
import { classifyFetchFailure } from "../fetch-failure.ts";
import { renameWithRetry, type Rename } from "../restore-journal.ts";
import { failureText } from "./failure.ts";
import type { ReleaseInfo } from "./types.ts";
import { prepareUpdatesDir, type CleanupFailure } from "./updates-dir.ts";

export type InstallerFile = Pick<ReleaseInfo, "assetName" | "url" | "size" | "sha256">;
export interface DownloadLimits { stallMs: number }
const PRODUCT_LIMITS: DownloadLimits = { stallMs: SELF_UPDATE.downloadStallMs };
export type Remove = (path: string) => Promise<void>;
const removeFile: Remove = (path) => rm(path, { force: true });

/** What a download uses besides the file. `recordCleanupFailure` receives a cleanup (closing or removing the
 * half-received file) that failed while another error is the answer; the service writes it to `self-update.log`.
 * Only tests pass their own `limits`, `remove` or `rename`. */
export interface DownloadDeps {
  recordCleanupFailure: (failure: CleanupFailure) => Promise<void>;
  limits?: DownloadLimits;
  remove?: Remove;
  rename?: Rename;
}
type Received = { bytes: number; sha256: string };

const cancelled = () => serviceError("SELF_UPDATE_CANCELLED", messages.selfUpdateErrors.SELF_UPDATE_CANCELLED);

function writeFailure(path: string, error: unknown): ServiceError {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOSPC"
    ? serviceError("SELF_UPDATE_DISK_FULL", messages.selfUpdateErrors.SELF_UPDATE_DISK_FULL(path))
    : serviceError("SELF_UPDATE_WRITE_FAILED", failureText((cause) => messages.selfUpdateErrors.SELF_UPDATE_WRITE_FAILED(path, cause), error));
}

function cleanupFailure(path: string, error: unknown): CleanupFailure {
  return { code: "SELF_UPDATE_PARTIAL_CLEANUP_FAILED",
    message: failureText((cause) => messages.selfUpdateErrors.SELF_UPDATE_PARTIAL_CLEANUP_FAILED(path, cause), error) };
}

/** `error` with `sentence` added, kept within the host's limit by shortening the error's own text. */
function withSentence(error: unknown, sentence: string): unknown {
  if (!(error instanceof ServiceError)) return error;
  return serviceError(error.code, fitted((shown) => `${shown ?? ""} ${sentence}`, error.publicMessage), error.writeNotStarted);
}

function readFailure(error: unknown, cancel: AbortSignal, stall: AbortSignal, limits: DownloadLimits): ServiceError {
  const text = messages.selfUpdateErrors;
  if (error instanceof ServiceError) return error;
  if (cancel.aborted) return cancelled();
  if (stall.aborted) return serviceError("SELF_UPDATE_DOWNLOAD_STALLED", text.SELF_UPDATE_DOWNLOAD_STALLED(Math.ceil(limits.stallMs / 1000)));
  switch (classifyFetchFailure(error, cancel)) {
    case "network": case "timeout": return serviceError("SELF_UPDATE_DOWNLOAD_NETWORK", failureText(text.SELF_UPDATE_DOWNLOAD_NETWORK, error));
    case "redirect": case "malformed": return serviceError("SELF_UPDATE_RESPONSE_INVALID", text.SELF_UPDATE_RESPONSE_INVALID);
    default: return serviceError("SELF_UPDATE_DOWNLOAD_UNEXPECTED", failureText(text.SELF_UPDATE_DOWNLOAD_UNEXPECTED, error));
  }
}

async function sha256Of(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  try { for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer); }
  catch (error) { throw signal.aborted ? cancelled() : writeFailure(path, error); }
  return hash.digest("hex");
}

/** An installer a previous attempt of this start already checked is used again, so a failed launch is retried
 * without a second 200 MB download (spec 10). Any other file under its name is removed. */
async function alreadyVerified(target: string, file: InstallerFile, ctx: RequestContext, remove: Remove): Promise<boolean> {
  let size: number;
  try { size = (await stat(target)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw writeFailure(target, error);
  }
  ctx.progress("self-update-verify");
  if (size === file.size && await sha256Of(target, ctx.signal) === file.sha256) return true;
  try { await remove(target); } catch (error) { throw writeFailure(target, error); }
  return false;
}

/** Streams the response into `handle`, hashing as it goes (never the whole file in memory, spec 10), and stops at
 * the first byte beyond `file.size`, after `limits.stallMs` without a byte, or on `ctx.signal`. Progress is sent when
 * the whole percent changes, not per chunk. */
async function stream(file: InstallerFile, partial: string, handle: FileHandle, ctx: RequestContext, limits: DownloadLimits,
  stall: { signal: AbortSignal; restart(): void }): Promise<Received> {
  const signal = AbortSignal.any([ctx.signal, stall.signal]);
  let response: Response;
  try { response = await fetch(file.url, { signal, redirect: "follow", headers: downloadHeaders() }); }
  catch (error) { throw readFailure(error, ctx.signal, stall.signal, limits); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {}); // the status is the answer; its body is not read
    throw serviceError("SELF_UPDATE_DOWNLOAD_HTTP", messages.selfUpdateErrors.SELF_UPDATE_DOWNLOAD_HTTP(response.status));
  }
  if (response.body === null) throw serviceError("SELF_UPDATE_RESPONSE_INVALID", messages.selfUpdateErrors.SELF_UPDATE_RESPONSE_INVALID);
  ctx.progress("self-update-download", { part: 1, parts: 1, loaded: 0, total: file.size });
  const hash = createHash("sha256");
  let bytes = 0;
  let shown = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch (error) { throw readFailure(error, ctx.signal, stall.signal, limits); }
      if (chunk.done) break;
      stall.restart();
      bytes += chunk.value.byteLength;
      if (bytes > file.size)
        throw serviceError("SELF_UPDATE_SIZE_MISMATCH", messages.selfUpdateErrors.SELF_UPDATE_SIZE_MISMATCH(file.size, bytes));
      hash.update(chunk.value);
      try { await handle.write(chunk.value); } catch (error) { throw writeFailure(partial, error); }
      const detail = { part: 1, parts: 1, loaded: bytes, total: file.size };
      const percent = downloadPercent(detail);
      if (percent !== null && percent !== shown) { shown = percent; ctx.progress("self-update-download", detail); }
    }
  } finally {
    await reader.cancel().catch(() => {}); // already finished or failed; cancelling only releases the connection
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Receives the installer into `partial` (`stream`). A file that cannot be closed is the error only when the download
 * itself succeeded; otherwise the download's error stays the answer and the close failure is recorded. */
async function receive(file: InstallerFile, partial: string, ctx: RequestContext, limits: DownloadLimits,
  record: DownloadDeps["recordCleanupFailure"]): Promise<Received> {
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), limits.stallMs);
  const restart = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), limits.stallMs); };
  let handle: FileHandle;
  try { handle = await open(partial, "w", 0o600); }
  catch (error) { clearTimeout(timer); throw writeFailure(partial, error); }
  let received: Received;
  try { received = await stream(file, partial, handle, ctx, limits, { signal: stall.signal, restart }); }
  catch (error) {
    clearTimeout(timer);
    try { await handle.close(); } catch (closeError) { await record(cleanupFailure(partial, closeError)); }
    throw error;
  }
  clearTimeout(timer);
  try { await handle.close(); } catch (error) { throw writeFailure(partial, error); }
  return received;
}

/** Downloads `file` into `dir` (the updates folder) and returns the installer's path once its size and sha256 match
 * the release (spec 6.2). While it downloads the file is `<name>.partial`; on any failure, the cancel included, that
 * file is removed and a `ServiceError` names the cause, with the expected and actual value for a mismatch, and says
 * whether the file is gone (`partialRemoved`) or could not be removed (`partialKept`, recorded through
 * `deps.recordCleanupFailure`); the cause stays the error either way. Checking is separate from receiving so a
 * signature check can be added after it later (spec 8). */
export async function downloadVerified(file: InstallerFile, dir: string, ctx: RequestContext, deps: DownloadDeps): Promise<string> {
  const remove = deps.remove ?? removeFile;
  await prepareUpdatesDir(dir);
  const target = join(dir, file.assetName);
  if (await alreadyVerified(target, file, ctx, remove)) return target;
  const partial = `${target}${SELF_UPDATE.partialSuffix}`;
  try {
    const received = await receive(file, partial, ctx, deps.limits ?? PRODUCT_LIMITS, deps.recordCleanupFailure);
    ctx.progress("self-update-verify");
    if (received.bytes !== file.size)
      throw serviceError("SELF_UPDATE_SIZE_MISMATCH", messages.selfUpdateErrors.SELF_UPDATE_SIZE_MISMATCH(file.size, received.bytes));
    if (received.sha256 !== file.sha256)
      throw serviceError("SELF_UPDATE_DIGEST_MISMATCH", messages.selfUpdateErrors.SELF_UPDATE_DIGEST_MISMATCH(file.sha256, received.sha256));
    try { await (deps.rename ?? renameWithRetry)(partial, target); } catch (error) { throw writeFailure(target, error); }
    return target;
  } catch (error) {
    try { await remove(partial); }
    catch (cleanupError) {
      await deps.recordCleanupFailure(cleanupFailure(partial, cleanupError));
      throw withSentence(error, messages.selfUpdate.partialKept);
    }
    throw withSentence(error, messages.selfUpdate.partialRemoved);
  }
}
