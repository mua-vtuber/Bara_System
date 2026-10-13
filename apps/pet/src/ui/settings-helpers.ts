import { messages } from "./messages.ts";
import { DEFAULT_AI_URLS, type AiProvider, type ConnectionMode, type ConnectionStatus, type Enrollment, type ServerUpdateStatus, type SettingsUpdate, type TunnelPortNotice,
  type UpdateStatus } from "../shared/contracts.ts";

/** Applies the provider's address default when the settings selector changes. */
export function aiUrlForProvider(provider: AiProvider, current: string): string {
  if (provider === "ollama") return DEFAULT_AI_URLS.ollama;
  const ollamaPort = `:${new URL(DEFAULT_AI_URLS.ollama).port}`;
  return provider === "openai-compatible" && (!current.trim() || current.endsWith(ollamaPort)) ? DEFAULT_AI_URLS["openai-compatible"] : current;
}

export function connectionCredential(raw: string): Pick<SettingsUpdate, "token" | "ownerToken"> {
  const value = raw.trim(); if (!value) return {};
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!new URLSearchParams(url.hash.slice(1)).get("bara-token")) throw new Error(messages.errors.credentials);
    return { ownerToken: value };
  }
  return { token: value };
}

/** Runs `connection.test` (passed in as `test`) and throws its message unless it reports connected: the
 * same version/capability judgment for a manually entered token and for an approved enrollment. */
export async function confirmConnection(test: () => Promise<ConnectionStatus>): Promise<void> {
  const result = await test();
  if (!result.connected) throw new Error(result.message);
}

/** Whether an enrollment answer finished connecting. A server approval only proves the token was
 * accepted, not that this server actually speaks the Pet integration protocol (an outdated server can
 * still approve enrollment), so an approval counts only after `confirmConnection` passes; a failed
 * check throws its message. Any other state is not finished yet, and `test` is not called. */
export async function enrollmentConnected(enrollment: Enrollment, test: () => Promise<ConnectionStatus>): Promise<boolean> {
  if (enrollment.state !== "approved") return false;
  await confirmConnection(test);
  return true;
}

/** How the settings screen stops what is in progress: the host-only OpenSSH wait (`cancel_ensure_ssh`)
 * or a service request (`operation.cancel` with that request's id). */
export interface SetupCancellers {
  ssh: () => Promise<void>;
  operation: (requestId: string) => Promise<void>;
}

/** The stop button: cancels the OpenSSH wait while one is running, otherwise the running request.
 * A cancel that fails is handed to `report` with its cause, so the user learns the work did not stop. */
export async function stopSetup(awaitingSsh: boolean, operation: string, cancel: SetupCancellers, report: (error: unknown) => void): Promise<void> {
  try {
    if (awaitingSsh) await cancel.ssh();
    else if (operation) await cancel.operation(operation);
  } catch (error) { report(error); }
}

/** Leaving the settings screen ends an OpenSSH wait still in progress. The elevated installer keeps
 * running in the host, and the next `ensure_ssh` waits on that same installer, so no second UAC prompt
 * appears; a wait left running instead would make that next call busy until it ended on its own. */
export async function leaveSetup(awaitingSsh: boolean, cancel: SetupCancellers, report: (error: unknown) => void): Promise<void> {
  if (!awaitingSsh) return;
  try { await cancel.ssh(); } catch (error) { report(error); }
}

/** The settings line for an update a previous start left unfinished (`status.update`): stopped before its backup was
 * done, failed after it, or cut off while migrating. Null when there is nothing to say (no update, or it finished,
 * or it is still backing up), and while the saved connection (`mode`) is not this PC's storage: the update concerns
 * that storage and every line says to retry with the connection check, which another connection never starts it
 * with. Choosing this PC again shows it. A failure after the backup always names the backup folder. */
