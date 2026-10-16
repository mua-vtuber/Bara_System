import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CORE_DEFAULT_PORT, connectionRoute, type ConnectionSettings, type HostInspection, type InstallResult, type RemoteInstallInput,
  type RequestContext, type RuntimePaths, type SshConnection, type TunnelPortNotice } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { ConfigStore, type CredentialSnapshot } from "../config.ts";
import { serviceError, type ServiceError } from "../errors.ts";
import { isRunning, runCaptured, stopProcess } from "./process.ts";
import { clientTokenFailure } from "./client-token-failure.ts";
import { isCoreRunning, reserveFreshOrigin, waitForClient, waitForHealth, type ReadyWait } from "./net.ts";
import { verifyRuntime, type PayloadManifest } from "./runtime.ts";
import { ensureRemoteTunnel, inspectRemote, prepareRemoteServer, startTunnel } from "./remote.ts";
import { isSameRemoteTarget } from "./remote-probe.ts";
import type { RemoteRestoreSource } from "./remote-restore.ts";
import { RemoteServerUpdater } from "./remote-update.ts";
import { claimPreferredOrigin, triesPreferredPort, tunnelPortNotice, type PreferredBlock } from "./tunnel-origin.ts";
import { rebindSnapshot } from "./connection-policy.ts";
import { keepsTunnel } from "./tunnel-keeper.ts";
import { assertTunnelListener, inspectListener } from "./port-owner.ts";
import { dbSchemaVersionOf } from "../maintenance/manifest.ts";
import { LocalServer } from "./local-server.ts";
import { CredentialRoutes } from "./credential-routes.ts";
import { decideLocalInstall, needsCoreProbe, type LocalInstallBlock } from "./local-plan.ts";
import { assertInstallSpace, freeBytesAt, type FreeSpace } from "./disk-space.ts";
import { inSequence, parseProgressLine, PROGRESS_LINES_ENV } from "./progress-line.ts";
import { INSTALL_MODEL_DICTIONARY_TIMEOUT_MS, INSTALL_PREPARE_TIMEOUT_MS, INSTALL_TOKEN_TIMEOUT_MS,
  MODEL_PREFETCH_IDLE_MS, REMOTE_INSTALL_READY_TIMEOUT_MS, TUNNEL_READY_TIMEOUT_MS } from "./limits.ts";

interface LocalJournal { version: 1; phase: "preparing" | "complete"; port: number }
/** `schemaVersion` is the memory database's schema version `managed-prepare` reports; null when it is
 * absent or not a non-negative integer, which never fails an install. */
interface Prepared { port: number; settingsPath: string; env: Record<string, string>; schemaVersion: number | null }

/** Failures of reusing the Pet's own complete install that the installer repairs on its own path: the
 * installer-owned token file is read back (`--read-existing`) or, when it is gone, issued again
 * (`--fresh`), as apps/setup/PET-INTEGRATION.md allows for installer-owned files. */
const REUSE_REPAIRABLE = new Set(["INSTALL_TOKENS_MISSING", "AUTH_REJECTED"]);
/** Tunnel failures after which another local port is tried: the tunnel exited or could not bind its port. */
const TUNNEL_PORT_LOST = new Set(["SSH_TUNNEL_EXITED", "SSH_TUNNEL_BIND_FAILED"]);
const tunnelPortLost = (error: unknown) => TUNNEL_PORT_LOST.has((error as { code?: string }).code ?? "");
/** Where `openTunnel` opens: the saved address, an address `claimPreferredOrigin` already reserved, or a fresh one. */
type TunnelTarget = { kind: "saved" } | { kind: "claimed"; baseUrl: string } | { kind: "fresh" };
/** Files `prefetch-core-models.ts` downloads after the dictionary. Only fills in the total while the dictionary
 * runs; the script's own lines carry its real count. */
const CORE_MODEL_PARTS = 4;

/** Runs around every start of the local memory server (`router.ts` joins the restore's `RestoreService` and the
 * update's `maintenance/upgrade.ts` `UpdateGate`). */
