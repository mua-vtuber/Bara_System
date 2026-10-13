import type { BackupJobKind, BackupJobState, ProgressDetail, ProgressEvent, ProgressStage } from "../shared/contracts.ts";

// How the settings screen follows a settings backup or a restore (`settings.ts` `renderBackup`), apart from the DOM so
// it can be tested. The job belongs to the service (`src/service/background-job.ts`), not to the screen: a screen that
// goes away (another view, the panel opened again on a result) ends only its own wait, and a screen opened again
// finds the job (`backup.status`), joins it (`backup.join`) and shows where it is and how it ends. Only the screen's
// "중단" stops it (`backup.cancel`).

/** What the follower sends; `request` is the bridge's in the app and a stand-in in tests. */
export interface JobPorts {
  request(method: "backup.export" | "backup.restore" | "backup.join" | "backup.cancel" | "operation.cancel",
    params: Record<string, unknown>, id?: string): Promise<unknown>;
  newId(): string;
  now(): number;
}

/** What the screen shows for the job. */
export interface JobView<T> {
  /** The job runs, started here or found running; `startedAt` in milliseconds, for the time so far. */
  running(startedAt: number): void;
  stage(stage: ProgressStage, detail?: ProgressDetail): void;
  done(result: T): void;
  /** The job failed or was stopped (`CANCELLED`); `error` is what `request` rejects with, or the same shape. */
  failed(error: unknown): void;
  /** The wait ended, after `done` or `failed`. */
  ended(): void;
}

export class JobFollower<T> {
  /** The request id of the wait in progress, which its progress events carry. */
  private waiting = "";
  private live = true;

  constructor(private readonly kind: BackupJobKind, private readonly ports: JobPorts, private readonly view: JobView<T>) {}

  /** The screen waits for a job of this kind. */
  get busy(): boolean { return this.waiting !== ""; }

  /** Starts the job (`backup.export`, or `backup.restore` with the chosen backup) and waits for it. */
  start(params: Record<string, unknown>): Promise<void> {
    return this.follow(this.kind === "export" ? "backup.export" : "backup.restore", params, this.ports.now(), null);
  }

  /** What `backup.status` says about this kind: a job that runs is joined, its stage shown at once; one that ended
   * while no screen waited shows how it ended. */
  attach(state: BackupJobState<T> | null): Promise<void> {
    if (!state || !this.live || this.busy) return Promise.resolve();
    if (state.state === "running") {
      const startedAt = Date.parse(state.startedAt);
      return this.follow("backup.join", { kind: this.kind }, Number.isNaN(startedAt) ? this.ports.now() : startedAt,
        state.stage ? [state.stage, state.detail] : null);
    }
    if (state.state === "done") this.view.done(state.result); else this.view.failed(state.error);
    return Promise.resolve();
  }

  /** A progress event of the bridge; only the wait's own reach the view. */
  progress(event: ProgressEvent): void {
    if (this.live && this.waiting !== "" && event.requestId === this.waiting) this.view.stage(event.stage, event.detail);
  }

  /** The screen's "중단": stops the job itself. */
  cancel(): Promise<unknown> { return this.ports.request("backup.cancel", { kind: this.kind }); }

  /** The screen goes away: its wait ends, the job goes on. */
  dispose(): void {
    this.live = false;
    if (this.waiting) void this.ports.request("operation.cancel", { requestId: this.waiting }).catch(() => {});
  }

  private async follow(method: "backup.export" | "backup.restore" | "backup.join", params: Record<string, unknown>, startedAt: number,
    stage: [ProgressStage, ProgressDetail | undefined] | null): Promise<void> {
    const id = this.waiting = this.ports.newId();
    this.view.running(startedAt);
    if (stage) this.view.stage(stage[0], stage[1]);
    try {
      const result = await this.ports.request(method, params, id) as T;
      if (this.live) this.view.done(result);
    } catch (error) {
      if (this.live) this.view.failed(error);
    } finally {
      if (this.waiting === id) this.waiting = "";
      if (this.live) this.view.ended();
    }
  }
}

/** The order to show the jobs `backup.status` reported in: an ended one before a running one, earlier ends first, so
 * the status line ends on what matters now. */
export function attachOrder<A, B>(jobs: { export: BackupJobState<A> | null; restore: BackupJobState<B> | null }): BackupJobKind[] {
  const at = (state: BackupJobState<unknown> | null) => !state ? -Infinity : state.state === "running" ? Infinity : Date.parse(state.endedAt) || 0;
  return (["export", "restore"] as const).filter((kind) => jobs[kind] !== null).sort((a, b) => {
    const [x, y] = [at(jobs[a]), at(jobs[b])];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
