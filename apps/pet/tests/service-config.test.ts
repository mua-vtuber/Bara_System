import { expect, test } from "bun:test";
import { decodeBoundSecret, decodeMemorySecret, encodeBoundSecret, memoryAudience, publicSettingsFromDisk } from "../src/service/config.ts";
import { ConfigStore } from "../src/service/config.ts";
import { rebindSnapshot } from "../src/service/install/connection-policy.ts";
import { MemoryClient } from "../src/service/client.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { startListenerProcess } from "./fixtures/loopback-listener.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import { messages } from "../src/ui/messages.ts";
import type { ConnectionSettings, HostVault } from "../src/shared/contracts.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Delegates every call to the real vault the other tests use (real Windows DPAPI on `win32`) while
 * counting `get` calls, so the spy never substitutes a fake vault -- it only observes the real one. */
class CountingVault implements HostVault {
  getCalls = 0;
  constructor(private readonly inner: HostVault) {}
  async get(key: string): Promise<string | null> { this.getCalls++; return this.inner.get(key); }
  set(key: string, value: string): Promise<void> { return this.inner.set(key, value); }
  delete(key: string): Promise<void> { return this.inner.delete(key); }
}

/** Delegates every call to the real vault, but holds `delete`/`set` open on a resolvable gate until the
 * test releases it -- a real mid-write pause inside `save()`'s own critical section, not a fake vault.
 * Used to prove `exclusive` actually serializes `assertConnectionCurrent` against a concurrent `save`: only
 * a real lock keeps `assertConnectionCurrent` from reading the connection file while `save` is paused here,
 * still holding the previous connection on disk. */
class GatedVault implements HostVault {
  private gate: Promise<void> = Promise.resolve();
  private release: (() => void) | null = null;
  constructor(private readonly inner: HostVault) {}
  /** Opens the gate: the next `delete`/`set` call blocks until `lift()` is called. */
  hold(): void { this.gate = new Promise((resolve) => { this.release = resolve; }); }
  lift(): void { this.release?.(); this.release = null; }
  async get(key: string): Promise<string | null> { return this.inner.get(key); }
  async set(key: string, value: string): Promise<void> { await this.gate; return this.inner.set(key, value); }
  async delete(key: string): Promise<void> { await this.gate; return this.inner.delete(key); }
}

test("persisted credentials never become public settings", () => {
  const result = publicSettingsFromDisk({ version: 1, token: "DO-NOT-RENDER", connection: { mode: "local", baseUrl: "http://127.0.0.1:3001" } }, { token: true, ownerToken: false, aiKey: false });
  expect(result.hasToken).toBe(true);
  expect(JSON.stringify(result)).not.toContain("DO-NOT-RENDER");
});

test("future config versions are not silently downgraded", () => {
  expect(() => publicSettingsFromDisk({ version: 2 }, { token: false, ownerToken: false, aiKey: false })).toThrow();
});

// WP-P2-16 (PV-9): a saved file with no cleanup key at all -- either a brand-new install, or one
// written before this field existed -- must read as the explicit "not configured" state, never as
// a silent default to a specific provider (Claude Code should never run without the user choosing it).
test("a settings file with no cleanup key reads as the explicit not-configured provider", () => {
  const result = publicSettingsFromDisk({ version: 1, connection: { mode: "local", baseUrl: "http://127.0.0.1:3001" } }, { token: false, ownerToken: false, aiKey: false });
  expect(result.cleanup).toEqual({ provider: "none", model: "" });
});

