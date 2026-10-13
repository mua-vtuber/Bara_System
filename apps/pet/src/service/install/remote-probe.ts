import type { ConnectionSettings, SshConnection } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError, type ServiceError } from "../errors.ts";
import { validateSsh } from "../validation.ts";
import { isSafeRemotePath, remoteCommand, safeRemotePath, shQuote } from "./ssh.ts";

/** Units the Bara core deploys (`deploy/systemd` in the core repository). A rename there must be made
 * here too (fix plan, B2 note). */
export const CORE_SERVICE_UNIT = "bara-memory.service";
export const CORE_DEPLOY_TIMER = "bara-deploy.timer";
/** The one service unit the Pet registers on a remote host, and the line that marks it as the Pet's. */
export const PET_SERVICE_UNIT = "bara-pet-memory.service";
export const PET_UNIT_MARKER = "# Managed by Bara Pet";
/** Layout of a Pet server path on the remote host. */
export const REMOTE_LAYOUT = {
  /** Server path below the remote account's home when the user gives none. */
  defaultDir: ".local/share/bara-pet-server",
  ownedMarker: ".bara-pet-owned", completeMarker: ".bara-pet-complete",
  releases: "releases", current: "current", data: "data", incoming: "incoming",
  /** A release directory is named by this many leading hex digits of the server source SHA-256. */
  releaseIdLength: 16,
} as const;
/** Inside a release: the bundled Bun and the core server it runs (apps/setup/PET-INTEGRATION.md). */
export const RELEASE_LAYOUT = { bun: "bun", serverDir: "apps/memory", serverScript: "src/index.ts", staticDir: "apps/memory/web" } as const;
/** Folder inside a release holding `node`, a link to that release's own Bun, put first on PATH for `bun install`. */
export const RELEASE_NODE_SHIM_DIR = ".bara-node";

/**
 * The one remote dependency install, run by the first install (remote.ts) and by a replace (release-host.ts).
 * Two dependencies (onnxruntime-node, protobufjs) run a postinstall script that calls `node`, and the host usually has
 * none. Bun then falls back to its own shim under /tmp/bun-node-<revision>, and reuses that folder when it already
 * exists, even when its link points at a release that was pruned since: `node: command not found`, exit 127
 * (2026-10-11, the 0.1.5 update on A1). So each release gets its own `node` link to its own Bun, first on PATH, and the
 * /tmp shim is never consulted.
 */
export function dependencyInstallScript(release: string): string {
  const shim = `${release}/${RELEASE_NODE_SHIM_DIR}`;
  const bun = `${release}/${RELEASE_LAYOUT.bun}`;
  return `cd ${shQuote(release)} && ${remoteCommand(["mkdir", "-p", shim])} && ${remoteCommand(["ln", "-sfn", bun, `${shim}/node`])} && ` +
    `PATH=${shQuote(shim)}:"$PATH" ${remoteCommand([bun, "install", "--frozen-lockfile", "--production"])}`;
}
/** Core CLIs run inside a release (apps/setup/PET-INTEGRATION.md). The install and the replace procedure run the same ones. */
export const CORE_CLI = { prepare: "apps/setup/src/managed-prepare.ts", models: "apps/setup/src/managed-models.ts",
  prefetch: "apps/memory/scripts/prefetch-core-models.ts", clientToken: "apps/setup/src/client-token.ts",
  restore: "apps/setup/src/managed-restore.ts" } as const;
/** Environment `managed-prepare` returns (apps/setup/PET-INTEGRATION.md), written into the Pet's unit
 * together with `MEMORY_STATIC`. */
export const MANAGED_PATH_KEYS = ["MEMORY_SETTINGS_PATH", "MEMORY_DB_PATH", "BARA_SECRETS_PATH", "BARA_ASSET_DIR",
  "BARA_HF_CACHE_DIR", "BARA_KIWI_MODEL_DIR", "SSE_TOKEN_PATH"] as const;
