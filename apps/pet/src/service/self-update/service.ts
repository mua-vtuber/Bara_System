import { join } from "node:path";
import type { RequestContext, RuntimePaths, SelfUpdateInstallResult, SelfUpdateStatus } from "../../shared/contracts.ts";
import { SELF_UPDATE, type ReleaseSource } from "../../shared/self-update.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { isReleaseVersion } from "../install/release-record.ts";
import { publicError } from "../protocol.ts";
import { SharedRun } from "../shared-run.ts";
import { fetchLatestRelease } from "./check.ts";
import { downloadVerified } from "./download.ts";
import { SelfUpdateLog } from "./log.ts";
import { NotifiedRecord, notifiedRecordPath } from "./notified-record.ts";
import { applyOutcome, INITIAL_CHECK_STATE, publicStatus, type CheckState } from "./state.ts";
import type { CheckOutcome, NotifiedRead } from "./types.ts";
import { clearUpdates, updatesDir, type CleanupFailure } from "./updates-dir.ts";

/** `source` is `PRODUCT_RELEASE_SOURCE` in the product (`router.ts`); there is no setting, variable or switch that
 * changes it. Only tests pass their own loopback server. */
export interface SelfUpdateDeps {
  paths: RuntimePaths;
  currentVersion: string;
  source: ReleaseSource;
  now?: () => Date;
}

/** A check is never a caller's to cancel: only `close()` (quitting) stops one, through its `SharedRun`. */
const QUIET: RequestContext = { signal: new AbortController().signal, progress: () => {} };

/** The pet's own update in this service process (docs/decisions/2026-10-14-pet-self-update-spec.md 5, 6.2): when to
 * check, what the last check found, whether its notice showed, and the one download at a time. */
export class SelfUpdateService {
  private state: CheckState = INITIAL_CHECK_STATE;
  private checkRun: SharedRun<void> | null = null;
  private installRun: { version: string; run: SharedRun<string> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cleaned: Promise<void> = Promise.resolve();
  /** The notice record as read: undefined until first read (once per start, `self-update.json`). */
  private notified: NotifiedRead | undefined;
  /** Why the notice record could not be read or written in this start, reported in every status. */
  private recordError: string | null = null;
  private closed = false;
  private readonly log: SelfUpdateLog;
  private readonly record: NotifiedRecord;
  private readonly dir: string;

  constructor(private readonly deps: SelfUpdateDeps) {
    this.dir = updatesDir(deps.paths.dataDir);
    this.record = new NotifiedRecord(notifiedRecordPath(deps.paths.dataDir));
    this.log = new SelfUpdateLog(join(deps.paths.dataDir, SELF_UPDATE.logFileName), deps.now ?? (() => new Date()));
  }

  /** Starts the checks once per service process: the updates folder is emptied, one check runs now and one every
   * `SELF_UPDATE.checkIntervalMs` (spec 5.1). The router calls this on `selfUpdate.status`, which only the real app's
   * pet window asks as soon as it loads, so a test that drives this service never reaches GitHub, and a service
   * started again after a crash starts its checks with the pet window's next ask. */
  ensureStarted(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, SELF_UPDATE.checkIntervalMs);
    this.cleaned = clearUpdates(this.dir).then(async (failures) => {
      for (const failure of failures) await this.log.write(failure.code, failure.message);
    });
    void this.check();
  }

  get installing(): boolean { return this.installRun?.run.running ?? false; }

  /** One scheduled check; skipped while an installer downloads (spec 5.1). */
  async tick(): Promise<"checked" | "skipped"> {
    if (this.installing || this.closed) return "skipped";
    await this.check();
    return "checked";
  }

  /** Runs a check, or joins the one already running (spec 5.1, `SharedRun`). Never rejects. */
  check(): Promise<void> {
    if (!this.checkRun?.running) this.checkRun = new SharedRun((ctx) => this.runCheck(ctx.signal));
    return this.checkRun.join(QUIET);
  }

  private async runCheck(signal: AbortSignal): Promise<void> {
    let outcome: CheckOutcome;
    // `fetchLatestRelease` never rejects; a defect that makes it throw anyway is still a failed check, not a lost one.
    try { outcome = await fetchLatestRelease(this.deps.source, this.deps.currentVersion, signal); }
    catch (error) { const reply = publicError(error); outcome = { kind: "failed", code: reply.code, message: reply.message }; }
    if (signal.aborted) return;
    this.state = applyOutcome(this.state, outcome);
    if (outcome.kind === "failed") await this.log.write(outcome.code, outcome.message);
  }

  /** The notice record, read once per start. A record that is there but broken is not "nothing notified": its error
   * is logged, kept in `recordError` (the pet window shows it once) and no notice bubble is owed in this start. */
  private async readNotified(): Promise<NotifiedRead> {
    if (this.notified !== undefined) return this.notified;
    try { this.notified = { kind: "read", version: await this.record.read() }; }
    catch (error) {
      this.recordError = await this.logFailure(error);
      this.notified = { kind: "failed" };
    }
    return this.notified;
  }

  /** The one place a caught failure becomes a log line; returns the message the caller keeps or shows. */
  private async logFailure(error: unknown): Promise<string> {
    const reply = publicError(error);
    await this.log.write(reply.code, reply.message);
    return reply.message;
  }

  async status(): Promise<SelfUpdateStatus> {
    const notified = await this.readNotified();
    return publicStatus(this.state, notified, { logError: this.log.error, recordError: this.recordError });
  }

  /** The pet window showed `version`'s notice bubble (spec 5.3). Kept in memory first, so a record that cannot be
   * written repeats the bubble at the next start at worst, never every 30 seconds; the write's failure is logged,
   * reported in `recordError` and still reaches the caller. */
  async acknowledge(version: string): Promise<SelfUpdateStatus> {
    if (!isReleaseVersion(version)) throw serviceError("SELF_UPDATE_VERSION_INVALID", messages.selfUpdateErrors.SELF_UPDATE_VERSION_INVALID);
    this.notified = { kind: "read", version };
    try { await this.record.write(version); }
    catch (error) {
      this.recordError = await this.logFailure(error);
      throw error;
    }
    return this.status();
  }

  /** Downloads and checks the installer of the version the last successful check found (spec 6.2). A second call for
   * the same version while it downloads joins that download (no second download); a caller's cancel ends only its
   * wait. Each failure is written to the log once. */
  async install(version: string, ctx: RequestContext): Promise<SelfUpdateInstallResult> {
    if (this.closed) throw serviceError("SHUTTING_DOWN", messages.rpc.shuttingDown);
    const release = this.state.available;
    if (release === null || release.version !== version)
      throw serviceError("SELF_UPDATE_NOT_AVAILABLE", messages.selfUpdateErrors.SELF_UPDATE_NOT_AVAILABLE(version));
    const running = this.installRun?.run.running ? this.installRun : null;
    if (running !== null && running.version !== version)
      throw serviceError("SELF_UPDATE_BUSY", messages.selfUpdateErrors.SELF_UPDATE_BUSY(running.version));
    const current = running ?? { version, run: new SharedRun<string>(async (runCtx) => {
      await this.cleaned;
      const recordCleanupFailure = (failure: CleanupFailure) => this.log.write(failure.code, failure.message);
      try { return await downloadVerified(release, this.dir, runCtx, { recordCleanupFailure }); }
      catch (error) { await this.logFailure(error); throw error; }
    }) };
    this.installRun = current;
    return { version, installer: await current.run.join(ctx) };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.checkRun?.close();
    this.installRun?.run.close();
  }
}
