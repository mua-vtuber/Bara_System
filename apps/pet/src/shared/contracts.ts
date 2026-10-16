/** Shared wire types; credentials are accepted once but never included in public settings. */
export const PROTOCOL_VERSION = 1;
export const CORE_DEFAULT_PORT = 3001;
/** Bytes a first local install downloads into the managed model folders (`models/hf-cache`, `models/kiwi-model`).
 * Measured sizes of the pinned files: bge-m3 q8 onnx 569.7 MB + tokenizer 17.1 MB; siglip2 text q8 283.4 MB +
 * vision q8 94.7 MB + tokenizer 34.4 MB; reranker q8 570.7 MB + tokenizer 17.1 MB; total about 1.59 GB. The Kiwi
 * archive's size is not known here, so a conservative 100 MB is added. Read by the install's free-space check
 * (`src/service/install/disk-space.ts`) and by the local choice's hint, so both name the same amount. */
export const LOCAL_INSTALL_MODEL_BYTES = 1_700_000_000;
/** Free space a local install keeps beyond the models: the database and its WAL, and temporary download files. */
export const LOCAL_INSTALL_MARGIN_BYTES = 1_000_000_000;
/** Default AI provider base URLs, shown as placeholders and applied when the settings screen switches
 * provider (`src/ui/settings.ts`). Not a live default for `AiSettings.baseUrl` itself -- the actual
 * setting is whatever the user saved. */
export const DEFAULT_AI_URLS = { ollama: "http://127.0.0.1:11434", "openai-compatible": "http://127.0.0.1:1234" } as const;
/** Client-side early length limits, checked before a save/question ever reaches the service (`src/ui/
 * feedback-model.ts` `quickLengthError`). `INPUT_MAX_CHARS` is stricter than the service's own absolute
 * ceiling for a saved body (`src/service/validation.ts` `SAVE_BODY_MAX_CHARS`) on purpose: the UI blocks
 * an oversized paste early with room to spare, while the service still enforces its own larger ceiling
 * independently in case a request ever reaches it some other way. A question has no separate service
 * ceiling: the service checks this same `QUESTION_MAX_CHARS` (`assistant.ts` `ask`, `client.ts` `search`). */
export const INPUT_MAX_CHARS = 30_000;
export const QUESTION_MAX_CHARS = 2_000;
/** Capability name for the dashboard's `?memoryId=` deep link (server-side
 * apps/memory/src/server-internal/routes/client-info-contract.ts `CLIENT_CAPABILITIES`). */
export const CAPABILITY_MEMORY_DEEPLINK = "memory-deeplink";
/** Capability names this Pet cannot work without, matched against `ConnectionStatus.capabilities`
 * (the server's own names, same file). A protocol-version match with one of these missing still
 * means the server predates a feature the Pet relies on, so it gets its own message instead of
 * "connected". */
