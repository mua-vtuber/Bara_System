import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { audienceMatches, CAPABILITY_MEMORY_DEEPLINK, CORE_DEFAULT_PORT, connectionAudience, connectionRoute, sameSshEndpoint, type AiSettings, type ConnectionSettings, type HostVault, type PublicSettings, type RuntimePaths, type SettingsUpdate } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { serviceError } from "./errors.ts";
import { parseBaseUrl, parseOwnerLink, validateConnection, validateId, validateSettingsUpdate } from "./validation.ts";

type Flags = { token: boolean; ownerToken: boolean; aiKey: boolean };
type Key = "token" | "ownerToken" | "aiKey" | "enrollment";
export interface CredentialSnapshot { settings: PublicSettings; token: string | null; ownerToken: string | null; aiKey: string | null }
const KEYS: Record<Key, string> = { token: "memory.token", ownerToken: "memory.ownerToken", aiKey: "ai.apiKey", enrollment: "enrollment.pickupSecret" };
const DEFAULT: Omit<PublicSettings, "hasToken" | "hasOwnerToken" | "hasAiKey"> = {
  version: 1, connection: { mode: "local", baseUrl: `http://127.0.0.1:${CORE_DEFAULT_PORT}` },
  ai: { provider: "none", baseUrl: "", model: "" }, cleanup: { provider: "none", model: "" }, autoStart: false, cleanupOnSave: false,
};

export function memoryAudience(connection: ConnectionSettings): string {
  return connectionAudience(connection);
}
export function aiAudience(ai: AiSettings): string { return JSON.stringify({ provider: ai.provider, origin: ai.baseUrl }); }
export function encodeBoundSecret(secret: string, audience: string): string { return JSON.stringify({ version: 1, audience, secret }); }
function openBoundSecret(raw: string | null, accepts: (audience: string) => boolean): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      if (entry.version === 1 && typeof entry.audience === "string" && accepts(entry.audience) && typeof entry.secret === "string" && entry.secret.length > 0) return entry.secret;
    }
  } catch {}
  return null; // malformed, legacy plaintext, or different audience: fail closed
}
export function decodeBoundSecret(raw: string | null, audience: string): string | null {
  return openBoundSecret(raw, (bound) => bound === audience);
}
/** A memory server credential, bound to that server's audience in the current or the untagged format. */
export function decodeMemorySecret(raw: string | null, connection: ConnectionSettings): string | null {
  return openBoundSecret(raw, (bound) => audienceMatches(bound, connection));
}
function writerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function reservedOrigins(raw: unknown, current: ConnectionSettings): Record<string, string> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).reservedOrigins : undefined;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw serviceError("CONFIG_INVALID", messages.settingsStore.portLedgerUnreadable);
  const entries = Object.entries(value ?? {});
  if (entries.length > 1_024) throw serviceError("CONFIG_INVALID", messages.settingsStore.portLedgerTooLarge);
  const reservations: Record<string, string> = Object.create(null);
  for (const [origin, audience] of entries) {
    let normalized: string;
    try { normalized = parseBaseUrl(origin); } catch { throw serviceError("CONFIG_INVALID", messages.settingsStore.portLedgerUnreadable); }
    if (typeof audience !== "string" || audience.length < 1 || audience.length > 4_096 || normalized !== origin)
      throw serviceError("CONFIG_INVALID", messages.settingsStore.portLedgerUnreadable);
    reservations[origin] = audience;
  }
  // Pre-upgrade settings had no ledger. Reserve their active SSH origin before any replacement.
  if (current.ssh) {
    const holder = reservations[current.baseUrl];
    if (holder && !audienceMatches(holder, current)) throw serviceError("CONFIG_INVALID", messages.settingsStore.portOwnerMismatch);
    reservations[current.baseUrl] = memoryAudience(current);
  }
  return reservations;
}
/** An address reserved for another server is refused. The one exception is a remote connection taking the
 * address of an existing-mode SSH tunnel to the very same server (`sameSshEndpoint`); whoever reserves or
 * saves it then rewrites the reservation to the remote audience. */
