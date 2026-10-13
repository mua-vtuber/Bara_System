import type { ProgressDetail, ProgressStage, RequestContext } from "../shared/contracts.ts";

type Progress = RequestContext["progress"];

interface Run<T> {
  promise: Promise<T>;
  settled: boolean;
  /** The progress reporter of every caller still waiting. */
  listeners: Set<Progress>;
  /** The latest progress frame, replayed to a caller that joins while the run is going. */
  last: [ProgressStage, ProgressDetail | undefined] | null;
}

/** Work that runs once for this service process however many callers ask for it, and whose outcome every caller
 * receives: the startup check, which the native host starts right after the service starts and the main window
 * observes (`router.ts` `startup.check`).
 *
 * The work runs on this object's own signal, not a caller's: a caller's cancel or ceiling ends only that caller's
 * wait, and only `close()` (quitting) stops the work. Each waiting caller gets the work's progress under its own
 * request id, and one that joins while the work runs first gets the latest stage again, so a screen that opens late
 * still shows, for example, that the memories are being backed up. A caller that comes after the work ended gets the
 * same outcome at once, with no progress. */
export class SharedRun<T> {
  private run: Run<T> | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly work: (ctx: RequestContext) => Promise<T>) {}

  /** Whether the work has been started (by any caller). */
  get started(): boolean { return this.run !== null; }
  /** Whether the work has been started and has not ended yet. */
  get running(): boolean { return this.run !== null && !this.run.settled; }

  join(ctx: RequestContext): Promise<T> {
    ctx.signal.throwIfAborted();
    const run = this.run ?? this.begin();
    if (run.settled) return run.promise;
    if (run.last) ctx.progress(run.last[0], run.last[1]);
    run.listeners.add(ctx.progress);
    return new Promise<T>((resolve, reject) => {
      const leave = () => { run.listeners.delete(ctx.progress); ctx.signal.removeEventListener("abort", cancelled); };
      const cancelled = () => { leave(); reject(ctx.signal.reason); };
      ctx.signal.addEventListener("abort", cancelled, { once: true });
      run.promise.then((value) => { leave(); resolve(value); }, (error) => { leave(); reject(error); });
    });
  }

  /** Stops the work if it is still running. Callers still waiting receive whatever the work ends with. */
  close(): void { this.abort.abort(); }

  private begin(): Run<T> {
    const run: Run<T> = { promise: Promise.resolve() as Promise<T>, settled: false, listeners: new Set(), last: null };
    const progress: Progress = (stage, detail) => {
      run.last = [stage, detail];
      for (const listener of run.listeners) listener(stage, detail);
    };
    this.run = run;
    run.promise = (async () => this.work({ signal: this.abort.signal, progress }))();
    run.promise.then(() => { run.settled = true; }, () => { run.settled = true; });
    return run;
  }
}
