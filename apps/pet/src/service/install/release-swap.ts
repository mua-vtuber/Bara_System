import type { RequestContext } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { failureCause } from "../backup.ts";
import { fitted, ServiceError, serviceError } from "../errors.ts";
import { causeOf } from "../fetch-failure.ts";
import { ADAPTER_SURVIVE_MS, INSTALL_MODEL_DICTIONARY_TIMEOUT_MS, MODEL_PREFETCH_IDLE_MS, RELEASE_HEALTH_SLOW_MAX_MS,
  RELEASE_HEALTH_WAIT_MS, RELEASE_POLL_INTERVAL_MS } from "./limits.ts";
import { CORE_CLI, RELEASE_LAYOUT, REMOTE_LAYOUT, type MANAGED_PATH_KEYS } from "./remote-probe.ts";
import { RELEASE_COMPLETE_MARKER, RELEASE_LOCK_DIR, RELEASE_RECORD_FILE, RELEASES_KEPT, parseReleaseRecord, releaseIdOf,
  releaseRecordText, type ReleaseDraft } from "./release-record.ts";
import type { ServiceControl, ShellReleaseHost } from "./release-host.ts";
import { envPrefix, remoteCommand, safeRemotePath, shQuote } from "./ssh.ts";

/** How a started component counts as started (spec 5.2 step 4). `env` is the server unit's environment, which the model
 * step runs with (BARA_KIWI_MODEL_DIR, BARA_HF_CACHE_DIR). */
export type ComponentCheck = { kind: "server"; port: number; db: string; snapshotDir: string; env: Record<string, string> } | { kind: "adapter" };
/** One component on a host: `root` holds `releases/`, `current` and `incoming/`. */
export interface ComponentTarget { root: string; control: ServiceControl; check: ComponentCheck }
export interface ReleaseBundle { archive: string; bun: string; bunSha: string; record: ReleaseDraft }
/** `slowMaxMs` (from the start, like `healthWaitMs`): how long a server still `active` with no restart is waited for past
 * `healthWaitMs` (limits.ts `RELEASE_HEALTH_SLOW_MAX_MS`). Equal to `healthWaitMs` means no slow wait. */
export interface ReplaceTiming { healthWaitMs: number; slowMaxMs: number; surviveMs: number; pollMs: number }
export const REPLACE_TIMING: ReplaceTiming = { healthWaitMs: RELEASE_HEALTH_WAIT_MS, slowMaxMs: RELEASE_HEALTH_SLOW_MAX_MS,
  surviveMs: ADAPTER_SURVIVE_MS, pollMs: RELEASE_POLL_INTERVAL_MS };
/** `leftoverLock`: the lock directory when the replace finished but its lock could not be removed (R3a); a later replace
 * stops with `RELEASE_BUSY` until it is deleted. `cancelledAfterCheck`: the caller cancelled after the new release had
 * already passed its start check; the release was kept running (R3c), so the caller reports a finished update, not a
 * cancelled one. */
export type ReplaceResult =
  | { kind: "replaced"; release: string; previous: string | null; reused: boolean; cancelledAfterCheck: boolean; leftoverLock: string | null }
  | { kind: "unchanged"; release: string; leftoverLock: string | null };
export interface ReplaceOptions { now?: () => Date; timing?: ReplaceTiming }

/** The server unit's environment keys the model step needs: the dictionary folder (`managed-models.ts --model-dir`) and
 * the search model cache `prefetch-core-models.ts` fills. A missing one stops the replace with its name. */
const MODEL_ENV_KEYS = ["BARA_KIWI_MODEL_DIR", "BARA_HF_CACHE_DIR"] as const satisfies ReadonlyArray<(typeof MANAGED_PATH_KEYS)[number]>;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The version a release directory's record names, or null for one written before records existed. */
async function recordedVersion(host: ShellReleaseHost, release: string): Promise<string | null> {
  const path = `${release}/${RELEASE_RECORD_FILE}`;
  const text = await host.readText(path);
  return text === null ? null : parseReleaseRecord(text, path).appVersion;
}

/** Null once the started component counts as started, otherwise the cause sentence of why not. A server still without
 * an answer after `healthWaitMs` is waited for while it stays `active` with no restart since the first read here (a slow
 * boot, limits.ts `RELEASE_HEALTH_SLOW_MAX_MS`), up to `slowMaxMs` from the start; `onSlow` runs once when that longer
 * wait begins. */
