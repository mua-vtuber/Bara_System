/** `bun run deploy:a1` (spec 5.4): build this checkout's bundle with the Pet installer's builder and replace the
 * release on the server the Pet's saved remote connection names. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ProgressStage, RequestContext } from "../src/shared/contracts.ts";
import { messages } from "../src/ui/messages.ts";
import { ServiceError, serviceError } from "../src/service/errors.ts";
import { causeOf } from "../src/service/fetch-failure.ts";
import { petDataDir, readDeployConnection } from "../src/service/install/deploy-target.ts";
import { SERVER_ADAPTERS_DIR_ENV } from "../src/service/install/adapter-registry.ts";
import { adapterLayout, adapterUnitName, deployAdapter, removeAdapter } from "../src/service/install/adapter-component.ts";
import { openSession } from "../src/service/install/remote-session.ts";
import { probeInstalled, replaceServer } from "../src/service/install/server-component.ts";
import { ShellReleaseHost, SystemdControl, sshTransport } from "../src/service/install/release-host.ts";
import { PET_SERVICE_UNIT, REMOTE_LAYOUT, remoteBlockError, type RemoteArch } from "../src/service/install/remote-probe.ts";
import { SERVER_COMPONENT } from "../src/service/install/release-record.ts";
import type { ReleaseBundle, ReplaceResult } from "../src/service/install/release-swap.ts";
import { BUN_VERSION, DIRTY_PATHS_SHOWN, REPO_ROOT, buildComponentBundle, bundlePaths, dirtyPaths, linuxBun, type BundleComponent } from "./release-bundle.ts";

/** Downloaded Linux Bun archives, checked against their pinned digests on every use (release-bundle.ts `ASSETS`). */
export const DEPLOY_CACHE_DIR = join(tmpdir(), "bara-deploy-cache");

export interface DeployArgs { adapter: string | null; settings: string | null; remove: boolean }
export function parseDeployArgs(argv: string[]): DeployArgs {
  let values: { adapter?: string; settings?: string; remove?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { adapter: { type: "string" }, settings: { type: "string" }, remove: { type: "boolean" } } }));
  } catch (error) { throw serviceError("DEPLOY_ARGS_INVALID", messages.deployCli.DEPLOY_ARGS_INVALID(error instanceof Error ? error.message : String(error))); }
  const adapter = values.adapter ?? null, settings = values.settings ?? null, remove = values.remove === true;
  if (adapter === null && (settings !== null || remove)) throw serviceError("DEPLOY_ARGS_INVALID", messages.deployCli.DEPLOY_ARGS_INVALID(messages.deployCli.adapterOnlyOptions));
  if (remove && settings !== null) throw serviceError("DEPLOY_ARGS_INVALID", messages.deployCli.DEPLOY_ARGS_INVALID(messages.deployCli.removeWithSettings));
  return { adapter, settings: settings === null ? null : resolve(settings), remove };
}

export interface DeployEnvironment { env: Record<string, string | undefined>; repoRoot: string; cacheDir: string }
const DEFAULT_ENVIRONMENT: DeployEnvironment = { env: process.env, repoRoot: REPO_ROOT, cacheDir: DEPLOY_CACHE_DIR };

export type DeployBundle = ReleaseBundle & { workDir: string; startFile: string };
async function componentBundle(component: BundleComponent, arch: RemoteArch, scratch: string, environment: DeployEnvironment): Promise<DeployBundle> {
  const built = await buildComponentBundle(environment.repoRoot, join(scratch, "bundle"), component);
  const bun = await linuxBun(arch, environment.cacheDir);
  return { archive: built.archive, bun: bun.path, bunSha: bun.sha256, workDir: built.workDir, startFile: built.startFile,
    record: { component: component.kind === "server" ? SERVER_COMPONENT : component.name, appVersion: built.appVersion,
      sourceSha: built.sourceSha, origin: "dev", commit: built.commit } };
}

/** What the user is told after a replace: the result line, then a warning for a lock folder left behind and a note
 * when a cancel arrived after the new version had already passed its check. */
export function resultLines(component: string, version: string, result: ReplaceResult): string[] {
  const lines = [result.kind === "unchanged" ? messages.deployCli.unchanged(component, result.release) : messages.deployCli.done(component, version, result.release)];
  if (result.kind === "replaced" && result.cancelledAfterCheck) lines.push(messages.deployCli.cancelledAfterCheck);
  if (result.leftoverLock !== null) lines.push(messages.deployCli.leftoverLock(result.leftoverLock));
  return lines;
}

/** What the user is told after an adapter install, update or removal: the dashboard follows only after the memory server
 * restarts (it reads adapter manifests at start; the deploy does not restart it), and a server whose unit lacks the
 * adapters variable must be updated first. */
export function adapterDashboardLines(serverEnv: Record<string, string>): string[] {
  const lines = [messages.deployCli.adapterDashboardAfterRestart(`sudo systemctl restart ${PET_SERVICE_UNIT}`)];
  if (serverEnv[SERVER_ADAPTERS_DIR_ENV] === undefined) lines.push(messages.deployCli.adapterServerNeedsUpdate(SERVER_ADAPTERS_DIR_ENV));
  return lines;
}

/** A service error is printed whole (stopped-state errors carry backup and previous-folder paths); anything else gets the generic sentence. */
export function describeFailure(error: unknown): string {
  return error instanceof ServiceError ? error.publicMessage : messages.deployCli.unexpected(causeOf(error));
}

/** The progress stage `replaceRelease` reports right before it stops the running service and moves `current`
 * (release-swap.ts `swap`). From then on stopping halfway would leave the component in no known state. */
