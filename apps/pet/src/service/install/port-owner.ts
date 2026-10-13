import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { tunnelPort } from "../validation.ts";
import { LISTENER_PROBE_TIMEOUT_MS, PORT_OWNER_LOOKUP_TIMEOUT_MS, TUNNEL_OWNER_TIMEOUT_MS } from "./limits.ts";
import { isRunning, runCaptured, windowsSystemRoot } from "./process.ts";

/** Pause between listener checks while a started child has not bound its port yet. */
const LISTENER_POLL_MS = 150;
/** Last line of the Windows lookup. Proves the query ran to the end instead of stopping early. */
const LOOKUP_END = "END";

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`Invalid TCP port: ${port}`);
}

/** Windows lookup output: one owning process id per listening socket, then `END`. */
export function parseWindowsOwners(output: string): Set<number> {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.pop() !== LOOKUP_END || lines.some((line) => !/^\d+$/.test(line)))
    throw serviceError("PORT_OWNER_UNKNOWN", messages.installService.ownerLookupUnreadable);
  return new Set(lines.map(Number));
}

/** `ss -ltnp` output. A listener whose process is hidden (another user's socket without
 * privileges) makes ownership unknown instead of silently leaving it out of the owner set. */
export function parseSsOwners(output: string): Set<number> {
  const owners = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!/^LISTEN\s/.test(line)) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    if (pids.length === 0)
      throw serviceError("PORT_OWNER_UNKNOWN", messages.installService.ownerNoPermission);
    for (const pid of pids) owners.add(pid);
  }
  return owners;
}

function lookupArgv(port: number): string[] {
  if (process.platform === "win32") {
    const powershell = join(windowsSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!existsSync(powershell))
      throw serviceError("PORT_OWNER_UNKNOWN", messages.installService.powershellMissing);
    // CIM rather than Get-NetTCPConnection: no match is an empty result instead of an error, so
    // every error that remains is a real failure. State 2 is Listen.
    const query = "Get-CimInstance -Namespace 'ROOT/StandardCimv2' -ClassName 'MSFT_NetTCPConnection' " +
      `-Filter 'LocalPort = ${port} AND State = 2'`;
    return [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
      `foreach ($row in @(${query})) { $row.OwningProcess }; '${LOOKUP_END}'`];
  }
  const ss = Bun.which("ss");
  if (!ss) throw serviceError("PORT_OWNER_UNKNOWN", messages.installService.ssCommandMissing);
  return [ss, "-ltnp", "sport", "=", `:${port}`];
}

/** Every process listening on the TCP port, on any local address, read from the OS listener
 * table. Never inferred from a responding endpoint: another process can serve the same port.
 * Runs as an asynchronous child process, so other requests and cancellation keep being handled
 * while the lookup is in flight. */
export async function listeningOwners(port: number, signal: AbortSignal): Promise<Set<number>> {
  assertPort(port);
  const { stdout } = await runCaptured(lookupArgv(port), { signal },
    { timeoutMs: PORT_OWNER_LOOKUP_TIMEOUT_MS, stepName: messages.installSteps.portOwnerLookup });
  return process.platform === "win32" ? parseWindowsOwners(stdout) : parseSsOwners(stdout);
}

/** True only when `pid` is the one and only listener. */
export function isSoleOwner(owners: ReadonlySet<number>, pid: number): boolean {
  return owners.size === 1 && owners.has(pid);
}

/** True only when a loopback connect is actively refused, meaning nothing accepts connections on
 * 127.0.0.1:port. A connect that succeeds, stalls, or fails in another way leaves the decision to
 * the listener lookup. Nothing is ever written on the probe connection. */
function connectionRefused(port: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => done(false), LISTENER_PROBE_TIMEOUT_MS);
    const onAbort = () => { cleanup(); reject(signal.reason); };
    function cleanup(): void { clearTimeout(timer); signal.removeEventListener("abort", onAbort); socket.destroy(); }
    function done(refused: boolean): void { cleanup(); resolve(refused); }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => done(false));
    socket.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
  });
}

