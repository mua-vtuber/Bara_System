import { isAbsolute } from "node:path";
import { CAPTURE_KINDS, type Capture, type ConnectionSettings, type SaveInput, type SettingsUpdate, type SshConnection } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";
import { serviceError } from "./errors.ts";

const fail = (field: string): never => { throw serviceError("INVALID_INPUT", messages.validation.checkValue(field)); };
/** The name each failed check gives its value in `fail`. */
const label = messages.fieldLabels;
/** The service's own absolute ceiling for a saved or edited memory's body (`validateSaveInput` here and
 * `client.ts` `update()`), independent of and larger than the UI's early client-side block
 * (`src/shared/contracts.ts` `INPUT_MAX_CHARS`, 30,000). The UI blocks an oversized paste early so the
 * user sees the limit before sending; this is the server-side backstop that still applies no matter how
 * a save or edit request reaches this validator, so it is deliberately more generous than the UI's early
 * warning rather than tied to it. */
export const SAVE_BODY_MAX_CHARS = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[(?:[0-9a-fA-F:]+)\])$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const limited = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function parseBaseUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048) fail(label.serverAddress);
  let url: URL;
  try { url = new URL(value); } catch { return fail(label.serverAddress); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") fail(label.serverAddress);
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(label.serverAddress);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) fail(label.serverAddress);
  if (!url.hostname || !Number.isInteger(Number(url.port || (url.protocol === "https:" ? 443 : 80)))) fail(label.serverAddress);
  return url.origin;
}

export function parseOwnerLink(value: string): { baseUrl: string; token: string } {
  let url: URL;
  try { url = new URL(value); } catch { return fail(label.adminLink); }
  if (url.search || url.username || url.password || !["/", "/web/graph.html"].includes(url.pathname)) fail(label.adminLink);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("bara-token");
  if (fragment.size !== 1 || !limited(token, 2048)) fail(label.adminLink);
  url.hash = "";
  url.pathname = "/";
  return { baseUrl: parseBaseUrl(url.toString()), token: token! };
}