export const MANAGED_ENV_KEYS = [...MANAGED_PATH_KEYS, "MEMORY_PORT", "MEMORY_HOST", "TZ"] as const;
export const MANAGED_HOST = "127.0.0.1";
/** Where the Pet's unit tells the server its dashboard files are; it also names the release the unit runs. */
export const STATIC_ENV_KEY = "MEMORY_STATIC";
/** Commands the probe and the install steps run; a missing one is named when the install stops. */
export const REMOTE_REQUIRED_COMMANDS = ["tar", "sha256sum", "systemctl", "ss", "grep", "sed", "sort", "paste", "readlink"] as const;

/** Remote output is read only between these lines, so a login shell's own output around it is ignored. */
export const FRAME_BEGIN = "bara-pet-frame-begin";
export const FRAME_END = "bara-pet-frame-end";

/** Shell expression printing each fact, in output order. Everything the probe runs only reads state:
 * `uname`, `id`, `sudo -n true`, `/etc/os-release`, `systemctl cat|show`, `test`, `readlink` and `ss`. */
const FACT_SOURCES = [
  ["os", '"$(uname -s 2>/dev/null)"'], ["machine", '"$(uname -m 2>/dev/null)"'], ["sudo", '"$sudo_state"'],
  ["ubuntu", '"$ubuntu"'], ["systemd", '"$systemd"'], ["tools_missing", '"$missing"'], ["server_path", '"$server_path"'],
  ["core_unit", '"$core_unit"'], ["core_active", '"$(prop "$core_service" ActiveState)"'], ["core_deploy_timer", '"$core_timer_state"'],
  ["pet_unit", '"$pet_unit"'], ["pet_active", '"$(prop "$pet_service" ActiveState)"'],
  ["pet_enabled", '"$(prop "$pet_service" UnitFileState)"'], ["pet_main_pid", '"$pet_main_pid"'],
  ["pet_env", '"$(prop "$pet_service" Environment)"'], ["path", '"$path"'], ["marker", '"$marker"'], ["current", '"$current"'],
  ["release_intact", '"$release_intact"'], ["listener_count", '"$listener_count"'], ["listener_pids", '"$listener_pids"'],
] as const;
export type FactKey = (typeof FACT_SOURCES)[number][0];
export const FACT_KEYS: readonly FactKey[] = FACT_SOURCES.map(([key]) => key);

/** POSIX sh body. `$1` is the requested server path (empty for the default below `$HOME`) and `$2` the
 * server port; the constants above arrive as quoted assignments, so no user value is ever part of the code.
 * `systemd` is yes only when `systemctl` really answers, so a unit never reads absent because systemd could not
 * be asked. A unit counts as present when its file exists or systemd still knows it (masked, or loaded after
 * its file was removed). The main PID reads 0 when systemd cannot be asked; the plan stops at `systemd` first.
 * A failed listener lookup reads `?`, never as a free port. */
