import { randomUUID } from "node:crypto";
import type { AiProbeResult, AppStatus, ConnectionSettings, ConnectionStatus, RequestContext, RuntimePaths, HostVault, RpcMethod, SaveInput, SettingsUpdate, RemoteInstallInput, SshConnection,
  StartupCheckResult } from "../shared/contracts.ts";
import { ConfigStore } from "./config.ts";
import { MemoryClient } from "./client.ts";
import { Assistant } from "./assistant.ts";
import { AiClient } from "./ai.ts";
import { discoverAi } from "./ai-discovery.ts";
import { CleanupService } from "./cleanup.ts";
import { CleanupOnSave, cleanupOnSaveTarget } from "./cleanup-on-save.ts";
import { messages } from "../ui/messages.ts";
import { serviceError } from "./errors.ts";
import { InstallManager } from "./install/index.ts";
import { BackupService } from "./backup.ts";
import { RestoreService } from "./restore.ts";
import type { StartGate } from "./install/index.ts";
import { publicError } from "./protocol.ts";
import type { Maintenance } from "./maintenance/manifest.ts";
import { UpdateGate } from "./maintenance/upgrade.ts";
import { freeBytesAt } from "./install/disk-space.ts";
import { SharedRun } from "./shared-run.ts";
import { ceilingFor, runWithCeiling } from "./operation-limits.ts";
import { checkStartup } from "../ui/startup-check.ts";
import { startupFailureFeedback } from "../ui/startup-failure.ts";

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw serviceError("INVALID_INPUT", messages.rpc.checkField(label));
  return value;
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw serviceError("INVALID_INPUT", messages.rpc.memoryNumber);
  return Number(value);
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw serviceError("INVALID_INPUT", messages.rpc.memoryRevision);
  return Number(value);
}
const needsServer = new Set<RpcMethod | "dashboard.link">([
  "connection.test", "enrollment.start", "enrollment.poll", "memory.status", "memory.search", "memory.get", "memory.update",
  "assistant.ask", "cleanup.run", "cleanup.list", "dashboard.link",
]);
const connectionOperations = new Set<RpcMethod | "dashboard.link">([
  "status", "connection.test", "enrollment.start", "enrollment.poll", "memory.save", "memory.status",
  "memory.search", "memory.get", "memory.update", "assistant.ask", "cleanup.run", "cleanup.list",
  "install.local", "install.remote", "dashboard.link",
]);

export class PetService {
  readonly config: ConfigStore;
  readonly client: MemoryClient;
  readonly installer: InstallManager;
  private readonly assistant: Assistant;
  private readonly ai: AiClient;
  private readonly cleanup: CleanupService;
  private readonly cleanupOnSave: CleanupOnSave;
  private readonly backup: BackupService;
  private readonly restore: RestoreService;
  private readonly gate: UpdateGate;
  private connectionTail: Promise<void> = Promise.resolve();
  private connectionJobs = 0;
  /** The startup check, run once per service start (`startup.check`); see `startupCheck`. */
  private readonly startup = new SharedRun<StartupCheckResult>((ctx) => this.startupCheck(ctx));

  constructor(paths: RuntimePaths, vault: HostVault, private readonly maintenance: Maintenance) {
    this.config = new ConfigStore(paths, vault);
    // Every local server start passes the update gate: a new version backs the database up before it is opened.
    this.gate = new UpdateGate({ paths, maintenance });
    // A restore from a backup holds the server stopped while it runs and finishes or undoes a switch a crash cut off,
    // before the update gate (which backs the store up) or preparation looks at the store.
    this.restore = new RestoreService(this.config, paths, {
      exclusive: (ctx, work) => this.withConnection(ctx, work),
      stopServer: () => this.installer.stopLocal(),
      startServer: (ctx) => this.installer.ensureConnection(ctx),
      blocker: () => this.gate.busy ? "RESTORE_UPDATE_RUNNING" : this.backup.busy ? "RESTORE_BACKUP_RUNNING"
        : this.connectionJobs > 0 || this.startup.running ? "RESTORE_CONNECTION_BUSY" : null,
    }, { appVersion: maintenance.status.appVersion });
    const startGate: StartGate = {
      beforeStart: () => this.restore.beforeStart(),
      beforePrepare: (ctx) => this.gate.beforePrepare(ctx),
      started: async () => { await this.gate.started(); await this.restore.started(); },
      failed: (error) => this.gate.failed(error),
      cancelled: () => this.gate.cancelled(),
    };
    this.installer = new InstallManager(this.config, paths, (version) => maintenance.recordDbSchema(version), freeBytesAt, startGate);
    this.client = new MemoryClient(this.config, this.installer.routes);
    this.assistant = new Assistant(this.config, this.client);
    this.ai = new AiClient(this.config);
    this.cleanup = new CleanupService(this.config, this.client);
    this.cleanupOnSave = new CleanupOnSave(() => this.config.plainSettings(), this.cleanup);
    // The settings backup steps aside while the gate copies the store or a start may be migrating it, and while a
    // restore moves the store's files.
    this.backup = new BackupService(this.config, paths, { updating: () => this.gate.busy, restoring: () => this.restore.active });
  }