export const REQUIRED_CAPABILITIES = ["capture", "ingest-receipts", CAPABILITY_MEMORY_DEEPLINK] as const;
export const CAPTURE_KINDS = ["idea", "decision", "question", "preference", "task", "information"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
/** The outgoing (save/update) contract: this Pet only ever writes `"user"` or `"ai"` as a source. */
export interface Capture { kind: CaptureKind; source: "user" | "ai" }
/** A capture as read back from the server (`Memory.metadata.capture`). The kind is always one this Pet
 * knows (`CAPTURE_KINDS`) -- an unrecognized kind lands in `Memory.metadata.unknownCapture` instead, see
 * its doc comment -- but the source is whatever string the server actually sent, which may differ from
 * this Pet's own `"user"|"ai"` write contract (e.g. a value written by another client). Never pass a
 * `StoredCapture` where a `Capture` (save/update params) is expected; build a fresh `Capture` instead. */
export interface StoredCapture { kind: CaptureKind; source: string }
export type ConnectionMode = "local" | "remote" | "existing";
export interface SshConnection {
  host: string; port: number; user: string; keyPath: string;
  fingerprint?: string; serverPath?: string; serverPort?: number;
}
export interface ConnectionSettings {
  mode: ConnectionMode; baseUrl: string; ssh?: SshConnection;
}
/** Version tag of the current `connectionAudience` format. Audiences written before it carry no tag. */
export const CONNECTION_AUDIENCE_VERSION = 2;
const SSH_KEYS = ["host", "port", "user", "keyPath", "fingerprint", "serverPath", "serverPort"] as const;
/** The SSH settings in one fixed key order, so equal settings always serialize to the same text. */
function canonicalSsh(ssh: SshConnection | undefined): Partial<SshConnection> | null {
  if (!ssh) return null;
  const canonical: Record<string, unknown> = {};
  for (const key of SSH_KEYS) if (ssh[key] !== undefined) canonical[key] = ssh[key];
  return canonical as Partial<SshConnection>;
}
/** Stable, non-secret identity of the memory server a connection reaches. It is stored with pending
 * receipts, deep links, bound credentials and port reservations. A remote (SSH) server is the remote
 * host, its host key fingerprint and the port the server listens on there: the local tunnel address,
 * the SSH login user and the SSH port only change how the Pet reaches that server, so a tunnel moved to
 * a new local port after a restart still names the same server. A local or existing server is its
 * address (and SSH route, if any), as the Pet has no other identity for it; a remote connection without
 * SSH settings, which `validateConnection` never lets through, has the same address-only identity. */
export function connectionAudience(connection: ConnectionSettings): string {
  if (connection.mode === "remote" && connection.ssh) {
    const { host, fingerprint, serverPort } = connection.ssh;
    return JSON.stringify({ v: CONNECTION_AUDIENCE_VERSION, mode: "remote", host, fingerprint: fingerprint ?? null,
      serverPort: serverPort ?? CORE_DEFAULT_PORT });
  }
  return JSON.stringify({ v: CONNECTION_AUDIENCE_VERSION, mode: connection.mode, origin: connection.baseUrl,
    ssh: canonicalSsh(connection.ssh) });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function legacySsh(value: unknown): SshConnection | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !(SSH_KEYS as readonly string[]).includes(key))) return null;
  const { host, port, user, keyPath, fingerprint, serverPath, serverPort } = value;
  if (typeof host !== "string" || typeof port !== "number" || typeof user !== "string" || typeof keyPath !== "string" ||
      (fingerprint !== undefined && typeof fingerprint !== "string") || (serverPath !== undefined && typeof serverPath !== "string") ||
      (serverPort !== undefined && typeof serverPort !== "number")) return null;
  return { host, port, user, keyPath, ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(serverPath !== undefined ? { serverPath } : {}), ...(serverPort !== undefined ? { serverPort } : {}) };
}
/** The connection an untagged (pre-version-2) audience was computed from: that format was exactly
 * `{mode, origin: baseUrl, ssh}`. Any other value, including an unreadable one, is not that format. */
function legacyAudienceConnection(stored: string): ConnectionSettings | null {
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return null; } // not JSON, so not the untagged format
  if (!isRecord(value) || Object.keys(value).length !== 3 || !("ssh" in value)) return null;
  const { mode, origin, ssh } = value;
  if ((mode !== "local" && mode !== "remote" && mode !== "existing") || typeof origin !== "string" || origin.length < 1) return null;
  if (ssh === null) return { mode, baseUrl: origin };
  const parsed = legacySsh(ssh);
  return parsed ? { mode, baseUrl: origin, ssh: parsed } : null;
}
/** The one comparison of a stored or caller-supplied audience with the current connection. It accepts
 * the current format, or an untagged audience whose own settings name the same server as `connection`
 * (a receipt stored before a restart moved the SSH tunnel to a new local port, for example). An
 * untagged audience of any other server, and any unreadable value, never matches. */
export function audienceMatches(stored: string, connection: ConnectionSettings): boolean {
  const current = connectionAudience(connection);
  if (stored === current) return true;
  const legacy = legacyAudienceConnection(stored);
  return legacy !== null && connectionAudience(legacy) === current;
}
/** The SSH settings of a stored "existing"-mode audience (current or untagged format), or null for any
 * other value. */
function storedExistingSsh(stored: string): SshConnection | null {
  const legacy = legacyAudienceConnection(stored);
  if (legacy) return legacy.mode === "existing" ? legacy.ssh ?? null : null;
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return null; } // unreadable: names no endpoint
  if (!isRecord(value) || Object.keys(value).length !== 4 || value.v !== CONNECTION_AUDIENCE_VERSION ||
      value.mode !== "existing" || typeof value.origin !== "string") return null;
  return legacySsh(value.ssh);
}
/** Whether `stored`, the audience of an "existing"-mode SSH tunnel, names the very server the remote
 * `connection` reaches by the remote identity of `connectionAudience`: the same host, the same pinned host
 * key and the same server port. Both connections then carry the same server's credentials, so a local
 * tunnel address the existing connection reserved may pass to the remote one (`config.ts` `checkOrigin`).
 * Only that direction exists, and never without a pinned host key on both sides. */
