import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionSettings, RequestContext, SshConnection } from "../../shared/contracts.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { ConfigStore, type CredentialSnapshot } from "../config.ts";
import { InstallManager } from "./index.ts";
import { tunnelCommand } from "./remote.ts";
import { keepsTunnel, TunnelKeeper, type KeepOutcome } from "./tunnel-keeper.ts";
import { TUNNEL_KEEPALIVE_INTERVAL_S, TUNNEL_KEEPALIVE_MAX_MISSED } from "./limits.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const DELAYS = { firstMs: 20, maxMs: 80 };
/** How much earlier than the asked wait a timer may be seen to fire. The event loop starts a timer from its cached
 * loop time, which on Windows can lag the Date.now() taken when the attempt began, so a 40 ms wait was seen as 37 ms
 * on the CI runner. Kept below half of every gap the checks tell apart (20 vs 40, 40 vs 80). */
const TIMER_EARLY_MS = 10;
const token = (seed: string) => seed.repeat(48);

/** Resolves once `check` holds, polling the real event loop; fails the test after `limitMs`. */
async function until(check: () => boolean, limitMs = 2_000): Promise<void> {
  const end = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await Bun.sleep(5);
  }
}

/** Attempts the keeper runs, answered in order by `answers` (the last one repeats), with when each started. */
function attempts(answers: Array<KeepOutcome | Error>) {
  const started: number[] = [];
  const signals: AbortSignal[] = [];
  const run = async (signal: AbortSignal): Promise<KeepOutcome> => {
    started.push(Date.now());
    signals.push(signal);
    const answer = answers[Math.min(started.length - 1, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { started, signals, run };
}

test("a lost tunnel is opened again after the first wait, and an open tunnel ends the attempts", async () => {
  const log = attempts(["kept"]);
  const keeper = new TunnelKeeper(log.run, DELAYS);
  const lostAt = Date.now();
  keeper.lost();
  expect(keeper.pending).toBe(true);
  await until(() => log.started.length === 1 && !keeper.pending);
  expect(log.started[0]! - lostAt).toBeGreaterThanOrEqual(DELAYS.firstMs - TIMER_EARLY_MS);
  await Bun.sleep(DELAYS.maxMs * 2);
  expect(log.started).toHaveLength(1);
  expect(keeper.lastFailure()).toBeNull();
});

test("failed attempts try again with a doubling wait up to the limit, and keep the last failure until one opens", async () => {
  const refused = new Error("refused");
  const log = attempts([refused, refused, refused, refused, "kept"]);
  const keeper = new TunnelKeeper(log.run, DELAYS);
  keeper.lost();
  await until(() => log.started.length === 4);
  expect(keeper.lastFailure()).toBe(refused);
  await until(() => log.started.length === 5 && !keeper.pending);
  expect(keeper.lastFailure()).toBeNull();
  const waits = log.started.slice(1).map((at, index) => at - log.started[index]!);
  // 40, 80, 80 (capped), 80: never faster than the doubling, never slower than the cap allows by much.
  expect(waits[0]!).toBeGreaterThanOrEqual(DELAYS.firstMs * 2 - TIMER_EARLY_MS);
  expect(waits[1]!).toBeGreaterThanOrEqual(DELAYS.maxMs - TIMER_EARLY_MS);
  expect(waits[2]!).toBeGreaterThanOrEqual(DELAYS.maxMs - TIMER_EARLY_MS);
  expect(Math.max(...waits)).toBeLessThan(DELAYS.maxMs * 4);
  await Bun.sleep(DELAYS.maxMs * 2);
  expect(log.started).toHaveLength(5);
});

test("a connection that needs no tunnel any more ends the attempts without a failure", async () => {
  const log = attempts([new Error("refused"), "unwanted"]);
  const keeper = new TunnelKeeper(log.run, DELAYS);
  keeper.lost();
  await until(() => log.started.length === 2 && !keeper.pending);
  expect(keeper.lastFailure()).toBeNull();
  await Bun.sleep(DELAYS.maxMs * 2);
  expect(log.started).toHaveLength(2);
});

test("a tunnel lost while an attempt runs is opened again after that attempt, once", async () => {
  let release!: () => void;
  const started: number[] = [];
  const keeper = new TunnelKeeper(async () => {
    started.push(Date.now());
    if (started.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return "kept";
  }, DELAYS);
  keeper.lost();
  await until(() => started.length === 1);
  // The attempt's own tunnel opened and closed again before it returned; reported twice, handled once.
  keeper.lost();
  keeper.lost();
  release();
  await until(() => started.length === 2 && !keeper.pending);
  await Bun.sleep(DELAYS.maxMs * 2);
  expect(started).toHaveLength(2);
});

test("a tunnel opened by a request drops the wait and the kept failure", async () => {
  const log = attempts([new Error("refused")]);
  const keeper = new TunnelKeeper(log.run, { firstMs: 20, maxMs: 2_000 });
  keeper.lost();
  await until(() => log.started.length === 1 && keeper.lastFailure() !== null);
  expect(keeper.pending).toBe(true);
  keeper.opened();
  expect(keeper.pending).toBe(false);
  expect(keeper.lastFailure()).toBeNull();
  await Bun.sleep(100);
  expect(log.started).toHaveLength(1);
});

test("stopping cancels the running attempt and starts none afterwards", async () => {
  const keeper = new TunnelKeeper(async (signal) => {
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return "kept";
  }, DELAYS);
  keeper.lost();
  await until(() => keeper.pending && (keeper as unknown as { running: unknown }).running !== null);
  await keeper.stop();
  expect(keeper.pending).toBe(false);
  expect(keeper.lastFailure()).toBeNull();
  keeper.lost();
  expect(keeper.pending).toBe(false);
});

test("only a saved SSH connection with a client token keeps a tunnel", () => {
  const ssh: SshConnection = { host: "memory.example.org", port: 22, user: "ubuntu", keyPath: join(tmpdir(), "id_ed25519") };
  const snapshot = (connection: ConnectionSettings, saved: string | null): CredentialSnapshot => ({
    settings: { connection } as CredentialSnapshot["settings"], token: saved, ownerToken: null, aiKey: null });
  expect(keepsTunnel(snapshot({ mode: "remote", baseUrl: "http://127.0.0.1:3001", ssh }, token("a")))).toBe(true);
  expect(keepsTunnel(snapshot({ mode: "existing", baseUrl: "http://127.0.0.1:3001", ssh }, token("a")))).toBe(true);
  expect(keepsTunnel(snapshot({ mode: "remote", baseUrl: "http://127.0.0.1:3001", ssh }, null))).toBe(false);
  expect(keepsTunnel(snapshot({ mode: "existing", baseUrl: "https://memory.example.org" }, token("a")))).toBe(false);
  expect(keepsTunnel(snapshot({ mode: "local", baseUrl: "http://127.0.0.1:3001" }, token("a")))).toBe(false);
});

test("the tunnel's ssh exits when the server stops answering its keepalive asks", () => {
  const ssh: SshConnection = { host: "memory.example.org", port: 22, user: "ubuntu", keyPath: join(tmpdir(), "id_ed25519") };
  const command = tunnelCommand({ ssh: "ssh", scp: "scp", keyscan: "ssh-keyscan", keygen: "ssh-keygen" }, ssh, "known_hosts", 3001, 3001);
  const options = command.flatMap((part, index) => command[index - 1] === "-o" ? [part] : []);
  expect(options).toContain(`ServerAliveInterval=${TUNNEL_KEEPALIVE_INTERVAL_S}`);
  expect(options).toContain(`ServerAliveCountMax=${TUNNEL_KEEPALIVE_MAX_MISSED}`);
  expect(options).toContain("ExitOnForwardFailure=yes");
  // The forward and the destination stay last, after every option.
  expect(command.slice(-3)).toEqual(["-L", "127.0.0.1:3001:127.0.0.1:3001", "ubuntu@memory.example.org"]);
});

installManagerTests();

/** `InstallManager` with a real settings store and real DPAPI: the resource folder is empty, so a connection
 * attempt stops at the payload check before any SSH work (see remote-recovery.test.ts). */
function installManagerTests(): void {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pet-tunnel-keeper-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });

  function pet() {
    const paths = { dataDir: join(dir, "data"), resourceDir: join(dir, "resources"), bunPath: join(dir, "resources", "runtime", "bun.exe") };
    const config = new ConfigStore(paths, new DpapiVault());
    const manager = new InstallManager(config, paths);
    const events = { opened: 0, lost: 0 };
    manager.watchTunnel({ opened: () => { events.opened++; }, lost: () => { events.lost++; } });
    const ssh: SshConnection = { host: "memory.example.org", port: 22, user: "ubuntu", keyPath: join(dir, "id_ed25519"),
      fingerprint: FINGERPRINT, serverPath: "/home/ubuntu/.local/share/bara-pet-server", serverPort: 3001 };
    return { config, manager, events, ssh };
  }

  windowsOnly("a failed attempt to open a saved remote tunnel is reported lost, so the keeper tries again", async () => {
    const { config, manager, events, ssh } = pet();
    await config.save({ connection: { mode: "remote", baseUrl: "http://127.0.0.1:41011", ssh }, token: token("a"), ownerToken: token("b") });
    try {
      await expect(manager.ensureConnection(ctx())).rejects.toBeDefined();
      expect(events).toEqual({ opened: 0, lost: 1 });
    } finally { await manager.close(); }
  }, 60_000);

  windowsOnly("a failed attempt for a connection that keeps no tunnel is not reported", async () => {
    const { config, manager, events, ssh } = pet();
    await config.save({ connection: { mode: "remote", baseUrl: "http://127.0.0.1:41012", ssh } });
    try {
      await expect(manager.ensureConnection(ctx())).rejects.toBeDefined();
      expect(events).toEqual({ opened: 0, lost: 0 });
    } finally { await manager.close(); }
  }, 60_000);
}