export interface StartGate {
  /** Awaited before a start looks at the installed store (whether its database exists): may refuse the start, and
   * finishes or undoes a restore's switch a crash cut off, so that nothing opens a store whose files are moving. */
  beforeStart?(ctx: RequestContext): Promise<void>;
  /** Awaited right before `managed-prepare` opens the database; may refuse the start. Returns an optional
   * pre-update SQLite snapshot path for setup to validate before reusing it as migration protection. */
  beforePrepare(ctx: RequestContext): Promise<string | undefined>;
  /** The local server started and answered with the stored token. */
  started(): Promise<void>;
  /** The error to throw for `error`, raised after `beforePrepare` passed in the same start. */
  failed(error: unknown): Promise<unknown>;
  /** The start was cancelled (it ends as cancelled, not as a failure). */
  cancelled(): void;
}
/** Told when the saved SSH tunnel opened, and when it closed by itself or a connection attempt for a connection that
 * keeps one failed (`router.ts` hands both to its `TunnelKeeper`, which opens the tunnel again). */
export interface TunnelEvents { opened(): void; lost(): void }
const NO_TUNNEL_EVENTS: TunnelEvents = { opened: () => {}, lost: () => {} };

const NO_GATE: StartGate = { beforePrepare: async () => undefined, started: async () => {}, failed: async (error) => error, cancelled: () => {} };

/** Whether reusing the install failed in a way its own path repairs, also when the start gate named the failure
 * `UPDATE_START_FAILED` and kept the original as `cause` (a token lost while an update was being finished). */
function repairable(error: unknown): boolean {
  const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return [failure?.code, failure?.cause?.code].some((code) => typeof code === "string" && REUSE_REPAIRABLE.has(code));
}

function installBlocked(code: LocalInstallBlock): ServiceError {
  return code === "INSTALL_EXISTING_CORE"
    ? serviceError(code, messages.connectionErrors.INSTALL_EXISTING_CORE(`http://127.0.0.1:${CORE_DEFAULT_PORT}`))
    : serviceError(code, messages.connectionErrors.INSTALL_EXISTING_CONNECTION);
}

function tokenFileOf(prepared: Prepared): string {
  const tokenFile = prepared.env.SSE_TOKEN_PATH;
  if (!tokenFile) throw serviceError("INSTALL_PREPARE_FAILED", messages.installService.tokenPathMissing);
  return tokenFile;
}

function tokenResult(text: string): { clientToken: string; ownerToken: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw serviceError("INSTALL_TOKEN_FAILED", messages.installService.tokenResultUnreadable); }
  const value = raw as { clientToken?: unknown; ownerToken?: unknown };
  if (!value || typeof value.clientToken !== "string" || typeof value.ownerToken !== "string" ||
      value.clientToken.length < 32 || value.ownerToken.length < 32)
    throw serviceError("INSTALL_TOKEN_FAILED", messages.installService.tokenResultInvalid);
  return { clientToken: value.clientToken, ownerToken: value.ownerToken };
}

export class InstallManager {
  private readonly localServer = new LocalServer();
  /** Checked by every memory server request (`MemoryClient`, cleanup, MCP, dashboard link) right before
   * it sends a credential; this class records the tunnel it verified and owns the local server. */
  readonly routes = new CredentialRoutes(this.localServer);
  private tunnel: Bun.Subprocess | null = null;
  private manifest: Promise<PayloadManifest> | null = null;
  /** In-flight and running connection work is keyed by `connectionRoute` (address and SSH route), not by
   * audience: a tunnel on another local port must not count as the one the saved settings name. */
  private connectionFlight: { route: string; abort: AbortController; promise: Promise<void> } | null = null;
  private connectionGeneration = 0;
  private activeTunnelRoute: string | null = null;
  /** Why the tunnel opened for `route` is not on the preferred port (null when it is); shown while that tunnel runs. */
  private tunnelPortRecord: { route: string; notice: TunnelPortNotice | null } | null = null;
  private tunnelEvents: TunnelEvents = NO_TUNNEL_EVENTS;
  /** Set by `close`: a tunnel that exits from then on was stopped by it, not lost. */
  private closed = false;
  private readonly coreRoot: string;
  private readonly memoryData: string;
  private readonly journalPath: string;
  /** The managed install's database, the same path `prepare` requires in its result. */
  private readonly databasePath: string;
  /** Brings a Pet-installed remote server to this Pet's server version once per service start (spec 5.3). */
  readonly serverUpdater: RemoteServerUpdater;

