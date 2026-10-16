import { join } from "node:path";
import type { HostInspection, RemoteInstallInput, RequestContext, RuntimePaths, SshConnection } from "../../shared/contracts.ts";
import { CORE_DEFAULT_PORT } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { tunnelPort, validateSsh } from "../validation.ts";
import { spawnResident } from "./process.ts";
import type { PayloadManifest } from "./runtime.ts";
import { envPrefix, findSshTools, remoteCommand, safeRemotePath, scanHost, shQuote, sshBase, trustHost, type SshTools } from "./ssh.ts";
import { RELEASE_COMPLETE_MARKER, RELEASE_RECORD_FILE, releaseRecordText } from "./release-record.ts";
import { ShellReleaseHost, SystemdControl, sshTransport } from "./release-host.ts";
import { bundledServerDraft, serverUnitText } from "./server-component.ts";
import { scpFile, sshRun, sshRunIdle, type RemoteSession as Session } from "./remote-session.ts";
import { clientTokenFailure } from "./client-token-failure.ts";
import { restoreAndSwap, uploadForRestore, type RemoteRestoreRun, type RemoteRestoreSource } from "./remote-restore.ts";
import { CORE_CLI, MANAGED_ENV_KEYS, MANAGED_HOST, MANAGED_PATH_KEYS, PET_SERVICE_UNIT, RELEASE_LAYOUT, REMOTE_LAYOUT,
  assertServiceStarted, dependencyInstallScript, parseRemoteFacts, planRemoteInstall, probeCommand, remoteBlockError, serviceStartCommand,
  type InstalledServer, type RemoteHost, type RemoteRequest } from "./remote-probe.ts";
import { INSTALL_MODEL_DICTIONARY_TIMEOUT_MS, INSTALL_PREPARE_TIMEOUT_MS, MODEL_PREFETCH_IDLE_MS,
  REMOTE_DEPENDENCIES_TIMEOUT_MS, REMOTE_EXTRACT_TIMEOUT_MS, REMOTE_SERVICE_ACTIVE_WAIT_MS, REMOTE_SERVICE_TIMEOUT_MS,
  REMOTE_TOKEN_TIMEOUT_MS, TUNNEL_KEEPALIVE_INTERVAL_S, TUNNEL_KEEPALIVE_MAX_MISSED } from "./limits.ts";

interface Tokens { clientToken: string; ownerToken: string }
/** What an install run did with the server it found. */
export type RemoteOutcome = "installed" | "repaired" | "connected";
/** A remote server ready for the Pet: its SSH route (verified fingerprint, server path and port), the tools and
 * trusted host file that reach it, and the Pet's token pair read from it. No tunnel is open yet. */
export interface PreparedRemote { ssh: SshConnection; tools: SshTools; knownHosts: string; tokens: Tokens; outcome: RemoteOutcome;
  /** Set when "백업에서 시작" swapped a backup in on this run; `replaced` is the server folder that keeps the empty
   * database and attachment folder this install made first. */
  restored?: { backupName: string; replaced: string } }
interface Installed { tokens: Tokens; replaced: string | null }

export async function inspectRemote(input: SshConnection, paths: RuntimePaths, ctx: RequestContext): Promise<HostInspection> {
  const scanned = await scanHost(findSshTools(), validateSsh(input), paths.dataDir, ctx);
  return { fingerprint: scanned.fingerprint, host: scanned.host, keyType: scanned.keyType, known: scanned.known };
}

function managedEnv(raw: unknown, data: string, port: number): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.remotePrepareInvalid);
  const env = raw as Record<string, unknown>;
  // `managed-prepare` keeps the port of an existing data folder, so resuming with another port ends here.
  if (typeof env.MEMORY_PORT === "string" && /^\d{1,5}$/.test(env.MEMORY_PORT) && env.MEMORY_PORT !== String(port))
    throw remoteBlockError({ code: "REMOTE_PORT_MISMATCH", installed: Number(env.MEMORY_PORT), requested: port });
  if (Object.keys(env).sort().join(",") !== [...MANAGED_ENV_KEYS].sort().join(",") || env.MEMORY_HOST !== MANAGED_HOST ||
      env.MEMORY_PORT !== String(port) || typeof env.TZ !== "string" || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(env.TZ))
    throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.remotePrepareInvalid);
  for (const key of MANAGED_PATH_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || !safeRemotePath(value).startsWith(`${data}/`))
      throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.remoteDataPathMismatch);
  }
  return env as Record<string, string>;
}