export function sameSshEndpoint(stored: string, connection: ConnectionSettings): boolean {
  if (connection.mode !== "remote" || !connection.ssh?.fingerprint) return false;
  const held = storedExistingSsh(stored);
  return held !== null && !!held.fingerprint && held.fingerprint === connection.ssh.fingerprint &&
    held.host === connection.ssh.host &&
    (held.serverPort ?? CORE_DEFAULT_PORT) === (connection.ssh.serverPort ?? CORE_DEFAULT_PORT);
}
/** Why a remote connection's SSH tunnel is not on its preferred local port (`CORE_DEFAULT_PORT`, the
 * address external AI apps such as Claude Code's bara MCP use): another program listens there (`owners`
 * are its process ids, empty when they could not be named), another server's connection reserved that
 * address, or the tunnel could not bind it. `port` is the local port the tunnel uses instead. */
export interface TunnelPortNotice {
  preferredPort: number; port: number; reason: "in-use" | "reserved" | "bind-failed"; owners: number[];
}
/** The exact address requests go to plus the complete SSH route. Only the service compares it, in
 * memory, to check that a snapshot's address is still the saved one before a credential is sent there
 * or the snapshot is written back; unlike `connectionAudience` it changes with the local tunnel port and
 * the SSH login. It is never stored or sent to the screen. */
export function connectionRoute(connection: ConnectionSettings): string {
  return JSON.stringify(["route", connection.mode, connection.baseUrl, canonicalSsh(connection.ssh)]);
}
export type AiProvider = "none" | "ollama" | "openai-compatible";
export interface AiSettings { provider: AiProvider; baseUrl: string; model: string }
/** `"none"` is the explicit "no cleanup AI chosen yet" state -- the same pattern as `AiProvider`'s own
 * `"none"` -- so an unconfigured install never silently defaults to a specific provider. */
export type CleanupProvider = "none" | "claude" | "codex" | "ollama" | "openai-compatible";
export interface CleanupSettings { provider: CleanupProvider; model: string }
export interface PublicSettings {
  version: 1; connection: ConnectionSettings; ai: AiSettings; cleanup: CleanupSettings;
  autoStart: boolean; hasToken: boolean; hasOwnerToken: boolean; hasAiKey: boolean;
  /** "입력한 메모 바로 정리": after a memo is saved, the Pet cleans up that memo alone (default off). */
  cleanupOnSave: boolean;
}
export interface SettingsUpdate {
  connection?: ConnectionSettings; ai?: AiSettings; cleanup?: CleanupSettings; autoStart?: boolean; cleanupOnSave?: boolean;
  token?: string; ownerToken?: string; aiKey?: string;
}
/** The last "입력한 메모 바로 정리" outcome the settings screen shows, so a failure outside the screen is not silent. */
export interface CleanupOnSaveStatus { memoryId: number; at: string; outcome: "done" | "failed" | "skipped"; detail: string }
/** What the settings screen shows: the newest result and the newest failure (kept until a newer failure replaces it). */
export interface CleanupOnSaveReport { latest: CleanupOnSaveStatus | null; lastFailure: CleanupOnSaveStatus | null }
export interface Memory {
  id: number; content: string; createdAt?: string; updatedAt?: string; revision?: number;
  audience?: string;
  editableContent?: string;
  /** `capture` is set only when the server's kind is one this Pet knows (`CAPTURE_KINDS`). A kind the
   * server sent but this Pet has never heard of (a newer server feature) lands in `unknownCapture`
   * instead -- it is honestly unclassified information, not a validation failure, since this Pet is
   * only reading a value it did not send. */
  metadata?: Record<string, unknown> & { capture?: StoredCapture; unknownCapture?: { kind: string; source: string } };
  memoryType?: string;
}
export interface SearchHit { memory: Memory; score?: number }
export interface SearchResult { query: string; results: SearchHit[]; audience?: string }
export interface SaveInput { content: string; requestId: string; audience: string; kind?: CaptureKind | null; autoClassify?: boolean }
/** Distinguishes an AI's explicit "no clear category" from a classification step that failed to run. */
export interface SaveClassification {
  outcome: "applied" | "undecided" | "failed";
  capture?: Capture | null;
  reason?: string;
}
export interface SaveResult {
  state: "saved" | "pending" | "unknown" | "rejected"; requestId: string;
  audience?: string;
  memory?: Memory; message?: string; capture?: Capture | null;
  classification?: SaveClassification;
  /** Only meaningful when `state === "saved"`. `"memory"` (or absent, for a pre-entity-patch server)
   * means the input became a normal memory with an origin node; `memory`/`memoryId` apply.
   * `"entity_patch"` means a bodyless entity-only input (e.g. `#가계부:미용 #금액:28000원`) updated an
   * existing entity's fields instead of creating one, so there is no origin node to fetch. */
  resultType?: "memory" | "entity_patch";
}
/** How an answer came out, named by `assistant.ts` where the answer is built so no screen has to guess it
 * from the text or the sources: `found` = the search returned at least one memory (whether or not an AI
 * wrote the answer), `notFound` = the search returned none, `aiFailed` = memories were found but the
 * answer AI could not produce an answer. The same list is `src/shared/native-host.json`
 * `contract.answerOutcomes`, which the host checks an `answer` feedback against. */