export function updateNoticeText(update: UpdateStatus | null | undefined, mode: ConnectionMode | null): string | null {
  if (!update || mode !== "local") return null;
  const from = update.from === "unknown" ? messages.updateNotice.previousVersion : update.from;
  if (update.stage === "failed" && update.backupPath) return messages.updateNotice.startFailed(from, update.to, update.backupPath);
  if (update.stage === "failed") return messages.updateNotice.backupFailed(from, update.to);
  if (update.stage === "migrating" && update.backupPath) return messages.updateNotice.interrupted(from, update.to, update.backupPath);
  return null;
}

/** Characters of a commit the dev build line shows. */
const COMMIT_SHOWN = 7;
/** The settings line about the remote server (spec 5.3): an update running or failed, a note an update finished with,
 * or the dev build it runs. A server running a Pet build with nothing to note needs no line. */
export function serverUpdateText(update: ServerUpdateStatus | null | undefined): { text: string; error: boolean } | null {
  if (!update) return null;
  switch (update.state) {
    case "updating": return { text: messages.serverUpdate.updating(update.from, update.to), error: false };
    case "failed": return { text: messages.serverUpdate.failed(update.message), error: true };
    case "current": {
      const { installed } = update;
      const lines = [
        ...(installed.origin === "dev" && installed.commit ? [messages.serverUpdate.devBuild(installed.commit.slice(0, COMMIT_SHOWN))] : []),
        ...(update.leftoverLock !== null ? [messages.serverUpdate.leftoverLock(update.leftoverLock)] : []),
        ...(update.cancelledAfterCheck ? [messages.serverUpdate.cancelledAfterCheck] : []),
      ];
      return lines.length === 0 ? null : { text: lines.join(" "), error: update.leftoverLock !== null };
    }
  }
}

/** The error notice after the install wizard connected (`install.remote`): the server line's text when it reports a
 * failed update or a lock folder an update left behind, otherwise nothing. */
export function serverUpdateNotice(update: ServerUpdateStatus | null | undefined): string | null {
  const line = serverUpdateText(update);
  return line?.error ? line.text : null;
}

/** The server-update part of `status`, or why it could not be read. A failed read is never taken as "no update news":
 * a failed server update would then look like success. */
export type ServerUpdateRead = { ok: true; update: ServerUpdateStatus | null } | { ok: false; cause: string };

export function readServerUpdate(read: () => Promise<{ serverUpdate?: ServerUpdateStatus | null }>,
  describe: (error: unknown) => string): Promise<ServerUpdateRead> {
  return read().then(
    (status): ServerUpdateRead => ({ ok: true, update: status.serverUpdate ?? null }),
    (error: unknown): ServerUpdateRead => ({ ok: false, cause: describe(error) }));
}

/** `serverUpdateNotice` after the install wizard, with a failed read told as an error with its cause. */
export function serverUpdateReadNotice(read: ServerUpdateRead): string | null {
  return read.ok ? serverUpdateNotice(read.update) : messages.serverUpdate.statusUnreadable(read.cause);
}

/** At startup after a connected check: a failed server update (one that left the server stopped already failed the
 * check), or a status that could not be read, as an error; anything else is shown on the settings screen only. */
export function startupServerUpdateNotice(read: ServerUpdateRead): string | null {
  if (!read.ok) return messages.serverUpdate.statusUnreadable(read.cause);
  return read.update?.state === "failed" ? messages.serverUpdate.failed(read.update.message) : null;
}

/** The line for a remote tunnel that is not on its preferred local port (`status.tunnelPort`), or null when it is. */
export function tunnelPortText(notice: TunnelPortNotice | null | undefined): string | null {
  if (!notice) return null;
  const text = messages.tunnelPort;
  switch (notice.reason) {
    case "in-use": return text.inUse(notice.preferredPort, notice.port, notice.owners);
    case "reserved": return text.reserved(notice.preferredPort, notice.port);
    case "bind-failed": return text.bindFailed(notice.preferredPort, notice.port);
  }
}