  constructor(private readonly config: ConfigStore, private readonly paths: RuntimePaths,
    /** Told the database schema version after each successful prepare; a failure to record it never fails the install. */
    private readonly onDbSchema: (version: number) => Promise<void> = async () => {},
    /** Reads the free space before a local install writes anything; tests pass a fixed reading. */
    private readonly freeSpace: FreeSpace = freeBytesAt,
    /** Runs before the database is opened and after the server started: the update's backup and record. */
    private readonly gate: StartGate = NO_GATE,
    /** Existing-core probe destination; tests use their own loopback listener, never the user's server. */
    private readonly coreProbePort: number = CORE_DEFAULT_PORT,
    /** Local port a remote tunnel tries first: the address external AI apps (Claude Code's bara MCP) use.
     * Tests pass a loopback port of their own, never the user's. */
    private readonly preferredTunnelPort: number = CORE_DEFAULT_PORT) {
    this.coreRoot = join(paths.resourceDir, "core");
    this.memoryData = join(paths.dataDir, "memory");
    this.journalPath = join(this.memoryData, "managed-install.json");
    this.databasePath = join(this.memoryData, "db", "bara.sqlite");
    this.serverUpdater = new RemoteServerUpdater(paths, () => this.verify());
  }

  /** Set once by the router, before any request runs. */
  watchTunnel(events: TunnelEvents): void {
    this.tunnelEvents = events;
  }

  /** The tunnel this service just verified now serves the saved connection: when it exits without this service
   * stopping or replacing it (the PC slept, the network dropped, the server restarted), it is forgotten and reported
   * lost, unless the saved connection changed meanwhile. */
  private tunnelOpened(tunnel: Bun.Subprocess): void {
    const route = this.activeTunnelRoute;
    this.tunnelEvents.opened();
    void tunnel.exited.then(async () => {
      if (this.closed || this.tunnel !== tunnel) return;
      this.routes.forgetTunnel(tunnel);
      this.tunnel = null;
      this.activeTunnelRoute = null;
      // A settings read that fails is reported as a loss too: the attempt that follows says why it cannot connect.
      const current = await this.config.snapshot().then((snapshot) => connectionRoute(snapshot.settings.connection), () => route);
      if (current === route && !this.closed) this.tunnelEvents.lost();
    });
  }

  private verify(): Promise<PayloadManifest> {
    this.manifest ??= verifyRuntime(this.paths).catch((error) => { this.manifest = null; throw error; });
    return this.manifest;
  }

  private async journal(): Promise<LocalJournal | null> {
    if (!existsSync(this.journalPath)) return null;
    let value: unknown;
    try { value = JSON.parse(await readFile(this.journalPath, "utf8")); }
    catch { throw serviceError("INSTALL_JOURNAL_INVALID", messages.installService.journalUnreadable); }
    const journal = value as LocalJournal;
    if (!journal || journal.version !== 1 || !["preparing", "complete"].includes(journal.phase) ||
        !Number.isSafeInteger(journal.port) || journal.port < 1 || journal.port > 65535)
      throw serviceError("INSTALL_JOURNAL_INVALID", messages.installService.journalInvalid);
    return journal;
  }

