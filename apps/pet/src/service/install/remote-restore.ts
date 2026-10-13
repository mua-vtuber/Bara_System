import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RequestContext } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { failureCause } from "../backup.ts";
import { fitted, serviceError } from "../errors.ts";
import { RESTORE_IDLE_MS } from "../restore.ts";
import type { RestoreCounts } from "../restore-journal.ts";
import { RESTORE_DIGEST_TIMEOUT_MS, RESTORE_EXTRACT_TIMEOUT_MS, RESTORE_PACK_TIMEOUT_MS, RESTORE_UPLOAD_TIMEOUT_MS,
  SSH_COMMAND_TIMEOUT_MS } from "./limits.ts";
import { runCaptured, windowsSystemRoot } from "./process.ts";
import { CORE_CLI, RELEASE_LAYOUT } from "./remote-probe.ts";
import type { ShellReleaseHost, ShellTransport } from "./release-host.ts";
import { envPrefix, remoteCommand, safeRemotePath, shQuote } from "./ssh.ts";

// The remote install's "백업에서 시작" (docs/decisions/2026-10-08-single-deploy-path-spec.md 4.2, 4.3), run by
// `remote.ts` `installServer` around its own steps:
//
// 1. `uploadForRestore`, after the release is unpacked and before `managed-prepare`: the server's data folder is read
//    (`managed-restore.ts inspect`) and `planRemoteRestore` decides. A folder already restored from this backup is
//    `done`; one holding memories (archived ones count), attachments or another backup's restore is refused; leftover
//    work of this backup `resume`s and of another backup is refused. Otherwise the backup folder is packed here with
//    Windows' own `tar`, sent with `scp`, checked with `sha256sum` and unpacked into `incoming/restore-archive`.
// 2. `restoreAndSwap`, after `managed-prepare` made the empty database and the models are in place: an earlier
//    attempt's unit is stopped, the work record names the backup, `portable-memory.ts restore` builds the restored
//    store in `data/restore-work/target` (with `--resume` when it goes on from leftover work) under an idle limit, its
//    counts are compared with the backup's manifest, and `managed-restore.ts swap` moves the empty database and
//    attachment folder aside (never deleting them) and the restored ones in.
//
// Every failure throws, so the install stops before its service is registered or started (spec 4.3).

/** The backup on this PC chosen for "백업에서 시작", found again by its id and read back here (`RestoreService.remoteSource`). */
export interface RemoteRestoreSource { id: string; name: string; archive: string; fingerprint: string; counts: RestoreCounts }

/** Names in the managed data root and the incoming folder. The work folder is shared with apps/setup/src/managed-restore.ts. */
export const RESTORE_WORK_DIR = "restore-work";
export const RESTORE_TARGET_DIR = "target";
export const RESTORE_JOB_FILE = "job.json";
export const RESTORE_UPLOAD_FILE = "restore-archive.tar.gz";
export const RESTORE_ARCHIVE_DIR = "restore-archive";
/** The model the restore computes search vectors with (spec 4.2). */
const RESTORE_MODEL = "bge-m3";
const JOB_FORMAT = 1;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const steps = messages.releaseSteps;

function unreadable(step: string): Error {
  return serviceError("RELEASE_STEP_OUTPUT_INVALID", messages.releaseErrors.RELEASE_STEP_OUTPUT_INVALID(step));
}
function lastJson(text: string): unknown {
  try { return JSON.parse(text.trim().split("\n").at(-1) ?? ""); } catch { return null; }
}
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** `managed-restore.ts inspect`: `memories` counts live plus archived memories, `null` when there is no database yet. */
export interface RemoteInspection { memories: number | null; contentFiles: number; restoredFingerprint: string | null }

export function parseInspection(text: string): RemoteInspection {
  const v = lastJson(text) as Partial<Record<keyof RemoteInspection, unknown>> | null;
  if (!v || typeof v !== "object" || !(v.memories === null || isCount(v.memories)) || !isCount(v.contentFiles) ||
      !(v.restoredFingerprint === null || (typeof v.restoredFingerprint === "string" && FINGERPRINT.test(v.restoredFingerprint))))
    throw unreadable(steps.restoreInspect);
  return { memories: v.memories as number | null, contentFiles: v.contentFiles, restoredFingerprint: v.restoredFingerprint as string | null };
}

export type RemoteRestorePlan = { kind: "done" } | { kind: "start" } | { kind: "resume" };

/** spec 4.3: refuse a target holding memories; finish an install that already swapped in this backup; resume this
 * backup's leftover work; refuse leftover work of another backup (or work whose record is gone) and name its folder. */
