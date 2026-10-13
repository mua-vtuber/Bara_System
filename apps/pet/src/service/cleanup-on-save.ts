import type { CleanupOnSaveReport, CleanupOnSaveStatus, PublicSettings, SaveResult } from "../shared/contracts.ts";
import type { CleanupService } from "./cleanup.ts";
import { ServiceError } from "./errors.ts";
import { causeOf } from "./fetch-failure.ts";
import { CLEANUP_ON_SAVE_TIMEOUT_MS } from "./operation-limits.ts";
import { messages } from "../ui/messages.ts";

/** "입력한 메모 바로 정리": runs after a save without holding the save's request. A failure never touches the
 * saved memo; the server's cleanup cycle processes the memo later because nothing was recorded for it.
 * Nothing here throws into the save or out of the detached run: every failure, including an unreadable
 * settings file, becomes a result the settings screen shows. */
export type CleanupOnSaveSettings = Pick<PublicSettings, "cleanupOnSave" | "cleanup">;

/** The memo a finished save asks to be cleaned up, or null. An entity patch has no origin memo; a server older
 * than the entity patch omits `resultType`, which still means a normal memo. */
export function cleanupOnSaveTarget(saved: SaveResult): number | null {
  if (saved.state !== "saved" || !saved.memory || saved.resultType === "entity_patch") return null;
  return saved.memory.id;
}

/** Runs go one at a time in save order, so quick saves never start parallel AI calls, and a memo already waiting
 * or running is not queued again. Two records are kept: `latest` (the newest result) and `lastFailure` (the newest
 * failed result), which a later success does not erase -- it stays on the settings screen until a newer failure
 * replaces it, so a success never hides an earlier failure. */
export class CleanupOnSave {
  private latest: CleanupOnSaveStatus | null = null;
  private failure: CleanupOnSaveStatus | null = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<number>();
  private readonly running = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly readSettings: () => Promise<CleanupOnSaveSettings>,
    private readonly cleanup: Pick<CleanupService, "runForMemo">,
    private readonly now: () => Date = () => new Date(),
    private readonly timeoutMs: number = CLEANUP_ON_SAVE_TIMEOUT_MS,
  ) {}

  start(memoryId: number): void {
    if (this.closed || this.queued.has(memoryId)) return;
    this.queued.add(memoryId);
    // run() records its own failures; the catch only keeps an unexpected rejection from stalling the queue.
    this.tail = this.tail
      .then(() => this.run(memoryId))
      .catch((error: unknown) => this.record(memoryId, "failed", this.cause(error)))
      .finally(() => { this.queued.delete(memoryId); });
  }

  last(): CleanupOnSaveStatus | null { return this.latest; }
  lastFailure(): CleanupOnSaveStatus | null { return this.failure; }
  report(): CleanupOnSaveReport { return { latest: this.latest, lastFailure: this.failure }; }

  /** Stops what runs and refuses new work; a stop at shutdown is not recorded as a failure of the memo's cleanup. */
  close(): void {
    this.closed = true;
    for (const c of this.running) c.abort();
    this.running.clear();
  }

  private record(memoryId: number, outcome: CleanupOnSaveStatus["outcome"], detail: string): void {
    const status = { memoryId, at: this.now().toISOString(), outcome, detail };
    this.latest = status;
    if (outcome === "failed") this.failure = status;
  }

  private cause(error: unknown): string {
    return error instanceof ServiceError ? error.publicMessage : causeOf(error);
  }

  private async run(memoryId: number): Promise<void> {
    if (this.closed) return;
    let settings: CleanupOnSaveSettings;
    try { settings = await this.readSettings(); }
    catch (error) { this.record(memoryId, "failed", this.cause(error)); return; }
    if (!settings.cleanupOnSave || this.closed) return;
    if (settings.cleanup.provider === "none") {
      this.record(memoryId, "skipped", messages.cleanupService.pickCleanupAi);
      return;
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    this.running.add(controller);
    try {
      const result = await this.cleanup.runForMemo(memoryId, controller.signal);
      const failures = result.failures ?? [];
      // Every stage skipped (an older server without the stage, a failed candidate list) did no cleanup at all.
      if (result.submitted + result.noFinding === 0 && failures.length > 0) this.record(memoryId, "failed", failures[0]!.message);
      else this.record(memoryId, "done", messages.settings.cleanupOnSaveDone(result.submitted, failures.length));
    } catch (error) {
      if (this.closed && !timedOut) return;
      this.record(memoryId, "failed", timedOut ? messages.settings.cleanupOnSaveTimedOut : this.cause(error));
    } finally {
      clearTimeout(timer);
      this.running.delete(controller);
    }
  }
}
