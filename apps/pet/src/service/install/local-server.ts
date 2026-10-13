import type { RequestContext } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { LOCAL_SERVER_READY_TIMEOUT_MS } from "./limits.ts";
import { readyTimeout, waitForClient } from "./net.ts";
import { inspectListener, waitForSoleListener, type OwnershipFailures } from "./port-owner.ts";
import { isRunning, spawnResident, stopProcess } from "./process.ts";

export interface LocalServerLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Fixed in the core settings file written at install, so a busy port is reported, never moved. */
  port: number;
  token: string;
  audience: string;
  ctx: RequestContext;
}

function portTaken(port: number, others: readonly number[]): Error {
  return serviceError("INSTALL_PORT_TAKEN", messages.installService.localPortTaken(port, others));
}

function ownershipFailures(port: number): OwnershipFailures {
  return {
    exited: () => serviceError("INSTALL_SERVER_EXITED", messages.installService.localServerExited),
    taken: (others) => portTaken(port, others),
    // Never the sole listener, so no request was sent: the same timeout as the readiness wait, no answer.
    unverified: () => readyTimeout("INSTALL_SERVER_TIMEOUT", LOCAL_SERVER_READY_TIMEOUT_MS, null),
  };
}

/** The Pet-managed memory server on this PC. The bearer token reaches the port only after the OS
 * listener table shows this object's own child process as the port's only listener. */
export class LocalServer {
  private child: Bun.Subprocess | null = null;
  /** Port and audience the running child was verified for: sole listener and authenticated ready. */
  private verified: { port: number; audience: string } | null = null;
  private starting: Promise<void> | null = null;

  async ensure(launch: LocalServerLaunch): Promise<void> {
    while (this.starting) await Promise.allSettled([this.starting]);
    launch.ctx.signal.throwIfAborted();
    // A verified child holds its listener until it exits; an exited child fails this check and
    // the next start verifies ownership again before any token is sent.
    if (this.serves(launch.port, launch.audience)) return;
    const starting = this.start(launch);
    this.starting = starting;
    try { await starting; } finally { if (this.starting === starting) this.starting = null; }
  }

  async close(): Promise<void> {
    await this.retire();
  }

  /** True while the child verified for this port and audience (sole listener, authenticated ready) runs.
   * Callers use it to skip the per-start preparation of a server that is already serving. */
  serves(port: number, audience: string): boolean {
    return this.child !== null && isRunning(this.child) &&
      this.verified?.port === port && this.verified.audience === audience;
  }

  /** Stop the current child (exited, or verified for another port or audience) and wait until it
   * has released its port and data folder. */
  private async retire(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.verified = null;
    if (!child) return;
    stopProcess(child);
    await child.exited;
  }

  private async start({ argv, cwd, env, port, token, audience, ctx }: LocalServerLaunch): Promise<void> {
    await this.retire();
    const before = await inspectListener(port, ctx.signal);
    if (before.kind !== "none") throw portTaken(port, before.kind === "other" ? before.others : []);
    ctx.signal.throwIfAborted();
    const child = spawnResident(argv, { cwd, env });
    this.child = child;
    const failures = ownershipFailures(port);
    const halt = new AbortController();
    const signal = AbortSignal.any([ctx.signal, halt.signal]);
    const deadline = Date.now() + LOCAL_SERVER_READY_TIMEOUT_MS;
    try {
      // Every authenticated request, the first one included, waits for a fresh sole-listener check.
      await Promise.race([
        waitForClient(`http://127.0.0.1:${port}`, token, signal, { timeoutMs: LOCAL_SERVER_READY_TIMEOUT_MS,
          timeoutCode: "INSTALL_SERVER_TIMEOUT",
          beforeRequest: () => waitForSoleListener(child, port, signal, deadline - Date.now(), failures) }),
        child.exited.then(() => { throw failures.exited(); }),
      ]);
      ctx.signal.throwIfAborted();
    } catch (error) {
      halt.abort();
      if (this.child === child) this.child = null;
      stopProcess(child);
      await child.exited;
      throw error;
    }
    if (this.child === child) this.verified = { port, audience };
  }
}