const PROBE_BODY = [
  "requested=$1 port=$2",
  "case $port in ''|*[!0-9]*) exit 64 ;; esac",
  "LC_ALL=C; export LC_ALL",
  "prop() { systemctl show -p \"$2\" --value \"$1\" 2>/dev/null; }",
  "unit_exists() {",
  "  systemctl --no-pager cat \"$1\" >/dev/null 2>&1 && return 0",
  "  load=$(prop \"$1\" LoadState) state=$(prop \"$1\" ActiveState)",
  "  { [ -n \"$load\" ] && [ \"$load\" != not-found ]; } || { [ -n \"$state\" ] && [ \"$state\" != inactive ]; }",
  "}",
  "if [ \"$(id -u 2>/dev/null)\" = 0 ]; then sudo_state=root",
  "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo_state=yes",
  "else sudo_state=no; fi",
  "if grep -Eq '^ID=\"?ubuntu\"?$' /etc/os-release 2>/dev/null; then ubuntu=yes; else ubuntu=no; fi",
  "if [ -d /run/systemd/system ] && [ -n \"$(systemctl show -p Version --value 2>/dev/null)\" ]; then systemd=yes; else systemd=no; fi",
  "missing=",
  "for tool in $required_commands; do",
  "  command -v \"$tool\" >/dev/null 2>&1 && continue",
  "  if [ -n \"$missing\" ]; then missing=\"$missing,$tool\"; else missing=$tool; fi",
  "done",
  "if [ -n \"$requested\" ]; then server_path=$requested; else server_path=\"$HOME/$default_dir\"; fi",
  "if unit_exists \"$core_service\"; then core_unit=present; else core_unit=absent; fi",
  "if unit_exists \"$core_timer\"; then core_timer_state=present; else core_timer_state=absent; fi",
  "if systemctl --no-pager cat \"$pet_service\" >/dev/null 2>&1; then",
  "  if systemctl --no-pager cat \"$pet_service\" 2>/dev/null | grep -Fqx -e \"$pet_marker\"; then pet_unit=owned; else pet_unit=foreign; fi",
  "elif unit_exists \"$pet_service\"; then pet_unit=foreign",
  "else pet_unit=absent; fi",
  "pet_main_pid=$(prop \"$pet_service\" MainPID)",
  "[ -n \"$pet_main_pid\" ] || pet_main_pid=0",
  "if [ -e \"$server_path\" ] || [ -L \"$server_path\" ]; then",
  "  if [ -f \"$server_path/$owned_marker\" ]; then path=owned; else path=foreign; fi",
  "else path=missing; fi",
  "if [ -f \"$server_path/$complete_marker\" ]; then marker=complete; else marker=none; fi",
  "current=$(readlink \"$server_path/$current_link\" 2>/dev/null) || current=",
  "if [ -x \"$server_path/$current_link/$release_bun\" ] && [ -f \"$server_path/$current_link/$server_entry\" ]; then release_intact=yes",
  "else release_intact=no; fi",
  "if [ \"$sudo_state\" = yes ]; then sockets=$(sudo -n ss -ltnpH \"( sport = :$port )\" 2>/dev/null)",
  "else sockets=$(ss -ltnpH \"( sport = :$port )\" 2>/dev/null); fi",
  "ss_status=$?",
  "listener_count=0 listener_ids=",
  "while IFS= read -r line; do",
  "  case $line in LISTEN*) ;; *) continue ;; esac",
  "  listener_count=$((listener_count + 1))",
  "  ids=$(printf '%s\\n' \"$line\" | grep -o 'pid=[0-9]*' | sed 's/^pid=//')",
  "  [ -n \"$ids\" ] || ids='?'",
  "  listener_ids=\"$listener_ids",
  "$ids\"",
  "done <<EOF",
  "$sockets",
  "EOF",
  "listener_pids=$(printf '%s\\n' \"$listener_ids\" | sed '/^$/d' | sort -u | paste -s -d , -)",
  "if [ \"$ss_status\" != 0 ]; then listener_count='?' listener_pids=; fi",
];

function assignments(values: Record<string, string>): string[] {
  return Object.entries(values).map(([name, value]) => `${name}=${shQuote(value)}`);
}

/** Lines printing `sources` as one frame of `key=value` lines. */
function frameLines(sources: ReadonlyArray<readonly [string, string]>): string[] {
  return [`printf '%s\\n' ${shQuote(FRAME_BEGIN)}`,
    ...sources.map(([key, source]) => `printf '%s=%s\\n' ${key} ${source}`), `printf '%s\\n' ${shQuote(FRAME_END)}`];
}

export const PROBE_SCRIPT = [
  ...assignments({ default_dir: REMOTE_LAYOUT.defaultDir, required_commands: REMOTE_REQUIRED_COMMANDS.join(" "),
    core_service: CORE_SERVICE_UNIT, core_timer: CORE_DEPLOY_TIMER, pet_service: PET_SERVICE_UNIT, pet_marker: PET_UNIT_MARKER,
    owned_marker: REMOTE_LAYOUT.ownedMarker, complete_marker: REMOTE_LAYOUT.completeMarker, current_link: REMOTE_LAYOUT.current,
    release_bun: RELEASE_LAYOUT.bun, server_entry: `${RELEASE_LAYOUT.serverDir}/${RELEASE_LAYOUT.serverScript}` }),
  ...PROBE_BODY, ...frameLines(FACT_SOURCES),
].join("\n");