function parseTokens(output: string): Tokens {
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw serviceError("REMOTE_TOKEN_FAILED", messages.installService.remoteTokenRecoveryFailed); }
  const tokens = value as { clientToken?: unknown; ownerToken?: unknown };
  if (!tokens || typeof tokens.clientToken !== "string" || typeof tokens.ownerToken !== "string" ||
      tokens.clientToken.length < 32 || tokens.ownerToken.length < 32)
    throw serviceError("REMOTE_TOKEN_FAILED", messages.installService.remoteTokenInvalid);
  return { clientToken: tokens.clientToken, ownerToken: tokens.ownerToken };
}

function systemctl(host: RemoteHost): string { return host.elevated ? "sudo -n systemctl" : "systemctl"; }

/** Enable and restart the Pet's unit, then require it to report `active` and enabled. The error carries
 * the unit's states only, never its log. */
async function startService(s: Session, host: RemoteHost): Promise<void> {
  assertServiceStarted(await sshRun(s, serviceStartCommand(systemctl(host), Math.ceil(REMOTE_SERVICE_ACTIVE_WAIT_MS / 1000)),
    messages.installSteps.remoteServiceStart, REMOTE_SERVICE_TIMEOUT_MS));
}

/** Read back the Pet's token pair from the token file the running unit uses. It mints nothing and
 * writes nothing (apps/setup/PET-INTEGRATION.md `--read-existing`). */
async function readTokens(s: Session, server: InstalledServer): Promise<Tokens> {
  const readable = await sshRun(s, `if test -r ${shQuote(server.tokenFile)}; then printf readable; else printf missing; fi`, messages.installSteps.remoteTokenFileCheck);
  if (readable !== "readable") throw serviceError("REMOTE_TOKENS_MISSING", messages.connectionErrors.REMOTE_TOKENS_MISSING);
  return parseTokens(await sshRun(s, `cd ${shQuote(server.release)} && ` +
    remoteCommand([`${server.release}/${RELEASE_LAYOUT.bun}`, CORE_CLI.clientToken, "--url", `http://${MANAGED_HOST}:${server.port}/`,
      "--tokens-file", server.tokenFile, "--read-existing"]), messages.installSteps.remoteCredentialsRead, REMOTE_TOKEN_TIMEOUT_MS, clientTokenFailure));
}

/** The idempotent install steps. Each can run again over a partial install of the same path: files are
 * replaced with the same content, `managed-prepare` keeps an existing database and settings, and an existing
 * token file is read back instead of issued again. The complete marker is written only once the unit runs. */