export const ANSWER_OUTCOMES = ["found", "notFound", "aiFailed"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];
export interface Answer { text: string; sources: Memory[]; generated: boolean; outcome: AnswerOutcome; audience?: string }
export interface ConnectionStatus {
  connected: boolean; message: string; protocolVersion?: number; serverVersion?: string;
  capabilities?: string[];
}
/** How this start relates to the version recorded in `maintenance.json`: `first-run` (no record yet; this
 * does NOT mean there is no data, since an install that predates the record has data), `same-version` (repair
 * or restart), `update` (a newer app than recorded), `downgrade` (an older app than recorded), `unreadable`
 * (the file was read but is invalid or in a format this app does not know, possibly from a newer app),
 * `read-failed` (the file exists but reading it failed with an I/O error, so its content is unknown and the
 * next start tries again) or `unversioned` (this app's own version is not plain MAJOR.MINOR.PATCH, so it
 * cannot be compared and nothing is written). Everything except the first three is reported, not acted on,
 * and never overwrites the record. */
export type MaintenanceRun = "first-run" | "same-version" | "update" | "downgrade" | "unreadable" | "read-failed" | "unversioned";
export interface MaintenanceStatus { run: MaintenanceRun; appVersion: string; recordedVersion: string | null; installationId: string | null }
/** Where the update of the local memory data stands (`<dataDir>/update-state.json`, `src/service/maintenance/upgrade.ts`):
 * `backup` (the pre-update backup is being made, or a run was cut off while making it), `backed-up` (it is complete
 * and the database was not opened yet), `migrating` (the new version's preparation opened the database; a run cut
 * off here may have migrated it), `complete` (the local server started on the updated data) or `failed` (stopped at
 * `failedStage`, with `errorCode`). */
export const UPDATE_STAGES = ["backup", "backed-up", "migrating", "complete", "failed"] as const;
export type UpdateStage = (typeof UPDATE_STAGES)[number];
/** `from` is the recorded app version, or `unknown` for data an app from before the record left. `backupPath` is the
 * pre-update backup folder once one is complete (null otherwise). */
export interface UpdateStatus {
  stage: UpdateStage; from: string; to: string; backupPath: string | null;
  failedStage: "backup" | "migrating" | null; errorCode: string | null;
}
/** What a Pet-installed remote server runs, from its `current/release.json` (docs/decisions/2026-10-08-single-deploy-path-spec.md 5.1). */
export interface RemoteServerRelease { appVersion: string; origin: "pet" | "dev"; commit: string | null }
/** The Pet's update of its remote server in this service start (`src/service/install/remote-update.ts`, spec 5.3).
 * `current`: the server runs `installed` (after an update, the Pet's own version). `leftoverLock` names the lock folder an
 * update finished without removing (a later update stops until it is deleted); `cancelledAfterCheck` says a cancel came
 * after the new version had passed its start check, so the update was finished anyway.
 * `failed`: `to` is null when the failure came before the Pet's own server version was read. `stopped`: the failure left
 * the server's service stopped; a rolled-back or refused update, or one that never reached the switch, leaves it as it was. */
export type ServerUpdateStatus =
  | { state: "current"; installed: RemoteServerRelease; leftoverLock: string | null; cancelledAfterCheck: boolean }
  | { state: "updating"; from: string | null; to: string }
  | { state: "failed"; from: string | null; to: string | null; code: string; message: string; stopped: boolean };
/** `installing`: an install (`install.local`, `install.remote`) was accepted and has not ended yet, whether it still
 * waits its turn or runs; false again after it succeeded, failed or was cancelled (`src/shared/run-count.ts`, counted in `src/service/router.ts`). */
