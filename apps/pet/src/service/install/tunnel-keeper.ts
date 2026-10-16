import type { CredentialSnapshot } from "../config.ts";
import { TUNNEL_RECONNECT_FIRST_DELAY_MS, TUNNEL_RECONNECT_MAX_DELAY_MS } from "./limits.ts";

/** Whether the saved connection runs through an SSH tunnel the service keeps open while nothing asks for it: a remote
 * server, or an existing server reached over SSH, with the client token the startup check also requires. External AI
 * apps (Claude Code's bara MCP) reach the server through that tunnel's local port without going through the Pet. */
export function keepsTunnel(snapshot: CredentialSnapshot): boolean {
  return !!snapshot.settings.connection.ssh && !!snapshot.token;
}

/** How one attempt ended: the tunnel is open (`kept`), or the saved connection needs none any more (`unwanted`).
 * An attempt that could not open it throws why. */
export type KeepOutcome = "kept" | "unwanted";
export interface ReconnectDelays { firstMs: number; maxMs: number }
const DEFAULT_DELAYS: ReconnectDelays = { firstMs: TUNNEL_RECONNECT_FIRST_DELAY_MS, maxMs: TUNNEL_RECONNECT_MAX_DELAY_MS };

/** Opens the saved SSH tunnel again on its own after it closed by itself or failed to open, instead of waiting for
 * the next Pet request that needs the server. Each failed attempt doubles the wait up to `maxMs`; a tunnel that
 * opens (by this or by any request) starts the next loss from `firstMs` again. Only one attempt runs at a time, and
 * after `stop` none starts. The last failure is kept until a tunnel opens, so the status line can say why. */
export class TunnelKeeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: { abort: AbortController; done: Promise<void> } | null = null;
  /** A loss reported while an attempt ran: that attempt may have opened the tunnel that was then lost. */
  private lostWhileRunning = false;
  private failures = 0;
  private failure: unknown = null;
  private stopped = false;

  constructor(private readonly attempt: (signal: AbortSignal) => Promise<KeepOutcome>,
    private readonly delays: ReconnectDelays = DEFAULT_DELAYS) {}

  /** The tunnel closed or did not open: try again after the current wait. A wait already set covers it. */
  lost(): void {
    if (this.stopped) return;
    if (this.running) { this.lostWhileRunning = true; return; }
    if (this.timer) return;
    const wait = Math.min(this.delays.firstMs * 2 ** this.failures, this.delays.maxMs);
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, wait);
  }

  /** A tunnel opened: a wait still set is dropped, and the next loss waits `firstMs` again. */
  opened(): void {
    this.failures = 0;
    this.failure = null;
    this.lostWhileRunning = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Why the last attempt failed, while no tunnel has opened since; null otherwise. */
  lastFailure(): unknown {
    return this.failure;
  }

  /** Whether an attempt runs or one is waiting to run. */
  get pending(): boolean {
    return this.running !== null || this.timer !== null;
  }

  private run(): void {
    const abort = new AbortController();
    const running = { abort, done: Promise.resolve() };
    // Marked running before the attempt starts, so a loss it reports itself is counted as one during the attempt.
    this.running = running;
    running.done = Promise.resolve().then(() => this.attempt(abort.signal)).then(
      () => {
        // Open, or not needed any more: either way nothing is failing now (a tunnel another request opened meanwhile
        // is found running, so `opened` is not told again).
        this.failures = 0;
        this.failure = null;
        return false;
      },
      (error: unknown) => {
        if (this.stopped) return false;
        this.failures++;
        this.failure = error;
        return true;
      },
    ).then((failed) => {
      this.running = null;
      const again = failed || this.lostWhileRunning;
      this.lostWhileRunning = false;
      if (again) this.lost();
    });
  }

  /** Quitting: no attempt starts any more, a running one is cancelled and waited for. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const running = this.running;
    running?.abort.abort();
    await running?.done;
  }
}