export function planRemoteRestore(inspection: RemoteInspection, job: { fingerprint: string } | null, workExists: boolean,
  fingerprint: string, workPath: string): RemoteRestorePlan {
  if (inspection.restoredFingerprint === fingerprint) return { kind: "done" };
  if ((inspection.memories ?? 0) > 0 || inspection.contentFiles > 0 || inspection.restoredFingerprint !== null)
    throw serviceError("RESTORE_TARGET_NOT_EMPTY", messages.remoteRestore.RESTORE_TARGET_NOT_EMPTY);
  if (!workExists) return { kind: "start" };
  if (job?.fingerprint !== fingerprint) throw serviceError("RESTORE_WORK_OTHER_BACKUP", messages.remoteRestore.RESTORE_WORK_OTHER_BACKUP(workPath));
  return { kind: "resume" };
}

/** The work record `restoreAndSwap` writes; anything else (missing, unreadable, another format) is no record. */
function parseJob(text: string | null): { fingerprint: string } | null {
  if (text === null) return null;
  const value = lastJson(text) as { format?: unknown; fingerprint?: unknown } | null;
  return value?.format === JOB_FORMAT && typeof value.fingerprint === "string" && FINGERPRINT.test(value.fingerprint)
    ? { fingerprint: value.fingerprint } : null;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Windows' own bsdtar (spec 4.2: "Windows 기본 tar"; Git Bash's GNU tar first on PATH cannot read a `C:\` path), or
 * `tar` on the PATH elsewhere. */
function tarCommand(): string { return process.platform === "win32" ? join(windowsSystemRoot(), "System32", "tar.exe") : "tar"; }

/** The chosen backup folder as one `tar.gz` in `scratchDir`, with its SHA-256. A failure leaves no partial file. */
export async function packBackup(source: RemoteRestoreSource, scratchDir: string, ctx: RequestContext): Promise<{ file: string; sha256: string }> {
  await mkdir(scratchDir, { recursive: true });
  const file = join(scratchDir, `restore-${randomUUID()}.tar.gz`);
  try {
    await runCaptured([tarCommand(), "-czf", file, "-C", source.archive, "."], ctx, { timeoutMs: RESTORE_PACK_TIMEOUT_MS, stepName: steps.restorePack });
    return { file, sha256: await fileSha256(file) };
  } catch (error) {
    await rm(file, { force: true });
    if (ctx.signal.aborted) throw error;
    throw serviceError("RESTORE_PACK_FAILED", fitted(messages.remoteRestore.RESTORE_PACK_FAILED, failureCause(error)));
  }
}

/** Everything the restore steps run on the host. `release` is the release directory just installed. */
export interface RemoteRestoreRun { shell: ShellTransport; host: ShellReleaseHost; release: string; data: string; incoming: string; scratchDir: string; ctx: RequestContext }

const releaseBun = (run: RemoteRestoreRun) => `${run.release}/${RELEASE_LAYOUT.bun}`;

/** spec 4.2 step 2, before the data folder is prepared: decide, then pack, upload, check and unpack the backup. */
export async function uploadForRestore(run: RemoteRestoreRun, source: RemoteRestoreSource): Promise<RemoteRestorePlan> {
  const inspection = parseInspection(await run.shell.run(`cd ${shQuote(run.release)} && ${remoteCommand([releaseBun(run), CORE_CLI.restore,
    "inspect", "--data-dir", run.data])}`, steps.restoreInspect, { timeoutMs: SSH_COMMAND_TIMEOUT_MS }));
  const work = `${run.data}/${RESTORE_WORK_DIR}`;
  const plan = planRemoteRestore(inspection, parseJob(await run.host.readText(`${work}/${RESTORE_JOB_FILE}`)), await run.host.exists(work),
    source.fingerprint, work);
  if (plan.kind === "done") {
    // A copy of the backup an earlier run unpacked but did not remove (it holds private data): nothing needs it any more.
    await run.host.removeTree(`${run.incoming}/${RESTORE_ARCHIVE_DIR}`);
    await run.host.removeTree(`${run.incoming}/${RESTORE_UPLOAD_FILE}`);
    return plan;
  }
  const packed = await packBackup(source, run.scratchDir, run.ctx);
  try {
    const upload = `${run.incoming}/${RESTORE_UPLOAD_FILE}`;
    await run.host.makeDir(run.incoming);
    await run.host.upload(packed.file, upload, RESTORE_UPLOAD_TIMEOUT_MS);
    if (await run.host.sha256(upload, RESTORE_DIGEST_TIMEOUT_MS) !== packed.sha256) {
      await run.host.removeTree(upload);
      throw serviceError("RESTORE_UPLOAD_MISMATCH", messages.remoteRestore.RESTORE_UPLOAD_MISMATCH);
    }
    await run.host.extract(upload, `${run.incoming}/${RESTORE_ARCHIVE_DIR}`, RESTORE_EXTRACT_TIMEOUT_MS);
    await run.host.removeTree(upload);
  } finally { await rm(packed.file, { force: true }); }
  return plan;
}

/** `managed-restore.ts swap`'s result: `replaced` is the folder in the data root holding the moved-aside empty database
 * and attachment folder. Only a path inside the data root is accepted. */
function parseSwap(text: string, data: string): { replaced: string } {
  const value = lastJson(text) as { replaced?: unknown } | null;
  const replaced = value?.replaced;
  if (typeof replaced !== "string" || !replaced.startsWith(`${data}/`)) throw unreadable(steps.restoreSwap);
  try { return { replaced: safeRemotePath(replaced) }; } catch { throw unreadable(steps.restoreSwap); }
}

/** spec 4.2 steps 4 and 5, after `managed-prepare` made the empty database: restore into the work folder, compare the
 * counts with the backup's manifest, swap. `stopService` stops an earlier attempt's unit so nothing holds the database.
 * The answer names where the swap put the empty database and attachment folder; `null` when the plan was `done`. */
export async function restoreAndSwap(run: RemoteRestoreRun, source: RemoteRestoreSource, plan: RemoteRestorePlan,
  env: Record<string, string>, stopService: () => Promise<void>): Promise<{ replaced: string } | null> {
  if (plan.kind === "done") return null;
  await stopService();
  const bun = releaseBun(run);
  const work = `${run.data}/${RESTORE_WORK_DIR}`, target = `${work}/${RESTORE_TARGET_DIR}`;
  if (plan.kind === "start") {
    await run.host.makeDir(work);
    await run.host.writeText(`${work}/${RESTORE_JOB_FILE}`, JSON.stringify({ format: JOB_FORMAT, fingerprint: source.fingerprint }));
  }
  run.ctx.progress("restore-data");
  let counts: Record<string, unknown> | null;
  try {
    // Progress and errors go to stderr (portable-memory.ts), which keeps the idle clock running; stdout is the result line.
    // An interrupted restore leaves its staging folder beside `target`, so going on from it needs `--resume`.
    const out = await run.shell.run(`cd ${shQuote(`${run.release}/${RELEASE_LAYOUT.serverDir}`)} && ${envPrefix(env)} ${remoteCommand([bun,
      "scripts/portable-memory.ts", "restore", "--archive", `${run.incoming}/${RESTORE_ARCHIVE_DIR}`, "--out", target, "--model", RESTORE_MODEL,
      ...(plan.kind === "resume" ? ["--resume"] : [])])}`, steps.restoreRun, { idleTimeoutMs: RESTORE_IDLE_MS });
    const result = lastJson(out) as { counts?: unknown } | null;
    counts = result && typeof result.counts === "object" && result.counts !== null ? result.counts as Record<string, unknown> : null;
  } catch (error) {
    if (run.ctx.signal.aborted) throw error;
    throw serviceError("RESTORE_REMOTE_FAILED", fitted(messages.remoteRestore.RESTORE_REMOTE_FAILED, failureCause(error)));
  }
  if (!counts || counts.memories !== source.counts.memories || (counts.archivedMemories ?? 0) !== source.counts.archived)
    throw serviceError("RESTORE_REMOTE_COUNT_MISMATCH", messages.remoteRestore.RESTORE_REMOTE_COUNT_MISMATCH(work));
  run.ctx.progress("restore-switch");
  let swapped: string;
  try {
    swapped = await run.shell.run(`cd ${shQuote(run.release)} && ${remoteCommand([bun, CORE_CLI.restore, "swap", "--data-dir", run.data,
      "--fingerprint", source.fingerprint, "--attachments", String(source.counts.attachments)])}`, steps.restoreSwap, { timeoutMs: SSH_COMMAND_TIMEOUT_MS });
  } catch (error) {
    if (run.ctx.signal.aborted) throw error;
    throw serviceError("RESTORE_SWAP_FAILED", fitted(messages.remoteRestore.RESTORE_SWAP_FAILED, failureCause(error)));
  }
  const result = parseSwap(swapped, run.data);
  await run.host.removeTree(`${run.incoming}/${RESTORE_ARCHIVE_DIR}`);
  return result;
}