export interface AppStatus { connection: ConnectionStatus; activeOperations: string[]; installing: boolean; installed: boolean; maintenance: MaintenanceStatus;
  update: UpdateStatus | null; serverUpdate: ServerUpdateStatus | null;
  /** Set while the running remote tunnel is not on its preferred local port; null otherwise. */
  tunnelPort: TunnelPortNotice | null }
/** Why an AI check came back unavailable, so a screen can pick the fix without reading `message`:
 * nothing is configured, the CLI is not on this PC, the CLI is not logged in, the server (or an
 * unexplained CLI failure) did not answer, the chosen model is missing or unselected, or the CLI version
 * lacks the tool restrictions the Pet needs. Absent when `available` is true. */
export type AiProbeReason = "not-configured" | "not-installed" | "login-required" | "connection-failed" | "model-missing" | "unsafe-version";
export interface AiProbeResult { available: boolean; models: string[]; message: string; reason?: AiProbeReason }
/** A local AI server `ai.discover` found answering at one of the Pet's fixed candidate addresses.
 * `id` names the candidate (`ollama`, `lm-studio`, `jan`, `llama-cpp`); `models` may be empty. */
export interface DiscoveredServer { id: string; provider: "ollama" | "openai-compatible"; baseUrl: string; models: string[] }
/** Whether the `claude` or `codex` command resolves on PATH. Login is not checked (`ai.probe` does that). */
export interface DiscoveredCli { provider: "claude" | "codex"; installed: boolean }
export interface AiDiscovery { servers: DiscoveredServer[]; clis: DiscoveredCli[] }
/** One candidate or stage the cleanup run could not process, with the reason so the screen can show
 * it instead of a silent "N skipped". `stage` is a `CleanupStage` (`src/service/cleanup.ts`) or
 * `"unknown"` when the failure happened before a stage was identified. */
export interface CleanupFailure { stage: string; code: string; message: string }
/** What a cleanup run did, as counts and per-candidate failures only: the screen writes the sentence
 * itself from `messages.cleanup`, so no service-made text reaches it. */
/** One name the cleanup AI gave with a type the server did not offer, left out of the submitted answer. */
export interface CleanupSkippedName { stage: string; type: string; name: string }
/** One proposal the cleanup server's quality checks turned down (regexStrengthen): `reason` is the server's
 * check name (`compile`, `self_match`, `overmatch`, `redundant`, `validity`) and `detail` its own sentence. */
export interface CleanupRejection { stage: string; reason: string; detail: string }
/** `rejected`/`rejections` are present only when the server turned a proposal down; such a candidate counts
 * neither as submitted nor as skipped. */
export interface CleanupResult { submitted: number; noFinding: number; skipped: number; rejected?: number; audience?: string; failures?: CleanupFailure[]; skippedNames?: CleanupSkippedName[]; rejections?: CleanupRejection[] }
export interface CleanupProposal { id: string; kind: string; status: string; summary?: string; audience?: string }
export interface InstallResult { connection: ConnectionSettings; message: string }
/** A finished backup: the folder the exporter published (absolute, and its name under the backup folder) and
 * what it holds, as counts the screen writes its own sentence from. */
export interface BackupResult { folder: string; folderName: string; memories: number; attachments: number }
/** Where a backup the settings screen can restore from came from: one the user made there (`manual`, under the
 * host's backup folder) or the one the update gate made before an update (`pre-update`). */
export type RestoreBackupKind = "manual" | "pre-update";
/** One backup `backup.list` found. `id` is opaque: `backup.restore` names the backup by it and the service finds the
 * folder again in a fresh listing, so the screen never sends a path. `createdAt` is ISO 8601; the counts are the
 * backup's own (`memories` the live memories, not the trashed ones). `resumable` marks the backup a restore that
 * stopped part-way was working on: choosing it again goes on from there. */
export interface RestoreEntry {
  id: string; kind: RestoreBackupKind; name: string; createdAt: string; memories: number; attachments: number; resumable: boolean;
}
/** How the last restore ended, as the restore record (`<dataDir>/restore-state.json`) keeps it: `complete` (the
 * server runs on the restored memories), `swapped` (the memories were put in place but the server has not started on
 * them yet), `rolled-back` (a start found a switch cut off and put the previous memories back) or `interrupted` (a
 * start found a restore cut off before the switch; nothing had changed). `beforeFolder` is where the memories from
 * before the restore were moved, kept until the user removes them. */