async function installServer(s: Session, host: RemoteHost, port: number, manifest: PayloadManifest,
  paths: RuntimePaths, source?: RemoteRestoreSource): Promise<Installed> {
  const { ctx } = s;
  const sourceSha = manifest.files["server-source.tar.gz"]!;
  const release = safeRemotePath(`${host.serverPath}/${REMOTE_LAYOUT.releases}/${sourceSha.slice(0, REMOTE_LAYOUT.releaseIdLength)}`);
  const incoming = safeRemotePath(`${host.serverPath}/${REMOTE_LAYOUT.incoming}`);
  const data = safeRemotePath(`${host.serverPath}/${REMOTE_LAYOUT.data}`);
  const bun = `${release}/${RELEASE_LAYOUT.bun}`;
  ctx.progress("transfer");
  await sshRun(s, `mkdir -p ${shQuote(incoming)} ${shQuote(release)} ${shQuote(data)} && ` +
    `printf 'bara-pet-v1\\n' > ${shQuote(`${host.serverPath}/${REMOTE_LAYOUT.ownedMarker}`)}`, messages.installSteps.remoteInstallDirPrepare);
  await scpFile(s, join(paths.resourceDir, "server-source.tar.gz"), `${incoming}/source.tar.gz`);
  await scpFile(s, join(paths.resourceDir, "linux", `bun-${host.arch}`), `${incoming}/bun`);
  const sourceDigest = (await sshRun(s, remoteCommand(["sha256sum", `${incoming}/source.tar.gz`]), messages.installSteps.transferVerify)).split(/\s+/)[0];
  const bunDigest = (await sshRun(s, remoteCommand(["sha256sum", `${incoming}/bun`]), messages.installSteps.transferVerify)).split(/\s+/)[0];
  if (sourceDigest !== sourceSha || bunDigest !== manifest.files[`linux/bun-${host.arch}`])
    throw serviceError("REMOTE_DIGEST_MISMATCH", messages.installService.remoteDigestMismatch);
  await sshRun(s, `${remoteCommand(["tar", "-xzf", `${incoming}/source.tar.gz`, "-C", release])} && ` +
    `${remoteCommand(["cp", `${incoming}/bun`, bun])} && ${remoteCommand(["chmod", "700", bun])}`, messages.installSteps.extract, REMOTE_EXTRACT_TIMEOUT_MS);
  ctx.progress("dependencies");
  await sshRun(s, dependencyInstallScript(release), messages.installSteps.dependencies, REMOTE_DEPENDENCIES_TIMEOUT_MS);
  const files = new ShellReleaseHost(sshTransport(s));
  // The same record and marker a replace writes (release-swap.ts), so a later update can compare and reuse this release.
  await files.writeText(`${release}/${RELEASE_RECORD_FILE}`, releaseRecordText(await bundledServerDraft(paths, manifest), new Date()));
  await files.writeText(`${release}/${RELEASE_COMPLETE_MARKER}`, "complete\n");
  const control = new SystemdControl(sshTransport(s), PET_SERVICE_UNIT, host.elevated,
    { scratchDir: join(paths.dataDir, "ssh"), remoteIncoming: incoming });
  // spec 4.2 step 2: the chosen backup goes up before the data folder is prepared.
  const restoreRun: RemoteRestoreRun | null = source
    ? { shell: sshTransport(s), host: files, release, data, incoming, scratchDir: join(paths.dataDir, "ssh"), ctx } : null;
  const restorePlan = source && restoreRun ? await uploadForRestore(restoreRun, source) : null;
  ctx.progress("models");
  const preparedText = await sshRun(s,
    `cd ${shQuote(release)} && ${remoteCommand([bun, CORE_CLI.prepare, "--data-dir", data, "--port", String(port)])}`, messages.installSteps.serverDataPrepare, INSTALL_PREPARE_TIMEOUT_MS);
  let prepared: unknown;
  try { prepared = JSON.parse(preparedText); }
  catch { throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.remotePrepareUnreadable); }
  const env = managedEnv(prepared && typeof prepared === "object" ? (prepared as { env?: unknown }).env : undefined, data, port);
  await sshRun(s, `cd ${shQuote(release)} && ${envPrefix(env)} ${remoteCommand([bun, CORE_CLI.models, "--model-dir", env.BARA_KIWI_MODEL_DIR!])}`,
    messages.installSteps.koreanDictionary, INSTALL_MODEL_DICTIONARY_TIMEOUT_MS);
  // Idle, not total: see limits.ts MODEL_PREFETCH_IDLE_MS.
  await sshRunIdle(s, `cd ${shQuote(release)} && ${envPrefix(env)} ${remoteCommand([bun, CORE_CLI.prefetch])}`,
    MODEL_PREFETCH_IDLE_MS, messages.installSteps.modelDownload);
  // spec 4.2 steps 4 and 5: restore over the empty database `managed-prepare` just made, then swap it in. An earlier
  // attempt's unit is stopped first; the service starts below only after every later step succeeded (spec 4.3).
  const swapped = source && restoreRun && restorePlan
    ? await restoreAndSwap(restoreRun, source, restorePlan, env, async () => { if (await control.exists()) await control.stop(); }) : null;
  const tokenFile = env.SSE_TOKEN_PATH;
  if (!tokenFile) throw serviceError("REMOTE_PREPARE_FAILED", messages.installService.tokenPathMissing);
  const mode = await sshRun(s, `if test -e ${shQuote(tokenFile)}; then printf existing; else printf fresh; fi`, messages.installSteps.remoteTokenFileCheck);
  const tokens = parseTokens(await sshRun(s, `cd ${shQuote(release)} && ${remoteCommand([bun, CORE_CLI.clientToken,
    "--url", `http://${MANAGED_HOST}:${port}/`, "--tokens-file", tokenFile, mode === "existing" ? "--read-existing" : "--fresh"])}`,
    messages.installSteps.remoteCredentialsPrepare, REMOTE_TOKEN_TIMEOUT_MS, clientTokenFailure));
  await files.pointLink(`${host.serverPath}/${REMOTE_LAYOUT.current}`, release);
  ctx.progress("service");
  await control.install(serverUnitText(s.ssh.user, host.serverPath, env));
  await startService(s, host);
  await sshRun(s, `printf 'complete\\n' > ${shQuote(`${host.serverPath}/${REMOTE_LAYOUT.completeMarker}`)}`, messages.installSteps.installCompleteMark);
  return { tokens, replaced: swapped?.replaced ?? null };
}

