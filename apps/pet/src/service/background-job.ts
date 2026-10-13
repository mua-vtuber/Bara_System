import type { BackupJobState, ProgressDetail, ProgressStage, RequestContext, RpcError } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { serviceError } from "./errors.ts";
import { publicError } from "./protocol.ts";

type Progress = RequestContext["progress"];

/** How long `close` waits for a stopped job to finish its own clean-up (a child process ended, its record written). */
export const JOB_CLOSE_GRACE_MS = 2_000;

interface Job<T> {
  controller: AbortController;
  promise: Promise<T>;
  startedAt: string;
  endedAt: string | null;
  outcome: { result: T } | { error: RpcError } | null;
  /** The outcome reached a caller still waiting when the job ended, or a `snapshot` handed it out. */
  delivered: boolean;
  /** The progress reporter of every caller still waiting. */
  listeners: Set<Progress>;
  /** The latest progress frame, replayed to a caller that joins while the job runs. */
  last: [ProgressStage, ProgressDetail | undefined] | null;
}

/** Long work on this PC's store that belongs to the service, not to the screen that started it: the settings backup
 * (`backup.ts`) and the restore from a backup (`restore.ts`). One runs at a time per kind.
 *
 * The work runs on the job's own signal, like `SharedRun`: a caller's cancel (`operation.cancel`, the screen leaving,
 * a quit's drain) ends only that caller's wait. Only `cancel` (the screen's "중단", `backup.cancel`) and `close`
 * (quitting) stop the work, and the work then ends as `CANCELLED` with `cancelledText`. A caller that joins while it
 * runs first gets the latest stage again, so a settings screen opened again shows where the job is. The outcome is
 * kept until the next job starts and reported once (`snapshot`), so a screen that was closed when the job ended
 * shows how it ended the next time it opens. */
export class BackgroundJob<T> {
  private job: Job<T> | null = null;
  private closed = false;

  constructor(private readonly cancelledText: string, private readonly now: () => Date = () => new Date()) {}

  /** A job has been started and has not ended yet. */
  get running(): boolean { return this.job !== null && this.job.outcome === null; }

  /** Starts `work` (the caller checked `running` first) and returns the starting caller's wait. */
  start(work: (ctx: RequestContext) => Promise<T>, ctx: RequestContext): Promise<T> {
    if (this.running) throw new Error("a job of this kind is running");
    const controller = new AbortController();
    if (this.closed) controller.abort();
    const job: Job<T> = { controller, promise: Promise.resolve() as Promise<T>, startedAt: this.now().toISOString(), endedAt: null,
      outcome: null, delivered: false, listeners: new Set(), last: null };
    const progress: Progress = (stage, detail) => {
      job.last = [stage, detail];
      for (const listener of job.listeners) listener(stage, detail);
    };
    this.job = job;
    job.promise = (async () => work({ signal: controller.signal, progress }))().then((result) => {
      job.endedAt = this.now().toISOString(); job.outcome = { result };
      return result;
    }, (error: unknown) => {
      // A stop leaves the work with whatever its step threw on the signal; a failure it named itself stays.
      const failure = controller.signal.aborted && publicError(error).code === "INTERNAL" ? serviceError("CANCELLED", this.cancelledText) : error;
      job.endedAt = this.now().toISOString(); job.outcome = { error: publicError(failure) };
      throw failure;
    });
    job.promise.catch(() => {});
    return this.wait(job, ctx);
  }

  /** `backup.join`: waits for the job that runs, or receives the outcome of the last one. */
  join(ctx: RequestContext): Promise<T> {
    if (!this.job) return Promise.reject(serviceError("BACKUP_JOB_NONE", messages.backupErrors.BACKUP_JOB_NONE));
    return this.wait(this.job, ctx);
  }

  /** `backup.status`: the job that runs, or the outcome of the last one when no caller has received it yet (then it
   * counts as received). */
  snapshot(): BackupJobState<T> | null {
    const job = this.job;
    if (!job) return null;
    if (!job.outcome) {
      const [stage, detail] = job.last ?? [null, undefined];
      return { state: "running", startedAt: job.startedAt, stage, ...(detail ? { detail } : {}) };
    }
    if (job.delivered) return null;
    job.delivered = true;
    const ended = { startedAt: job.startedAt, endedAt: job.endedAt! };
    return "result" in job.outcome ? { state: "done", ...ended, result: job.outcome.result } : { state: "failed", ...ended, error: job.outcome.error };
  }

  /** `backup.cancel`: stops the job that runs. False when none runs. */
  cancel(): boolean {
    if (!this.running) return false;
    this.job!.controller.abort();
    return true;
  }

  /** Quitting: stops the job that runs and waits a little for its clean-up. No job starts afterwards. */
  async close(graceMs = JOB_CLOSE_GRACE_MS): Promise<void> {
    this.closed = true;
    const job = this.job;
    if (!job || job.outcome) return;
    job.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.promise.then(() => {}, () => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
  }

  private wait(job: Job<T>, ctx: RequestContext): Promise<T> {
    if (ctx.signal.aborted) return Promise.reject(ctx.signal.reason);
    if (job.outcome) { job.delivered = true; return job.promise; }
    if (job.last) ctx.progress(job.last[0], job.last[1]);
    job.listeners.add(ctx.progress);
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = () => { left = true; job.listeners.delete(ctx.progress); ctx.signal.removeEventListener("abort", cancelled); };
      const cancelled = () => { leave(); reject(ctx.signal.reason); };
      ctx.signal.addEventListener("abort", cancelled, { once: true });
      job.promise.then((value) => { if (left) return; leave(); job.delivered = true; resolve(value); },
        (error: unknown) => { if (left) return; leave(); job.delivered = true; reject(error); });
    });
  }
}
