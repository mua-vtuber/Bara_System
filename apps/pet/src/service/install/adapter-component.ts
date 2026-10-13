import { statSync } from "node:fs";
import type { RequestContext } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";
import { ADAPTER_DATA_DIR_ENV, ADAPTER_MEMORY_URL_ENV, ADAPTERS, ADAPTERS_DIR, adapterSource } from "./adapter-registry.ts";
import { REMOTE_LAYOUT } from "./remote-probe.ts";
import { isComponentName } from "./release-record.ts";
import type { ServiceControl, ShellReleaseHost, UnitInstaller } from "./release-host.ts";
import { replaceRelease, type ReleaseBundle, type ReplaceOptions, type ReplaceResult } from "./release-swap.ts";
import { safeRemotePath } from "./ssh.ts";

export const ADAPTER_UNIT_MARKER = "# Managed by Bara deploy:a1";

/** The adapter name is checked here, before it can reach a unit name or a path on the host. */
export function adapterUnitName(name: string): string {
  if (!isComponentName(name)) throw serviceError("ADAPTER_UNKNOWN", messages.adapterErrors.ADAPTER_UNKNOWN(name, Object.keys(ADAPTERS).join(", ")));
  return `bara-adapter-${name}.service`;
}

/** Owner-only folder (mode 700) the settings file waits in before it is installed 600; apart from the shared `incoming/`. */
export const ADAPTER_SECRET_STAGING_DIR = "secret-staging";

export interface AdapterLayout { root: string; data: string; incoming: string }
export function adapterLayout(serverPath: string, name: string): AdapterLayout {
  adapterUnitName(name);
  const root = `${safeRemotePath(serverPath)}/${ADAPTERS_DIR}/${name}`;
  return { root, data: `${root}/${REMOTE_LAYOUT.data}`, incoming: `${root}/${REMOTE_LAYOUT.incoming}` };
}

export interface AdapterUnitInput { name: string; user: string; layout: AdapterLayout; workDir: string; startFile: string; serverPort: number; timeZone: string }

/** The adapter's unit (spec 6.3): runs `current/bun run <start file>` in its folder, with its fixed data folder and the
 * memory server's loopback address. The time zone is the memory server's (its unit's `TZ`). */
export function adapterUnitText(input: AdapterUnitInput): string {
  const current = `${input.layout.root}/${REMOTE_LAYOUT.current}`;
  return [ADAPTER_UNIT_MARKER, "[Unit]", `Description=bara-adapter ${input.name}`, "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", `User=${input.user}`, `WorkingDirectory=${current}/${input.workDir}`, `ExecStart=${current}/bun run ${input.startFile}`,
    "Restart=on-failure", "RestartSec=5", `Environment=${ADAPTER_DATA_DIR_ENV}=${input.layout.data}`,
    `Environment=${ADAPTER_MEMORY_URL_ENV}=http://127.0.0.1:${input.serverPort}`, `Environment=TZ=${input.timeZone}`, "",
    "[Install]", "WantedBy=multi-user.target", ""].join("\n");
}

export interface AdapterDeploy {
  host: ShellReleaseHost; control: ServiceControl; units: UnitInstaller; unit: AdapterUnitInput; bundle: ReleaseBundle;
  settingsFile: string | null; ctx: RequestContext; options?: ReplaceOptions;
}

function assertSettingsFile(path: string): void {
  let isFile: boolean;
  try { isFile = statSync(path).isFile(); } catch { throw serviceError("ADAPTER_SETTINGS_MISSING", messages.adapterErrors.ADAPTER_SETTINGS_MISSING(path)); }
  if (!isFile) throw serviceError("ADAPTER_SETTINGS_NOT_FILE", messages.adapterErrors.ADAPTER_SETTINGS_NOT_FILE(path));
}

/** spec 6.4: install or update one adapter. A first install needs its settings file; a later one may replace it. Both
 * refusals happen before anything is created on the host. */
export async function deployAdapter(input: AdapterDeploy): Promise<ReplaceResult> {
  const { host, unit } = input;
  const { layout, name } = unit;
  const source = adapterSource(name);
  const firstInstall = !(await host.exists(`${layout.root}/${REMOTE_LAYOUT.current}`));
  if (firstInstall && input.settingsFile === null) throw serviceError("ADAPTER_SETTINGS_REQUIRED", messages.adapterErrors.ADAPTER_SETTINGS_REQUIRED(name));
  if (input.settingsFile !== null) assertSettingsFile(input.settingsFile);
  await host.makeDir(layout.data);
  if (input.settingsFile !== null) {
    // The file holds secrets: it waits in an owner-only folder and its temporary copy is removed whatever happens.
    const staging = `${layout.root}/${ADAPTER_SECRET_STAGING_DIR}`;
    const staged = `${staging}/${source.settingsFile}`;
    await host.makePrivateDir(staging);
    try {
      await host.upload(input.settingsFile, staged);
      await host.installFile(staged, `${layout.data}/${source.settingsFile}`, "600");
    } finally { await host.removeTree(staged); }
  }
  await input.units.install(adapterUnitText(unit));
  return replaceRelease(host, { root: layout.root, control: input.control, check: { kind: "adapter" } }, input.bundle, input.ctx, input.options ?? {});
}

export interface AdapterRemoval { host: ShellReleaseHost; control: ServiceControl; units: UnitInstaller; name: string; layout: AdapterLayout }

/** spec 6.4 `--remove`: stop the adapter and remove its unit; its data folder stays and is named. */
export async function removeAdapter(input: AdapterRemoval): Promise<{ dataDir: string }> {
  const registered = await input.units.exists();
  if (!registered && !(await input.host.exists(input.layout.root)))
    throw serviceError("ADAPTER_NOT_INSTALLED", messages.adapterErrors.ADAPTER_NOT_INSTALLED(input.name));
  if (registered) {
    await input.control.stop();
    await input.units.remove();
  }
  return { dataDir: input.layout.data };
}
