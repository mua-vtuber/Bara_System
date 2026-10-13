import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostInspection, RequestContext, SshConnection } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { ServiceError, serviceError } from "../errors.ts";
import { validateSsh } from "../validation.ts";
import { runCaptured, windowsSystemRoot, type Captured } from "./process.ts";
import { SSH_FINGERPRINT_TIMEOUT_MS, SSH_KEYSCAN_TIMEOUT_MS, SSH_KEY_DISCOVERY_TIMEOUT_MS } from "./limits.ts";

/** Codes `runCaptured` (`process.ts`) raises when a step hits its own time limit rather than
 * failing normally. Only these two must still surface to the user: losing the step name behind
 * a real timeout would hide that the network, not the server's refusal, is what stopped the scan. */
function isStepTimeout(error: unknown): error is ServiceError {
  return error instanceof ServiceError && (error.code === "INSTALL_STEP_TIMEOUT" || error.code === "INSTALL_STEP_STALLED");
}

/** Runs an SSH probe step that is expected to fail in the ordinary course of host discovery
 * (`ssh-keyscan` finding no ed25519 key, or an auth-disabled `ssh` ending at "Permission
 * denied"): its plain failure is swallowed and reported as `undefined`, exactly like a
 * `scanHost`/`discoverWithoutAuthentication` fallthrough to the next detection method.
 *
 * A real timeout or stall is a different kind of failure -- the network never answered, not
 * the server refusing -- and must reach the caller with its step name intact, so it is
 * rethrown as-is. An abort is rethrown the same way `ctx.signal.throwIfAborted()` would.
 *
 * Both `scanHost` and `discoverWithoutAuthentication` call this instead of writing their own
 * try/catch, so the swallow-vs-surface rule lives in one place and `ssh.test.ts` exercises it
 * directly against real child processes instead of copying the pattern into each test. */
export async function runExpectedFailureProbe(argv: string[], ctx: Pick<RequestContext, "signal">,
  options: { timeoutMs: number; stepName: string }): Promise<Captured | undefined> {
  try {
    return await runCaptured(argv, ctx, options);
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (isStepTimeout(error)) throw error;
    return undefined;
  }
}

export interface SshTools { ssh: string; scp: string; keyscan: string; keygen: string }
export interface ScannedHost extends HostInspection { line: string }
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** An absolute remote path of plain characters with no empty, `.` or `..` segment, other than `/` itself. */
export function isSafeRemotePath(path: string): boolean {
  return SAFE_REMOTE_PATH.test(path) && !path.includes("//") &&
    !path.split("/").some((segment) => segment === ".." || segment === ".") && path !== "/";
}

export function safeRemotePath(path: string): string {
  if (!isSafeRemotePath(path)) throw serviceError("INVALID_INPUT", messages.installService.remotePathInvalid);
  return path.replace(/\/$/, "");
}

export function shQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function remoteCommand(args: readonly string[]): string { return args.map(shQuote).join(" "); }

export function findSshTools(): SshTools {
  const names = process.platform === "win32"
    ? ["ssh.exe", "scp.exe", "ssh-keyscan.exe", "ssh-keygen.exe"]
    : ["ssh", "scp", "ssh-keyscan", "ssh-keygen"];
  const dirs = process.platform === "win32"
    ? [join(windowsSystemRoot(), "System32", "OpenSSH")]
    : (process.env.PATH || "").split(":");
  const resolved = names.map((name) => dirs.map((dir) => join(dir, name)).find(existsSync));
  if (resolved.some((value) => !value)) throw serviceError("SSH_CLIENT_MISSING", messages.installService.sshClientMissing);
  return { ssh: resolved[0]!, scp: resolved[1]!, keyscan: resolved[2]!, keygen: resolved[3]! };
}

export function knownHostsPath(dataDir: string): string { return join(dataDir, "ssh", "known_hosts"); }

/** Windows ssh-keyscan can fail KEX against newer sshd. Discover an untrusted
 * public key through ssh with every authentication source disabled. The
 * connection deliberately ends at Permission denied; only the temporary
 * known_hosts line is used for fingerprint approval. */
async function discoverWithoutAuthentication(tools: SshTools, ssh: SshConnection,
  dir: string, ctx: RequestContext): Promise<string> {
  const temporary = join(dir, `discover-${randomUUID()}.known_hosts`);
  const globalHosts = process.platform === "win32" ? "NUL" : "/dev/null";
  try {
    // Authentication is intentionally disabled, so this is expected to fail (the connection
    // deliberately ends at "Permission denied"); only a real timeout must surface.
    await runExpectedFailureProbe([tools.ssh, "-F", "none", "-o", "BatchMode=yes",
      "-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no", "-o", "HostbasedAuthentication=no",
      "-o", "GSSAPIAuthentication=no", "-o", "PreferredAuthentications=none",
      "-o", "IdentityAgent=none", "-o", "IdentityFile=none",
      "-o", "StrictHostKeyChecking=accept-new", "-o", "HashKnownHosts=no",
      "-o", "CheckHostIP=no", "-o", "UpdateHostKeys=no",
      "-o", `UserKnownHostsFile=${temporary}`, "-o", `GlobalKnownHostsFile=${globalHosts}`,
      "-o", "ConnectTimeout=7", "-p", String(ssh.port), "-T", `${ssh.user}@${ssh.host}`],
    ctx, { timeoutMs: SSH_KEY_DISCOVERY_TIMEOUT_MS, stepName: messages.installSteps.sshHostKeyDiscover });
    return existsSync(temporary) ? await readFile(temporary, "utf8") : "";
  } finally { await Bun.file(temporary).delete().catch(() => {}); }
}