export function validateSsh(value: SshConnection): SshConnection {
  if (!isRecord(value) || !limited(value.host, 253) || !HOST.test(value.host as string) || !limited(value.user, 32) || !USER.test(value.user as string)) fail(label.sshConnection);
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) fail(label.sshPort);
  if (!limited(value.keyPath, 1024) || !isAbsolute(value.keyPath) || value.keyPath.startsWith("\\\\")) fail(label.sshKeyPath);
  if (value.fingerprint !== undefined && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint)) fail(label.sshFingerprint);
  if (value.serverPath !== undefined && (!value.serverPath.startsWith("/") || /[\r\n\0`$]/.test(value.serverPath) || value.serverPath.includes(".."))) fail(label.serverPath);
  if (value.serverPort !== undefined && (!Number.isInteger(value.serverPort) || value.serverPort < 1 || value.serverPort > 65535)) fail(label.serverPort);
  return { host: value.host, port: value.port, user: value.user, keyPath: value.keyPath,
    ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}),
    ...(value.serverPath ? { serverPath: value.serverPath } : {}),
    ...(value.serverPort ? { serverPort: value.serverPort } : {}) };
}

/** The one rule for the local end of an SSH tunnel: exactly `http://127.0.0.1:<port>`, with an explicit
 * port from 1 to 65535 and no credentials, path, query or fragment. Returns the port, or `null` when
 * the address is anything else (another host or scheme, no port, an unparsable string). The caller
 * decides which error that is: saving a connection (`validateConnection`), opening the tunnel
 * (`ensureRemoteTunnel`) and checking who owns its port (`port-owner.ts`) all use this one check, so
 * an address one of them accepts is never refused by another. */
export function tunnelPort(baseUrl: string): number | null {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return null; }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || !/^[0-9]+$/.test(url.port)) return null;
  const port = Number(url.port);
  return port >= 1 && port <= 65535 ? port : null;
}

export function validateConnection(value: ConnectionSettings): ConnectionSettings {
  if (!isRecord(value) || !["local", "remote", "existing"].includes(value.mode as string)) fail(label.connectionMode);
  const baseUrl = parseBaseUrl(value.baseUrl);
  if (value.mode === "remote" && !value.ssh) fail(label.sshConnection);
  // A remote server's identity leaves out the local address, so the stored token would stay with any
  // address saved under the same SSH settings; only the tunnel's own loopback address is accepted.
  if (value.mode === "remote" && tunnelPort(baseUrl) === null) fail(label.sshTunnelAddress);
  const ssh = value.ssh ? validateSsh(value.ssh) : undefined;
  return { mode: value.mode, baseUrl, ...(ssh ? { ssh } : {}) };
}

export function validateSettingsUpdate(value: SettingsUpdate): SettingsUpdate {
  if (!isRecord(value)) fail(label.settings);
  const result: SettingsUpdate = {};
  if (value.connection !== undefined) result.connection = validateConnection(value.connection);
  if (value.ai !== undefined) {
    if (!isRecord(value.ai) || !["none", "ollama", "openai-compatible"].includes(value.ai.provider as string) || typeof value.ai.model !== "string" || value.ai.model.length > 160) fail(label.aiSettings);
    result.ai = { provider: value.ai.provider, model: value.ai.model.trim(), baseUrl: value.ai.provider === "none" ? "" : parseBaseUrl(value.ai.baseUrl) };
  }
  if (value.cleanup !== undefined) {
    if (!isRecord(value.cleanup) || !["none", "claude", "codex", "ollama", "openai-compatible"].includes(value.cleanup.provider as string) || typeof value.cleanup.model !== "string" || value.cleanup.model.length > 160) fail(label.cleanupAiSettings);
    result.cleanup = { provider: value.cleanup.provider, model: value.cleanup.model.trim() };
  }
  if (value.autoStart !== undefined) { if (typeof value.autoStart !== "boolean") fail(label.autoStart); result.autoStart = value.autoStart; }
  if (value.cleanupOnSave !== undefined) { if (typeof value.cleanupOnSave !== "boolean") fail(label.cleanupOnSave); result.cleanupOnSave = value.cleanupOnSave; }
  for (const key of ["token", "ownerToken", "aiKey"] as const) if (value[key] !== undefined) {
    const secret = value[key];
    if (typeof secret !== "string" || secret.length > 4096 || /[\x00-\x1f\x7f]/.test(secret) || (key === "token" && secret.includes("://"))) fail(label.credentials);
    result[key] = secret;
  }
  return result;
}

export function validateCapture(value: unknown): Capture | null {
  if (value === null) return null;
  if (!isRecord(value) || !CAPTURE_KINDS.includes(value.kind as Capture["kind"]) || !["user", "ai"].includes(value.source as string)) fail(label.category);
  const capture = value as Record<string, unknown>;
  return { kind: capture.kind as Capture["kind"], source: capture.source as Capture["source"] };
}

export function validateSaveInput(value: SaveInput): SaveInput {
  if (!isRecord(value) || !limited(value.content, SAVE_BODY_MAX_CHARS)) fail(label.input);
  validateRequestId(value.requestId);
  if (!limited(value.audience, 4_096)) fail(label.serverConnection);
  if (value.kind !== undefined && value.kind !== null && !CAPTURE_KINDS.includes(value.kind)) fail(label.category);
  if (value.autoClassify !== undefined && typeof value.autoClassify !== "boolean") fail(label.autoClassify);
  return value;
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(label.requestNumber);
  return value as string;
}

export function validateText(value: unknown, field: string, max = 20_000): string {
  if (!limited(value, max)) fail(field);
  return (value as string).trim();
}

export function validateId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(label.memoryNumber);
  return value as number;
}