function checkOrigin(reservations: Record<string, string>, connection: ConnectionSettings): void {
  const holder = reservations[connection.baseUrl];
  if (holder && !audienceMatches(holder, connection) && !sameSshEndpoint(holder, connection)) throw serviceError("CONNECTION_ORIGIN_RESERVED", messages.settingsStore.originReserved);
}
function loopbackOrigin(baseUrl: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
}

/** Persisted unknown properties, especially secrets, never enter renderer settings. */
export function publicSettingsFromDisk(raw: unknown, flags: Flags): PublicSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw serviceError("CONFIG_INVALID", messages.settingsStore.settingsUnreadable);
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) throw serviceError("CONFIG_INVALID", messages.settingsStore.settingsVersionMismatch);
  try {
    const validated = validateSettingsUpdate({
      ...(value.connection !== undefined ? { connection: value.connection as SettingsUpdate["connection"] } : {}),
      ...(value.ai !== undefined ? { ai: value.ai as SettingsUpdate["ai"] } : {}),
      ...(value.cleanup !== undefined ? { cleanup: value.cleanup as SettingsUpdate["cleanup"] } : {}),
      ...(value.autoStart !== undefined ? { autoStart: value.autoStart as boolean } : {}),
      ...(value.cleanupOnSave !== undefined ? { cleanupOnSave: value.cleanupOnSave as boolean } : {}),
    });
    return { ...DEFAULT, ...validated, hasToken: flags.token, hasOwnerToken: flags.ownerToken, hasAiKey: flags.aiKey };
  } catch { throw serviceError("CONFIG_INVALID", messages.settingsStore.settingsUnreadable); }
}

/** The Pet's settings file and its save-in-progress marker in the data folder; `deploy-target.ts` reads the same file. */
export const PET_SETTINGS_FILE = "pet-settings.json";
export const PET_SETTINGS_PENDING = "pet-settings.pending";

