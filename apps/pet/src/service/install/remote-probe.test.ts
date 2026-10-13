import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ConnectionSettings } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { CORE_DEPLOY_TIMER, CORE_SERVICE_UNIT, FACT_KEYS, FRAME_BEGIN, FRAME_END, PET_SERVICE_UNIT, PROBE_SCRIPT,
  assertServiceStarted, isSameRemoteTarget, parseRemoteFacts, planRemoteInstall, probeCommand, remoteBlockError,
  serviceStartCommand, type FactKey, type RemoteBlock, type RemotePlan, type RemoteRequest } from "./remote-probe.ts";

const PATH = "/home/ubuntu/.local/share/bara-pet-server";
const RELEASE = `${PATH}/releases/0123456789abcdef`;
const PORT = 3001;
const PID = "4242";
const TOKEN_FILE = `${PATH}/data/tokens/sse-tokens.json`;
const REQUEST: RemoteRequest = { serverPort: PORT };

/** The environment the Pet writes into its unit for a server at `root`, as `systemctl show -p Environment
 * --value` prints it. Data paths are the ones `managed-prepare` returns. */
function unitEnv(root = PATH, overrides: Record<string, string | null> = {}): string {
  const data = `${root}/data`;
  const values: Record<string, string | null> = { MEMORY_SETTINGS_PATH: `${data}/config/memory-settings.json`,
    MEMORY_DB_PATH: `${data}/db/bara.sqlite`, MEMORY_PORT: String(PORT), MEMORY_HOST: "127.0.0.1",
    BARA_SECRETS_PATH: `${data}/config/secrets.json`, BARA_ASSET_DIR: `${data}/assets`, BARA_HF_CACHE_DIR: `${data}/models/hf-cache`,
    BARA_KIWI_MODEL_DIR: `${data}/models/kiwi-model`, SSE_TOKEN_PATH: `${data}/tokens/sse-tokens.json`, TZ: "Asia/Seoul",
    MEMORY_STATIC: `${root}/releases/0123456789abcdef/apps/memory/web`, ...overrides };
  return Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}`).join(" ");
}

type Output = Record<FactKey, string>;
/** A supported host with nothing of Bara on it, probed by an account with `sudo -n`. */
const FRESH: Output = { os: "Linux", machine: "aarch64", sudo: "yes", ubuntu: "yes", systemd: "yes", tools_missing: "",
  server_path: PATH, core_unit: "absent", core_active: "inactive", core_deploy_timer: "absent", pet_unit: "absent",
  pet_active: "inactive", pet_enabled: "", pet_main_pid: "0", pet_env: "", path: "missing", marker: "none", current: "",
  release_intact: "no", listener_count: "0", listener_pids: "" };
/** The Pet's complete install with its service running on the port. */
const RUNNING: Partial<Output> = { pet_unit: "owned", pet_active: "active", pet_enabled: "enabled", pet_main_pid: PID,
  pet_env: unitEnv(), path: "owned", marker: "complete", current: RELEASE, release_intact: "yes", listener_count: "1", listener_pids: PID };

/** What the probe prints: its frame, with a login shell's own output around it. */
function probeOutput(facts: Partial<Output>, lines?: string[]): string {
  const all = { ...FRESH, ...facts };
  return ["Welcome to Ubuntu 24.04 LTS", FRAME_BEGIN, ...(lines ?? FACT_KEYS.map((key) => `${key}=${all[key]}`)), FRAME_END, ""].join("\n");
}

function plan(facts: Partial<Output>, request: RemoteRequest = REQUEST): RemotePlan {
  return planRemoteInstall(parseRemoteFacts(probeOutput(facts)), request);
}

function outcome(result: RemotePlan): string { return result.kind === "blocked" ? result.block.code : result.kind; }

function failure(run: () => unknown): { code?: string; message?: string } {
  try { run(); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  throw new Error("expected a failure");
}

const host = { serverPath: PATH, arch: "arm64", elevated: true } as const;
const server = { release: RELEASE, port: PORT, tokenFile: TOKEN_FILE, unitOnLink: false };
const blocked = (block: RemoteBlock): RemotePlan => ({ kind: "blocked", block });
const preflightFailed = (item: string | null) => ({ code: "REMOTE_PREFLIGHT_FAILED", message: messages.connectionErrors.REMOTE_PREFLIGHT_FAILED(item) });

test("the probe's frame is read between whatever the login shell prints", () => {
  expect(parseRemoteFacts(probeOutput(RUNNING))).toEqual({ os: "Linux", machine: "aarch64", sudo: "yes", ubuntu: true, systemd: true,
    toolsMissing: [], serverPath: PATH, coreUnit: false, coreActive: "inactive", coreDeployTimer: false, petUnit: "owned",
    petActive: "active", petEnabled: "enabled", petMainPid: 4242, petEnv: unitEnv(), path: "owned", marker: "complete",
    current: RELEASE, releaseIntact: true, listenerCount: 1, listenerPids: [PID] });
});

test("a missing fact stops the install and names the fact", () => {
  for (const key of FACT_KEYS) {
    const lines = FACT_KEYS.filter((other) => other !== key).map((other) => `${other}=${FRESH[other]}`);
    expect({ key, failure: failure(() => parseRemoteFacts(probeOutput({}, lines))) }).toEqual({ key, failure: preflightFailed(key) });
  }
});

test("a repeated or unknown fact, a line without a value or a broken frame stops the install", () => {
  const lines = FACT_KEYS.map((key) => `${key}=${FRESH[key]}`);
  const broken = [
    probeOutput({}, [...lines, "path=owned"]), probeOutput({}, [...lines, "rm_rf=/"]), probeOutput({}, [...lines, "just text"]),
    probeOutput({}).replace(FRAME_END, ""), probeOutput({}).replace(FRAME_BEGIN, ""), `${FRAME_BEGIN}\n${probeOutput({})}`, "",
  ];
  for (const text of broken) expect(failure(() => parseRemoteFacts(text))).toEqual(preflightFailed(null));
});

test("each fact accepts only its own values", () => {
  const invalid: Array<[FactKey, string]> = [["sudo", "maybe"], ["ubuntu", "true"], ["systemd", ""], ["path", "elsewhere"],
    ["marker", "partial"], ["pet_unit", "mine"], ["core_unit", "yes"], ["core_deploy_timer", ""], ["release_intact", "1"],
    ["pet_main_pid", "12a"], ["pet_main_pid", ""], ["listener_count", "-1"], ["listener_pids", "12;13"], ["tools_missing", "rm"],
    ["tools_missing", "ss,"], ["core_active", "Active"], ["pet_active", "active running"], ["pet_env", "A=1\u0001"],
    ["machine", "x86 64"], ["os", "Linux\u001b[0m"], ["current", "/srv/a\u0007"]];
  for (const [key, value] of invalid)
    expect({ key, value, failure: failure(() => parseRemoteFacts(probeOutput({ [key]: value }))) })
      .toEqual({ key, value, failure: preflightFailed(key) });
});

test("the listener count and the listening processes must agree", () => {
  for (const facts of [{ listener_count: "0", listener_pids: PID }, { listener_count: "1", listener_pids: "" }, { listener_count: "?", listener_pids: PID }])
    expect(failure(() => parseRemoteFacts(probeOutput(facts)))).toEqual(preflightFailed("listener_pids"));
  expect(parseRemoteFacts(probeOutput({ listener_count: "3", listener_pids: `${PID},77,?` })).listenerPids).toEqual([PID, "77", "?"]);
  expect(parseRemoteFacts(probeOutput({ listener_count: "?" }))).toMatchObject({ listenerCount: null, listenerPids: [] });
});

test("a listener lookup that failed is never read as a free port", () => {
  const unread = blocked({ code: "REMOTE_PREFLIGHT_FAILED", item: "listener_count" });
  expect(plan({ listener_count: "?" })).toEqual(unread);
  expect(plan({ ...RUNNING, listener_count: "?", listener_pids: "" })).toEqual(unread);
  expect(plan({ ...RUNNING, pet_active: "failed", pet_main_pid: "0", listener_count: "?", listener_pids: "" })).toEqual(unread);
  // Without `ss` at all the missing command is what the user learns first.
  expect(plan({ tools_missing: "ss", listener_count: "?" })).toEqual(blocked({ code: "REMOTE_TOOLS_MISSING", missing: ["ss"] }));
  expect(remoteBlockError(unread.kind === "blocked" ? unread.block : { code: "REMOTE_OS_UNSUPPORTED" }).publicMessage)
    .toBe(messages.connectionErrors.REMOTE_PREFLIGHT_FAILED("listener_count"));
});

test("an unsupported host stops before anything about existing installs is read", () => {
  const cases: Array<[Partial<Output>, RemoteBlock]> = [
    [{ os: "Darwin" }, { code: "REMOTE_OS_UNSUPPORTED" }], [{ ubuntu: "no" }, { code: "REMOTE_OS_UNSUPPORTED" }],
    [{ machine: "riscv64" }, { code: "REMOTE_ARCH_UNSUPPORTED" }],
    [{ tools_missing: "ss,systemctl" }, { code: "REMOTE_TOOLS_MISSING", missing: ["ss", "systemctl"] }],
    [{ systemd: "no" }, { code: "REMOTE_SYSTEMD_MISSING" }], [{ sudo: "no" }, { code: "REMOTE_SUDO_REQUIRED" }],
    [{ sudo: "no", core_unit: "present", ...RUNNING }, { code: "REMOTE_SUDO_REQUIRED" }],
  ];
  for (const [facts, block] of cases) expect(plan(facts)).toEqual(blocked(block));
  expect(plan({ sudo: "root", machine: "x86_64" })).toEqual({ kind: "install", host: { serverPath: PATH, arch: "x64", elevated: false } });
});

test("an existing core stops the install whatever its state, even beside a Pet install", () => {
  for (const state of ["active", "inactive", "failed", "activating", "deactivating"]) {
    expect(plan({ core_unit: "present", core_active: state })).toEqual(blocked({ code: "REMOTE_EXISTING_CORE", service: state, timer: false }));
    expect(plan({ ...RUNNING, core_unit: "present", core_active: state }))
      .toEqual(blocked({ code: "REMOTE_EXISTING_CORE", service: state, timer: false }));
  }
  expect(plan({ core_deploy_timer: "present" })).toEqual(blocked({ code: "REMOTE_EXISTING_CORE", service: null, timer: true }));
  expect(plan({ core_unit: "present", core_deploy_timer: "present" }))
    .toEqual(blocked({ code: "REMOTE_EXISTING_CORE", service: "inactive", timer: true }));
  expect(remoteBlockError({ code: "REMOTE_EXISTING_CORE", service: "inactive", timer: false }).publicMessage)
    .toBe(messages.connectionErrors.REMOTE_EXISTING_CORE(CORE_SERVICE_UNIT, "inactive"));
  expect(remoteBlockError({ code: "REMOTE_EXISTING_CORE", service: null, timer: true }).publicMessage)
    .toBe(messages.connectionErrors.REMOTE_EXISTING_CORE(CORE_DEPLOY_TIMER, null));
});

test("data or a unit that is not the Pet's is never touched", () => {
  expect(plan({ path: "foreign" })).toEqual(blocked({ code: "REMOTE_EXISTING_SERVER" }));
  expect(plan({ ...RUNNING, path: "foreign" })).toEqual(blocked({ code: "REMOTE_EXISTING_SERVER" }));
  for (const path of ["missing", "owned"]) expect(plan({ path, pet_unit: "foreign" })).toEqual(blocked({ code: "REMOTE_UNIT_FOREIGN" }));
});

test("the Pet's unit serving another path is not replaced by an install at a new path", () => {
  // The plan's own table would install here: the port is held only by the Pet unit's process.
  const other = { pet_unit: "owned", pet_active: "active", pet_enabled: "enabled", pet_main_pid: PID, pet_env: unitEnv("/srv/bara-pet"),
    listener_count: "1", listener_pids: PID };
  expect(plan(other)).toEqual(blocked({ code: "REMOTE_OTHER_PET_SERVER" }));
  expect(plan({ ...other, path: "owned" })).toEqual(blocked({ code: "REMOTE_OTHER_PET_SERVER" }));
});

test("a Pet unit whose environment the Pet did not write is left alone", () => {
  const envs = ["", unitEnv(PATH, { MEMORY_STATIC: null }), unitEnv(PATH, { SSE_TOKEN_PATH: null }),
    unitEnv(PATH, { SSE_TOKEN_PATH: "/home/ubuntu/sse-tokens.json" }), unitEnv(PATH, { SSE_TOKEN_PATH: `${PATH}/data/../../../etc/tokens.json` }),
    unitEnv(PATH, { MEMORY_DB_PATH: "/var/lib/bara/bara.sqlite" }), unitEnv(PATH, { MEMORY_HOST: "0.0.0.0" }),
    unitEnv(PATH, { MEMORY_PORT: "70000" }), unitEnv(PATH, { MEMORY_STATIC: `${PATH}/apps/memory/web` }),
    unitEnv(PATH, { MEMORY_STATIC: `${PATH}/releases/NOT-A-RELEASE/apps/memory/web` }), `${unitEnv()} TZ=UTC`,
    unitEnv(PATH, { TZ: "\"Asia/Seoul\"" }), `"EXTRA=a b" ${unitEnv()}`];
  for (const pet_env of envs) expect({ pet_env, plan: plan({ ...RUNNING, pet_env }) })
    .toEqual({ pet_env, plan: blocked({ code: "REMOTE_UNIT_UNRECOGNIZED" }) });
});

test("a new or partial install runs the install steps only while the port is free or the Pet's own", () => {
  const install: RemotePlan = { kind: "install", host };
  expect(plan({})).toEqual(install);
  expect(plan({ listener_count: "1", listener_pids: "777" })).toEqual(blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners: ["777"] }));
  expect(plan({ listener_count: "1", listener_pids: "?" })).toEqual(blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners: ["?"] }));
  // Only the process of the Pet's own verified unit counts as the Pet's, never a main PID reported without it.
  expect(plan({ pet_main_pid: PID, listener_count: "1", listener_pids: PID })).toEqual(blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners: [PID] }));
  expect(plan({ path: "owned" })).toEqual(install);
  expect(plan({ path: "owned", listener_count: "1", listener_pids: "777" }))
    .toEqual(blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners: ["777"] }));
  // Interrupted after the unit started: resuming restarts the Pet's own server.
  expect(plan({ ...RUNNING, marker: "none" })).toEqual(install);
  expect(plan({ ...RUNNING, marker: "none", listener_count: "2", listener_pids: `${PID},777` }))
    .toEqual(blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners: ["777"] }));
  // A unit left behind by a removed server path protects no data, whatever port it used.
  expect(plan({ ...RUNNING, path: "missing", marker: "none", pet_env: unitEnv(PATH, { MEMORY_PORT: "3002" }) })).toEqual(install);
});

test("a complete record is trusted only when its unit and release check out; otherwise the install resumes", () => {
  const install: RemotePlan = { kind: "install", host };
  expect(plan({ ...RUNNING, pet_unit: "absent", pet_env: "", pet_active: "inactive", pet_main_pid: "0", listener_count: "0", listener_pids: "" }))
    .toEqual(install);
  expect(plan({ ...RUNNING, release_intact: "no" })).toEqual(install);
  expect(plan({ ...RUNNING, current: "" })).toEqual(install);
  expect(plan({ ...RUNNING, current: "/opt/other/releases/0123456789abcdef" })).toEqual(install);
  // The link moved to a new release but the unit still runs the old one: the interrupted resume goes on.
  expect(plan({ ...RUNNING, current: `${PATH}/releases/fedcba9876543210` })).toEqual(install);
  expect(plan({ ...RUNNING, pet_unit: "absent", pet_env: "", pet_active: "inactive", pet_main_pid: "0", listener_pids: "777" }))
    .toEqual(blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners: ["777"] }));
});

test("a verified install connects while running and started at boot, and is repaired otherwise", () => {
  expect(plan(RUNNING)).toEqual({ kind: "connect", host, server });
  expect(plan({ ...RUNNING, listener_count: "0", listener_pids: "" })).toEqual({ kind: "connect", host, server });
  expect(plan({ ...RUNNING, pet_active: "reloading" })).toEqual({ kind: "connect", host, server });
  for (const [active, enabled, pid] of [["inactive", "enabled", "0"], ["failed", "enabled", "0"], ["activating", "enabled", PID],
    ["deactivating", "enabled", PID], ["active", "disabled", PID], ["active", "", PID], ["inactive", "disabled", "0"]])
    expect({ active, enabled, plan: plan({ ...RUNNING, pet_active: active, pet_enabled: enabled, pet_main_pid: pid,
      listener_count: pid === "0" ? "0" : "1", listener_pids: pid === "0" ? "" : pid }) })
      .toEqual({ active, enabled, plan: { kind: "repair", host, server } });
});

test("a verified install whose port another process holds is neither connected nor restarted", () => {
  // No token may go to that process through the tunnel, and restarting the unit could not bind the port.
  const busy = (owners: string[]) => blocked({ code: "REMOTE_PORT_BUSY", port: PORT, owners });
  expect(plan({ ...RUNNING, listener_pids: "777" })).toEqual(busy(["777"]));
  expect(plan({ ...RUNNING, pet_active: "inactive", pet_main_pid: "0", listener_pids: "777" })).toEqual(busy(["777"]));
  expect(plan({ ...RUNNING, listener_count: "2", listener_pids: `${PID},777` })).toEqual(busy(["777"]));
  expect(plan({ ...RUNNING, listener_count: "2", listener_pids: `${PID},?` })).toEqual(busy(["?"]));
});

test("an installed server on another port is reported with both ports instead of being reinstalled", () => {
  const mismatch = blocked({ code: "REMOTE_PORT_MISMATCH", installed: 3002, requested: PORT });
  expect(plan({ ...RUNNING, pet_env: unitEnv(PATH, { MEMORY_PORT: "3002" }) })).toEqual(mismatch);
  expect(plan({ ...RUNNING, marker: "none", pet_env: unitEnv(PATH, { MEMORY_PORT: "3002" }) })).toEqual(mismatch);
  expect(remoteBlockError({ code: "REMOTE_PORT_MISMATCH", installed: 3002, requested: PORT }).publicMessage)
    .toBe(messages.connectionErrors.REMOTE_PORT_MISMATCH(3002, PORT));
});

test("connect and repair use the token file the running unit uses, not a path the Pet assumes", () => {
  const tokenFile = `${PATH}/data/secure/pet-tokens.json`;
  const env = unitEnv(PATH, { SSE_TOKEN_PATH: tokenFile });
  expect(plan({ ...RUNNING, pet_env: env })).toEqual({ kind: "connect", host, server: { ...server, tokenFile } });
  expect(plan({ ...RUNNING, pet_env: env, pet_active: "failed", pet_main_pid: "0", listener_count: "0", listener_pids: "" }))
    .toEqual({ kind: "repair", host, server: { ...server, tokenFile } });
});

test("a server running another release than this Pet carries is connected as it is", () => {
  const release = `${PATH}/releases/ffffffffffffffff`;
  const env = unitEnv(PATH, { MEMORY_STATIC: `${release}/apps/memory/web` });
  expect(plan({ ...RUNNING, pet_env: env, current: release })).toEqual({ kind: "connect", host, server: { ...server, release } });
});

test("the server path must be the requested one, and a recovery must find the saved one", () => {
  expect(plan(RUNNING, { serverPort: PORT, serverPath: "/srv/other" })).toEqual(blocked({ code: "REMOTE_PREFLIGHT_FAILED", item: "server_path" }));
  expect(plan(RUNNING, { serverPort: PORT, serverPath: PATH })).toEqual({ kind: "connect", host, server });
  expect(plan(RUNNING, { serverPort: PORT, savedServerPath: "/srv/other" })).toEqual(blocked({ code: "INSTALL_EXISTING_CONNECTION" }));
  expect(plan(RUNNING, { serverPort: PORT, savedServerPath: PATH })).toEqual({ kind: "connect", host, server });
  expect(failure(() => plan({ server_path: "/home/my user/.local/share/bara-pet-server" })))
    .toEqual({ code: "INVALID_INPUT", message: messages.installService.remotePathInvalid });
});

test("every combination of install state, unit, service, listeners and release gets the documented decision", () => {
  let combinations = 0;
  for (const path of ["missing", "owned", "foreign"] as const)
    for (const marker of ["none", "complete"] as const)
      for (const unit of ["absent", "here", "foreign"] as const)
        for (const active of ["active", "inactive"] as const)
          for (const enabled of ["enabled", "disabled"] as const)
            for (const listeners of ["none", "own", "other"] as const)
              for (const release of ["intact", "broken"] as const) {
                combinations++;
                const running = unit === "here" && active === "active";
                const facts: Partial<Output> = { path, marker, pet_unit: unit === "here" ? "owned" : unit,
                  pet_env: unit === "here" ? unitEnv() : "", pet_active: unit === "absent" ? "inactive" : active,
                  pet_enabled: unit === "absent" ? "" : enabled, pet_main_pid: running ? PID : "0",
                  current: release === "intact" ? RELEASE : "", release_intact: release === "intact" ? "yes" : "no",
                  listener_count: listeners === "none" ? "0" : "1", listener_pids: listeners === "none" ? "" : listeners === "own" ? PID : "777" };
                // The documented order: foreign data, foreign unit, a port held by anyone but the running Pet unit,
                // then install unless the Pet's complete install checks out, then connect or repair.
                const busy = listeners === "other" || (listeners === "own" && !running);
                const verified = unit === "here" && path === "owned" && marker === "complete" && release === "intact";
                const expected = path === "foreign" ? "REMOTE_EXISTING_SERVER" : unit === "foreign" ? "REMOTE_UNIT_FOREIGN"
                  : busy ? "REMOTE_PORT_BUSY" : !verified ? "install" : active === "active" && enabled === "enabled" ? "connect" : "repair";
                expect({ path, marker, unit, active, enabled, listeners, release, decision: outcome(plan(facts)) })
                  .toEqual({ path, marker, unit, active, enabled, listeners, release, decision: expected });
              }
  expect(combinations).toBe(3 * 2 * 3 * 2 * 2 * 3 * 2);
});

test("a run with a stored token may go on only for the same remote server", () => {
  const keyPath = resolve("id_ed25519");
  const ssh = { host: "memory.example.org", port: 22, user: "ubuntu", keyPath, fingerprint: `SHA256:${"A".repeat(43)}`,
    serverPath: PATH, serverPort: PORT };
  const saved: ConnectionSettings = { mode: "remote", baseUrl: "http://127.0.0.1:41001", ssh };
  const request = { host: ssh.host, port: 22, user: "ubuntu", keyPath: resolve("other-key"), serverPort: 3005 };
  expect(isSameRemoteTarget(saved, request)).toBe(true);
  expect(isSameRemoteTarget(saved, { ...request, serverPath: `${PATH}/` })).toBe(true);
  for (const change of [{ host: "other.example.org" }, { port: 2222 }, { user: "root" }, { serverPath: "/srv/other" }])
    expect({ change, same: isSameRemoteTarget(saved, { ...request, ...change }) }).toEqual({ change, same: false });
  for (const other of [{ ...saved, mode: "existing" as const }, { mode: "local" as const, baseUrl: "http://127.0.0.1:41001" },
    { ...saved, ssh: { ...ssh, serverPath: undefined } }])
    expect(isSameRemoteTarget(other, request)).toBe(false);
});

test("the probe only reads: no command in it can change the host", () => {
  expect(PROBE_SCRIPT).not.toMatch(/\b(?:rm|rmdir|mkdir|mv|cp|ln|chmod|chown|touch|tee|dd|kill|pkill|install|truncate)\b/);
  expect(PROBE_SCRIPT).not.toMatch(/systemctl\s+(?:-\S+\s+)*(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|reset-failed|kill|edit|set-property)\b/);
  // Output goes only to the discarded stream or to standard output.
  const targets = [...PROBE_SCRIPT.matchAll(/>/g)].map((match) => PROBE_SCRIPT.slice(match.index + 1).match(/^(?:\/dev\/null|&1)/)?.[0] ?? null);
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((target) => target === null)).toEqual([]);
  expect([...PROBE_SCRIPT.matchAll(/sudo -n (\S+)/g)].map(([, command]) => command)).toEqual(["true", "ss"]);
});

test("the probe prints exactly the facts the parser reads, in order", () => {
  expect([...PROBE_SCRIPT.matchAll(/^printf '%s=%s\\n' ([a-z_]+) /gm)].map(([, key]) => key)).toEqual([...FACT_KEYS]);
});

test("user values reach the probe only as quoted arguments", () => {
  expect(probeCommand({ serverPort: PORT, serverPath: "/srv/bara-pet" }).endsWith(" 'bara-pet-probe' '/srv/bara-pet' '3001'")).toBe(true);
  expect(probeCommand({ serverPort: PORT }).endsWith(" 'bara-pet-probe' '' '3001'")).toBe(true);
  expect(probeCommand(REQUEST).startsWith("'sh' '-c' '")).toBe(true);
});

test("a started unit must be active and start at boot; a failure names its states only", () => {
  const states = (active: string, sub: string, enabled: string) =>
    ["noise", FRAME_BEGIN, `active=${active}`, `sub=${sub}`, `enabled=${enabled}`, FRAME_END].join("\n");
  expect(assertServiceStarted(states("active", "running", "enabled"))).toBeUndefined();
  for (const [active, sub, enabled] of [["failed", "failed", "enabled"], ["activating", "auto-restart", "enabled"], ["active", "running", "disabled"]])
    expect(failure(() => assertServiceStarted(states(active!, sub!, enabled!)))).toEqual({ code: "REMOTE_SERVICE_FAILED",
      message: messages.connectionErrors.REMOTE_SERVICE_FAILED(PET_SERVICE_UNIT, active!, sub!, enabled!) });
  for (const text of ["", states("Active", "running", "enabled"), states("active", "running", "enabled").replace("sub=running\n", "")])
    expect(failure(() => assertServiceStarted(text))).toEqual({ code: "REMOTE_SERVICE_FAILED",
      message: messages.connectionErrors.REMOTE_SERVICE_FAILED(PET_SERVICE_UNIT, "?", "?", "?") });
  const command = serviceStartCommand("sudo -n systemctl", 30);
  for (const step of ["enable", "reset-failed", "restart"]) expect(command).toContain(`sudo -n systemctl ${step} '${PET_SERVICE_UNIT}'`);
  expect(command).toContain("-lt 30");
  expect(command).not.toMatch(/journalctl|systemctl status/);
});

const LINK_STATIC = { MEMORY_STATIC: `${PATH}/current/apps/memory/web` };

test("a unit that runs the current link is the Pet's server at the release the link names", () => {
  expect(plan({ ...RUNNING, pet_env: unitEnv(PATH, LINK_STATIC) })).toEqual({ kind: "connect", host, server: { ...server, unitOnLink: true } });
});

test("a unit that names a release directory itself is still read, marked as not on the link", () => {
  expect(plan(RUNNING)).toEqual({ kind: "connect", host, server });
});

test("a link unit whose link names nothing under the server path resumes the install", () => {
  expect(outcome(plan({ ...RUNNING, pet_env: unitEnv(PATH, LINK_STATIC), current: "/elsewhere/releases/0123456789abcdef" }))).toBe("install");
});

test("a link unit of another server path is another Pet server", () => {
  expect(outcome(plan({ ...RUNNING, pet_env: unitEnv("/srv/other", { MEMORY_STATIC: "/srv/other/current/apps/memory/web" }) })))
    .toBe("REMOTE_OTHER_PET_SERVER");
});