  private async withConnection<T>(ctx: RequestContext, work: () => Promise<T>): Promise<T> {
    const previous = this.connectionTail;
    let release!: () => void;
    this.connectionTail = new Promise<void>(resolve => { release = resolve; });
    this.connectionJobs++;
    try { await previous; ctx.signal.throwIfAborted(); return await work(); }
    finally { this.connectionJobs--; release(); }
  }

  /** The startup check the main window used to run by itself (`src/ui/startup-check.ts` `checkStartup`): read the
   * settings, then, with a token saved, the same work as `connection.test` — through the connection queue, so it
   * starts the local memory server of a complete install (the update gate first), opens the SSH tunnel or checks
   * the existing server, by `InstallManager.ensureConnection`'s rules alone. It never installs: a local install
   * that is not complete is not prepared, and a complete one whose database is gone stops with
   * `INSTALL_DATA_MISSING` instead of getting a new, empty one. The connection part keeps the request ceiling a
   * `connection.test` has, on the run's own signal (`SharedRun`), so the check ends the way the screen's did. */
  private startupCheck(ctx: RequestContext): Promise<StartupCheckResult> {
    const asReply = (error: unknown) => { throw publicError(error); };
    return checkStartup(() => this.config.load().catch(asReply),
      () => runWithCeiling((signal) => {
        const inner = { ...ctx, signal };
        return this.withConnection(inner, () => this.dispatchInside("connection.test", {}, inner, []));
      }, ceilingFor("connection.test"), ctx.signal).catch(asReply) as Promise<{ connected: boolean; message: string }>)
      .then((check) => check.kind === "failed"
        ? { ...check, feedback: startupFailureFeedback(randomUUID(), check.stage, check.reason) } : check);
  }

  /** The `status` answer: every place that builds it reads the same parts, the remote server's update included. */
  private async appStatus(connection: ConnectionStatus, activeOperations: string[]): Promise<AppStatus> {
    return { connection, activeOperations, installed: await this.installer.status(), maintenance: this.maintenance.status,
      update: await this.gate.status(), serverUpdate: this.installer.serverUpdater.status(),
      tunnelPort: this.installer.tunnelPortStatus() };
  }

  async dispatch(method: RpcMethod | "dashboard.link", params: Record<string, unknown>, ctx: RequestContext, activeOperations: string[]): Promise<unknown> {
    // Joins the one startup check of this start, whoever asked first; it takes its turn in the connection queue itself.
    if (method === "startup.check") return this.startup.join(ctx);
    if (method === "status" && this.restore.holdingServer) {
      return this.appStatus({ connected: false, message: messages.restore.serverStopped }, activeOperations);
    }
    if (method === "status" && this.connectionJobs > 0) {
      return this.appStatus({ connected: false, message: messages.rpc.otherOperationRunning }, activeOperations);
    }
    // A restore puts the restored store back on this PC's connection once it is done; the connection is not changed
    // under it (the AI and autostart settings can still be saved).
    const changesConnection = method === "install.local" || method === "install.remote" || (method === "settings.save" &&
      (params.connection !== undefined || params.token !== undefined || params.ownerToken !== undefined));
    if (changesConnection && this.restore.active) throw serviceError("RESTORE_CONNECTION_LOCKED", messages.restoreErrors.RESTORE_CONNECTION_LOCKED);
    if (method === "settings.save") {
      if (this.connectionJobs > 0) throw serviceError("CONNECTION_BUSY", messages.rpc.settingsSaveBusy);
      return this.withConnection(ctx, () => this.dispatchInside(method, params, ctx, activeOperations));
    }
    if (connectionOperations.has(method)) return this.withConnection(ctx, () => this.dispatchInside(method, params, ctx, activeOperations));
    return this.dispatchInside(method, params, ctx, activeOperations);
  }

