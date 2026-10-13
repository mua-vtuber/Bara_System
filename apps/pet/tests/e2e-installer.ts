/** Manual isolated installer E2E. Never points to production.
 * Run: bun run tests/e2e-installer.ts [--fixture path/to/fixture.json]
 * Default fixture: ignored .omx/ssh-e2e/fixture.json.
 * After the first install it runs the install state scenarios on the same loopback fixture: a plain re-run
 * connects, a stopped service is repaired from a new Pet data folder, a removed `current` link resumes the
 * install, a foreign listener on the port stops the run, another server path is refused, and an inactive core
 * unit (created only when the fixture has none, then removed) stops the install.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { ConfigStore } from "../src/service/config.ts";
import { MemoryClient } from "../src/service/client.ts";
import { InstallManager } from "../src/service/install/index.ts";
import { SSH_COMMAND_TIMEOUT_MS } from "../src/service/install/limits.ts";
import { availableManagedPort } from "../src/service/install/net.ts";
import { runCaptured } from "../src/service/install/process.ts";
import { CORE_SERVICE_UNIT, PET_SERVICE_UNIT, RELEASE_LAYOUT, REMOTE_LAYOUT } from "../src/service/install/remote-probe.ts";
import { findSshTools, knownHostsPath, remoteCommand, shQuote, sshBase } from "../src/service/install/ssh.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import { loadSshFixture } from "./e2e/ssh-fixture.ts";
import { connectionAudience, type RemoteInstallInput, type RequestContext, type RuntimePaths } from "../src/shared/contracts.ts";

const project = resolve(import.meta.dir, "..");
const reportDir = join(project, ".omx", "e2e");
const reportPath = join(reportDir, "installer-report.json");
const resourceDir = join(project, "resources");
const { ssh, fingerprint } = loadSshFixture(Bun.argv.slice(2), project);
const serverPath = ssh.serverPath!;
if (process.platform !== "win32" || !existsSync(join(resourceDir, "payload-manifest.json")))
  throw new Error("Isolated Windows SSH fixture and packaged resources are required");
await mkdir(reportDir, { recursive: true });
const dataDir = await mkdtemp(join(reportDir, "installer-pet-data-"));
const paths: RuntimePaths = { dataDir, resourceDir, bunPath: join(resourceDir, "runtime", "bun.exe") };
const report: Record<string, unknown> = { outcome: "running", stage: "inspect", startedAt: new Date().toISOString(),
  fixture: { host: ssh.host, port: ssh.port, serverPath, service: "bara-pet-memory.service" },
  cleanup: { ownedService: "bara-pet-memory.service", ownedServerPath: serverPath, preserve: "bara-memory.service" },
  localDataDir: dataDir, checks: {}, progress: [],
  limitations: ["ARM64 Bun archive verified by SHA-256 but not executed on ARM64 hardware",
    ssh.user === "root" ? "sudo -n denial not exercised; the isolated fixture uses root" : "sudo -n denial requires a separate restricted fixture"] };
const checks = report.checks as Record<string, boolean>;
const progress = report.progress as Array<{ stage: string }>;
const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const check = (name: string, condition: unknown) => { assert(condition, name); checks[name] = true; };
const ctx: RequestContext = { signal: new AbortController().signal,
  progress(stage) { progress.push({ stage }); report.stage = stage; process.stderr.write(`[installer-e2e] ${stage}\n`); writeFileSync(reportPath, JSON.stringify(report, null, 2)); } };
const vault = new DpapiVault();
const config = new ConfigStore(paths, vault);
const manager = new InstallManager(config, paths);
let restarted: InstallManager | null = null;
let attached: InstallManager | null = null;
const scenarioManagers: InstallManager[] = [];
const install: RemoteInstallInput = { ssh, acceptedFingerprint: fingerprint };
const privileged = ssh.user === "root" ? "" : "sudo -n ";
const tools = findSshTools();

/** One command on the loopback fixture, through the host key the first install trusted. */
async function onFixture(command: string): Promise<string> {
  return (await runCaptured([...sshBase(tools, ssh, knownHostsPath(dataDir)), command], ctx,
    { timeoutMs: SSH_COMMAND_TIMEOUT_MS, stepName: "E2E fixture command" })).stdout.trim();
}