export interface LastRestore {
  outcome: "complete" | "swapped" | "rolled-back" | "interrupted"; at: string; backupName: string;
  beforeFolder: string | null; memories: number | null; attachments: number | null;
}
export interface RestoreListing { entries: RestoreEntry[]; last: LastRestore | null }
/** A finished restore: the restored counts (checked against the backup's manifest) and the folder that now holds the
 * memories from before it. */
export interface RestoreResult {
  backupName: string; kind: RestoreBackupKind; memories: number; archived: number; attachments: number;
  beforeFolder: string; resumed: boolean;
}
/** The two settings-screen jobs on this PC's store (`backup.export`, `backup.restore`). Each runs in the service, not in
 * the screen: leaving the screen ends only its wait, and only `backup.cancel` (the screen's "중단") or quitting stops
 * the job. */
export type BackupJobKind = "export" | "restore";
/** One job as `backup.status` reports it: running (with the stage it reached), or ended with the outcome no screen
 * has received yet. Times are ISO 8601. An ended job's outcome is reported once: to a screen still waiting on it when
 * it ends, or else to the next `backup.status`. */
export type BackupJobState<T> =
  | { state: "running"; startedAt: string; stage: ProgressStage | null; detail?: ProgressDetail }
  | { state: "done"; startedAt: string; endedAt: string; result: T }
  | { state: "failed"; startedAt: string; endedAt: string; error: RpcError };
export interface BackupJobs { export: BackupJobState<BackupResult> | null; restore: BackupJobState<RestoreResult> | null }
/** `restoreFrom`: the id of a backup in `backup.list` (`scope: "remote-install"`) to fill the new server with (spec 4). */
export interface RemoteInstallInput { ssh: SshConnection; acceptedFingerprint: string; restoreFrom?: string }
export interface HostInspection { fingerprint: string; host: string; keyType: string; known: boolean }
export interface Enrollment {
  state: "pending" | "approved" | "rejected"; requestId?: string; message: string;
}
/** Native-assigned sequence prevents an older event/read response replacing a newer bubble. */
export interface Feedback {
  id: string;
  kind: "working" | "saved" | "answer" | "error";
  mode: "input" | "question";
  summary: string;
  detail: string;
  memoryId?: number;
  sources?: Array<{ id: number; content: string }>;
  generated?: boolean;
  requestId?: string;
  audience?: string;
  sequence?: number;
  /** Set only on a `saved` feedback whose classification step failed; lets a view that re-fetches
   * the memory (and so loses `detail`, the original failure text) still surface the reason. */
  classificationFailureReason?: string;
  /** Set on every `answer` feedback and on no other kind (the host rejects either mistake): the
   * outcome `assistant.ts` named for the answer, kept even when `sources` is emptied for an audience mismatch. */
  answerOutcome?: AnswerOutcome;
  /** Who started the work: `user` (a save, a question, a tray command) or `background` (the startup check).
   * Absent means the user. While the pet is hidden the host pops up a bubble only for the user's results;
   * a background result waits in the tray's "최근 결과" (`src-tauri/src/feedback.rs` `shows_bubble`). */
  origin?: FeedbackOrigin;
}

export type FeedbackOrigin = "user" | "background";

/** The startup step that failed: reading the saved settings, or checking the server connection. They
 * fail for different reasons and call for different fixes, so each has its own text. */
export type StartupStage = "settings" | "connection";
/** How the startup check ended (`src/ui/startup-check.ts` `checkStartup`). A failure names the step that failed
 * (`stage`), the cause (`reason`) and the sentence the status line shows (`text`); the bubble is built from `stage`
 * and `reason`, and `text` stands in for it when the bubble cannot be published. */
export type StartupCheck =
  | { kind: "firstRun" }
  | { kind: "connected"; message: string }
  | { kind: "failed"; stage: StartupStage; reason: string; text: string };
/** `startup.check`'s answer. The service runs the startup check once per start and every caller (the native host
 * right after it starts the service, then the main window) receives the same outcome. A failure also carries the
 * background bubble for it (`src/ui/startup-failure.ts`), which the host shows itself only when the main window
 * did not take the report (`claim_startup_report`), for example because its page failed to load. */
export type StartupCheckResult = Exclude<StartupCheck, { kind: "failed" }> | (Extract<StartupCheck, { kind: "failed" }> & { feedback: Feedback });

/** The last check for a newer pet (docs/decisions/2026-10-14-pet-self-update-spec.md 5.3): never checked, checked with
 * no newer version, checked with a newer version, or failed. */