export type ListenerState =
  /** Nothing accepts connections on 127.0.0.1:port. */
  | { kind: "none" }
  /** The expected process is the port's only listener. */
  | { kind: "sole" }
  /** Another process listens on the port, alone or next to the expected process. */
  | { kind: "other"; others: number[] }
  /** A connection was accepted, but the listener table showed no listener for the port. */
  | { kind: "unknown" };

/** Probe first; run the listener lookup only when something may be listening. */
export async function inspectListener(port: number, signal: AbortSignal, expectedPid?: number): Promise<ListenerState> {
  assertPort(port);
  if (await connectionRefused(port, signal)) return { kind: "none" };
  const owners = await listeningOwners(port, signal);
  if (expectedPid !== undefined && isSoleOwner(owners, expectedPid)) return { kind: "sole" };
  const others = [...owners].filter((pid) => pid !== expectedPid).sort((a, b) => a - b);
  return others.length > 0 ? { kind: "other", others } : { kind: "unknown" };
}

export interface OwnershipFailures {
  /** The child exited, so it cannot own the port. */
  exited(): Error;
  /** Another process listens on the port, alone or next to the child. */
  taken(others: readonly number[]): Error;
  /** No sole ownership: at check time for `assertSoleListener`, by the deadline for `waitForSoleListener`. */
  unverified(): Error;
}

async function childListener(child: Bun.Subprocess, port: number, signal: AbortSignal,
  failures: OwnershipFailures): Promise<ListenerState> {
  signal.throwIfAborted();
  if (!isRunning(child)) throw failures.exited();
  const state = await inspectListener(port, signal, child.pid);
  // A child that exited during the lookup no longer holds the port, whatever the table said.
  if (!isRunning(child)) throw failures.exited();
  if (state.kind === "other") throw failures.taken(state.others);
  return state;
}

/** Verify, right before a credential is sent, that `child` alone listens on the port. */
export async function assertSoleListener(child: Bun.Subprocess, port: number, signal: AbortSignal,
  failures: OwnershipFailures): Promise<void> {
  if ((await childListener(child, port, signal, failures)).kind !== "sole") throw failures.unverified();
}

/** Wait until `child` alone listens on the port. While the child has not bound yet the loopback
 * probe is refused and no lookup runs; at least one check runs even with no time left. */
export async function waitForSoleListener(child: Bun.Subprocess, port: number, signal: AbortSignal,
  timeoutMs: number, failures: OwnershipFailures): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while ((await childListener(child, port, signal, failures)).kind !== "sole") {
    if (Date.now() >= deadline) throw failures.unverified();
    await Bun.sleep(LISTENER_POLL_MS);
  }
}

function requireTunnelPort(baseUrl: string): number {
  const port = tunnelPort(baseUrl);
  if (port === null) throw serviceError("SSH_TUNNEL_URL_INVALID", messages.installService.tunnelAddressInvalid);
  return port;
}

function tunnelTaken(port: number, others: readonly number[]): Error {
  return serviceError("SSH_TUNNEL_BIND_FAILED", messages.installService.tunnelPortTaken(port, others));
}

/** Wait until a started SSH tunnel is the only listener on its local port. */
export async function waitForTunnelListener(tunnel: Bun.Subprocess, baseUrl: string, signal: AbortSignal,
  timeoutMs: number = TUNNEL_OWNER_TIMEOUT_MS): Promise<void> {
  const port = requireTunnelPort(baseUrl);
  await waitForSoleListener(tunnel, port, signal, timeoutMs, {
    exited: () => serviceError("SSH_TUNNEL_BIND_FAILED", messages.installService.tunnelBindFailed),
    taken: (others) => tunnelTaken(port, others),
    unverified: () => serviceError("SSH_TUNNEL_OWNER_UNKNOWN", messages.installService.tunnelOwnerUnknown),
  });
}

/** Before each credentialed request through the tunnel: the tunnel still alone owns its port. */
export async function assertTunnelListener(tunnel: Bun.Subprocess, baseUrl: string, signal: AbortSignal): Promise<void> {
  const port = requireTunnelPort(baseUrl);
  const lost = () => serviceError("SSH_TUNNEL_BIND_FAILED", messages.installService.tunnelPortLost);
  await assertSoleListener(tunnel, port, signal, { exited: lost, taken: (others) => tunnelTaken(port, others), unverified: lost });
}
