import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { READY_REQUEST_TIMEOUT_MS, REMOTE_DEPENDENCIES_TIMEOUT_MS, REMOTE_EXTRACT_TIMEOUT_MS, REMOTE_SERVICE_TIMEOUT_MS,
  SSH_COMMAND_TIMEOUT_MS } from "./limits.ts";
import { scpFile, sshRun, sshRunIdle, type RemoteSession } from "./remote-session.ts";
import { remoteCommand, safeRemotePath, shQuote } from "./ssh.ts";
import { dependencyInstallScript } from "./remote-probe.ts";

export type ShellLimit = { timeoutMs: number } | { idleTimeoutMs: number };
/** Runs POSIX sh scripts on a host and puts files there; returns stdout, trimmed. Production: SSH (`sshTransport`).
 * Tests: the local `sh` (`test-utils/local-host.ts`), so every script below runs for real in both. */
export interface ShellTransport {
  run(script: string, stepName: string, limit: ShellLimit): Promise<string>;
  send(localFile: string, remotePath: string, timeoutMs?: number): Promise<void>;
}

export function sshTransport(s: RemoteSession): ShellTransport {
  return {
    run: (script, stepName, limit) => "idleTimeoutMs" in limit
      ? sshRunIdle(s, script, limit.idleTimeoutMs, stepName) : sshRun(s, script, stepName, limit.timeoutMs),
    send: (localFile, remotePath, timeoutMs) => scpFile(s, localFile, remotePath, timeoutMs),
  };
}

const steps = messages.releaseSteps;
function unreadable(step: string): Error {
  return serviceError("RELEASE_STEP_OUTPUT_INVALID", messages.releaseErrors.RELEASE_STEP_OUTPUT_INVALID(step));
}
/** `bun -e` source printing the highest applied schema version of the SQLite file at `db`, opened read-only. */
function schemaScript(db: string): string {
  return `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(db)}, { readonly: true });` +
    ` try { const row = db.query("SELECT MAX(version) AS v FROM schema_version").get(); console.log(JSON.stringify(row?.v ?? null)); }` +
    ` finally { db.close(); }`;
}
/** `bun -e` source printing the loopback server's `/health` body, or `null` when no 2xx JSON answer came in time. */
function healthScript(port: number): string {
  return `fetch("http://127.0.0.1:${port}/health", { signal: AbortSignal.timeout(${READY_REQUEST_TIMEOUT_MS}) })` +
    `.then(async (r) => console.log(r.ok ? JSON.stringify(await r.json()) : "null"), () => console.log("null"));`;
}

export interface HealthReport { ok: boolean; version: string | null }

/** Every file operation the install and the replace procedure do on a host, as one sh script each. Paths go through
 * `safeRemotePath`, values through `shQuote`, so no input becomes code. */
export class ShellReleaseHost {
  constructor(readonly shell: ShellTransport) {}

  private ask(script: string, stepName: string, timeoutMs = SSH_COMMAND_TIMEOUT_MS): Promise<string> {
    return this.shell.run(script, stepName, { timeoutMs });
  }

  async exists(path: string): Promise<boolean> {
    const q = shQuote(safeRemotePath(path));
    return (await this.ask(`if test -e ${q} || test -L ${q}; then printf yes; else printf no; fi`, steps.inspect)) === "yes";
  }

  async readText(path: string): Promise<string | null> {
    const q = shQuote(safeRemotePath(path));
    const out = await this.ask(`if test -f ${q}; then printf 'present:'; cat ${q}; else printf missing; fi`, steps.inspect);
    if (out === "missing") return null;
    if (!out.startsWith("present:")) throw unreadable(steps.inspect);
    return out.slice("present:".length);
  }

  async writeText(path: string, text: string): Promise<void> {
    const target = safeRemotePath(path);
    await this.ask(`printf '%s' ${shQuote(text)} > ${shQuote(`${target}.tmp`)} && mv -f ${shQuote(`${target}.tmp`)} ${shQuote(target)}`, steps.writeFile);
  }

  async makeDir(path: string): Promise<void> { await this.ask(remoteCommand(["mkdir", "-p", safeRemotePath(path)]), steps.makeDir); }
  /** A directory only its owner can enter (mode 700), also when it already existed with looser rights. */
  async makePrivateDir(path: string): Promise<void> {
    const dir = safeRemotePath(path);
    await this.ask(`${remoteCommand(["mkdir", "-p", dir])} && ${remoteCommand(["chmod", "700", dir])}`, steps.makeDir);
  }
  async removeTree(path: string): Promise<void> { await this.ask(remoteCommand(["rm", "-rf", "--", safeRemotePath(path)]), steps.removeDir); }