export function sshBase(tools: SshTools, input: SshConnection, knownHosts: string): string[] {
  const ssh = validateSsh(input);
  return [tools.ssh, "-F", "none", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "VerifyHostKeyDNS=no",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-o", "ConnectTimeout=10",
    "-i", ssh.keyPath, "-p", String(ssh.port), `${ssh.user}@${ssh.host}`];
}

export function scpBase(tools: SshTools, input: SshConnection, knownHosts: string): string[] {
  const ssh = validateSsh(input);
  return [tools.scp, "-F", "none", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "VerifyHostKeyDNS=no",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-i", ssh.keyPath, "-P", String(ssh.port)];
}

export async function scanHost(tools: SshTools, input: SshConnection, dataDir: string, ctx: RequestContext): Promise<ScannedHost> {
  const ssh = validateSsh(input);
  if (!existsSync(ssh.keyPath)) throw serviceError("SSH_KEY_MISSING", messages.installService.sshKeyMissing);
  const dir = join(dataDir, "ssh");
  await mkdir(dir, { recursive: true });
  // ssh-keyscan finding nothing (no ed25519 key, or Windows keyscan failing KEX against a newer
  // sshd) is expected and falls through to discoverWithoutAuthentication below; only a real
  // timeout must surface, with this step's name, instead of being read as "found nothing".
  const keyscanResult = await runExpectedFailureProbe(
    [tools.keyscan, "-T", "7", "-p", String(ssh.port), "-t", "ed25519,ecdsa,rsa", ssh.host],
    ctx, { timeoutMs: SSH_KEYSCAN_TIMEOUT_MS, stepName: messages.installSteps.sshHostKeyScan });
  let publicKeys = keyscanResult?.stdout ?? "";
  if (!publicKeys.split(/\r?\n/).some((line) => line.includes(" ssh-ed25519 ")))
    publicKeys = await discoverWithoutAuthentication(tools, ssh, dir, ctx);
  const lines = publicKeys.split(/\r?\n/).filter((line) => /^\S+\s+(ssh-ed25519|ecdsa-sha2-[\w-]+|ssh-rsa)\s+[A-Za-z0-9+/=]+$/.test(line));
  const line = lines.find((entry) => entry.includes(" ssh-ed25519 ")) ?? lines[0];
  if (!line) throw serviceError("SSH_HOST_KEY_MISSING", messages.installService.hostKeyMissing);
  const temporary = join(dir, `scan-${randomUUID()}.pub`);
  try {
    await writeFile(temporary, line + "\n", { mode: 0o600 });
    const printed = await runCaptured([tools.keygen, "-lf", temporary], ctx, { timeoutMs: SSH_FINGERPRINT_TIMEOUT_MS, stepName: messages.installSteps.sshFingerprint });
    const fingerprint = printed.stdout.match(/SHA256:[A-Za-z0-9+/]{43}/)?.[0];
    if (!fingerprint) throw serviceError("SSH_HOST_KEY_INVALID", messages.installService.hostFingerprintFailed);
    const knownPath = knownHostsPath(dataDir);
    const existing = existsSync(knownPath) ? await readFile(knownPath, "utf8") : "";
    const hostField = line.split(/\s+/)[0]!;
    const expectedField = ssh.port === 22 ? ssh.host : `[${ssh.host.replace(/^\[|\]$/g, "")}]:${ssh.port}`;
    if (hostField !== expectedField) throw serviceError("SSH_HOST_KEY_INVALID", messages.installService.hostKeyAddressMismatch);
    const knownLines = existing.split(/\r?\n/).filter((candidate) => candidate.startsWith(hostField + " "));
    if (knownLines.some((candidate) => candidate !== line)) throw serviceError("SSH_HOST_CHANGED", messages.installService.hostKeyChanged);
    return { fingerprint, host: ssh.host, keyType: line.split(/\s+/)[1]!, known: knownLines.includes(line), line };
  } finally { await Bun.file(temporary).delete().catch(() => {}); }
}

export async function trustHost(scanned: ScannedHost, acceptedFingerprint: string, dataDir: string): Promise<string> {
  if (scanned.fingerprint !== acceptedFingerprint) throw serviceError("SSH_FINGERPRINT_MISMATCH", messages.installService.fingerprintMismatch);
  await mkdir(join(dataDir, "ssh"), { recursive: true });
  const path = knownHostsPath(dataDir);
  if (!scanned.known) {
    const hostField = scanned.line.split(/\s+/)[0]!;
    const existing = existsSync(path) ? await readFile(path, "utf8") : "";
    if (existing.split(/\r?\n/).some((line) => line.startsWith(hostField + " ") && line !== scanned.line))
      throw serviceError("SSH_HOST_CHANGED", messages.installService.hostKeyChanged);
    if (!existing.includes(scanned.line + "\n")) await appendFile(path, scanned.line + "\n", { mode: 0o600 });
  }
  return path;
}

/** `KEY='value' ...` before a remote command; every value quoted. */
export function envPrefix(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${shQuote(value)}`).join(" ");
}