export interface RemoteRequest {
  /** The server path the user gave, already `safeRemotePath`-normalized; absent for the default. */
  serverPath?: string;
  serverPort: number;
  /** Server path of the saved connection when this run recovers it: the probe must find the same path. */
  savedServerPath?: string;
}

/** The one SSH command of the probe. User values travel only as quoted positional arguments. */
export function probeCommand(request: RemoteRequest): string {
  return remoteCommand(["sh", "-c", PROBE_SCRIPT, "bara-pet-probe", request.serverPath ?? "", String(request.serverPort)]);
}

export interface RemoteFacts {
  os: string; machine: string; sudo: "root" | "yes" | "no"; ubuntu: boolean; systemd: boolean; toolsMissing: string[];
  serverPath: string; coreUnit: boolean; coreActive: string; coreDeployTimer: boolean;
  petUnit: "absent" | "owned" | "foreign"; petActive: string; petEnabled: string; petMainPid: number; petEnv: string;
  path: "missing" | "owned" | "foreign"; marker: "none" | "complete"; current: string; releaseIntact: boolean;
  /** Listening sockets on the requested port; `null` when the listener lookup itself failed. */
  listenerCount: number | null;
  /** Each listening process id on the requested port, `?` for a listener whose process is hidden. */
  listenerPids: string[];
}

/** `key=value` lines between the frame markers: each of `keys` exactly once and nothing else. */
function readFrame(text: string, keys: readonly string[], failure: (item: string | null) => ServiceError): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const begin = lines.indexOf(FRAME_BEGIN), end = lines.indexOf(FRAME_END);
  if (begin < 0 || end < begin || lines.lastIndexOf(FRAME_BEGIN) !== begin || lines.lastIndexOf(FRAME_END) !== end) throw failure(null);
  const values = new Map<string, string>();
  for (const line of lines.slice(begin + 1, end)) {
    const split = line.indexOf("=");
    const key = split > 0 ? line.slice(0, split) : "";
    if (!keys.includes(key) || values.has(key)) throw failure(null);
    values.set(key, line.slice(split + 1));
  }
  for (const key of keys) if (!values.has(key)) throw failure(key);
  return values;
}

const TOKEN = /^[A-Za-z0-9._-]{0,64}$/;
const STATE = /^[a-z-]{0,32}$/;
const TEXT = /^[^\x00-\x1f\x7f]{0,16384}$/;
const PID_LIST = /^(?:(?:\d{1,10}|\?)(?:,(?:\d{1,10}|\?))*)?$/;

function probeFailure(item: string | null): ServiceError {
  return serviceError("REMOTE_PREFLIGHT_FAILED", messages.connectionErrors.REMOTE_PREFLIGHT_FAILED(item));
}