/** Verify the host, probe it once, and do what the plan decides: install or resume the Pet's server,
 * repair its stopped service, or connect to it as it is. `savedServerPath` is set when the run recovers
 * the saved connection; a different server path on the host then stops the run. */
export async function prepareRemoteServer(input: RemoteInstallInput, paths: RuntimePaths, manifest: PayloadManifest,
  ctx: RequestContext, savedServerPath?: string, source?: RemoteRestoreSource): Promise<PreparedRemote> {
  const requested = validateSsh(input.ssh);
  const tools = findSshTools();
  ctx.progress("host-key");
  const scanned = await scanHost(tools, requested, paths.dataDir, ctx);
  const knownHosts = await trustHost(scanned, input.acceptedFingerprint, paths.dataDir);
  ctx.progress("preflight");
  const request: RemoteRequest = { serverPort: requested.serverPort ?? CORE_DEFAULT_PORT,
    ...(requested.serverPath ? { serverPath: safeRemotePath(requested.serverPath) } : {}),
    ...(savedServerPath === undefined ? {} : { savedServerPath }) };
  const facts = parseRemoteFacts(await sshRun({ tools, ssh: requested, knownHosts, ctx }, probeCommand(request), messages.installSteps.remoteProbe));
  const plan = planRemoteInstall(facts, request);
  if (plan.kind === "blocked") throw remoteBlockError(plan.block);
  // "백업에서 시작" fills only a new server: a complete Pet server here keeps its memories (spec 4.3).
  if (source && plan.kind !== "install") throw serviceError("RESTORE_TARGET_INSTALLED", messages.remoteRestore.RESTORE_TARGET_INSTALLED);
  const ssh = validateSsh({ ...requested, fingerprint: scanned.fingerprint, serverPath: plan.host.serverPath, serverPort: request.serverPort });
  const session: Session = { tools, ssh, knownHosts, ctx };
  if (plan.kind === "install") {
    const installed = await installServer(session, plan.host, request.serverPort, manifest, paths, source);
    return { ssh, tools, knownHosts, tokens: installed.tokens, outcome: "installed",
      ...(source && installed.replaced !== null ? { restored: { backupName: source.name, replaced: installed.replaced } } : {}) };
  }
  if (plan.kind === "repair") {
    ctx.progress("service");
    await startService(session, plan.host);
  }
  return { ssh, tools, knownHosts, tokens: await readTokens(session, plan.server), outcome: plan.kind === "repair" ? "repaired" : "connected" };
}

/** The tunnel's `ssh` command. It exits when the server stops answering its keepalive asks, so a connection that died
 * under it (sleep, network change) ends the process and the service opens the tunnel again (`tunnel-keeper.ts`). */
export function tunnelCommand(tools: SshTools, ssh: SshConnection, knownHosts: string, localPort: number, serverPort: number): string[] {
  const base = sshBase(tools, ssh, knownHosts);
  base.splice(-1, 0, "-o", "ExitOnForwardFailure=yes", "-o", `ServerAliveInterval=${TUNNEL_KEEPALIVE_INTERVAL_S}`,
    "-o", `ServerAliveCountMax=${TUNNEL_KEEPALIVE_MAX_MISSED}`, "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${serverPort}`);
  return base;
}

export function startTunnel(tools: SshTools, ssh: SshConnection, knownHosts: string, localPort: number, serverPort: number): Bun.Subprocess {
  return spawnResident(tunnelCommand(tools, ssh, knownHosts, localPort, serverPort));
}

export async function ensureRemoteTunnel(ssh: SshConnection, paths: RuntimePaths,
  ctx: RequestContext, baseUrl: string): Promise<{ tunnel: Bun.Subprocess; baseUrl: string }> {
  const tools = findSshTools();
  if (!ssh.fingerprint) throw serviceError("SSH_HOST_UNTRUSTED", messages.installService.hostUntrusted);
  const scanned = await scanHost(tools, ssh, paths.dataDir, ctx);
  ctx.signal.throwIfAborted();
  const knownHosts = await trustHost(scanned, ssh.fingerprint, paths.dataDir);
  const localPort = tunnelPort(baseUrl);
  if (localPort === null) throw serviceError("SSH_TUNNEL_URL_INVALID", messages.installService.tunnelAddressInvalid);
  ctx.signal.throwIfAborted();
  return { tunnel: startTunnel(tools, ssh, knownHosts, localPort, ssh.serverPort ?? CORE_DEFAULT_PORT), baseUrl };
}
