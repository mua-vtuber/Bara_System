import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRunning, runCaptured, stopProcess } from "../process.ts";
import type { ServiceControl, ServiceState, ShellTransport, UnitInstaller } from "../release-host.ts";

// Second, real implementations used by tests only (Linux/WSL). Production code never imports this folder.

/** The local `sh` as a `ShellTransport`: the very scripts the SSH transport sends, run on this machine's files.
 * `send` copies the file where `scp` would have put it. */
export function localTransport(signal: AbortSignal = new AbortController().signal): ShellTransport {
  return {
    run: async (script, stepName, limit) => (await runCaptured(["sh", "-c", script], { signal }, { stepName, ...limit })).stdout.trim(),
    send: async (localFile, remotePath) => { await mkdir(dirname(remotePath), { recursive: true }); await copyFile(localFile, remotePath); },
  };
}

/** A `bun` file a release can carry in tests: a shell script that runs this test's own Bun. */
export async function writeBunWrapper(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "bun");
  await writeFile(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  return path;
}

/** Runs a component the way its unit does: `<root>/current/bun <args>` in `<root>/current/<workDir>`, resolving
 * `current` at each start as systemd does. The process is real; its state is whether it still runs. */
export class ProcessControl implements ServiceControl {
  private child: Bun.Subprocess | null = null;
  private restarts = 0;
  private pendingRestart: ReturnType<typeof setTimeout> | null = null;
  /** `restartOnFailure`: like a unit's `Restart=on-failure`, a process that ends other than with exit 0 is started again
   * after `restartDelayMs` (the unit's `RestartSec`, default 0) and counted in `restarts` (systemd's `NRestarts`, reset
   * by an explicit start). */
  constructor(private readonly spec: { root: string; workDir: string; args: string[]; env: Record<string, string>;
    restartOnFailure?: boolean; restartDelayMs?: number }) {}

  get pid(): number | null { return this.child && isRunning(this.child) ? this.child.pid : null; }

  async start(): Promise<void> {
    await this.stop();
    this.restarts = 0;
    this.spawn();
  }

  private spawn(): void {
    const current = join(this.spec.root, "current");
    const child = Bun.spawn([join(current, "bun"), ...this.spec.args], { cwd: join(current, this.spec.workDir),
      env: { ...process.env, ...this.spec.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      onExit: (exited, exitCode) => {
        // A stop clears `child` first, so only a process that ended by itself while still the current one restarts.
        if (!this.spec.restartOnFailure || this.child !== exited || exitCode === 0) return;
        this.pendingRestart = setTimeout(() => {
          this.pendingRestart = null;
          if (this.child !== exited) return;
          this.restarts += 1;
          this.spawn();
        }, this.spec.restartDelayMs ?? 0);
      } });
    this.child = child;
  }

  async stop(): Promise<void> {
    if (this.pendingRestart !== null) { clearTimeout(this.pendingRestart); this.pendingRestart = null; }
    const child = this.child;
    this.child = null;
    if (!child || !isRunning(child)) return;
    stopProcess(child);
    await child.exited;
  }

  async state(): Promise<ServiceState> {
    if (!this.child) return { active: "inactive", restarts: this.restarts };
    if (isRunning(this.child)) return { active: "active", restarts: this.restarts };
    // Between a failed exit and its restart systemd shows `activating` (auto-restart), not `failed`.
    return { active: this.spec.restartOnFailure && this.child.exitCode !== 0 ? "activating" : "failed", restarts: this.restarts };
  }
}

/** Keeps the unit text in a file, where `SystemdControl` would install it under /etc/systemd/system. */
export class FileUnitInstaller implements UnitInstaller {
  constructor(private readonly path: string) {}
  async install(text: string): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); await writeFile(this.path, text); }
  async remove(): Promise<void> { await rm(this.path, { force: true }); }
  async exists(): Promise<boolean> { return (await this.read()) !== null; }
  async read(): Promise<string | null> { return readFile(this.path, "utf8").catch(() => null); }
}