export type SelfUpdateCheckState = "unknown" | "current" | "available" | "failed";
/** `selfUpdate.status`: what the pet window draws from (spec 5.3), and nothing else.
 * - `available`: the newer version the update button offers; kept through a later failed check (spec 5.3).
 * - `failure`: the last check's code and sentence while `check` is `failed`.
 * - `failureNoticeId`: changes only when a new run of failed checks starts; the pet window shows `failure` on its notice
 *   line once per id (spec 5.4).
 * - `announce`: the version whose notice bubble is still owed (`available` and not yet acknowledged).
 * - `logError`: why the failure log (`self-update.log`) could not be written, if it could not.
 * - `recordError`: why the notice record (`self-update.json`) could not be read or written, if it could not. While it
 *   cannot be read, `announce` is null: the notice bubble is not shown on a guess. */
export interface SelfUpdateStatus {
  check: SelfUpdateCheckState;
  available: string | null;
  failure: { code: string; message: string } | null;
  failureNoticeId: number | null;
  announce: string | null;
  logError: string | null;
  recordError: string | null;
}
/** A downloaded installer whose size and sha256 matched the release (spec 6.2): `installer` is its absolute path inside
 * the pet data folder's `updates` folder, the only place the host runs it from (`src-tauri/src/self_update.rs`). */
export interface SelfUpdateInstallResult { version: string; installer: string }
/** The bubble's update phases (spec 6.1), kept by the host (`src-tauri/src/update_bubble.rs`). */
export const UPDATE_BUBBLE_PHASES = ["notice", "confirm", "busy", "failed"] as const;
export type UpdateBubblePhase = (typeof UPDATE_BUBBLE_PHASES)[number];
/** Native host -> bubble event (`native-host.json` `contract.updateBubbleEvent`). `sequence` comes from the same counter
 * as `Feedback.sequence`, so the bubble orders results and update events as the host made them. */
export interface UpdateBubbleEvent { phase: UpdateBubblePhase; version: string; sequence: number }

export interface RpcOperations {
  "status": { params: Record<string, never>; result: AppStatus };
  "settings.get": { params: Record<string, never>; result: PublicSettings };
  "settings.save": { params: SettingsUpdate; result: PublicSettings };
  "connection.test": { params: Record<string, never>; result: ConnectionStatus };
  "startup.check": { params: Record<string, never>; result: StartupCheckResult };
  "enrollment.start": { params: Record<string, never>; result: Enrollment };
  "enrollment.poll": { params: Record<string, never>; result: Enrollment };
  "memory.save": { params: SaveInput; result: SaveResult };
  "memory.status": { params: { requestId: string; audience: string }; result: SaveResult };
  "memory.search": { params: { query: string }; result: SearchResult };
  "memory.get": { params: { id: number; audience: string }; result: Memory };
  "memory.update": { params: { id: number; audience: string; content?: string; expectedRevision?: number; capture?: Capture | null }; result: Memory };
  "assistant.ask": { params: { question: string; audience: string }; result: Answer };
  "ai.probe": { params: { target?: "answer" | "cleanup" }; result: AiProbeResult };
  "ai.discover": { params: Record<string, never>; result: AiDiscovery };
  "cleanup.run": { params: { limit?: number }; result: CleanupResult };
  "cleanup.list": { params: Record<string, never>; result: CleanupProposal[] };
  "cleanup.onSaveStatus": { params: Record<string, never>; result: CleanupOnSaveReport };
  "install.local": { params: Record<string, never>; result: InstallResult };
  "install.remote": { params: RemoteInstallInput; result: InstallResult };
  "ssh.inspect": { params: { ssh: SshConnection }; result: HostInspection };
  "backup.export": { params: Record<string, never>; result: BackupResult };
  "backup.list": { params: { scope?: "remote-install" }; result: RestoreListing };
  "backup.restore": { params: { id: string }; result: RestoreResult };
  "backup.status": { params: Record<string, never>; result: BackupJobs };
  "backup.join": { params: { kind: BackupJobKind }; result: BackupResult | RestoreResult };
  "backup.cancel": { params: { kind: BackupJobKind }; result: { cancelled: boolean } };
  "selfUpdate.status": { params: Record<string, never>; result: SelfUpdateStatus };
  "selfUpdate.acknowledge": { params: { version: string }; result: SelfUpdateStatus };
  "selfUpdate.install": { params: { version: string }; result: SelfUpdateInstallResult };
  "operation.cancel": { params: { requestId: string }; result: { cancelled: boolean } };
}
export type RpcMethod = keyof RpcOperations;
/** Service error code of a request refused while an install runs (`AppStatus.installing`): the dashboard link and a
 * question, which need the finished install (`src/service/router.ts`). A screen tells it apart from a failure. */