test("answer and cleanup AI settings survive reopening the store and changing cleanup providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-ai-settings-"));
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const vault = new DpapiVault();
  const ai = { provider: "ollama" as const, baseUrl: "http://127.0.0.1:11434", model: "authored-answer-model" };
  try {
    await new ConfigStore(paths, vault).save({ ai, cleanup: { provider: "claude", model: "" } });
    expect(await new ConfigStore(paths, vault).load()).toMatchObject({ ai, cleanup: { provider: "claude", model: "" } });
    await new ConfigStore(paths, vault).save({ cleanup: { provider: "codex", model: "authored-cleanup-model" } });
    expect(await new ConfigStore(paths, vault).load()).toMatchObject({ ai, cleanup: { provider: "codex", model: "authored-cleanup-model" } });
    await new ConfigStore(paths, vault).save({ cleanup: { provider: "none", model: "" } });
    expect(await new ConfigStore(paths, vault).load()).toMatchObject({ ai, cleanup: { provider: "none", model: "" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unrecognized cleanup provider value in a saved file is rejected, not silently defaulted", () => {
  expect(() => publicSettingsFromDisk({ version: 1, connection: { mode: "local", baseUrl: "http://127.0.0.1:3001" }, cleanup: { provider: "gpt-legacy", model: "" } }, { token: false, ownerToken: false, aiKey: false })).toThrow();
});

test("encrypted bearer is usable only for its bound server identity", () => {
  const local = { mode: "local" as const, baseUrl: "http://127.0.0.1:3001" };
  const remote = { mode: "existing" as const, baseUrl: "https://memory.example.org" };
  const sealed = encodeBoundSecret("scoped-token", memoryAudience(local));
  expect(decodeBoundSecret(sealed, memoryAudience(local))).toBe("scoped-token");
  expect(decodeBoundSecret(sealed, memoryAudience(remote))).toBeNull();
  expect(decodeBoundSecret("scoped-token", memoryAudience(local))).toBeNull();
});
test("identical loopback URLs with different SSH fingerprints are different audiences", () => {
  const base = { mode: "existing" as const, baseUrl: "http://127.0.0.1:3001", ssh: { host: "example.org", port: 22, user: "ubuntu", keyPath: "C:\\key", fingerprint: "SHA256:" + "A".repeat(43) } };
  const changed = { ...base, ssh: { ...base.ssh, fingerprint: "SHA256:" + "B".repeat(43) } };
  expect(memoryAudience(base)).not.toBe(memoryAudience(changed));
});

// WP-P2-19: credentials and port reservations written before the audience version tag carry the old
// `{mode, origin, ssh}` text. They stay usable for the same server after the tunnel's local port moves,
// and never for another server.
const UPGRADE_SSH = { host: "a.example.org", port: 22, user: "ubuntu", keyPath: "C:\\keys\\a", fingerprint: `SHA256:${"A".repeat(43)}` };
function untaggedAudience(connection: ConnectionSettings): string {
  return JSON.stringify({ mode: connection.mode, origin: connection.baseUrl, ssh: connection.ssh ?? null });
}
test("a credential bound to an untagged audience opens only for the same server", () => {
  const before: ConnectionSettings = { mode: "remote", baseUrl: "http://127.0.0.1:41031", ssh: UPGRADE_SSH };
  const sealed = encodeBoundSecret("scoped-token", untaggedAudience(before));
  expect(decodeMemorySecret(sealed, { ...before, baseUrl: "http://127.0.0.1:41032" })).toBe("scoped-token");
  expect(decodeMemorySecret(sealed, { ...before, ssh: { ...UPGRADE_SSH, host: "b.example.org" } })).toBeNull();
  expect(decodeMemorySecret(sealed, { ...before, ssh: { ...UPGRADE_SSH, fingerprint: `SHA256:${"B".repeat(43)}` } })).toBeNull();
  expect(decodeMemorySecret(encodeBoundSecret("scoped-token", memoryAudience(before)), before)).toBe("scoped-token");
});
test.skipIf(process.platform !== "win32")("settings written before the audience tag keep their token and port reservation for the same server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-audience-upgrade-"));
  const vault = new DpapiVault();
  // A separate process owns the saved tunnel address, standing in for the SSH tunnel the service verified.
  const tunnelEnd = await startListenerProcess({});
  const before: ConnectionSettings = { mode: "remote", baseUrl: tunnelEnd.baseUrl, ssh: { ...UPGRADE_SSH, keyPath: join(dir, "key") } };
  const legacy = untaggedAudience(before);
  // The on-disk state an earlier Pet left behind: its settings file and its vault entries (same key names).
  writeFileSync(join(dir, "pet-settings.json"), JSON.stringify({ version: 1, connection: before, ai: { provider: "none", baseUrl: "", model: "" },
    cleanup: { provider: "none", model: "" }, autoStart: false, reservedOrigins: { [before.baseUrl]: legacy } }));
  await vault.set("memory.token", encodeBoundSecret("authored-token", legacy));
  await vault.set("memory.ownerToken", encodeBoundSecret("authored-owner-token", legacy));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, vault);
  try {
    const snapshot = await config.snapshot();
    expect(snapshot.token).toBe("authored-token");
    expect(snapshot.ownerToken).toBe("authored-owner-token");
    // A review link opened from a result the earlier Pet showed carries that same untagged audience.
    const routes = new CredentialRoutes(new LocalServer());
    await routes.verifyTunnel(tunnelEnd.process, before, new AbortController().signal);
    const client = new MemoryClient(config, routes);
    expect(new URL(await config.dashboardLink((connection) => client.assertSendable(connection), undefined, true, legacy)).searchParams.get("view")).toBe("proposals");
    await rebindSnapshot(config, snapshot, { ...before, baseUrl: "http://127.0.0.1:41034" });
    expect((await config.snapshot()).token).toBe("authored-token");
    // The old port stays reserved for server A, so server B can never take it over.
    await expect(config.assertOriginAvailable({ ...before, ssh: { ...before.ssh!, host: "b.example.org" } }))
      .rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
    await config.assertOriginAvailable({ ...before, ssh: { ...before.ssh!, user: "admin" } });
  } finally { await tunnelEnd.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
test.skipIf(process.platform !== "win32")("a snapshot of the old tunnel address is refused once the tunnel moved, though the audience is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-route-guard-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const before: ConnectionSettings = { mode: "remote", baseUrl: "http://127.0.0.1:41035", ssh: { ...UPGRADE_SSH, keyPath: join(dir, "key") } };
  const moved = { ...before, baseUrl: "http://127.0.0.1:41036" };
  try {
    await config.save({ connection: before, token: "authored-token" });
    const stale = await config.snapshot();
    await rebindSnapshot(config, stale, moved);
    expect(memoryAudience(moved)).toBe(memoryAudience(before));
    // A request built from the stale snapshot would send the token to the old local port. The server is the
    // same (equal audience), so the refusal says the address changed, not that another server answers.
    await expect(config.assertConnectionCurrent(before)).rejects
      .toMatchObject({ code: "CONNECTION_CHANGED", publicMessage: messages.connectionChange.routeChanged });
    await expect(config.save({ autoStart: true }, before)).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    await config.assertConnectionCurrent(moved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
test.skipIf(process.platform !== "win32")("an SSH loopback origin cannot be reassigned to a different server identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-origin-ledger-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const ssh = { host: "a.example.org", port: 22, user: "ubuntu", keyPath: join(dir, "key"), fingerprint: `SHA256:${"A".repeat(43)}` };
  const a = { mode: "remote" as const, baseUrl: "http://127.0.0.1:41001", ssh };
  try {
    await config.save({ connection: a, token: "authored-A" });
    await config.save({ connection: { ...a, baseUrl: "http://127.0.0.1:41002" }, token: "authored-A" });
    await expect(config.save({ connection: { ...a, ssh: { ...ssh, host: "b.example.org" } }, token: "authored-B" }))
      .rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
    expect((await config.load()).connection.baseUrl).toBe("http://127.0.0.1:41002");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000); // Real Windows DPAPI subprocess startup can exceed 5s on hosted runners.
test.skipIf(process.platform !== "win32")("a pre-upgrade SSH connection is reserved before any replacement save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-origin-upgrade-"));
  const ssh = { host: "a.example.org", port: 22, user: "ubuntu", keyPath: join(dir, "key"), fingerprint: `SHA256:${"A".repeat(43)}` };
  const current = { mode: "remote" as const, baseUrl: "http://127.0.0.1:41003", ssh };
  writeFileSync(join(dir, "pet-settings.json"), JSON.stringify({ version: 1, connection: current, ai: { provider: "none", baseUrl: "", model: "" }, cleanup: { provider: "claude", model: "" }, autoStart: false }));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  try {
    await expect(config.save({ connection: { ...current, ssh: { ...ssh, host: "b.example.org" } } }))
      .rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test.skipIf(process.platform !== "win32")("an explicitly reserved local server port cannot become an SSH tunnel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-local-reservation-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const local = { mode: "local" as const, baseUrl: "http://127.0.0.1:41008" };
  const remote = { mode: "remote" as const, baseUrl: local.baseUrl,
    ssh: { host: "b.example.org", port: 22, user: "ubuntu", keyPath: join(dir, "key"), fingerprint: `SHA256:${"B".repeat(43)}` } };
  try {
    await config.reserveOrigin(local);
    await expect(config.assertOriginAvailable(remote)).rejects.toMatchObject({ code: "CONNECTION_ORIGIN_RESERVED" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// WP-P2-17: assertConnectionCurrent only needs the connection identity, never a decrypted secret, so it
// must never call vault.get -- unlike snapshot()/save(), which genuinely need the bound token.
test.skipIf(process.platform !== "win32")("assertConnectionCurrent never decrypts a vault secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-audience-nosecret-"));
  const vault = new CountingVault(new DpapiVault());
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, vault);
  const connection = { mode: "existing" as const, baseUrl: "https://memory.example.org" };
  try {
    await config.save({ connection, token: "authored-token" });
    vault.getCalls = 0;
    await config.assertConnectionCurrent(connection);
    expect(vault.getCalls).toBe(0);
    await expect(config.assertConnectionCurrent({ mode: "existing", baseUrl: "https://other.example.org" }))
      .rejects.toMatchObject({ code: "CONNECTION_CHANGED", publicMessage: messages.connectionChange.routeChanged });
    expect(vault.getCalls).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// The lock (`exclusive`) still serializes assertConnectionCurrent against a concurrent settings.save --
// only the work done inside the lock (secret decryption) shrank, not what the lock protects (write order).
// This must fail if the lock is removed: it holds `save()` paused mid-write (after it has queued its
// vault delete/set but before the connection file is renamed to the new value) through a real delegating
// wrapper around the real vault's `set`/`delete`, then starts `assertConnectionCurrent` while `save` is still
// paused there. With the lock, `assertConnectionCurrent` cannot even begin its own turn in the queue until
// `save` releases it, so it always resolves after `save` and always sees connectionB (the committed
// value) on disk -- resolving against connectionA's own audience would throw CONNECTION_CHANGED. Without
// the lock, `assertConnectionCurrent` runs concurrently with the paused `save`, reads the connection file
// while it still holds connectionA (not yet renamed), and resolves successfully instead of throwing --
// which is exactly the interleaving this test must catch.
test.skipIf(process.platform !== "win32")("assertConnectionCurrent still serializes with a concurrent save through the same lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-audience-serialize-"));
  const vault = new GatedVault(new DpapiVault());
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, vault);
  const connectionA = { mode: "existing" as const, baseUrl: "https://memory.example.org" };
  const connectionB = { mode: "existing" as const, baseUrl: "https://other.example.org" };
  try {
    await config.save({ connection: connectionA, token: "authored-token" });
    vault.hold();
    const order: string[] = [];
    const save = config.save({ connection: connectionB }).then(() => order.push("save"));
    // Give `save` a turn to actually enter its critical section and block on the gated vault call before
    // starting the assertion, so the assertion's queue entry is genuinely concurrent with a paused save
    // rather than merely scheduled after it resolves.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const assertion = config.assertConnectionCurrent(connectionA)
      .then(() => order.push("assert-resolved"))
      .catch((error) => { order.push("assert-rejected"); return error; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    vault.lift();
    const [, assertOutcome] = await Promise.all([save, assertion]);
    // The lock guarantees `save` finishes its critical section before `assertConnectionCurrent` gets a turn,
    // so the assertion always runs against the already-committed connectionB and must reject with
    // CONNECTION_CHANGED (connectionA's audience no longer matches). A resolved assertion here would mean
    // it read connectionA while `save` was still paused mid-write -- the lock did not serialize them.
    expect(order).toEqual(["save", "assert-rejected"]);
    expect(assertOutcome).toMatchObject({ code: "CONNECTION_CHANGED" });
    expect((await config.load()).connection.baseUrl).toBe(connectionB.baseUrl);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// WP-P2-03 step 5: an older server without the memory-deeplink capability cannot resolve a
// `?memoryId=` query parameter, so dashboardLink must fall back to a plain dashboard-home link
// instead of guessing at a link the server bounces to its home page.
test.skipIf(process.platform !== "win32")("dashboardLink omits memoryId when the capability list lacks memory-deeplink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-dashboard-link-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  const connection = { mode: "existing" as const, baseUrl: "https://memory.example.org" };
  const audience = memoryAudience(connection);
  const client = new MemoryClient(config, new CredentialRoutes(new LocalServer()));
  const gate = (target: ConnectionSettings) => client.assertSendable(target);
  try {
    await config.save({ connection, token: "authored-token", ownerToken: "authored-owner-token" });
    const withoutDeeplink = await config.dashboardLink(gate, 7, false, audience, ["ingest-receipts", "capture"]);
    expect(new URL(withoutDeeplink).searchParams.has("memoryId")).toBe(false);
    const withDeeplink = await config.dashboardLink(gate, 7, false, audience, ["ingest-receipts", "capture", "memory-deeplink"]);
    expect(new URL(withDeeplink).searchParams.get("memoryId")).toBe("7");
    // An unconfirmed capability list must never be treated as "no capabilities" (that would silently
    // drop memoryId); the caller must ask client.info() first, or this throws instead of degrading.
    await expect(config.dashboardLink(gate, 7, false, audience)).rejects.toMatchObject({ code: "CAPABILITIES_UNKNOWN" });
    const plainLink = await config.dashboardLink(gate, undefined, false, audience);
    expect(new URL(plainLink).searchParams.has("memoryId")).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