async function started(host: ShellReleaseHost, target: ComponentTarget, release: string, expected: string | null,
  timing: ReplaceTiming, signal: AbortSignal, onSlow: () => void = () => {}): Promise<string | null> {
  const text = messages.releaseErrors;
  const begun = Date.now();
  const deadline = begun + timing.healthWaitMs;
  const slowDeadline = begun + Math.max(timing.healthWaitMs, timing.slowMaxMs);
  let last = text.noAnswer;
  let firstRestarts: number | null = null;
  let slow = false;
  while (Date.now() < slowDeadline) {
    const pastNormalWait = Date.now() >= deadline;
    const state = await target.control.state();
    firstRestarts ??= state.restarts;
    if (state.active === "failed") return text.notActive(state.active);
    if (pastNormalWait) {
      if (target.check.kind !== "server") return last;
      if (state.active !== "active") return text.notActive(state.active);
      if (state.restarts !== firstRestarts) return text.restarted(state.restarts - firstRestarts);
      if (!slow) { slow = true; onSlow(); }
    }
    if (state.active === "active") {
      if (target.check.kind === "adapter") {
        await pause(timing.surviveMs, signal);
        const after = await target.control.state();
        if (after.active !== "active") return text.notActive(after.active);
        return after.restarts === state.restarts ? null : text.restarted(after.restarts - state.restarts);
      }
      const health = await host.health(`${release}/${RELEASE_LAYOUT.bun}`, target.check.port);
      if (health?.ok) return expected === null || health.version === expected ? null : text.wrongVersion(health.version ?? text.noVersion, expected);
      last = text.noAnswer;
    } else last = text.notActive(state.active);
    await pause(timing.pollMs, signal);
  }
  return last;
}

async function stage(host: ShellReleaseHost, bundle: ReleaseBundle, release: string, incoming: string, now: () => Date,
  ctx: RequestContext): Promise<void> {
  ctx.progress("transfer");
  await host.makeDir(incoming);
  const archive = `${incoming}/${releaseIdOf(bundle.record.sourceSha)}.tar.gz`;
  const bun = `${incoming}/bun-${releaseIdOf(bundle.bunSha)}`;
  await host.upload(bundle.archive, archive);
  await host.upload(bundle.bun, bun);
  if (await host.sha256(archive) !== bundle.record.sourceSha || await host.sha256(bun) !== bundle.bunSha)
    throw serviceError("RELEASE_DIGEST_MISMATCH", messages.releaseErrors.RELEASE_DIGEST_MISMATCH);
  await host.extract(archive, release);
  await host.installRuntime(bun, release);
  ctx.progress("dependencies");
  await host.installDependencies(release);
  await host.writeText(`${release}/${RELEASE_RECORD_FILE}`, releaseRecordText(bundle.record, now()));
  await host.writeText(`${release}/${RELEASE_COMPLETE_MARKER}`, "complete\n");
  await host.removeTree(archive);
  await host.removeTree(bun);
}

/** S-10: the memory server's Korean dictionary and search models for the new release, with the installer's own two
 * commands (remote.ts `installServer`), before `current` moves. A failure leaves the running release untouched. */
async function prepareModels(host: ShellReleaseHost, release: string, env: Record<string, string>, ctx: RequestContext): Promise<void> {
  ctx.progress("models");
  const bun = `${release}/${RELEASE_LAYOUT.bun}`;
  const prefix = `cd ${shQuote(release)} && ${envPrefix(env)}`;
  try {
    await host.shell.run(`${prefix} ${remoteCommand([bun, CORE_CLI.models, "--model-dir", env.BARA_KIWI_MODEL_DIR!])}`,
      messages.installSteps.koreanDictionary, { timeoutMs: INSTALL_MODEL_DICTIONARY_TIMEOUT_MS });
    // Idle, not total: see limits.ts MODEL_PREFETCH_IDLE_MS.
    await host.shell.run(`${prefix} ${remoteCommand([bun, CORE_CLI.prefetch])}`, messages.installSteps.modelDownload,
      { idleTimeoutMs: MODEL_PREFETCH_IDLE_MS });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw serviceError("RELEASE_MODELS_FAILED", fitted(messages.releaseErrors.RELEASE_MODELS_FAILED, failureCause(error)));
  }
}

/** The cause sentence of an error thrown after the switch: cancellation by name, otherwise the step's own cause. */
function causeFrom(error: unknown, signal: AbortSignal): string {
  if (signal.aborted && error === signal.reason) return messages.releaseErrors.cancelled;
  const cause = failureCause(error) ?? causeOf(error);
  return signal.aborted ? messages.releaseErrors.causeThenCancelled(cause) : cause;
}