/** Read the probe output. A missing, repeated, unknown or malformed fact stops the install. */
export function parseRemoteFacts(text: string): RemoteFacts {
  const raw = readFrame(text, FACT_KEYS, probeFailure);
  const read = (key: FactKey, valid: (value: string) => boolean): string => {
    const value = raw.get(key)!;
    if (!valid(value)) throw probeFailure(key);
    return value;
  };
  const oneOf = <T extends string>(key: FactKey, allowed: readonly T[]): T => read(key, (value) => (allowed as readonly string[]).includes(value)) as T;
  const matching = (key: FactKey, pattern: RegExp): string => read(key, (value) => pattern.test(value));
  const yes = (key: FactKey): boolean => oneOf(key, ["yes", "no"]) === "yes";
  const present = (key: FactKey): boolean => oneOf(key, ["present", "absent"]) === "present";
  const toolsMissing = read("tools_missing", (value) => value === "" ||
    value.split(",").every((tool) => (REMOTE_REQUIRED_COMMANDS as readonly string[]).includes(tool))).split(",").filter(Boolean);
  const count = matching("listener_count", /^(?:\d{1,5}|\?)$/);
  const listenerCount = count === "?" ? null : Number(count);
  const listenerPids = matching("listener_pids", PID_LIST).split(",").filter(Boolean);
  if (listenerCount === null ? listenerPids.length > 0 : (listenerCount === 0) !== (listenerPids.length === 0))
    throw probeFailure("listener_pids");
  return {
    os: matching("os", TOKEN), machine: matching("machine", TOKEN), sudo: oneOf("sudo", ["root", "yes", "no"]),
    ubuntu: yes("ubuntu"), systemd: yes("systemd"), toolsMissing, serverPath: matching("server_path", TEXT),
    coreUnit: present("core_unit"), coreActive: matching("core_active", STATE), coreDeployTimer: present("core_deploy_timer"),
    petUnit: oneOf("pet_unit", ["absent", "owned", "foreign"]), petActive: matching("pet_active", STATE),
    petEnabled: matching("pet_enabled", STATE), petMainPid: Number(matching("pet_main_pid", /^\d{1,10}$/)),
    petEnv: matching("pet_env", TEXT), path: oneOf("path", ["missing", "owned", "foreign"]),
    marker: oneOf("marker", ["none", "complete"]), current: matching("current", TEXT),
    releaseIntact: yes("release_intact"), listenerCount, listenerPids,
  };
}

export type RemoteArch = "x64" | "arm64";
const ARCHES: Readonly<Record<string, RemoteArch>> = { x86_64: "x64", aarch64: "arm64", arm64: "arm64" };
/** Where and how the install steps run. `elevated`: systemd changes need `sudo -n`. */
export interface RemoteHost { serverPath: string; arch: RemoteArch; elevated: boolean }
/** The Pet server a verified unit runs: its release directory, port and token file (the unit's `SSE_TOKEN_PATH`).
 * `unitOnLink`: the unit runs `<server path>/current` (written since spec 2026-10-08 5.1); false for a unit written
 * before, which names a release directory itself and is rewritten once by the next update. */
export interface InstalledServer { release: string; port: number; tokenFile: string; unitOnLink: boolean }

export type RemoteBlock =
  | { code: "REMOTE_OS_UNSUPPORTED" } | { code: "REMOTE_ARCH_UNSUPPORTED" }
  | { code: "REMOTE_TOOLS_MISSING"; missing: string[] } | { code: "REMOTE_SYSTEMD_MISSING" } | { code: "REMOTE_SUDO_REQUIRED" }
  | { code: "REMOTE_PREFLIGHT_FAILED"; item: FactKey }
  /** The saved connection is another server path on this host. */
  | { code: "INSTALL_EXISTING_CONNECTION" }
  /** The core's own service or deploy timer, whatever its state; `service` is its state when the service exists. */
  | { code: "REMOTE_EXISTING_CORE"; service: string | null; timer: boolean }
  /** Something that is not the Pet's sits at the server path. */
  | { code: "REMOTE_EXISTING_SERVER" }
  /** The Pet's unit serves a Pet server at another path; installing here would replace it. */
  | { code: "REMOTE_OTHER_PET_SERVER" }
  | { code: "REMOTE_UNIT_FOREIGN" } | { code: "REMOTE_UNIT_UNRECOGNIZED" }
  | { code: "REMOTE_PORT_MISMATCH"; installed: number; requested: number }
  | { code: "REMOTE_PORT_BUSY"; port: number; owners: string[] };

export type RemotePlan =
  /** Run the idempotent install steps: a new server, or resuming one that is not complete and verified. */
  | { kind: "install"; host: RemoteHost }
  /** A verified install whose service is stopped, failed or not started at boot: enable, restart, connect. */
  | { kind: "repair"; host: RemoteHost; server: InstalledServer }
  /** A verified, running install: connect without changing any server file, whichever release it runs. */
  | { kind: "connect"; host: RemoteHost; server: InstalledServer }
  | { kind: "blocked"; block: RemoteBlock };

type UnitReading = { kind: "unrecognized" } | { kind: "elsewhere" } | { kind: "here"; server: InstalledServer };