  /** The real (non-link) directories in `path`; [] only when `path` does not exist. A path that is something else, or a
   * directory that cannot be read, is an error (`ls` reports the real cause), never an empty list. */
  async listDirs(path: string): Promise<string[]> {
    const target = safeRemotePath(path);
    const q = shQuote(target);
    const out = await this.ask(`if test -d ${q}; then ls -A -- ${q} >/dev/null || exit 1; printf 'dirs:\\n'; ` +
      `for d in ${q}/*; do if test -d "$d" && ! test -L "$d"; then printf '%s\\n' "\${d##*/}"; fi; done; ` +
      `elif test -e ${q} || test -L ${q}; then printf notdir; else printf 'dirs:\\n'; fi`, steps.listDirs);
    if (out === "notdir") throw serviceError("RELEASE_NOT_DIRECTORY", messages.releaseErrors.RELEASE_NOT_DIRECTORY(target));
    if (!out.startsWith("dirs:")) throw unreadable(steps.listDirs);
    return out.slice("dirs:".length).split("\n").filter(Boolean);
  }

  upload(localFile: string, remotePath: string, timeoutMs?: number): Promise<void> {
    return this.shell.send(localFile, safeRemotePath(remotePath), timeoutMs);
  }

  /** `timeoutMs` defaults to a release bundle's size; a larger archive (a backup) passes its own limit. */
  async sha256(path: string, timeoutMs = SSH_COMMAND_TIMEOUT_MS): Promise<string> {
    const digest = (await this.ask(remoteCommand(["sha256sum", safeRemotePath(path)]), steps.digest, timeoutMs)).split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{64}$/.test(digest)) throw unreadable(steps.digest);
    return digest;
  }

  /** Replaces `into` with the archive's contents. Called only for a release directory that is neither running nor complete,
   * or for the incoming folder a backup is unpacked into. `timeoutMs` defaults to a release bundle's size. */
  async extract(archive: string, into: string, timeoutMs = REMOTE_EXTRACT_TIMEOUT_MS): Promise<void> {
    const dir = safeRemotePath(into);
    await this.ask(`${remoteCommand(["rm", "-rf", "--", dir])} && ${remoteCommand(["mkdir", "-p", dir])} && ` +
      remoteCommand(["tar", "-xzf", safeRemotePath(archive), "-C", dir]), steps.extract, timeoutMs);
  }

  async installRuntime(bunFile: string, release: string): Promise<void> {
    const bun = `${safeRemotePath(release)}/bun`;
    await this.ask(`${remoteCommand(["cp", safeRemotePath(bunFile), bun])} && ${remoteCommand(["chmod", "700", bun])}`, steps.runtime);
  }

  async installFile(source: string, target: string, mode: "600" | "644"): Promise<void> {
    await this.ask(remoteCommand(["install", "-m", mode, safeRemotePath(source), safeRemotePath(target)]), steps.installFile);
  }

  async installDependencies(release: string): Promise<void> {
    await this.ask(dependencyInstallScript(safeRemotePath(release)), steps.dependencies, REMOTE_DEPENDENCIES_TIMEOUT_MS);
  }

  /** The link's target, or null when there is no link (a missing `current` honestly means "nothing installed yet"). */
  async readLink(link: string): Promise<string | null> {
    const q = shQuote(safeRemotePath(link));
    const out = await this.ask(`if test -L ${q}; then readlink ${q}; fi`, steps.inspect);
    return out === "" ? null : out;
  }

  /** Points `link` at `target` in one rename, so the link never names nothing. */
  async pointLink(link: string, target: string): Promise<void> {
    const next = `${safeRemotePath(link)}.next`;
    await this.ask(`${remoteCommand(["ln", "-sfn", safeRemotePath(target), next])} && ${remoteCommand(["mv", "-Tf", next, safeRemotePath(link)])}`, steps.link);
  }

  /** True once taken, false only when the lock directory already exists. Any other `mkdir` failure (missing parent,
   * permission, read-only file system, a file in the way) fails the step with `mkdir`'s own message as its stderr. */
  async lock(dir: string): Promise<boolean> {
    const q = shQuote(safeRemotePath(dir));
    const out = await this.ask(`if err=$(mkdir ${q} 2>&1); then printf locked; elif test -d ${q}; then printf busy; ` +
      `else printf '%s\\n' "$err" >&2; exit 1; fi`, steps.lock);
    if (out !== "locked" && out !== "busy") throw unreadable(steps.lock);
    return out === "locked";
  }
  async unlock(dir: string): Promise<void> { await this.ask(remoteCommand(["rmdir", safeRemotePath(dir)]), steps.lock); }

  async schemaVersion(bun: string, db: string): Promise<number | null> {
    const file = safeRemotePath(db);
    const out = await this.ask(`if test -f ${shQuote(file)}; then ${remoteCommand([safeRemotePath(bun), "-e", schemaScript(file)])}; else printf null; fi`, steps.schemaRead);
    if (out === "null") return null;
    const value = Number(out);
    if (!Number.isSafeInteger(value) || value < 0) throw unreadable(steps.schemaRead);
    return value;
  }

  async health(bun: string, port: number): Promise<HealthReport | null> {
    const out = await this.ask(remoteCommand([safeRemotePath(bun), "-e", healthScript(port)]), steps.health);
    let body: unknown;
    try { body = JSON.parse(out); } catch { throw unreadable(steps.health); }
    if (body === null) return null;
    const value = body as { ok?: unknown; version?: unknown };
    return { ok: value.ok === true, version: typeof value.version === "string" ? value.version : null };
  }
}

