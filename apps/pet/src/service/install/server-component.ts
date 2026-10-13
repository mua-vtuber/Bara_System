import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestContext, RuntimePaths } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { MANAGED_ENV_KEYS, PET_UNIT_MARKER, RELEASE_LAYOUT, REMOTE_LAYOUT, STATIC_ENV_KEY, parseRemoteFacts, petUnitEnvironment,
  planRemoteInstall, probeCommand, type InstalledServer, type RemoteBlock, type RemoteHost, type RemoteRequest } from "./remote-probe.ts";
import { ADAPTERS_DIR, SERVER_ADAPTERS_DIR_ENV } from "./adapter-registry.ts";
import { RELEASE_RECORD_FILE, SERVER_COMPONENT, parseReleaseRecord, type ReleaseDraft, type ReleaseRecord } from "./release-record.ts";
import type { ServiceControl, ShellReleaseHost, UnitInstaller } from "./release-host.ts";
import { assertRunning, REPLACE_TIMING, replaceRelease, type ComponentTarget, type ReleaseBundle, type ReplaceOptions, type ReplaceResult,
  type ReplaceTiming } from "./release-swap.ts";
import { sshRun, type RemoteSession } from "./remote-session.ts";
import { safeRemotePath } from "./ssh.ts";
import type { PayloadManifest } from "./runtime.ts";

/** Pre-migration snapshots below the managed data root: `managed-prepare` sets `backup.dir` to `<data>/backups`
 * (apps/setup/src/managed-prepare.ts) and the core keeps them in its `pre-migration` subfolder. */
export const PRE_MIGRATION_DIR = "backups/pre-migration";

/** The memory server offers its dashboard restart button only when this is `1` (apps/memory/src/server-internal/restart-policy.ts
 * `RESTART_ON_EXIT_ENV`): the unit's `Restart=on-failure` starts it again after the restart exit code. A contract between two
 * programs, not shared code. */
export const SERVER_RESTART_ON_EXIT_ENV = "BARA_RESTART_ON_EXIT";
export const SERVER_RESTART_ON_EXIT_VALUE = "1";