const SWITCH_STAGE: ProgressStage = "service";
export type InterruptPhase = "preparing" | "switching";

/** What one Ctrl+C does: before the switch the first one cancels (nothing running is changed); once the switch has
 * begun none cancels, the replace runs its switch or recovery to the end and the user is told so. */
export function interruptDecision(phase: InterruptPhase, alreadyInterrupted: boolean): { abort: boolean; line: string } {
  if (phase === "switching") return { abort: false, line: messages.deployCli.finishingSwitch };
  return { abort: !alreadyInterrupted, line: messages.deployCli.cancelling };
}

export interface InterruptGuard { readonly interrupted: boolean; progress(stage: ProgressStage): void; interrupt(): void }

/** Ties Ctrl+C to `controller` by `interruptDecision`; `progress` must see every stage the deploy reports. */
export function interruptGuard(controller: AbortController, say: (line: string) => void): InterruptGuard {
  let phase: InterruptPhase = "preparing";
  let interrupted = false;
  return {
    get interrupted() { return interrupted; },
    progress(stage) { if (stage === SWITCH_STAGE) phase = "switching"; },
    interrupt() {
      const decision = interruptDecision(phase, interrupted);
      interrupted = true;
      say(decision.line);
      if (decision.abort) controller.abort(serviceError("DEPLOY_CANCELLED", messages.deployCli.DEPLOY_CANCELLED));
    },
  };
}

export async function deploy(args: DeployArgs, ctx: RequestContext, log: (line: string) => void,
  environment: DeployEnvironment = DEFAULT_ENVIRONMENT): Promise<void> {
  const dataDir = petDataDir(environment.env);
  const ssh = await readDeployConnection(dataDir);
  const component: BundleComponent = args.adapter === null ? { kind: "server" } : { kind: "adapter", name: args.adapter };
  if (component.kind === "adapter") adapterUnitName(component.name);
  if (!args.remove) {
    const dirty = dirtyPaths(environment.repoRoot, bundlePaths(component));
    if (dirty.length > 0) {
      const shown = dirty.slice(0, DIRTY_PATHS_SHOWN).join(", ") + (dirty.length > DIRTY_PATHS_SHOWN ? ", ..." : "");
      throw serviceError("DEPLOY_DIRTY_TREE", messages.deployCli.DEPLOY_DIRTY_TREE(dirty.length, shown));
    }
    // Checked after the refusals above so they report the same on any Bun, and before anything is sent.
    if (process.versions.bun !== BUN_VERSION) throw serviceError("DEPLOY_BUN_VERSION", messages.deployCli.DEPLOY_BUN_VERSION(BUN_VERSION, process.versions.bun));
  }
  const session = await openSession(ssh, dataDir, ctx);
  const probed = await probeInstalled(session);
  if (probed.kind === "blocked") throw remoteBlockError(probed.block);
  if (probed.kind === "incomplete") throw serviceError("DEPLOY_SERVER_NOT_READY", messages.deployCli.DEPLOY_SERVER_NOT_READY);
  const shell = sshTransport(session);
  const files = new ShellReleaseHost(shell);
  const scratch = await mkdtemp(join(tmpdir(), "bara-deploy-"));
  try {
    if (component.kind === "server") {
      const bundle = await componentBundle(component, probed.host.arch, scratch, environment);
      const control = new SystemdControl(shell, PET_SERVICE_UNIT, probed.host.elevated,
        { scratchDir: scratch, remoteIncoming: `${probed.host.serverPath}/${REMOTE_LAYOUT.incoming}` });
      for (const line of resultLines(SERVER_COMPONENT, bundle.record.appVersion, await replaceServer({ host: files, control, units: control, user: ssh.user }, probed, bundle, ctx))) log(line);
      return;
    }
    const layout = adapterLayout(probed.host.serverPath, component.name);
    const control = new SystemdControl(shell, adapterUnitName(component.name), probed.host.elevated, { scratchDir: scratch, remoteIncoming: layout.incoming });
    if (args.remove) {
      const removed = await removeAdapter({ host: files, control, units: control, name: component.name, layout });
      log(messages.deployCli.adapterRemoved(component.name, removed.dataDir));
      for (const line of adapterDashboardLines(probed.env)) log(line);
      return;
    }
    const timeZone = probed.env.TZ;
    if (!timeZone) throw serviceError("ADAPTER_SERVER_ENV_MISSING", messages.adapterErrors.ADAPTER_SERVER_ENV_MISSING("TZ"));
    const bundle = await componentBundle(component, probed.host.arch, scratch, environment);
    const result = await deployAdapter({ host: files, control, units: control, bundle, settingsFile: args.settings, ctx,
      unit: { name: component.name, user: ssh.user, layout, workDir: bundle.workDir, startFile: bundle.startFile, serverPort: probed.server.port, timeZone } });
    for (const line of resultLines(component.name, bundle.record.appVersion, result)) log(line);
    for (const line of adapterDashboardLines(probed.env)) log(line);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const controller = new AbortController();
  const guard = interruptGuard(controller, (line) => console.error(line));
  const onInterrupt = () => guard.interrupt();
  process.on("SIGINT", onInterrupt);
  const ctx: RequestContext = { signal: controller.signal, progress: (stage) => { guard.progress(stage); console.error(messages.progress[stage]); } };
  try {
    await deploy(parseDeployArgs(Bun.argv.slice(2)), ctx, (line) => console.log(line));
    if (guard.interrupted) {
      console.error(messages.deployCli.interruptedButFinished);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(describeFailure(error));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