  private async writeJournal(value: LocalJournal): Promise<void> {
    await mkdir(this.memoryData, { recursive: true });
    const temporary = `${this.journalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.journalPath);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  /** Every database-opening step runs inside here: the gate may stop it before `prepare`, is told when the server
   * started, and names any later failure. A cancel stays a cancel; the gate is told the start ended. */
  private async gated<T>(ctx: RequestContext, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (!ctx.signal.aborted) throw await this.gate.failed(error);
      this.gate.cancelled();
      throw error;
    }
  }

  private async prepare(port: number, ctx: RequestContext): Promise<Prepared> {
    const snapshot = await this.gate.beforePrepare(ctx);
    const result = await runCaptured([this.paths.bunPath, "apps/setup/src/managed-prepare.ts",
      "--data-dir", this.memoryData, "--port", String(port), ...(snapshot ? ["--pre-update-snapshot", snapshot] : [])], ctx,
      { cwd: this.coreRoot, timeoutMs: INSTALL_PREPARE_TIMEOUT_MS, stepName: messages.installSteps.prepareMemoryData });
    let prepared: Prepared;
    try { prepared = JSON.parse(result.stdout) as Prepared; }
    catch { throw serviceError("INSTALL_PREPARE_FAILED", messages.installService.prepareResultUnreadable); }
    if (!prepared || prepared.settingsPath !== join(this.memoryData, "config", "memory-settings.json") ||
        !prepared.env || prepared.env.MEMORY_DB_PATH !== this.databasePath ||
        prepared.env.MEMORY_HOST !== "127.0.0.1" || prepared.env.MEMORY_PORT !== String(prepared.port))
      throw serviceError("INSTALL_PREPARE_FAILED", messages.installService.prepareDataPathMismatch);
    prepared.schemaVersion = dbSchemaVersionOf((prepared as { schemaVersion?: unknown }).schemaVersion);
    if (prepared.schemaVersion !== null) await this.onDbSchema(prepared.schemaVersion).catch(() => {});
    return prepared;
  }

  /** Both scripts' byte progress is reported as one sequence: the dictionary is part 1, the core models follow. */
  private async prefetch(prepared: Prepared, ctx: RequestContext): Promise<void> {
    ctx.progress("models");
    // A progress line is taken (not kept in the step's output) once it parses, even when it cannot be placed.
    const report = (before: number, after: number) => (line: string) => {
      const own = parseProgressLine(line);
      const detail = own && inSequence(own, before, after);
      if (detail) ctx.progress("models", detail);
      return own !== null;
    };
    // The scripts write progress lines only when asked to, so a CLI setup's terminal stays clean.
    const env = { ...prepared.env, [PROGRESS_LINES_ENV]: "1" };
    await runCaptured([this.paths.bunPath, "apps/setup/src/managed-models.ts", "--model-dir", prepared.env.BARA_KIWI_MODEL_DIR!],
      ctx, { cwd: this.coreRoot, env, timeoutMs: INSTALL_MODEL_DICTIONARY_TIMEOUT_MS, stepName: messages.installSteps.koreanDictionary,
        onLine: report(0, CORE_MODEL_PARTS) });
    // Idle, not total: the core script must keep emitting output periodically during a
    // transfer (see limits.ts MODEL_PREFETCH_IDLE_MS) for this to bound a single stalled
    // model download instead of the whole multi-model prefetch step.
    await runCaptured([this.paths.bunPath, "scripts/prefetch-core-models.ts"],
      ctx, { cwd: join(this.coreRoot, "apps", "memory"), env, idleTimeoutMs: MODEL_PREFETCH_IDLE_MS, stepName: messages.installSteps.modelDownload,
        onLine: report(1, 0) });
  }

  /** No bearer is sent to the port before `LocalServer` has verified its own child as the port's
   * only listener; a port held by another program ends with `INSTALL_PORT_TAKEN`. */
  private async startLocal(prepared: Prepared, token: string, route: string, ctx: RequestContext): Promise<void> {
    const memoryRoot = join(this.coreRoot, "apps", "memory");
    await this.localServer.ensure({ argv: [this.paths.bunPath, "src/index.ts"], cwd: memoryRoot,
      env: { ...prepared.env, MEMORY_STATIC: join(memoryRoot, "web") }, port: prepared.port, token, audience: route, ctx });
    await this.gate.started();
  }

  /** A complete install owns its database. `managed-prepare` would create a missing one empty, so the
   * Pet stops here instead of silently connecting the user to a new, empty store. */
  private assertInstalledData(): void {
    if (!existsSync(this.databasePath))
      throw serviceError("INSTALL_DATA_MISSING", messages.connectionErrors.INSTALL_DATA_MISSING);
  }

  async local(ctx: RequestContext): Promise<InstallResult> {
    await this.verify();
    await this.gate.beforeStart?.(ctx);
    const journal = await this.journal();
    const initial = await this.config.snapshot();
    const known = { journal, mode: initial.settings.connection.mode, hasToken: !!initial.token };
    const plan = decideLocalInstall({ ...known,
      coreRunning: needsCoreProbe(known) ? await isCoreRunning(this.coreProbePort, ctx.signal) : null });
    if (plan.kind === "blocked") throw installBlocked(plan.code);
    if (plan.kind === "reuse") {
      try {
        await this.ensureConnection(ctx);
        return { connection: (await this.config.load()).connection, message: messages.localInstall.reused };
      } catch (error) {
        if (!repairable(error)) throw error;
      }
    }
    let selectedUrl: string;
    // The free-space check comes before any origin, record or data folder is written, so a drive that cannot
    // take the models is left as it was. A repaired reuse downloads nothing and is not checked.
    if (plan.kind === "fresh") {
      await assertInstallSpace(this.memoryData, this.freeSpace);
      selectedUrl = await reserveFreshOrigin((baseUrl) => this.config.reserveOrigin({ mode: "local", baseUrl }));
    } else {
      // Checked before the record goes back to "preparing", which skips this check on the next attempt.
      if (journal?.phase === "complete") this.assertInstalledData();
      if (plan.kind === "resume") await assertInstallSpace(this.memoryData, this.freeSpace);
      selectedUrl = `http://127.0.0.1:${plan.port}`;
      await this.config.reserveOrigin({ mode: "local", baseUrl: selectedUrl });
    }
    const port = Number(new URL(selectedUrl).port);
    await this.writeJournal({ version: 1, phase: "preparing", port });
    ctx.progress("prepare");
    const { prepared, tokens, connection } = await this.gated(ctx, async () => {
      const prepared = await this.prepare(port, ctx);
      await this.writeJournal({ version: 1, phase: "preparing", port: prepared.port });
      await this.prefetch(prepared, ctx);
      const tokenFile = tokenFileOf(prepared);
      const mode = existsSync(tokenFile) ? "--read-existing" : "--fresh";
      const baseUrl = `http://127.0.0.1:${prepared.port}`;
      const captured = await runCaptured([this.paths.bunPath, "apps/setup/src/client-token.ts", "--url", `${baseUrl}/`,
        "--tokens-file", tokenFile, mode], ctx, { cwd: this.coreRoot, sensitive: clientTokenFailure, timeoutMs: INSTALL_TOKEN_TIMEOUT_MS, stepName: messages.installSteps.prepareCredentials });
      const tokens = tokenResult(captured.stdout);
      const connection = { mode: "local" as const, baseUrl };
      ctx.progress("server");
      await this.startLocal(prepared, tokens.clientToken, connectionRoute(connection), ctx);
      return { prepared, tokens, connection };
    });
    await this.config.save({ connection, token: tokens.clientToken, ownerToken: tokens.ownerToken },
      initial.settings.connection);
    await this.writeJournal({ version: 1, phase: "complete", port: prepared.port });
    return { connection, message: messages.localInstall.prepared };
  }

  async inspect(ssh: SshConnection, ctx: RequestContext): Promise<HostInspection> {
    return inspectRemote(ssh, this.paths, ctx);
  }

  /** `source`: the backup "백업에서 시작" fills the new server with, already read back on this PC (`RestoreService.remoteSource`). */
  async remote(input: RemoteInstallInput, ctx: RequestContext, source?: RemoteRestoreSource): Promise<InstallResult> {
    const initial = await this.config.snapshot();
    const saved = initial.settings.connection;
    // A stored token belongs to a connection the user already has. Only a run for that same remote server goes
    // on, as its recovery (for example after its token stopped working); the probe then checks its server path.
    if (initial.token && !isSameRemoteTarget(saved, input.ssh)) throw installBlocked("INSTALL_EXISTING_CONNECTION");
    const manifest = await this.verify();
    const server = await prepareRemoteServer(input, this.paths, manifest, ctx, initial.token ? saved.ssh?.serverPath : undefined, source);
    // A server this run did not just install is brought to this Pet's server version before its tunnel opens (spec 5.3).
    if (server.outcome !== "installed") await this.serverUpdater.ensure(server.ssh, ctx);
    await this.stopTunnel();
    const { connection, block } = await this.remoteConnection(saved, server.ssh, ctx.signal);
    ctx.signal.throwIfAborted();
    const tunnel = startTunnel(server.tools, server.ssh, server.knownHosts, Number(new URL(connection.baseUrl).port), server.ssh.serverPort!);
    this.tunnel = tunnel;
    try {
      await this.routes.verifyTunnel(tunnel, connection, ctx.signal);
      await Promise.race([
        waitForClient(connection.baseUrl, server.tokens.clientToken, ctx.signal, {
          timeoutMs: REMOTE_INSTALL_READY_TIMEOUT_MS, timeoutCode: "SSH_SERVER_TIMEOUT",
          beforeRequest: () => assertTunnelListener(tunnel, connection.baseUrl, ctx.signal) }),
        tunnel.exited.then(() => { throw serviceError("SSH_TUNNEL_EXITED", messages.installService.tunnelExited); }),
      ]);
      await this.config.save({ connection, token: server.tokens.clientToken, ownerToken: server.tokens.ownerToken },
        saved);
      this.activeTunnelRoute = connectionRoute(connection);
      this.recordTunnelPort(block === null ? null : tunnelPortNotice(connection.baseUrl, this.preferredTunnelPort, block));
      this.tunnelOpened(tunnel);
      const message = messages.remoteInstall[server.outcome];
      return { connection, message: server.restored
        ? `${message} ${messages.remoteRestore.restored(server.restored.backupName, server.restored.replaced)}` : message };
    } catch (error) {
      this.routes.forgetTunnel(tunnel);
      stopProcess(tunnel);
      if (this.tunnel === tunnel) { this.tunnel = null; this.activeTunnelRoute = null; }
      throw error;
    }
  }

  /** Stop this service's tunnel, if any, and wait for it to exit so its local port is released. */
  private async stopTunnel(): Promise<void> {
    const tunnel = this.tunnel;
    this.tunnel = null;
    this.activeTunnelRoute = null;
    this.routes.forgetTunnel(tunnel);
    if (!tunnel) return;
    stopProcess(tunnel);
    await tunnel.exited;
  }

  /** The local tunnel address for a prepared remote server. The preferred port comes first when it is free and
   * not another server's; then the saved address, when it names the same server and route and nothing listens
   * on its port; otherwise a new address is reserved. The connection's audience does not include this local
   * address, so records bound to it stay valid either way. `block` is why the preferred port was not taken. */
  private async remoteConnection(saved: ConnectionSettings, ssh: SshConnection, signal: AbortSignal):
    Promise<{ connection: ConnectionSettings; block: PreferredBlock | null }> {
    const kept: ConnectionSettings = { mode: "remote", baseUrl: saved.baseUrl, ssh };
    const claim = await claimPreferredOrigin(this.config, kept, this.preferredTunnelPort, signal);
    if (claim.kind === "claimed") return { connection: { ...kept, baseUrl: claim.baseUrl }, block: null };
    const savedPort = Number(new URL(saved.baseUrl).port);
    if (saved.mode === "remote" && savedPort > 0 && connectionRoute(kept) === connectionRoute(saved) &&
        (await inspectListener(savedPort, signal)).kind === "none") {
      await this.config.reserveOrigin(kept);
      return { connection: kept, block: claim };
    }
    const baseUrl = await reserveFreshOrigin((candidate) => this.config.reserveOrigin({ mode: "remote", baseUrl: candidate, ssh }));
    return { connection: { mode: "remote", baseUrl, ssh }, block: claim };
  }

  /** Records the tunnel-port notice for the tunnel that now runs on `activeTunnelRoute`. */
  private recordTunnelPort(notice: TunnelPortNotice | null): void {
    this.tunnelPortRecord = this.activeTunnelRoute === null ? null : { route: this.activeTunnelRoute, notice };
  }

  /** Why the running remote tunnel is not on the preferred port, or null (no such tunnel, or it is on it). */
  tunnelPortStatus(): TunnelPortNotice | null {
    const record = this.tunnelPortRecord;
    return record && this.tunnel && isRunning(this.tunnel) && this.activeTunnelRoute === record.route ? record.notice : null;
  }

  private async assertCurrent(route: string, generation: number): Promise<void> {
    if (generation !== this.connectionGeneration ||
        connectionRoute((await this.config.snapshot()).settings.connection) !== route)
      throw serviceError("CONNECTION_CHANGED", messages.connectionChange.routeChanged);
  }

  /** Opens the tunnel at `target` and returns the local address it serves on, saved as the connection's own. */
  private async openTunnel(snapshot: CredentialSnapshot, route: string, generation: number,
    ctx: RequestContext, target: TunnelTarget): Promise<string> {
    const connection = snapshot.settings.connection;
    const ssh = connection.ssh!;
    const chosenUrl = target.kind === "saved" ? connection.baseUrl : target.kind === "claimed" ? target.baseUrl
      : await reserveFreshOrigin((baseUrl) => this.config.reserveOrigin({ ...connection, baseUrl }));
    if (target.kind === "saved") await this.config.reserveOrigin(connection);
    const started = await ensureRemoteTunnel(ssh, this.paths, ctx, chosenUrl);
    const { tunnel, baseUrl } = started;
    if (ctx.signal.aborted) { stopProcess(tunnel); ctx.signal.throwIfAborted(); }
    this.tunnel = tunnel;
    this.activeTunnelRoute = route;
    try {
      await this.routes.verifyTunnel(tunnel, { ...connection, baseUrl }, ctx.signal);
      const wait: ReadyWait = { timeoutMs: TUNNEL_READY_TIMEOUT_MS, timeoutCode: "SSH_SERVER_TIMEOUT",
        beforeRequest: () => assertTunnelListener(tunnel, baseUrl, ctx.signal) };
      const ready = snapshot.token
        ? waitForClient(baseUrl, snapshot.token, ctx.signal, wait)
        : waitForHealth(baseUrl, ctx.signal, wait);
      await Promise.race([ready,
        tunnel.exited.then(() => { throw serviceError("SSH_TUNNEL_EXITED", messages.installService.tunnelExited); })]);
      await this.assertCurrent(route, generation);
      if (baseUrl !== connection.baseUrl) {
        if (connection.mode === "existing" || !snapshot.token)
          throw serviceError("SSH_TUNNEL_URL_INVALID", messages.installService.tunnelAddressKeepFailed);
        await rebindSnapshot(this.config, snapshot, { ...connection, baseUrl });
        this.activeTunnelRoute = connectionRoute({ ...connection, baseUrl });
      }
      this.tunnelOpened(tunnel);
      return baseUrl;
    } catch (error) {
      this.routes.forgetTunnel(tunnel);
      stopProcess(tunnel);
      if (this.tunnel === tunnel) { this.tunnel = null; this.activeTunnelRoute = null; }
      throw error;
    }
  }

  private async ensureSnapshot(snapshot: CredentialSnapshot, route: string, generation: number,
    ctx: RequestContext): Promise<void> {
    const connection = snapshot.settings.connection;
    if (connection.mode === "existing" && !connection.ssh) return;
    if (connection.mode === "local") {
      if (!snapshot.token) return;
      const journal = await this.journal();
      if (!journal || journal.phase !== "complete") return;
      if (connection.baseUrl !== `http://127.0.0.1:${journal.port}`)
        throw serviceError("INSTALL_JOURNAL_INVALID", messages.installService.journalPortMismatch);
      // A verified server keeps serving until it exits, so requests reuse it without an origin write,
      // a payload check or a `managed-prepare` process: preparation runs once per server start.
      if (this.localServer.serves(journal.port, route)) return;
      await this.gate.beforeStart?.(ctx);
      this.assertInstalledData();
      await this.config.reserveOrigin(connection);
      await this.verify();
      const token = snapshot.token;
      await this.gated(ctx, async () => {
        const prepared = await this.prepare(journal.port, ctx);
        // The core would create a missing token file at start holding only its dashboard token, which
        // neither `--read-existing` nor `--fresh` accepts afterwards; so it is not started without one.
        if (!existsSync(tokenFileOf(prepared)))
          throw serviceError("INSTALL_TOKENS_MISSING", messages.connectionErrors.INSTALL_TOKENS_MISSING);
        await this.startLocal(prepared, token, route, ctx);
      });
      await this.assertCurrent(route, generation);
      return;
    }
    if (!connection.ssh) return;
    try { await this.config.reserveOrigin(connection); }
    catch (error) {
      if (this.tunnel && isRunning(this.tunnel) && this.activeTunnelRoute === route) {
        this.routes.forgetTunnel(this.tunnel);
        stopProcess(this.tunnel);
        this.tunnel = null;
        this.activeTunnelRoute = null;
      }
      throw error;
    }
    if (this.tunnel && isRunning(this.tunnel) && this.activeTunnelRoute === route) return;
    this.routes.forgetTunnel(this.tunnel);
    if (this.tunnel && isRunning(this.tunnel)) stopProcess(this.tunnel);
    this.tunnel = null;
    this.activeTunnelRoute = null;
    // A remote server the Pet installed is brought to this Pet's server version before its tunnel opens (spec 5.3).
    if (connection.mode === "remote") await this.serverUpdater.ensure(connection.ssh, ctx);
    // A remote tunnel saved elsewhere moves to the preferred port whenever that port is free and not another
    // server's (an address saved before this rule moves on its next connection); otherwise it stays where it was.
    let block: PreferredBlock | "bind-failed" | null = null;
    if (triesPreferredPort(connection, !!snapshot.token, this.preferredTunnelPort)) {
      const claim = await claimPreferredOrigin(this.config, connection, this.preferredTunnelPort, ctx.signal);
      if (claim.kind === "claimed") {
        try {
          await this.openTunnel(snapshot, route, generation, ctx, claim);
          this.recordTunnelPort(null);
          return;
        } catch (error) {
          if (!tunnelPortLost(error)) throw error;
          await this.assertCurrent(route, generation);
          block = "bind-failed";
        }
      } else block = claim;
    }
    let baseUrl: string;
    try {
      baseUrl = await this.openTunnel(snapshot, route, generation, ctx, { kind: "saved" });
    } catch (error) {
      if (connection.mode !== "remote" || !snapshot.token || !tunnelPortLost(error)) throw error;
      // A saved local port can be taken after restart. Rebind both credentials
      // from the same snapshot only if the saved connection is still the one it read.
      await this.assertCurrent(route, generation);
      baseUrl = await this.openTunnel(snapshot, route, generation, ctx, { kind: "fresh" });
      block ??= "bind-failed";
    }
    // Only a remote connection with a token can move its address, so only it is told why it did not.
    this.recordTunnelPort(connection.mode === "remote" && snapshot.token
      ? tunnelPortNotice(baseUrl, this.preferredTunnelPort, block ?? "bind-failed") : null);
  }

  async ensureConnection(ctx: RequestContext): Promise<void> {
    let snapshot = await this.config.snapshot();
    let route = connectionRoute(snapshot.settings.connection);
    while (this.connectionFlight && this.connectionFlight.route !== route) {
      this.connectionFlight.abort.abort();
      await this.connectionFlight.promise.catch(() => {});
      snapshot = await this.config.snapshot();
      route = connectionRoute(snapshot.settings.connection);
    }
    if (this.connectionFlight) return this.connectionFlight.promise;
    const abort = new AbortController();
    const generation = ++this.connectionGeneration;
    const signal = AbortSignal.any([ctx.signal, abort.signal]);
    const promise = this.ensureSnapshot(snapshot, route, generation, { ...ctx, signal });
    this.connectionFlight = { route, abort, promise };
    try { await promise; }
    catch (error) {
      if (keepsTunnel(snapshot)) this.tunnelEvents.lost();
      throw error;
    }
    finally { if (this.connectionFlight?.promise === promise) this.connectionFlight = null; }
  }

  /** Stops the local memory server this service started, if it runs, and waits until it has exited and released
   * the store's files (a restore moves them). The next request starts it again through `ensureConnection`. */
  async stopLocal(): Promise<void> {
    await this.localServer.close();
  }

  async status(): Promise<boolean> {
    const settings = await this.config.load();
    if (settings.connection.mode === "remote") return !!(await this.config.getToken());
    return settings.connection.mode === "local" && (await this.journal())?.phase === "complete";
  }

  async close(): Promise<void> {
    this.closed = true;
    this.serverUpdater.close();
    this.connectionFlight?.abort.abort();
    this.routes.forgetTunnel(this.tunnel);
    if (this.tunnel) stopProcess(this.tunnel);
    await Promise.allSettled([this.connectionFlight?.promise, this.localServer.close(), this.tunnel?.exited].filter(Boolean));
    this.tunnel = null;
    this.activeTunnelRoute = null;
  }
}