interface Failed { release: string; previous: string | null; current: string; before: number | null; cause: string; timing: ReplaceTiming }

/** spec 5.2 failure handling: the error that states where it left the component. Throws only what it did not plan. */
async function rollBack(host: ShellReleaseHost, target: ComponentTarget, f: Failed, signal: AbortSignal): Promise<ServiceError> {
  const text = messages.releaseErrors;
  await target.control.stop();
  if (target.check.kind === "server" && await host.schemaVersion(`${f.release}/${RELEASE_LAYOUT.bun}`, target.check.db) !== f.before)
    return serviceError("RELEASE_SCHEMA_CHANGED", text.RELEASE_SCHEMA_CHANGED(f.cause, target.check.snapshotDir, f.previous));
  if (f.previous === null) return serviceError("RELEASE_START_FAILED", text.RELEASE_START_FAILED(f.cause));
  await host.pointLink(f.current, f.previous);
  await target.control.start();
  const again = await started(host, target, f.previous, await recordedVersion(host, f.previous), f.timing, signal);
  if (again !== null) {
    await target.control.stop();
    return serviceError("RELEASE_ROLLBACK_FAILED", text.RELEASE_ROLLBACK_FAILED(f.cause, again));
  }
  return serviceError("RELEASE_ROLLED_BACK", text.RELEASE_ROLLED_BACK(f.cause));
}

/** Runs the recovery to its end, also when the replace was cancelled (the switch already happened, so stopping halfway
 * would leave the component in no known state). An error inside it ends as `RELEASE_RECOVERY_FAILED`, which says
 * whether the service could be stopped and where `current` points. Always throws. */
async function recover(host: ShellReleaseHost, target: ComponentTarget, f: Failed): Promise<never> {
  const signal = new AbortController().signal;
  let outcome: ServiceError;
  try { outcome = await rollBack(host, target, f, signal); }
  catch (error) {
    const text = messages.releaseErrors;
    const recovery = causeFrom(error, signal);
    const stopped = await target.control.stop().then(() => true, () => false);
    const link = await host.readLink(f.current).then((to) => to ?? text.linkMissing, () => text.linkUnknown);
    throw serviceError("RELEASE_RECOVERY_FAILED", text.RELEASE_RECOVERY_FAILED(f.cause, recovery, stopped, link));
  }
  throw outcome;
}

/** R3a, and the Pet update's keep path (`remote-update.ts`): `release` is already `current`. Unless the component runs
 * it (server: `/health` with its recorded version), an earlier update left it stopped; that is said plainly and the
 * service is not started here. A service still `activating` (just started or restarting) is waited for as `started`
 * waits; an `active` adapter needs no further check. */
export async function assertRunning(host: ShellReleaseHost, target: ComponentTarget, release: string, timing: ReplaceTiming,
  ctx: RequestContext): Promise<void> {
  const text = messages.releaseErrors;
  const state = await target.control.state();
  let why: string | null;
  if (state.active !== "active" && state.active !== "activating") why = text.notActive(state.active);
  else if (state.active === "active" && target.check.kind === "adapter") why = null;
  else {
    const expected = target.check.kind === "server" ? await recordedVersion(host, release) : null;
    why = await started(host, target, release, expected, timing, ctx.signal, () => ctx.progress("server"));
  }
  if (why === null) return;
  throw target.check.kind === "server"
    ? serviceError("RELEASE_NOT_RUNNING", text.RELEASE_NOT_RUNNING_SERVER(release, why, target.check.snapshotDir))
    : serviceError("RELEASE_NOT_RUNNING", text.RELEASE_NOT_RUNNING(release, why));
}

/** Removes every release directory except the running one and the one before it. */
async function prune(host: ShellReleaseHost, releases: string, keep: Array<string | null>): Promise<void> {
  const kept = new Set(keep.filter((name): name is string => name !== null).slice(0, RELEASES_KEPT));
  for (const name of await host.listDirs(releases)) if (!kept.has(name)) await host.removeTree(`${releases}/${name}`);
}

type Swapped = { kind: "replaced"; release: string; previous: string | null; reused: boolean; cancelledAfterCheck: boolean }
  | { kind: "unchanged"; release: string };

