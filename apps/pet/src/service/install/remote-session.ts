import type { RequestContext, SshConnection } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { runCaptured, type SensitiveFailure } from "./process.ts";
import { findSshTools, safeRemotePath, scanHost, scpBase, sshBase, trustHost, type SshTools } from "./ssh.ts";
import { SSH_COMMAND_TIMEOUT_MS, SSH_TRANSFER_TIMEOUT_MS } from "./limits.ts";

/** The SSH route one run uses for every remote command: tools, verified connection and trusted host file. */
export interface RemoteSession { tools: SshTools; ssh: SshConnection; knownHosts: string; ctx: RequestContext }

export async function sshRun(s: RemoteSession, script: string, stepName: string, timeoutMs: number = SSH_COMMAND_TIMEOUT_MS,
  sensitive: boolean | SensitiveFailure = false): Promise<string> {
  const output = await runCaptured([...sshBase(s.tools, s.ssh, s.knownHosts), script], s.ctx, { timeoutMs, sensitive, stepName });
  return output.stdout.trim();
}

/** Idle-based variant for remote steps whose duration depends on transfer or compute size (model prefetch,
 * portable restore): any output resets the clock (limits.ts MODEL_PREFETCH_IDLE_MS, restore.ts RESTORE_IDLE_MS). */
export async function sshRunIdle(s: RemoteSession, script: string, idleTimeoutMs: number, stepName: string): Promise<string> {
  const output = await runCaptured([...sshBase(s.tools, s.ssh, s.knownHosts), script], s.ctx, { idleTimeoutMs, stepName });
  return output.stdout.trim();
}

const VERBATIM_UNC = "\\\\?\\UNC\\";
const VERBATIM = "\\\\?\\";

/** scp reads any argument with a colon as `host:path`. The Tauri host passes Windows paths in verbatim form
 * (`\\?\C:\...`), which scp would take as a host named `\\?\C` and fail with 255 before connecting, so local
 * paths drop the verbatim prefix. Only the two plain forms are rewritten; anything else passes through. */
export function scpLocalPath(local: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return local;
  if (local.startsWith(VERBATIM_UNC)) return `\\\\${local.slice(VERBATIM_UNC.length)}`;
  if (local.startsWith(VERBATIM) && /^[A-Za-z]:\\/.test(local.slice(VERBATIM.length))) return local.slice(VERBATIM.length);
  return local;
}

export async function scpFile(s: RemoteSession, local: string, remote: string, timeoutMs: number = SSH_TRANSFER_TIMEOUT_MS): Promise<void> {
  await runCaptured([...scpBase(s.tools, s.ssh, s.knownHosts), scpLocalPath(local), `${s.ssh.user}@${s.ssh.host}:${safeRemotePath(remote)}`],
    s.ctx, { timeoutMs, stepName: messages.installSteps.fileTransfer });
}

/** A session to a saved remote connection. The host key must still be the fingerprint the user approved: the Pet's
 * server update and `deploy:a1` never approve a new key. */
export async function openSession(ssh: SshConnection, dataDir: string, ctx: RequestContext): Promise<RemoteSession> {
  if (!ssh.fingerprint) throw serviceError("SSH_HOST_UNTRUSTED", messages.installService.hostUntrusted);
  const tools = findSshTools();
  const scanned = await scanHost(tools, ssh, dataDir, ctx);
  const knownHosts = await trustHost(scanned, ssh.fingerprint, dataDir);
  return { tools, ssh, knownHosts, ctx };
}