/** A new Pet data folder: no saved connection or token, as after reinstalling the Pet on the PC. */
async function freshPet(label: string): Promise<{ config: ConfigStore; manager: InstallManager }> {
  const petPaths: RuntimePaths = { ...paths, dataDir: await mkdtemp(join(reportDir, `${label}-`)) };
  const petConfig = new ConfigStore(petPaths, new DpapiVault());
  const petManager = new InstallManager(petConfig, petPaths);
  scenarioManagers.push(petManager);
  return { config: petConfig, manager: petManager };
}

async function stopsWith(run: Promise<unknown>, code: string): Promise<boolean> {
  try { await run; return false; } catch (error) { return (error as { code?: string }).code === code; }
}

try {
  await saveReport();
  const inspected = await manager.inspect(ssh, ctx);
  check("fingerprintInspected", inspected.fingerprint === fingerprint && inspected.keyType === "ssh-ed25519");
  report.stage = "fingerprint-rejection";
  let wrongRejected = false;
  const wrongFingerprint = `SHA256:${fingerprint[7] === "A" ? "B" : "A"}${fingerprint.slice(8)}`;
  try { await manager.remote({ ssh, acceptedFingerprint: wrongFingerprint }, ctx); }
  catch (error) { wrongRejected = (error as { code?: string }).code === "SSH_FINGERPRINT_MISMATCH"; }
  check("wrongFingerprintRejected", wrongRejected);

  report.stage = "remote-install";
  const result = await manager.remote({ ssh, acceptedFingerprint: fingerprint }, ctx);
  check("remoteConnectionSaved", result.connection.mode === "remote" && result.connection.ssh?.serverPath === serverPath);
  const snapshot = await config.snapshot();
  check("dpapiScopedTokens", !!snapshot.token && !!snapshot.ownerToken && !JSON.stringify(snapshot.settings).includes(snapshot.token));
  const client = new MemoryClient(config, manager.routes);
  check("authenticatedClientInfo", (await client.info(ctx.signal)).connected);
  const requestId = randomUUID();
  const content = `격리 원격 설치 검증 ${requestId}: 붉은 책갈피는 북쪽 서랍에 있다.`;
  const saved = await client.save({ requestId, audience: connectionAudience(snapshot.settings.connection), content, kind: "decision" }, ctx);
  check("remoteSave", saved.state === "saved" && !!saved.memory && saved.memory.metadata?.capture?.kind === "decision");
  const id = saved.memory!.id;
  report.memoryId = id;
  check("remoteSearch", (await client.search("붉은 책갈피 북쪽 서랍", ctx)).results.some((hit) => hit.memory.id === id));
  check("remoteGet", (await client.get(id, ctx, connectionAudience(snapshot.settings.connection))).content === content);

  report.stage = "restart-connection";
  await manager.close();
  const savedPort = Number(new URL(snapshot.settings.connection.baseUrl).port);
  let occupiedSawBearer = false;
  const occupant = Bun.serve({ hostname: "127.0.0.1", port: savedPort, fetch(request) {
    if (request.headers.has("authorization")) occupiedSawBearer = true;
    return Response.json({ protocolVersion: 1, capabilities: [] });
  } });
  restarted = new InstallManager(config, paths);
  try { await restarted.ensureConnection(ctx); }
  finally { occupant.stop(true); }
  check("occupiedPortSawNoBearer", !occupiedSawBearer);
  check("portReboundWithSameCredentials", (await config.snapshot()).token === snapshot.token &&
    (await config.snapshot()).ownerToken === snapshot.ownerToken &&
    (await config.load()).connection.baseUrl !== snapshot.settings.connection.baseUrl);
  const restartedClient = new MemoryClient(config, restarted.routes);
  check("restartedTunnel", (await restartedClient.info(ctx.signal)).connected && (await restartedClient.get(id, ctx)).id === id);
  check("remoteStatus", await restarted.status());
  await restarted.close();
  restarted = null;

  report.stage = "existing-ssh-attach";
  const existingDataDir = await mkdtemp(join(reportDir, "existing-ssh-data-"));
  report.existingDataDir = existingDataDir;
  const existingPaths: RuntimePaths = { ...paths, dataDir: existingDataDir };
  const existingConfig = new ConfigStore(existingPaths, new DpapiVault());
  const localPort = await availableManagedPort();
  await existingConfig.save({ connection: { mode: "existing", baseUrl: `http://127.0.0.1:${localPort}`, ssh },
    ownerToken: snapshot.ownerToken! });
  attached = new InstallManager(existingConfig, existingPaths);
  await attached.ensureConnection(ctx); // no client token yet; must tunnel and check /health
  const existingClient = new MemoryClient(existingConfig, attached.routes);
  const enrollment = await existingClient.enrollmentStart(ctx); // owner approval, no reinstall
  check("existingSshOwnerEnrollment", enrollment.state === "approved" && !!(await existingConfig.getToken()));
  check("existingSshPreservesMemory", (await existingClient.get(id, ctx)).content === content);
  check("existingAttachNotInstalled", !(await attached.status()));

  report.stage = "rerun-connect";
  const rerun = new InstallManager(config, paths);
  scenarioManagers.push(rerun);
  const beforeRerun = await config.snapshot();
  const reconnected = await rerun.remote(install, ctx);
  const afterRerun = await config.snapshot();
  check("rerunConnectsWithoutReinstall", reconnected.message === messages.remoteInstall.connected);
  check("rerunKeepsTokensAndAudience", afterRerun.token === beforeRerun.token && afterRerun.ownerToken === beforeRerun.ownerToken &&
    connectionAudience(afterRerun.settings.connection) === connectionAudience(beforeRerun.settings.connection));
  check("rerunServesMemory", (await new MemoryClient(config, rerun.routes).get(id, ctx)).content === content);
  await rerun.close();

  report.stage = "repair-stopped-service";
  await onFixture(`${privileged}systemctl stop ${shQuote(PET_SERVICE_UNIT)}`);
  const repairPet = await freshPet("installer-repair-data");
  check("stoppedServiceRepaired", (await repairPet.manager.remote(install, ctx)).message === messages.remoteInstall.repaired);
  const repairedTokens = await repairPet.config.snapshot();
  check("repairReadsInstalledTokens", repairedTokens.token === snapshot.token && repairedTokens.ownerToken === snapshot.ownerToken);
  check("repairKeepsMemory", (await new MemoryClient(repairPet.config, repairPet.manager.routes).get(id, ctx)).content === content);
  check("repairedServiceActive", await onFixture(`systemctl is-active ${shQuote(PET_SERVICE_UNIT)}`) === "active");
  await repairPet.manager.close();

  report.stage = "resume-missing-current";
  const currentLink = `${serverPath}/${REMOTE_LAYOUT.current}`;
  await onFixture(`rm -- ${shQuote(currentLink)}`);
  const resumePet = await freshPet("installer-resume-data");
  check("missingCurrentResumesInstall", (await resumePet.manager.remote(install, ctx)).message === messages.remoteInstall.installed);
  check("resumeKeepsTokens", (await resumePet.config.snapshot()).token === snapshot.token);
  check("resumeKeepsMemory", (await new MemoryClient(resumePet.config, resumePet.manager.routes).get(id, ctx)).content === content);
  check("currentLinkRestored", (await onFixture(`readlink -- ${shQuote(currentLink)}`)).startsWith(`${serverPath}/${REMOTE_LAYOUT.releases}/`));
  await resumePet.manager.close();

  report.stage = "port-busy";
  const occupantUnit = "bara-pet-e2e-occupant.service";
  const occupantScript = `Bun.serve({ hostname: "127.0.0.1", port: ${ssh.serverPort}, fetch: () => new Response("e2e occupant") })`;
  await onFixture(`${privileged}systemctl stop ${shQuote(PET_SERVICE_UNIT)} && ` +
    `${privileged}systemd-run --unit=${occupantUnit} --collect ${remoteCommand([`${currentLink}/${RELEASE_LAYOUT.bun}`, "-e", occupantScript])} >/dev/null 2>&1 && ` +
    `for attempt in 1 2 3 4 5 6 7 8 9 10; do ss -ltnH ${shQuote(`( sport = :${ssh.serverPort} )`)} | grep -q . && exit 0; sleep 1; done; exit 1`);
  try {
    const busyPet = await freshPet("installer-busy-data");
    check("foreignListenerStopsRun", await stopsWith(busyPet.manager.remote(install, ctx), "REMOTE_PORT_BUSY"));
    await busyPet.manager.close();
  } finally { await onFixture(`${privileged}systemctl stop ${occupantUnit}`); }
  const restoredPet = await freshPet("installer-restore-data");
  check("serviceRepairedAfterPortFreed", (await restoredPet.manager.remote(install, ctx)).message === messages.remoteInstall.repaired);
  await restoredPet.manager.close();

  report.stage = "other-server-path";
  const otherPath = `${posix.dirname(serverPath)}-other/install`;
  assert(/^\/tmp\/bara-pet-[A-Za-z0-9_-]+\/install$/.test(otherPath), "other path must stay an app-owned /tmp fixture path");
  const otherPet = await freshPet("installer-other-data");
  check("otherPathKeepsInstalledServer", await stopsWith(otherPet.manager.remote({ ...install, ssh: { ...ssh, serverPath: otherPath } }, ctx),
    "REMOTE_OTHER_PET_SERVER"));
  check("otherPathNotCreated", await onFixture(`if test -e ${shQuote(otherPath)}; then printf exists; else printf absent; fi`) === "absent");
  await otherPet.manager.close();

  report.stage = "existing-core";
  const coreUnitPath = `/etc/systemd/system/${CORE_SERVICE_UNIT}`;
  if (await onFixture(`if systemctl cat ${shQuote(CORE_SERVICE_UNIT)} >/dev/null 2>&1; then printf present; else printf absent; fi`) === "present") {
    report.skipped = { existingCore: `${CORE_SERVICE_UNIT} already exists on the fixture and was left untouched` };
  } else {
    await onFixture(`printf '%s\\n' '[Unit]' 'Description=Bara Pet installer E2E placeholder, never started' '[Service]' ` +
      `'Type=oneshot' 'ExecStart=/bin/true' | ${privileged}tee ${shQuote(coreUnitPath)} >/dev/null && ${privileged}systemctl daemon-reload`);
    try {
      const corePet = await freshPet("installer-core-data");
      check("inactiveCoreStopsInstall", await stopsWith(corePet.manager.remote(install, ctx), "REMOTE_EXISTING_CORE"));
      await corePet.manager.close();
    } finally { await onFixture(`${privileged}rm -f -- ${shQuote(coreUnitPath)} && ${privileged}systemctl daemon-reload`); }
  }

  report.stage = "complete";
  report.outcome = "passed";
  report.finishedAt = new Date().toISOString();
  await saveReport();
  process.stdout.write(JSON.stringify({ outcome: "passed", checks: Object.keys(checks).length,
    memoryId: id, report: reportPath }) + "\n");
} catch (error) {
  report.outcome = "failed";
  report.errorCode = (error as { code?: string }).code ?? "E2E_FAILURE";
  report.errorMessage = error instanceof Error ? error.message : "Installer E2E failed";
  report.finishedAt = new Date().toISOString();
  await saveReport();
  process.stderr.write(`[installer-e2e] failed at ${report.stage}: ${report.errorCode} ${report.errorMessage}\n`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([manager.close(), restarted?.close(), attached?.close(), ...scenarioManagers.map((pet) => pet.close())]
    .filter(Boolean) as Promise<void>[]);
}