/** `systemctl show -p Environment` of the Pet's unit: space-separated `KEY=value` entries with plain values,
 * as the Pet writes them. systemd quotes a value with special characters; such a unit is not the Pet's writing. */
function unitEnvironment(text: string): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const entry of text.split(" ")) {
    const match = /^([A-Z_][A-Z0-9_]*)=([^\s"'`$\\]*)$/.exec(entry);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  return values;
}

/** The Pet unit's environment as `planRemoteInstall` verified it; the update writes it back into a link unit. */
export function petUnitEnvironment(text: string): Record<string, string> {
  const values = unitEnvironment(text);
  if (!values) throw serviceError("REMOTE_UNIT_UNRECOGNIZED", messages.connectionErrors.REMOTE_UNIT_UNRECOGNIZED(PET_SERVICE_UNIT));
  return Object.fromEntries(values);
}

/** The server path that owns `release` (`<path>/releases/<id>`), or null when it is not a release directory. */
function releaseRoot(release: string): string | null {
  const separator = `/${REMOTE_LAYOUT.releases}/`;
  const at = release.lastIndexOf(separator);
  const id = release.slice(at + separator.length);
  return at > 0 && isSafeRemotePath(release) && new RegExp(`^[0-9a-f]{${REMOTE_LAYOUT.releaseIdLength}}$`).test(id)
    ? release.slice(0, at) : null;
}

function portNumber(text: string): number | null {
  const port = Number(text);
  return /^\d{1,5}$/.test(text) && port >= 1 && port <= 65535 ? port : null;
}

/** Which Pet server the owned unit runs, read from the environment the Pet wrote into it. A unit on the link runs the
 * release `current` names; when that is no release of this path, the install resumes and fixes the link. */
function readPetUnit(env: string, serverPath: string, current: string): UnitReading {
  const values = unitEnvironment(env);
  if (!values || [...MANAGED_ENV_KEYS, STATIC_ENV_KEY].some((key) => !values.has(key))) return { kind: "unrecognized" };
  const staticDir = values.get(STATIC_ENV_KEY)!;
  const suffix = `/${RELEASE_LAYOUT.staticDir}`;
  const named = staticDir.endsWith(suffix) ? staticDir.slice(0, -suffix.length) : "";
  const linkSuffix = `/${REMOTE_LAYOUT.current}`;
  const unitOnLink = named.endsWith(linkSuffix) && isSafeRemotePath(named);
  const root = unitOnLink ? named.slice(0, -linkSuffix.length) : releaseRoot(named);
  if (root === null || root === "") return { kind: "unrecognized" };
  if (root !== serverPath) return { kind: "elsewhere" };
  const data = `${serverPath}/${REMOTE_LAYOUT.data}/`;
  const port = portNumber(values.get("MEMORY_PORT")!);
  if (port === null || values.get("MEMORY_HOST") !== MANAGED_HOST ||
      MANAGED_PATH_KEYS.some((key) => { const path = values.get(key)!; return !isSafeRemotePath(path) || !path.startsWith(data); }))
    return { kind: "unrecognized" };
  const release = unitOnLink ? (releaseRoot(current) === serverPath ? current : named) : named;
  return { kind: "here", server: { release, port, tokenFile: values.get("SSE_TOKEN_PATH")!, unitOnLink } };
}

/** Active states in which the unit's process runs. */
const RUNNING = new Set(["active", "reloading"]);

/** Decide what an install run does on this host. Nothing the Pet did not install is ever changed: an existing
 * core, foreign data or a foreign unit stops the run, and a complete record is trusted only when its unit,
 * release and port check out. The requested port must be free or held only by the Pet unit's own process. */
export function planRemoteInstall(facts: RemoteFacts, request: RemoteRequest): RemotePlan {
  const blocked = (block: RemoteBlock): RemotePlan => ({ kind: "blocked", block });
  if (facts.os !== "Linux" || !facts.ubuntu) return blocked({ code: "REMOTE_OS_UNSUPPORTED" });
  const arch = ARCHES[facts.machine];
  if (!arch) return blocked({ code: "REMOTE_ARCH_UNSUPPORTED" });
  if (facts.toolsMissing.length > 0) return blocked({ code: "REMOTE_TOOLS_MISSING", missing: facts.toolsMissing });
  if (!facts.systemd) return blocked({ code: "REMOTE_SYSTEMD_MISSING" });
  if (facts.sudo === "no") return blocked({ code: "REMOTE_SUDO_REQUIRED" });
  // An unusable default below the remote home ends here as before, with the path input error.
  const serverPath = safeRemotePath(facts.serverPath);
  if (request.serverPath !== undefined && serverPath !== request.serverPath) return blocked({ code: "REMOTE_PREFLIGHT_FAILED", item: "server_path" });
  if (request.savedServerPath !== undefined && serverPath !== request.savedServerPath) return blocked({ code: "INSTALL_EXISTING_CONNECTION" });
  if (facts.coreUnit || facts.coreDeployTimer)
    return blocked({ code: "REMOTE_EXISTING_CORE", service: facts.coreUnit ? facts.coreActive : null, timer: facts.coreDeployTimer });
  if (facts.path === "foreign") return blocked({ code: "REMOTE_EXISTING_SERVER" });
  if (facts.petUnit === "foreign") return blocked({ code: "REMOTE_UNIT_FOREIGN" });
  const unit = facts.petUnit === "owned" ? readPetUnit(facts.petEnv, serverPath, facts.current) : null;
  if (unit?.kind === "unrecognized") return blocked({ code: "REMOTE_UNIT_UNRECOGNIZED" });
  if (unit?.kind === "elsewhere") return blocked({ code: "REMOTE_OTHER_PET_SERVER" });
  const server = unit?.kind === "here" ? unit.server : null;
  // Data may exist only under an existing path; a leftover unit of a removed path protects nothing.
  if (server && facts.path === "owned" && server.port !== request.serverPort)
    return blocked({ code: "REMOTE_PORT_MISMATCH", installed: server.port, requested: request.serverPort });
  // Who holds the port decides where a token may go; an unread listener table is never a free port.
  if (facts.listenerCount === null) return blocked({ code: "REMOTE_PREFLIGHT_FAILED", item: "listener_count" });
  const ownPid = server && facts.petMainPid > 0 ? String(facts.petMainPid) : null;
  const owners = facts.listenerPids.filter((pid) => pid !== ownPid);
  const busy = owners.length > 0 ? blocked({ code: "REMOTE_PORT_BUSY", port: request.serverPort, owners }) : null;
  const host: RemoteHost = { serverPath, arch, elevated: facts.sudo === "yes" };
  if (!server || facts.path === "missing" || facts.marker === "none" || !facts.releaseIntact || facts.current !== server.release)
    return busy ?? { kind: "install", host };
  if (busy) return busy;
  return RUNNING.has(facts.petActive) && facts.petEnabled === "enabled"
    ? { kind: "connect", host, server } : { kind: "repair", host, server };
}

/** Whether `requested` names the remote server of the saved connection: the same host, SSH port and account,
 * and the same server path when one is given. Only such a run may go on while a token is stored, as that
 * server's recovery; the probe then checks the server path it finds (`RemoteRequest.savedServerPath`). */
export function isSameRemoteTarget(saved: ConnectionSettings, requested: SshConnection): boolean {
  const ssh = saved.mode === "remote" ? saved.ssh : undefined;
  if (!ssh?.serverPath) return false;
  const target = validateSsh(requested);
  return target.host === ssh.host && target.port === ssh.port && target.user === ssh.user &&
    (target.serverPath === undefined || safeRemotePath(target.serverPath) === ssh.serverPath);
}

/** The service error for a block, with its text from `messages.connectionErrors`. */
export function remoteBlockError(block: RemoteBlock): ServiceError {
  const text = messages.connectionErrors;
  switch (block.code) {
    case "REMOTE_OS_UNSUPPORTED": return serviceError(block.code, text.REMOTE_OS_UNSUPPORTED);
    case "REMOTE_ARCH_UNSUPPORTED": return serviceError(block.code, text.REMOTE_ARCH_UNSUPPORTED);
    case "REMOTE_TOOLS_MISSING": return serviceError(block.code, text.REMOTE_TOOLS_MISSING(block.missing.join(", ")));
    case "REMOTE_SYSTEMD_MISSING": return serviceError(block.code, text.REMOTE_SYSTEMD_MISSING);
    case "REMOTE_SUDO_REQUIRED": return serviceError(block.code, text.REMOTE_SUDO_REQUIRED);
    case "REMOTE_PREFLIGHT_FAILED": return probeFailure(block.item);
    case "INSTALL_EXISTING_CONNECTION": return serviceError(block.code, text.INSTALL_EXISTING_CONNECTION);
    case "REMOTE_EXISTING_CORE":
      return serviceError(block.code, block.service === null
        ? text.REMOTE_EXISTING_CORE(CORE_DEPLOY_TIMER, null) : text.REMOTE_EXISTING_CORE(CORE_SERVICE_UNIT, block.service));
    case "REMOTE_EXISTING_SERVER": return serviceError(block.code, text.REMOTE_EXISTING_SERVER);
    case "REMOTE_OTHER_PET_SERVER": return serviceError(block.code, text.REMOTE_OTHER_PET_SERVER(PET_SERVICE_UNIT));
    case "REMOTE_UNIT_FOREIGN": return serviceError(block.code, text.REMOTE_UNIT_FOREIGN(PET_SERVICE_UNIT));
    case "REMOTE_UNIT_UNRECOGNIZED": return serviceError(block.code, text.REMOTE_UNIT_UNRECOGNIZED(PET_SERVICE_UNIT));
    case "REMOTE_PORT_MISMATCH": return serviceError(block.code, text.REMOTE_PORT_MISMATCH(block.installed, block.requested));
    case "REMOTE_PORT_BUSY": return serviceError(block.code, text.REMOTE_PORT_BUSY(block.port, block.owners.join(", ")));
  }
}

const SERVICE_STATE_SOURCES = [["active", "ActiveState"], ["sub", "SubState"], ["enabled", "UnitFileState"]] as const;

/** Enable and restart the Pet's unit, wait up to `waitSeconds` for it to report `active`, then print its
 * states. It never prints the unit's log. `control` is `systemctl`, or `sudo -n systemctl` for a non-root account. */
export function serviceStartCommand(control: string, waitSeconds: number): string {
  const unit = shQuote(PET_SERVICE_UNIT);
  const state = (property: string) => `"$(systemctl show -p ${property} --value ${unit} 2>/dev/null)"`;
  return [
    `${control} enable ${unit} >/dev/null 2>&1`,
    `${control} reset-failed ${unit} >/dev/null 2>&1`,
    `${control} restart ${unit} >/dev/null 2>&1`,
    `waited=0`,
    `while [ "$waited" -lt ${waitSeconds} ]; do`,
    `  case ${state("ActiveState")} in active|failed) break ;; esac`,
    `  sleep 1; waited=$((waited + 1))`,
    `done`,
    ...frameLines(SERVICE_STATE_SOURCES.map(([key, property]) => [key, state(property)] as const)),
  ].join("\n");
}

/** The unit started when it is `active` and starts at boot. Otherwise `REMOTE_SERVICE_FAILED` names its
 * states only, `?` for states the output did not carry. */
export function assertServiceStarted(text: string): void {
  const failed = (active: string, sub: string, enabled: string) => serviceError("REMOTE_SERVICE_FAILED",
    messages.connectionErrors.REMOTE_SERVICE_FAILED(PET_SERVICE_UNIT, active, sub, enabled));
  const unreadable = () => failed("?", "?", "?");
  const values = readFrame(text, SERVICE_STATE_SOURCES.map(([key]) => key), unreadable);
  const active = values.get("active")!, sub = values.get("sub")!, enabled = values.get("enabled")!;
  if (![active, sub, enabled].every((value) => STATE.test(value))) throw unreadable();
  if (active !== "active" || enabled !== "enabled") throw failed(active, sub, enabled);
}