export const INSTALL_RUNNING_CODE = "INSTALL_RUNNING";
/** Service error codes a `memory.update` can end with that the edit dialog answers with a
 * "reload the latest" action: the server refused a stale revision (`conflict`) or an AI classification
 * over a user one (`captureConflict`), or the edit was saved but its read-back failed (`rereadFailed`). */
export const MEMORY_EDIT_ERROR_CODES = { conflict: "EDIT_CONFLICT", captureConflict: "CAPTURE_CONFLICT", rereadFailed: "EDIT_REREAD_FAILED" } as const;
export const RPC_METHODS: readonly RpcMethod[] = [
  "status", "settings.get", "settings.save", "connection.test", "startup.check", "enrollment.start", "enrollment.poll",
  "memory.save", "memory.status", "memory.search", "memory.get", "memory.update", "assistant.ask", "ai.probe", "ai.discover",
  "cleanup.run", "cleanup.list", "cleanup.onSaveStatus", "install.local", "install.remote", "ssh.inspect", "backup.export", "backup.list", "backup.restore",
  "backup.status", "backup.join", "backup.cancel",
  "selfUpdate.status", "selfUpdate.acknowledge", "selfUpdate.install", "operation.cancel",
];
export interface RpcRequest { id: string; method: RpcMethod; params: unknown }
export interface RpcError { code: string; message: string }
export type RpcResponse = { id: string; result: unknown } | { id: string; error: RpcError };
/** What a native command or a `request` rejects with (`src-tauri/src/host_error.rs` `HostError`).
 * A host failure carries only its code (listed in `src/shared/native-host.json` `contract.hostErrorCodes`)
 * and, when there is one, a numeric OS error or exit `status`; a service failure carries the service's
 * code and its checked public `message`, kept apart instead of joined into one string. */
export interface HostErrorPayload { code: string; message?: string; status?: number }
export const PROGRESS_STAGES = ["prepare", "models", "server", "host-key", "preflight", "transfer", "dependencies", "service", "search", "answer", "classify", "cleanup", "update-backup", "restore-verify", "restore-data", "restore-switch", "server-update", "self-update-download", "self-update-verify"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];
/** Byte counts of one download inside a stage (today only `models`): file `part` of `parts` (1-based,
 * `part <= parts <= contract.progressDetailMaxParts`), `loaded` of `total` bytes, `total` 0 when unknown.
 * Numbers only, so no text from a child process reaches the screen through it. */
export interface ProgressDetail { part: number; parts: number; loaded: number; total: number }
/** Service -> native host frame (stdout line), sent by `RequestContext.progress`. The host
 * deliberately discards any accompanying sentence, so this frame carries no message. */
export interface ProgressFrame { event: "progress"; requestId: string; stage: ProgressStage; detail?: ProgressDetail }
/** Native host -> UI event (Tauri `pet-progress`), emitted by `bridge.rs` `route_line` only when
 * the stage is one of `PROGRESS_STAGES` (`policy::progress_stage` drops anything else). This is
 * what `src/ui/bridge.ts` `onProgress` listens for; the UI looks up its own Korean text for the
 * stage in `messages.progress` rather than trusting a message from the host. `detail` is present
 * only when the host found exactly the four bounded integers (`policy::progress_detail`). */
export interface ProgressEvent { requestId: string; stage: ProgressStage; detail?: ProgressDetail }
export interface HostRequest {
  host: { id: string; method: "vault.get" | "vault.set" | "vault.delete"; params: { key: string; value?: string } };
}
export type HostReply = { hostReply: { id: string; result: unknown } | { id: string; error: RpcError } };
/** `progress` with a `detail` may be thinned out on its way to the host (`src/service/progress-frames.ts`);
 * one without a detail always goes through. */
export interface RequestContext { signal: AbortSignal; progress(stage: ProgressStage, detail?: ProgressDetail): void }
/** `backupDir` is the folder backups go to, as the native host chose it (`BARA_PET_BACKUP_DIR`); absent when the
 * host could not tell where the user's Documents folder is. */
export interface RuntimePaths { dataDir: string; resourceDir: string; bunPath: string; backupDir?: string }
/** Implemented by the real private native-host pipe; tests use policy fixtures or real DPAPI. */
export interface HostVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