/** Everything between taking and releasing the lock. */
async function swap(host: ShellReleaseHost, target: ComponentTarget, bundle: ReleaseBundle, ctx: RequestContext,
  timing: ReplaceTiming, now: () => Date, root: string): Promise<Swapped> {
  const releases = `${root}/${REMOTE_LAYOUT.releases}`;
  const id = releaseIdOf(bundle.record.sourceSha);
  const release = `${releases}/${id}`;
  const current = `${root}/${REMOTE_LAYOUT.current}`;
  const previous = await host.readLink(current);
  if (previous === release) {
    await assertRunning(host, target, release, timing, ctx);
    return { kind: "unchanged", release };
  }
  const reused = await host.exists(`${release}/${RELEASE_COMPLETE_MARKER}`);
  if (!reused) await stage(host, bundle, release, `${root}/${REMOTE_LAYOUT.incoming}`, now, ctx);
  if (target.check.kind === "server") await prepareModels(host, release, target.check.env, ctx);
  ctx.progress("service");
  const before = target.check.kind === "server" ? await host.schemaVersion(`${release}/${RELEASE_LAYOUT.bun}`, target.check.db) : null;
  // Cancellation is honoured up to here. Once the service is stopped, every outcome, a cancellation or an error of any
  // step included, goes through the recovery, which runs to its end and names the state it left.
  ctx.signal.throwIfAborted();
  await target.control.stop();
  let cause: string | null;
  try {
    await host.pointLink(current, release);
    await target.control.start();
    cause = await started(host, target, release, bundle.record.appVersion, timing, ctx.signal, () => ctx.progress("server"));
  } catch (error) {
    cause = causeFrom(error, ctx.signal);
  }
  if (cause !== null) await recover(host, target, { release, previous, current, before, cause, timing });
  // R3c: the step-4 check passed, so the replace succeeded (spec 5.2 runs failure handling only when the check fails).
  // A cancellation that arrives now does not roll a healthy release back; it finishes and is reported in the result.
  const cancelledAfterCheck = ctx.signal.aborted;
  await prune(host, releases, [id, previous === null ? null : previous.slice(previous.lastIndexOf("/") + 1)]);
  return { kind: "replaced", release, previous, reused, cancelledAfterCheck };
}

/** The error a failed replace ends with when its lock could not be removed either: the replace's own error with the
 * leftover lock appended (R3a), so the first failure is never hidden behind the unlock failure. */
function withLeftoverLock(original: unknown, lockLeft: string): ServiceError {
  if (original instanceof ServiceError)
    return new ServiceError(original.code, `${original.publicMessage} ${lockLeft}`, original.writeNotStarted);
  return serviceError("RELEASE_LOCK_LEFT", messages.releaseErrors.RELEASE_LOCK_LEFT(failureCause(original) ?? causeOf(original), lockLeft));
}

/** spec 5.2: put `bundle` in place of what `target` runs. Order: lock; when `current` already is this bundle, only check
 * that it runs; stage the release unless complete; (server) models; stop, switch `current`, start, check; on failure
 * the spec 5.2 recovery (`recover`); on success keep only the running and the previous release. The lock is always
 * released; a lock that could not be released is named in the result (`leftoverLock`) or in the error. */
export async function replaceRelease(host: ShellReleaseHost, target: ComponentTarget, bundle: ReleaseBundle,
  ctx: RequestContext, options: ReplaceOptions = {}): Promise<ReplaceResult> {
  if (target.check.kind === "server") {
    const env = target.check.env;
    const missing = MODEL_ENV_KEYS.find((key) => !env[key]);
    if (missing !== undefined) throw serviceError("RELEASE_ENV_INCOMPLETE", messages.releaseErrors.RELEASE_ENV_INCOMPLETE(missing));
  }
  const timing = options.timing ?? REPLACE_TIMING;
  const now = options.now ?? (() => new Date());
  const root = safeRemotePath(target.root);
  const lock = `${root}/${RELEASE_LOCK_DIR}`;
  await host.makeDir(`${root}/${REMOTE_LAYOUT.releases}`);
  if (!(await host.lock(lock))) throw serviceError("RELEASE_BUSY", messages.releaseErrors.RELEASE_BUSY(lock));
  let outcome: { ok: true; value: Swapped } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await swap(host, target, bundle, ctx, timing, now, root) }; }
  catch (error) { outcome = { ok: false, error }; }
  let leftoverLock: string | null = null;
  try { await host.unlock(lock); }
  catch (unlockError) {
    if (!outcome.ok) throw withLeftoverLock(outcome.error, messages.releaseErrors.lockLeft(lock, failureCause(unlockError) ?? causeOf(unlockError)));
    leftoverLock = lock;
  }
  if (!outcome.ok) throw outcome.error;
  return { ...outcome.value, leftoverLock };
}