/** The Pet's server unit. It runs whatever `current` names, so a replace changes only the link (spec 5.1). */
export function serverUnitText(user: string, serverPath: string, env: Record<string, string>): string {
  const current = `${safeRemotePath(serverPath)}/${REMOTE_LAYOUT.current}`;
  const lines = [PET_UNIT_MARKER, "[Unit]", "Description=Bara Pet Memory", "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", `User=${user}`, `WorkingDirectory=${current}/${RELEASE_LAYOUT.serverDir}`,
    `ExecStart=${current}/${RELEASE_LAYOUT.bun} run ${RELEASE_LAYOUT.serverScript}`, "Restart=on-failure", "RestartSec=5"];
  for (const key of MANAGED_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.remotePrepareInvalid);
    lines.push(`Environment=${key}=${value}`);
  }
  lines.push(`Environment=${STATIC_ENV_KEY}=${current}/${RELEASE_LAYOUT.staticDir}`,
    `Environment=${SERVER_ADAPTERS_DIR_ENV}=${safeRemotePath(serverPath)}/${ADAPTERS_DIR}`,
    `Environment=${SERVER_RESTART_ON_EXIT_ENV}=${SERVER_RESTART_ON_EXIT_VALUE}`, "", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

/** The server release this Pet carries: its source bundle digest and the memory app version inside it. */
export async function bundledServerDraft(paths: RuntimePaths, manifest: PayloadManifest): Promise<ReleaseDraft> {
  const sourceSha = manifest.files["server-source.tar.gz"];
  let version: unknown;
  try { version = (JSON.parse(await readFile(join(paths.resourceDir, "core", "apps", "memory", "package.json"), "utf8")) as { version?: unknown }).version; }
  catch { throw serviceError("PAYLOAD_INVALID", messages.installService.payloadFileMissing); }
  if (typeof version !== "string" || !sourceSha) throw serviceError("PAYLOAD_INVALID", messages.installService.payloadFileMissing);
  return { component: SERVER_COMPONENT, appVersion: version, sourceSha, origin: "pet", commit: null };
}

export type ProbedServer =
  | { kind: "ready"; host: RemoteHost; server: InstalledServer; env: Record<string, string> }
  | { kind: "incomplete" }
  | { kind: "blocked"; block: RemoteBlock };

/** The install's own probe on the saved connection's server path: a complete Pet server (`ready`), one an install has
 * not finished (`incomplete`, left to the install), or a block. */
export async function probeInstalled(session: RemoteSession): Promise<ProbedServer> {
  const { ssh } = session;
  if (!ssh.serverPath) throw serviceError("RELEASE_CONNECTION_INCOMPLETE", messages.releaseErrors.RELEASE_CONNECTION_INCOMPLETE("serverPath"));
  if (ssh.serverPort === undefined) throw serviceError("RELEASE_CONNECTION_INCOMPLETE", messages.releaseErrors.RELEASE_CONNECTION_INCOMPLETE("serverPort"));
  const serverPath = safeRemotePath(ssh.serverPath);
  const request: RemoteRequest = { serverPort: ssh.serverPort, serverPath, savedServerPath: serverPath };
  const facts = parseRemoteFacts(await sshRun(session, probeCommand(request), messages.installSteps.remoteProbe));
  const plan = planRemoteInstall(facts, request);
  if (plan.kind === "blocked") return { kind: "blocked", block: plan.block };
  if (plan.kind === "install") return { kind: "incomplete" };
  return { kind: "ready", host: plan.host, server: plan.server, env: petUnitEnvironment(facts.petEnv) };
}

/** The record of the release `current` names, or null for a server installed before records existed. */
export async function readInstalledRecord(host: ShellReleaseHost, serverPath: string): Promise<ReleaseRecord | null> {
  const path = `${safeRemotePath(serverPath)}/${REMOTE_LAYOUT.current}/${RELEASE_RECORD_FILE}`;
  const text = await host.readText(path);
  return text === null ? null : parseReleaseRecord(text, path);
}

export interface ServerSwapDeps { host: ShellReleaseHost; control: ServiceControl; units: UnitInstaller; user: string }

/** A unit needs writing again when it names a release directory itself (before the link layout) or lacks the adapters
 * variable (before Task 10). Otherwise a replace changes only the link (spec 5.1). */
export function serverUnitNeedsRewrite(probed: Extract<ProbedServer, { kind: "ready" }>): boolean {
  return !probed.server.unitOnLink || probed.env[SERVER_ADAPTERS_DIR_ENV] !== `${probed.host.serverPath}/${ADAPTERS_DIR}` ||
    probed.env[SERVER_RESTART_ON_EXIT_ENV] !== SERVER_RESTART_ON_EXIT_VALUE;
}

/** Replaces the memory server's release (spec 5.2). A unit written before the link layout is rewritten first, once. */
export async function replaceServer(deps: ServerSwapDeps, probed: Extract<ProbedServer, { kind: "ready" }>, bundle: ReleaseBundle,
  ctx: RequestContext, options: ReplaceOptions = {}): Promise<ReplaceResult> {
  const target = serverTarget(probed, deps.control);
  if (serverUnitNeedsRewrite(probed)) await deps.units.install(serverUnitText(deps.user, probed.host.serverPath, probed.env));
  return replaceRelease(deps.host, target, bundle, ctx, options);
}

/** The memory server as a replace target: its port, database and pre-migration snapshot folder under its server path. */
function serverTarget(probed: Extract<ProbedServer, { kind: "ready" }>, control: ServiceControl): ComponentTarget {
  const serverPath = probed.host.serverPath;
  const db = probed.env.MEMORY_DB_PATH;
  if (!db) throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.remotePrepareInvalid);
  return { root: serverPath, control,
    check: { kind: "server", port: probed.server.port, db, snapshotDir: `${serverPath}/${REMOTE_LAYOUT.data}/${PRE_MIGRATION_DIR}`, env: probed.env } };
}

/** Throws `RELEASE_NOT_RUNNING` (with the pre-migration snapshot folder) unless the release `current` names runs and
 * its `/health` answers its recorded version. Never starts the service: an earlier update may have left it stopped on
 * a database whose structure the previous release cannot open. */
export async function assertServerRunning(host: ShellReleaseHost, control: ServiceControl, probed: Extract<ProbedServer, { kind: "ready" }>,
  ctx: RequestContext, timing: ReplaceTiming = REPLACE_TIMING): Promise<void> {
  await assertRunning(host, serverTarget(probed, control), probed.server.release, timing, ctx);
}