  private async dispatchInside(method: RpcMethod | "dashboard.link", params: Record<string, unknown>, ctx: RequestContext, activeOperations: string[]): Promise<unknown> {
    ctx.signal.throwIfAborted();
    if (needsServer.has(method)) {
      // From a restore's start the server is stopped or about to be; it is not asked for anything until it is back.
      if (this.restore.holdingServer) throw serviceError("RESTORE_RUNNING", messages.restoreErrors.RESTORE_RUNNING);
      await this.installer.ensureConnection(ctx);
    }
    switch (method) {
      // `status` opens no tunnel and starts no server. `client.info` reaches the server only through a
      // listener this service already verified (`CredentialRoutes`); otherwise it reports, without
      // sending anything, that the connection is not verified yet.
      case "status": return this.appStatus(await this.client.info(ctx.signal), activeOperations);
      case "settings.get": return this.config.load();
      case "settings.save": return this.config.save(params as SettingsUpdate);
      case "connection.test": return this.client.info(ctx.signal);
      case "enrollment.start": return this.client.enrollmentStart(ctx);
      case "enrollment.poll": return this.client.enrollmentPoll(ctx);
      case "memory.save": {
        const rejected = (message: string) =>
          ({ state: "rejected", requestId: params.requestId, ...(typeof params.audience === "string" ? { audience: params.audience } : {}), message });
        // From a restore's start, before its server stop too: a memory saved now would stay behind in the store the
        // restore moves aside. The text says what happened to this input: it stays in the box.
        if (this.restore.holdingServer) return rejected(messages.restore.saveRefused);
        try { await this.installer.ensureConnection(ctx); }
        catch (error) {
          const failure = publicError(error);
          return rejected(failure.code === "RESTORE_RUNNING" ? messages.restore.saveRefused : failure.message);
        }
        const saved = await this.assistant.save(params as unknown as SaveInput, ctx);
        const cleanupTarget = cleanupOnSaveTarget(saved);
        if (cleanupTarget !== null) this.cleanupOnSave.start(cleanupTarget);
        return saved;
      }
      case "memory.status": return this.client.status(text(params.requestId, messages.fieldLabels.recordNumber), ctx, text(params.audience, messages.fieldLabels.serverConnection));
      case "memory.search": return this.client.search(text(params.query, messages.fieldLabels.searchQuery), ctx);
      case "memory.get": return this.client.get(id(params.id), ctx, text(params.audience, messages.fieldLabels.serverConnection));
      case "memory.update": return this.client.update({ id: id(params.id), audience: text(params.audience, messages.fieldLabels.serverConnection), ...(params.content === undefined ? {} : { content: text(params.content, messages.fieldLabels.content) }),
        ...(params.expectedRevision === undefined ? {} : { expectedRevision: revision(params.expectedRevision) }),
        ...(params.capture === undefined ? {} : { capture: params.capture as Parameters<MemoryClient["update"]>[0]["capture"] }) }, ctx);
      case "assistant.ask": return this.assistant.ask(text(params.question, messages.fieldLabels.question), ctx, text(params.audience, messages.fieldLabels.serverConnection));
      case "ai.probe": {
        if (params.target !== undefined && params.target !== "answer" && params.target !== "cleanup") throw serviceError("INVALID_INPUT", messages.rpc.pickAiTarget);
        return this.ai.probe(params.target ?? "answer", ctx) as Promise<AiProbeResult>;
      }
      case "ai.discover": return discoverAi(ctx.signal);
      case "cleanup.run": return this.cleanup.run({ limit: params.limit as number | undefined }, ctx);
      case "cleanup.list": return this.cleanup.list(ctx);
      case "cleanup.onSaveStatus": return this.cleanupOnSave.report();
      case "install.local": return this.installer.local(ctx);
      case "install.remote": {
        // "백업에서 시작": the backup is found and read back on this PC before the install sends anything (spec 4.2).
        const source = params.restoreFrom === undefined ? undefined : await this.restore.remoteSource(params.restoreFrom, ctx);
        return this.installer.remote(params as unknown as RemoteInstallInput, ctx, source);
      }
      case "ssh.inspect": return this.installer.inspect(params.ssh as SshConnection, ctx);
      // Reads the store's files, not the server: it waits on no connection and runs beside one, but not beside an
      // update being finished (`BACKUP_UPDATE_RUNNING`).
      case "backup.export": return this.backup.export(ctx);
      // Outside the connection queue: a restore takes the queue only to stop the server (after the work in it) and
      // to start it again, so saves and questions meanwhile are refused at once (`RESTORE_RUNNING`), not queued.
      // `scope: "remote-install"` is the remote install's "백업에서 시작" list (spec 4.1); without it, the restore screen's.
      case "backup.list": {
        if (params.scope !== undefined && params.scope !== "remote-install") throw serviceError("INVALID_INPUT", messages.rpc.unsupportedRequest);
        return this.restore.list(params.scope === "remote-install" ? "remote-install" : "restore");
      }
      case "backup.restore": return this.restore.restore(params, ctx);
      // The settings backup and the restore are the service's jobs: a settings screen opened again finds them here
      // and joins them, and only its "중단" stops one (`background-job.ts`).
      case "backup.status": return { export: this.backup.status(), restore: this.restore.status() };
      case "backup.join": return this.backupJob(params.kind).join(ctx);
      case "backup.cancel": return { cancelled: this.backupJob(params.kind).cancel() };
      case "dashboard.link": {
        const memoryId = params.memoryId === null || params.memoryId === undefined ? undefined : id(params.memoryId);
        const audience = typeof params.audience === "string" ? params.audience : undefined;
        // A plain dashboard or review link carries no memoryId, so there is nothing for the
        // memory-deeplink capability to gate: skip the extra /client-info round trip entirely.
        const assertSendable = (connection: ConnectionSettings) => this.client.assertSendable(connection);
        if (memoryId === undefined) return { url: await this.config.dashboardLink(assertSendable, undefined, params.review === true, audience) };
        // memory-deeplink capability decides whether the memoryId query parameter is safe to send
        // (an older server without it bounces the link to its dashboard home instead of resolving it).
        // A capability list the server never actually confirmed (network/auth/upgrade/incompatible
        // failure) must not be treated as "no capabilities" -- that would silently drop memoryId and
        // hand back a home link instead of surfacing the real connection failure.
        const status = await this.client.info(ctx.signal);
        if (!status.capabilities) throw serviceError("CONNECTION_FAILED", status.message);
        return { url: await this.config.dashboardLink(assertSendable, memoryId, params.review === true, audience, status.capabilities) };
      }
      default: throw serviceError("INVALID_INPUT", messages.rpc.unsupportedRequest);
    }
  }
  private backupJob(kind: unknown): Pick<BackupService | RestoreService, "join" | "cancel"> {
    if (kind === "export") return this.backup;
    if (kind === "restore") return this.restore;
    throw serviceError("INVALID_INPUT", messages.rpc.unsupportedRequest);
  }

  /** The host's quit began (`service.drain`): running work may still finish, but nothing is started any more for a
   * restore that ends meanwhile (the quit then closes what runs). */
  beginDrain(): void { this.restore.drain(); }

  /** The update gate closes too: a pre-update backup still running is stopped and its partial folder removed. A
   * startup check, a settings backup or a restore still running is stopped as well; a stopped restore does not start
   * the server again. The local server and tunnel close after those, so nothing they started is left behind. */
  async close(): Promise<void> {
    this.startup.close();
    this.cleanupOnSave.close();
    await Promise.all([this.restore.close(), this.backup.close()]);
    await Promise.all([this.installer.close(), this.gate.close()]);
  }
}
