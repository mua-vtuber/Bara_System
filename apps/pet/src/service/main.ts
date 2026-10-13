import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { parseFrame, publicError, NativeVault } from "./protocol.ts";
import { PetService } from "./router.ts";
import { openMaintenance } from "./maintenance/manifest.ts";
import { managedDatabase } from "./maintenance/upgrade.ts";
import { recoverRestore } from "./restore-journal.ts";
import { PET_VERSION } from "../shared/version.ts";
import { ceilingFor, runWithCeiling } from "./operation-limits.ts";
import type { RuntimePaths } from "../shared/contracts.ts";
import { progressReporter } from "./progress-frames.ts";
import { messages } from "../ui/messages.ts";
import nativeHost from "../shared/native-host.json";

/** Sent every `contract.serviceHeartbeatMs` while any operation is in progress. The native host
 * waits for a reply as long as some line keeps arriving and stops this process only after
 * `contract.serviceSilenceLimitMs` without one; per-operation limits are this service's own. */
const ALIVE_FRAME = { event: "alive" } as const;

function runtimePaths(): RuntimePaths {
  const dataDir = process.env.BARA_PET_DATA_DIR;
  const resourceDir = process.env.BARA_PET_RESOURCES;
  if (!dataDir || !resourceDir) throw new Error("BARA_PET_DATA_DIR and BARA_PET_RESOURCES are required");
  // Only an absolute folder from the host counts; without one a backup is refused rather than written elsewhere.
  const backupDir = process.env.BARA_PET_BACKUP_DIR;
  return { dataDir: resolve(dataDir), resourceDir: resolve(resourceDir), bunPath: resolve(process.env.BARA_PET_BUN || process.execPath),
    ...(backupDir && isAbsolute(backupDir) ? { backupDir: resolve(backupDir) } : {}) };
}
function send(frame: unknown): void {
  if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(frame)}\n`);
}
const vault = new NativeVault(send);
const paths = runtimePaths();
// A restore's switch a crash cut off is finished or undone before anything reads the store, the version record's
// "is there data" check below included. A failure here is not fatal: every start of the local server tries again
// (`RestoreService.beforeStart`) and refuses to open a store that is not whole.
await recoverRestore(paths.dataDir, () => new Date()).catch(() => {});
/** Once per start: records which app version runs on this data (see `maintenance/manifest.ts`). With the managed
 * database already there, a first run is deferred like an update until that database is backed up (`maintenance/upgrade.ts`). */
const maintenance = await openMaintenance(paths, PET_VERSION, { existingData: existsSync(managedDatabase(paths.dataDir)) });
const service = new PetService(paths, vault, maintenance);
const operations = new Map<string, AbortController>();
const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
let closing = false;
/** Set by the host's `service.drain`: no new work is accepted, the running work may finish. */
let draining = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** The longest the host's quit waits for running work before cancelling it (`contract.serviceDrainMs`, which
 * the host also uses for its own wait), and the extra time the cancelled
 * work gets to answer. A save the server confirmed in that window reaches the screen as saved; one still open
 * is answered as cancelled and its draft and request id stay for the next start (never resent on its own). */
const DRAIN_LIMIT_MS = nativeHost.contract.serviceDrainMs;
const CANCEL_GRACE_MS = 2_000;

/** Runs the heartbeat exactly while `operations` is not empty, so an idle service stays quiet. */
function syncHeartbeat(): void {
  if (operations.size > 0 && !closing) {
    heartbeat ??= setInterval(() => send(ALIVE_FRAME), nativeHost.contract.serviceHeartbeatMs);
  } else if (heartbeat !== undefined) {
    clearInterval(heartbeat); heartbeat = undefined;
  }
}

async function stop(): Promise<void> {
  if (closing) return; closing = true;
  syncHeartbeat();
  for (const controller of operations.values()) controller.abort();
  vault.close(); lines.close();
  await service.close().catch(() => {});
}
async function idle(withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (operations.size > 0 && Date.now() < until) await Bun.sleep(50);
  return operations.size === 0;
}

/** The host's graceful quit: refuse new work, let running work finish within `timeoutMs` (capped at
 * `DRAIN_LIMIT_MS`), cancel what is left, close what this service started (local server, SSH tunnel), then
 * answer. The host ends the process tree after the answer, or after its own limit if none comes. */
async function drain(id: string, params: Record<string, unknown>): Promise<void> {
  draining = true;
  // Before anything is cancelled: a restore that ends from here on must not start the memory server again.
  service.beginDrain();
  const requested = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? params.timeoutMs : DRAIN_LIMIT_MS;
  const finished = await idle(Math.max(0, Math.min(requested, DRAIN_LIMIT_MS)));
  const cancelled = finished ? 0 : operations.size;
  if (!finished) { for (const controller of operations.values()) controller.abort(); await idle(CANCEL_GRACE_MS); }
  await service.close().catch(() => {});
  send({ id, result: { finished, cancelled } });
}

process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
process.stdout.on("error", () => { void stop(); });

async function handle(line: string): Promise<void> {
  let frame;
  try { frame = parseFrame(line, true); }
  catch { send({ id: "protocol", error: { code: "INVALID_INPUT", message: messages.rpc.invalidFrame } }); return; }
  if ("hostReply" in frame) { vault.accept(frame); return; }
  if (closing) return;
  if (operations.has(frame.id)) { send({ id: frame.id, error: { code: "DUPLICATE_REQUEST", message: messages.rpc.duplicateRequest } }); return; }
  const params = frame.params as Record<string, unknown>;
  if (frame.method === "service.drain") { void drain(frame.id, params); return; }
  if (draining) { send({ id: frame.id, error: { code: "SHUTTING_DOWN", message: messages.rpc.shuttingDown } }); return; }
  if (frame.method === "operation.cancel") {
    const controller = typeof params.requestId === "string" ? operations.get(params.requestId) : undefined;
    controller?.abort(); send({ id: frame.id, result: { cancelled: !!controller } }); return;
  }
  if (operations.size >= 16) { send({ id: frame.id, error: { code: "BUSY", message: messages.rpc.tooManyOperations } }); return; }
  const controller = new AbortController(); operations.set(frame.id, controller); syncHeartbeat();
  const progress = progressReporter(frame.id, (frameOut) => { if (!closing) send(frameOut); });
  try {
    const result = await runWithCeiling((signal) => service.dispatch(frame.method as Exclude<typeof frame.method, "service.drain">, params,
      { signal, progress }, [...operations.keys()]), ceilingFor(frame.method), controller.signal);
    if (!closing) send({ id: frame.id, result });
  } catch (error) {
    if (!closing) send({ id: frame.id, error: controller.signal.aborted ? { code: "CANCELLED", message: messages.rpc.cancelled } : publicError(error) });
  } finally { operations.delete(frame.id); syncHeartbeat(); }
}
for await (const line of lines) void handle(line);
await stop();
