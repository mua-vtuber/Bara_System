import { join } from "node:path";
import type { RemoteServerRelease, RequestContext, RuntimePaths, ServerUpdateStatus, SshConnection } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { publicError } from "../protocol.ts";
import { SharedRun } from "../shared-run.ts";
import { PET_SERVICE_UNIT, REMOTE_LAYOUT, remoteBlockError } from "./remote-probe.ts";
import { openSession } from "./remote-session.ts";
import { compareVersions, type ReleaseRecord } from "./release-record.ts";
import { ShellReleaseHost, SystemdControl, sshTransport, type ServiceControl } from "./release-host.ts";
import type { ReplaceTiming } from "./release-swap.ts";
import { assertServerRunning, bundledServerDraft, probeInstalled, readInstalledRecord, replaceServer, type ProbedServer } from "./server-component.ts";
import type { PayloadManifest } from "./runtime.ts";

export type ServerUpdateDecision = { kind: "update"; from: string | null; to: string } | { kind: "keep" };

/** spec 5.3: only a Pet whose server version is higher updates; the same or a higher version (a dev build included) is
 * left alone. A server without a record was installed by a Pet from before records (plan S-6) and is updated. */
export function decideServerUpdate(bundledVersion: string, installed: ReleaseRecord | null): ServerUpdateDecision {
  if (installed === null) return { kind: "update", from: null, to: bundledVersion };
  return compareVersions(bundledVersion, installed.appVersion) > 0
    ? { kind: "update", from: installed.appVersion, to: bundledVersion } : { kind: "keep" };
}

/** Failures after which the replace procedure left the server's service stopped (`release-swap.ts` `rollBack`,
 * `recover`, `assertRunning`). Every other failure left the server running what it ran, or never reached it. */
export const STOPPED_CODES: ReadonlySet<string> = new Set(["RELEASE_START_FAILED", "RELEASE_ROLLBACK_FAILED", "RELEASE_SCHEMA_CHANGED",
  "RELEASE_RECOVERY_FAILED", "RELEASE_NOT_RUNNING"]);

/** The failed status for `error`: its public message whole (stopped-state errors carry the backup and previous-folder
 * paths), and whether it left the service stopped. */
export function updateFailure(error: unknown, from: string | null, to: string | null): Extract<ServerUpdateStatus, { state: "failed" }> {
  const failure = publicError(error);
  return { state: "failed", from, to, code: failure.code, message: failure.message, stopped: STOPPED_CODES.has(failure.code) };
}

/** The update's SSH work is never cancelled once it begins: a replace cut off after its service stop could leave the
 * server stopped (a schema-changed one is not started again). Only the check before the replace honours a cancel. */
const NEVER_ABORTED = new AbortController().signal;

function releaseOf(record: ReleaseRecord): RemoteServerRelease {
  return { appVersion: record.appVersion, origin: record.origin, commit: record.commit };
}

/** The status of a server left as it is (spec 5.3 keep): `current` only once the release `current` names runs and
 * answers its recorded version. A server an earlier update left stopped fails with `RELEASE_NOT_RUNNING` (a stopped
 * code), so its cause stays on screen, also after the Pet restarts; the service is never started here. */
export async function keptServerStatus(host: ShellReleaseHost, control: ServiceControl, probed: Extract<ProbedServer, { kind: "ready" }>,
  installed: ReleaseRecord, ctx: RequestContext, timing?: ReplaceTiming): Promise<ServerUpdateStatus> {
  await assertServerRunning(host, control, probed, ctx, timing);
  return { state: "current", installed: releaseOf(installed), leftoverLock: null, cancelledAfterCheck: false };
}

/** Brings a Pet-installed remote server to this Pet's server version (spec 5.3), once per service start and server. */
export class RemoteServerUpdater {
  private readonly runs = new Map<string, SharedRun<void>>();
  private current: ServerUpdateStatus | null = null;

  constructor(private readonly paths: RuntimePaths, private readonly manifest: () => Promise<PayloadManifest>) {}

  status(): ServerUpdateStatus | null { return this.current; }

  /** Resolves when the server was left serving: current, updated, rolled back, or a check that failed before reaching
   * it (the status shows that cause; the connection goes on, ruling P1). Throws when the update left the service
   * stopped; that run is then forgotten, so the next connect checks the server again. A caller's cancel or ceiling
   * ends only its own wait (`SharedRun`). */
  ensure(ssh: SshConnection, ctx: RequestContext): Promise<void> {
    const key = JSON.stringify([ssh.host, ssh.port, ssh.user, ssh.serverPath ?? null, ssh.serverPort ?? null]);
    let run = this.runs.get(key);
    if (!run) {
      const created: SharedRun<void> = new SharedRun<void>(async (runCtx) => {
        try { await this.work(ssh, runCtx); }
        catch (error) {
          // Classified from the error itself: another server's run may have written the shared status meanwhile.
          if (!STOPPED_CODES.has(publicError(error).code)) return;
          if (this.runs.get(key) === created) this.runs.delete(key);
          throw error;
        }
      });
      run = created;
      this.runs.set(key, run);
    }
    return run.join(ctx);
  }

  close(): void { for (const run of this.runs.values()) run.close(); }

  /** Records every failure in the status; rethrows it for `ensure` to decide whether it blocks the connection. */
  private async work(ssh: SshConnection, ctx: RequestContext): Promise<void> {
    let from: string | null = null;
    let to: string | null = null;
    try {
      const manifest = await this.manifest();
      const draft = await bundledServerDraft(this.paths, manifest);
      to = draft.appVersion;
      const session = await openSession(ssh, this.paths.dataDir, { signal: NEVER_ABORTED, progress: ctx.progress });
      const probed = await probeInstalled(session);
      // An install that has not finished is the install's to complete, not an update's.
      if (probed.kind === "incomplete") { this.current = null; return; }
      if (probed.kind === "blocked") throw remoteBlockError(probed.block);
      const shell = sshTransport(session);
      const files = new ShellReleaseHost(shell);
      const installed = await readInstalledRecord(files, probed.host.serverPath);
      const decision = decideServerUpdate(draft.appVersion, installed);
      const control = new SystemdControl(shell, PET_SERVICE_UNIT, probed.host.elevated,
        { scratchDir: join(this.paths.dataDir, "ssh"), remoteIncoming: `${probed.host.serverPath}/${REMOTE_LAYOUT.incoming}` });
      // `keep` always has a record: a server without one is updated (`decideServerUpdate`).
      if (decision.kind === "keep") { this.current = await keptServerStatus(files, control, probed, installed!, session.ctx); return; }
      from = decision.from;
      // The last point a quitting service stops the update; past it the replace runs to its end.
      ctx.signal.throwIfAborted();
      this.current = { state: "updating", from, to };
      ctx.progress("server-update");
      const arch = probed.host.arch;
      const bunSha = manifest.files[`linux/bun-${arch}`];
      if (!bunSha) throw serviceError("PAYLOAD_INVALID", messages.installService.payloadFileMissing);
      const result = await replaceServer({ host: files, control, units: control, user: ssh.user }, probed,
        { archive: join(this.paths.resourceDir, "server-source.tar.gz"), bun: join(this.paths.resourceDir, "linux", `bun-${arch}`), bunSha, record: draft },
        session.ctx);
      this.current = { state: "current", installed: { appVersion: draft.appVersion, origin: "pet", commit: null },
        leftoverLock: result.leftoverLock, cancelledAfterCheck: result.kind === "replaced" && result.cancelledAfterCheck };
    } catch (error) {
      this.current = updateFailure(error, from, to);
      throw error;
    }
  }
}