export class ConfigStore {
  private readonly file: string;
  private readonly pending: string;
  private queue: Promise<void> = Promise.resolve();
  private poisoned = false;
  constructor(readonly paths: RuntimePaths, private readonly vault: HostVault) {
    this.file = join(paths.dataDir, PET_SETTINGS_FILE);
    this.pending = join(paths.dataDir, PET_SETTINGS_PENDING);
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.poisoned) throw serviceError("CONFIG_UNAVAILABLE", messages.settingsStore.saveRecoveryFailed);
      return await work();
    } finally { release(); }
  }

  private async recoverPending(): Promise<void> {
    let marker: string;
    try { marker = await readFile(this.pending, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw serviceError("CONFIG_UNAVAILABLE", messages.settingsStore.recoveryStateUnknown);
    }
    let owner: { pid?: unknown; startedAt?: unknown } = {};
    try { owner = JSON.parse(marker); } catch {}
    if (typeof owner.pid === "number" && owner.pid !== process.pid && typeof owner.startedAt === "number" && Date.now() - owner.startedAt < 120_000 && writerAlive(owner.pid)) {
      throw serviceError("CONFIG_BUSY", messages.settingsStore.anotherWindowSaving);
    }
    try {
      // Crash may have committed either side. Forget all credentials before serving a request.
      for (const key of Object.values(KEYS)) await this.vault.delete(key);
      await unlink(this.pending);
    } catch {
      this.poisoned = true;
      throw serviceError("CONFIG_UNAVAILABLE", messages.settingsStore.recoveryFailed);
    }
  }

  private async readDisk(): Promise<unknown> {
    try { return JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT;
      throw serviceError("CONFIG_INVALID", messages.settingsStore.settingsUnreadable);
    }
  }
  private async rawSecrets(): Promise<Record<Key, string | null>> {
    const [token, ownerToken, aiKey, enrollment] = await Promise.all(Object.values(KEYS).map((key) => this.vault.get(key)));
    return { token, ownerToken, aiKey, enrollment };
  }
  private async snapshotUnlocked(): Promise<CredentialSnapshot> {
    await this.recoverPending();
    const disk = await this.readDisk();
    const settings = publicSettingsFromDisk(disk, { token: false, ownerToken: false, aiKey: false });
    reservedOrigins(disk, settings.connection);
    const raw = await this.rawSecrets();
    const token = decodeMemorySecret(raw.token, settings.connection);
    const ownerToken = decodeMemorySecret(raw.ownerToken, settings.connection);
    const aiKey = decodeBoundSecret(raw.aiKey, aiAudience(settings.ai));
    return { settings: { ...settings, hasToken: !!token, hasOwnerToken: !!ownerToken, hasAiKey: !!aiKey }, token, ownerToken, aiKey };
  }

  /** One lock protects the endpoint and all private credentials used with it. */
  snapshot(): Promise<CredentialSnapshot> { return this.exclusive(() => this.snapshotUnlocked()); }
  /** The saved settings with no secret decryption (`vault.get` is never called), for a caller that runs on every
   * save and needs only plain preferences. `hasToken`/`hasOwnerToken`/`hasAiKey` are not read here (false). */
  plainSettings(): Promise<PublicSettings> {
    return this.exclusive(async () => {
      await this.recoverPending();
      return publicSettingsFromDisk(await this.readDisk(), { token: false, ownerToken: false, aiKey: false });
    });
  }
  async load(): Promise<PublicSettings> { return (await this.snapshot()).settings; }
  /** Connection settings only, with no secret decryption (`vault.get` is never called here). Use this
   * wherever only the connection identity is needed, e.g. `assertConnectionCurrent`; a caller that
   * actually needs a token or key must still use `snapshot()`. */
  private async connectionSnapshot(): Promise<{ connection: ConnectionSettings }> {
    await this.recoverPending();
    const settings = publicSettingsFromDisk(await this.readDisk(), { token: false, ownerToken: false, aiKey: false });
    return { connection: settings.connection };
  }
  /** A snapshot's connection is still the saved one, down to its local address and SSH route, so a
   * credential read with it is sent only to the address it was read for. Stricter than an audience check:
   * a tunnel moved to a new local port keeps its audience but fails this check. A moved route is a changed
   * address (`routeChanged`, as `save` and `setEnrollment` say it), not a claim that another server answers. */
  async assertConnectionCurrent(snapshotConnection: ConnectionSettings): Promise<void> {
    return this.exclusive(async () => {
      const { connection } = await this.connectionSnapshot();
      if (connectionRoute(connection) !== connectionRoute(snapshotConnection))
        throw serviceError("CONNECTION_CHANGED", messages.connectionChange.routeChanged);
    });
  }
  assertOriginAvailable(connection: ConnectionSettings): Promise<void> { return this.exclusive(async () => {
    await this.recoverPending();
    const disk = await this.readDisk();
    const settings = publicSettingsFromDisk(disk, { token: false, ownerToken: false, aiKey: false });
    checkOrigin(reservedOrigins(disk, settings.connection), validateConnection(connection));
  }); }
  reserveOrigin(connection: ConnectionSettings): Promise<void> { return this.exclusive(async () => {
    await this.recoverPending();
    const target = validateConnection(connection);
    const disk = await this.readDisk();
    const settings = publicSettingsFromDisk(disk, { token: false, ownerToken: false, aiKey: false });
    const reservations = reservedOrigins(disk, settings.connection);
    checkOrigin(reservations, target);
    if (reservations[target.baseUrl] !== undefined && audienceMatches(reservations[target.baseUrl], target)) return;
    reservations[target.baseUrl] = memoryAudience(target);
    const next = { version: 1 as const, connection: settings.connection, ai: settings.ai, cleanup: settings.cleanup,
      autoStart: settings.autoStart, cleanupOnSave: settings.cleanupOnSave, reservedOrigins: reservations };
    await mkdir(this.paths.dataDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, this.file); }
    catch { throw serviceError("CONFIG_SAVE_FAILED", messages.settingsStore.portLedgerSaveFailed); }
    finally { await unlink(temporary).catch(() => {}); }
  }); }

  /** `expectedConnection`, when given, is the connection of the snapshot the caller acted on; the save is
   * refused unless the saved connection is still exactly that one (address and SSH route included). */
  async save(input: SettingsUpdate, expectedConnection?: ConnectionSettings): Promise<PublicSettings> {
    const checked = validateSettingsUpdate(input);
    return this.exclusive(async () => {
      const before = await this.snapshotUnlocked();
      if (expectedConnection !== undefined && connectionRoute(before.settings.connection) !== connectionRoute(expectedConnection)) throw serviceError("CONNECTION_CHANGED", messages.connectionChange.routeChanged);
      const old = await this.rawSecrets();
      let ownerToken = checked.ownerToken;
      let connection = checked.connection ?? before.settings.connection;
      if (ownerToken?.includes("://")) {
        const parsed = parseOwnerLink(ownerToken);
        ownerToken = parsed.token;
        connection = validateConnection({ ...(checked.connection ?? { mode: "existing", baseUrl: parsed.baseUrl }), baseUrl: parsed.baseUrl });
      }
      const disk = await this.readDisk();
      const reservations = reservedOrigins(disk, before.settings.connection);
      const oldAudience = memoryAudience(before.settings.connection);
      if (loopbackOrigin(before.settings.connection.baseUrl) && (before.token || before.ownerToken)) {
        if (reservations[before.settings.connection.baseUrl] && !audienceMatches(reservations[before.settings.connection.baseUrl]!, before.settings.connection))
          throw serviceError("CONFIG_INVALID", messages.settingsStore.portOwnerMismatch);
        reservations[before.settings.connection.baseUrl] = oldAudience;
      }
      checkOrigin(reservations, connection);
      if (loopbackOrigin(connection.baseUrl) && (connection.ssh || checked.token || ownerToken)) reservations[connection.baseUrl] = memoryAudience(connection);
      const next = { version: 1 as const, connection, ai: checked.ai ?? before.settings.ai,
        cleanup: checked.cleanup ?? before.settings.cleanup, autoStart: checked.autoStart ?? before.settings.autoStart,
        cleanupOnSave: checked.cleanupOnSave ?? before.settings.cleanupOnSave,
        reservedOrigins: reservations };
      const oldMemory = memoryAudience(before.settings.connection), newMemory = memoryAudience(next.connection);
      const oldAi = aiAudience(before.settings.ai), newAi = aiAudience(next.ai);
      const desired: Record<Key, string | null> = {
        token: checked.token !== undefined ? (checked.token ? encodeBoundSecret(checked.token, newMemory) : null) : oldMemory === newMemory ? old.token : null,
        ownerToken: ownerToken !== undefined ? (ownerToken ? encodeBoundSecret(ownerToken, newMemory) : null) : oldMemory === newMemory ? old.ownerToken : null,
        aiKey: checked.aiKey !== undefined ? (checked.aiKey ? encodeBoundSecret(checked.aiKey, newAi) : null) : oldAi === newAi ? old.aiKey : null,
        enrollment: oldMemory === newMemory ? old.enrollment : null,
      };
      await mkdir(this.paths.dataDir, { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      let renamed = false;
      let markerWritten = false;
      try {
        await writeFile(this.pending, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { encoding: "utf8", flag: "wx", mode: 0o600 });
        markerWritten = true;
        for (const name of Object.keys(KEYS) as Key[]) {
          if (desired[name] === old[name]) continue;
          if (desired[name] === null) await this.vault.delete(KEYS[name]);
          else await this.vault.set(KEYS[name], desired[name]!);
        }
        await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(tmp, this.file);
        renamed = true;
        await unlink(this.pending);
        return publicSettingsFromDisk(next, {
          token: !!decodeMemorySecret(desired.token, next.connection),
          ownerToken: !!decodeMemorySecret(desired.ownerToken, next.connection),
          aiKey: !!decodeBoundSecret(desired.aiKey, newAi),
        });
      } catch {
        try {
          if (markerWritten) for (const name of Object.keys(KEYS) as Key[]) {
              if (old[name] === null) await this.vault.delete(KEYS[name]);
              else await this.vault.set(KEYS[name], old[name]!);
          }
          if (markerWritten && !renamed) await unlink(this.pending).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
          else if (markerWritten) this.poisoned = true; // marker forces startup recovery of a possibly new file
        } catch { this.poisoned = true; }
        throw serviceError("CONFIG_SAVE_FAILED", messages.settingsStore.settingsSaveFailed);
      } finally { await unlink(tmp).catch(() => {}); }
    });
  }

  async getToken(): Promise<string | null> { return (await this.snapshot()).token; }
  async getOwnerToken(): Promise<string | null> { return (await this.snapshot()).ownerToken; }
  async getAiKey(): Promise<string | null> { return (await this.snapshot()).aiKey; }
  enrollmentSnapshot(): Promise<{ snapshot: CredentialSnapshot; enrollment: string | null }> { return this.exclusive(async () => {
    const snapshot = await this.snapshotUnlocked();
    const enrollment = decodeMemorySecret(await this.vault.get(KEYS.enrollment), snapshot.settings.connection);
    return { snapshot, enrollment };
  }); }
  getEnrollment(): Promise<string | null> { return this.exclusive(async () => {
    await this.recoverPending();
    const settings = publicSettingsFromDisk(await this.readDisk(), { token: false, ownerToken: false, aiKey: false });
    return decodeMemorySecret(await this.vault.get(KEYS.enrollment), settings.connection);
  }); }
  setEnrollment(value: string, expectedConnection?: ConnectionSettings): Promise<void> { return this.exclusive(async () => {
    await this.recoverPending();
    const settings = publicSettingsFromDisk(await this.readDisk(), { token: false, ownerToken: false, aiKey: false });
    const audience = memoryAudience(settings.connection);
    if (expectedConnection !== undefined && connectionRoute(settings.connection) !== connectionRoute(expectedConnection)) throw serviceError("CONNECTION_CHANGED", messages.connectionChange.routeChanged);
    await this.vault.set(KEYS.enrollment, encodeBoundSecret(value, audience));
  }); }
  clearEnrollment(): Promise<void> { return this.exclusive(() => this.vault.delete(KEYS.enrollment)); }

  /** Private host use only; never include this URL in a renderer RPC result.
   * `capabilities` (the caller's most recent `ConnectionStatus.capabilities`, e.g. from `client.info()`)
   * gates the `memoryId` deep link: an older server without `memory-deeplink` does not understand the
   * query parameter and bounces the dashboard to its home page, so this honestly falls back to a plain
   * dashboard-home link instead of guessing at a link the server cannot resolve. Required whenever
   * `memoryId` is given -- a caller that has not actually confirmed the server's capability list must
   * ask `client.info()` first rather than pass `undefined` here, which would silently drop `memoryId`.
   * `assertSendable` (`MemoryClient.assertSendable`) runs on the same snapshot's connection before the
   * owner token is put into the link, because the browser opens that address with the token. */
  async dashboardLink(assertSendable: (connection: ConnectionSettings) => Promise<void>, memoryId?: number, review = false,
    expectedAudience?: string, capabilities?: string[]): Promise<string> {
    const { settings, ownerToken } = await this.snapshot();
    if ((memoryId !== undefined || review) && (!expectedAudience || !audienceMatches(expectedAudience, settings.connection))) {
      throw serviceError("CONNECTION_CHANGED", messages.connectionChange.serverSwitched);
    }
    if (memoryId !== undefined && !capabilities) throw serviceError("CAPABILITIES_UNKNOWN", messages.settingsStore.capabilitiesUnknown);
    if (!ownerToken) throw serviceError("OWNER_TOKEN_REQUIRED", messages.settingsStore.ownerTokenRequired);
    await assertSendable(settings.connection);
    const url = new URL(settings.connection.baseUrl);
    if (memoryId !== undefined) {
      const validId = validateId(memoryId);
      if (capabilities!.includes(CAPABILITY_MEMORY_DEEPLINK)) url.searchParams.set("memoryId", String(validId));
    }
    if (review) url.searchParams.set("view", "proposals");
    url.hash = new URLSearchParams({ "bara-token": ownerToken }).toString();
    return url.toString();
  }
}
