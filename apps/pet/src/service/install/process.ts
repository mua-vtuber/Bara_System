import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import type { RequestContext } from "../../shared/contracts.ts";

export interface Captured { stdout: string; stderr: string }
const MAX_OUTPUT = 1_000_000;

/** `%SystemRoot%` only when it is an absolute path; a relative value would resolve system tools
 * against the working directory. Never replaced by a guessed folder. */
function configuredSystemRoot(): string | null {
  const root = process.env.SystemRoot;
  return root && isAbsolute(root) ? root : null;
}

/** Folder that holds the Windows system tools (PowerShell, OpenSSH, taskkill). */
export function windowsSystemRoot(): string {
  const root = configuredSystemRoot();
  if (!root) throw serviceError("WINDOWS_SYSTEM_ROOT_MISSING", messages.installService.systemRootMissing);
  return root;
}

/** True until `child` has ended. A Bun child ended by `kill()` keeps `exitCode` null and sets only
 * `signalCode` (Bun 1.3.6 on Windows), so `exitCode === null` alone reports a dead child as running:
 * the tunnel would not be reopened, and `stopProcess` would run `taskkill` on a PID the OS may have
 * handed to another program. Every liveness check goes through here. */
export function isRunning(child: Bun.Subprocess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function stopProcess(child: Bun.Subprocess): void {
  if (!isRunning(child)) return;
  if (process.platform === "win32") {
    // Cleanup path: never throws. Without SystemRoot only the direct child is stopped, as before;
    // the tool folder is not guessed.
    const root = configuredSystemRoot();
    const taskkill = root ? join(root, "System32", "taskkill.exe") : null;
    const result = taskkill && existsSync(taskkill)
      ? Bun.spawnSync([taskkill, "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
      : null;
    if (!result || result.exitCode !== 0) child.kill();
  } else {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { child.kill(); }
  }
}

async function readChunks(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(value);
    }
  } finally { reader.releaseLock(); }
}

function outputLimit(child: Bun.Subprocess): never {
  stopProcess(child);
  throw serviceError("INSTALL_OUTPUT_LIMIT", messages.installService.outputTooLarge);
}

async function boundedRead(stream: ReadableStream<Uint8Array>, child: Bun.Subprocess, onChunk: (chunk: Uint8Array) => void,
  limit = MAX_OUTPUT): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await readChunks(stream, (value) => {
    size += value.byteLength;
    if (size > limit) outputLimit(child);
    chunks.push(value);
    onChunk(value);
  });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Reads stdout line by line for `onLine`: a line is handed over once its `\n` arrives, whatever chunk boundary
 * (or UTF-8 sequence) it was split across, without a trailing `\r`; an unterminated tail is never handed over.
 * A line `onLine` takes (returns true, a progress line) is neither kept nor counted against `MAX_OUTPUT`, so a
 * long download's steady progress cannot end its step; every other line is kept as it came, `\r\n` included.
 * A throwing `onLine` is ignored: reporting progress must never fail or stall the step. */
async function boundedLines(stream: ReadableStream<Uint8Array>, child: Bun.Subprocess, onChunk: () => void,
  onLine: (line: string) => boolean | void, limit = MAX_OUTPUT): Promise<string> {
  const decoder = new TextDecoder();
  let pending = "", kept = "", size = 0;
  const keep = (text: string) => {
    size += Buffer.byteLength(text);
    if (size > limit) outputLimit(child);
    kept += text;
  };
  await readChunks(stream, (value) => {
    onChunk();
    pending += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const raw = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      let taken = false;
      try { taken = onLine(raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.slice(0, -1)) === true; } catch { /* progress only */ }
      if (!taken) keep(raw);
    }
    // A line that never ends is bounded too (a character is at least one byte).
    if (size + pending.length > limit) outputLimit(child);
  });
  keep(pending + decoder.decode());
  return kept;
}

/** Why a captured child process ended without a clean zero exit. Distinguishes a step that
 * genuinely ran out of its total budget from one whose output went silent (stalled transfer)
 * from one that ran to completion and simply failed. */
type StopReason = "timeout" | "stalled" | null;

/** `onLine` sees each complete stdout line as it streams (never for a `sensitive` step, whose output may hold
 * a secret); the returned `stdout` is the whole output except the lines `onLine` took (see `boundedLines`).
 * `maxStdoutBytes` raises the stdout bound for a step whose one result line is large by design (the portable
 * archive's manifest lists every attachment); stderr keeps the default bound. */
export async function runCaptured(argv: string[], ctx: Pick<RequestContext, "signal">, options: {
  cwd?: string; env?: Record<string, string>; sensitive?: boolean; stepName?: string; onLine?: (line: string) => boolean | void;
  maxStdoutBytes?: number;
} & ({ timeoutMs: number; idleTimeoutMs?: never } | { idleTimeoutMs: number; timeoutMs?: never })): Promise<Captured> {
  ctx.signal.throwIfAborted();
  if (options.timeoutMs === undefined && options.idleTimeoutMs === undefined)
    throw new Error("runCaptured requires either timeoutMs or idleTimeoutMs");
  const child = Bun.spawn(argv, { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: process.platform !== "win32" });
  const onAbort = () => stopProcess(child);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  let stopReason: StopReason = null;
  const totalTimer = options.timeoutMs === undefined ? null : setTimeout(() => { stopReason = "timeout"; stopProcess(child); }, options.timeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (options.idleTimeoutMs === undefined) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { stopReason = "stalled"; stopProcess(child); }, options.idleTimeoutMs);
  };
  resetIdle();
  const onLine = options.sensitive ? undefined : options.onLine;
  const stepLabel = options.stepName ?? basename(argv[0] ?? "command");
  try {
    const [stdout, stderr, code] = await Promise.all([
      onLine ? boundedLines(child.stdout as ReadableStream<Uint8Array>, child, resetIdle, onLine, options.maxStdoutBytes)
        : boundedRead(child.stdout as ReadableStream<Uint8Array>, child, resetIdle, options.maxStdoutBytes),
      boundedRead(child.stderr as ReadableStream<Uint8Array>, child, resetIdle), child.exited,
    ]);
    ctx.signal.throwIfAborted();
    // A timer firing (stopReason set) means the step hit a limit; classify as timeout/stalled even if the child exits 0.
    if (stopReason === "timeout") throw serviceError("INSTALL_STEP_TIMEOUT", messages.installService.stepTimeout(stepLabel));
    if (stopReason === "stalled") throw serviceError("INSTALL_STEP_STALLED", messages.installService.stepStalled(stepLabel));
    if (code !== 0) {
      if (options.sensitive) throw serviceError("INSTALL_COMMAND_FAILED", messages.installService.sensitiveStepFailed);
      // The step's own error output rides along for a caller that names the cause (`failedStepStderr`);
      // `publicError` never reads it. A `sensitive` step's output may hold a secret, so it never carries any.
      throw Object.assign(serviceError("INSTALL_COMMAND_FAILED", messages.installService.stepFailed(stepLabel, code)), { stderr });
    }
    return { stdout, stderr };
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

/** The error output of a non-`sensitive` step that `runCaptured` ended with a nonzero exit; undefined for any
 * other failure. */
export function failedStepStderr(error: unknown): string | undefined {
  const stderr = (error as { code?: unknown; stderr?: unknown } | null)?.stderr;
  return (error as { code?: unknown } | null)?.code === "INSTALL_COMMAND_FAILED" && typeof stderr === "string" ? stderr : undefined;
}

export function spawnResident(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Bun.Subprocess {
  return Bun.spawn(argv, { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: process.platform !== "win32" });
}