export interface ServiceState { active: string; restarts: number }
/** Stops and starts one component's long-running process. Production: `SystemdControl`. Tests: `ProcessControl`. */
export interface ServiceControl { stop(): Promise<void>; start(): Promise<void>; state(): Promise<ServiceState> }
/** Registers or removes the unit file a `ServiceControl` runs. */
export interface UnitInstaller { install(text: string): Promise<void>; remove(): Promise<void>; exists(): Promise<boolean> }

/** Where systemd reads the unit files the Pet and `deploy:a1` register. */
export const SYSTEM_UNIT_DIR = "/etc/systemd/system";

/** `systemctl show -p ActiveState --value` and `-p NRestarts --value`, one per line. */
export function parseServiceState(text: string): ServiceState {
  const [active = "", restarts = ""] = text.split(/\r?\n/);
  if (!/^[a-z-]{1,32}$/.test(active) || !/^\d{1,9}$/.test(restarts)) throw unreadable(steps.serviceState);
  return { active, restarts: Number(restarts) };
}

/** A unit file name `SystemdControl` accepts: no path separator, so it can only name a file in `SYSTEM_UNIT_DIR`. */
const UNIT_NAME = /^[A-Za-z0-9@._-]+\.service$/;

export class SystemdControl implements ServiceControl, UnitInstaller {
  constructor(private readonly shell: ShellTransport, readonly unit: string, private readonly elevated: boolean,
    private readonly staging: { scratchDir: string; remoteIncoming: string }) {
    if (!UNIT_NAME.test(unit)) throw serviceError("RELEASE_UNIT_INVALID", messages.releaseErrors.RELEASE_UNIT_INVALID(unit));
  }

  private get ctl(): string { return this.elevated ? "sudo -n systemctl" : "systemctl"; }
  private get sudo(): string { return this.elevated ? "sudo -n " : ""; }
  private run(script: string, stepName: string): Promise<string> {
    return this.shell.run(script, stepName, { timeoutMs: REMOTE_SERVICE_TIMEOUT_MS });
  }

  async stop(): Promise<void> { await this.run(`${this.ctl} stop ${shQuote(this.unit)}`, steps.serviceStop); }

  async start(): Promise<void> {
    const u = shQuote(this.unit);
    await this.run(`${this.ctl} enable ${u} >/dev/null && { ${this.ctl} reset-failed ${u} >/dev/null 2>&1 || true; } && ${this.ctl} restart ${u}`, steps.serviceStart);
  }

  async state(): Promise<ServiceState> {
    const u = shQuote(this.unit);
    return parseServiceState(await this.run(`systemctl show -p ActiveState --value ${u}; systemctl show -p NRestarts --value ${u}`, steps.serviceState));
  }

  async exists(): Promise<boolean> {
    return (await this.run(`if systemctl cat ${shQuote(this.unit)} >/dev/null 2>&1; then printf yes; else printf no; fi`, steps.serviceState)) === "yes";
  }

  async install(text: string): Promise<void> {
    await mkdir(this.staging.scratchDir, { recursive: true });
    const local = join(this.staging.scratchDir, `unit-${randomUUID()}.service`);
    const incoming = safeRemotePath(this.staging.remoteIncoming);
    const remote = `${incoming}/${this.unit}`;
    try {
      await writeFile(local, text, { mode: 0o600 });
      await this.shell.run(remoteCommand(["mkdir", "-p", incoming]), steps.unitInstall, { timeoutMs: SSH_COMMAND_TIMEOUT_MS });
      await this.shell.send(local, remote);
    } finally { await Bun.file(local).delete().catch(() => {}); }
    await this.run(`${this.sudo}install -m 0644 ${shQuote(remote)} ${shQuote(`${SYSTEM_UNIT_DIR}/${this.unit}`)} && ${this.ctl} daemon-reload`, steps.unitInstall);
  }

  async remove(): Promise<void> {
    const u = shQuote(this.unit);
    await this.run(`{ ${this.ctl} disable --now ${u} >/dev/null 2>&1 || true; } && ${this.sudo}rm -f ${shQuote(`${SYSTEM_UNIT_DIR}/${this.unit}`)} && ${this.ctl} daemon-reload`, steps.unitRemove);
  }
}
