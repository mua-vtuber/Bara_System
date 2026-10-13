import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SshConnection } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { PET_SETTINGS_FILE, PET_SETTINGS_PENDING, publicSettingsFromDisk } from "../config.ts";
import { serviceError } from "../errors.ts";
import { causeOf } from "../fetch-failure.ts";

/** The native host's rule for the Pet's data folder (`src-tauri/src/bridge.rs` `default_data_dir`). */
export const PET_DATA_DIR_ENV = "BARA_PET_DATA_DIR";
const PET_DATA_SUBDIR = ["Bara", "Pet"] as const;

export function petDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env[PET_DATA_DIR_ENV];
  if (configured) return configured;
  const local = env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) throw serviceError("DEPLOY_PET_DATA_DIR_MISSING", messages.deployCli.DEPLOY_PET_DATA_DIR_MISSING);
  return join(local, ...PET_DATA_SUBDIR);
}

export type DeploySsh = SshConnection & { fingerprint: string; serverPath: string; serverPort: number };

/** The Pet's saved remote connection (spec 5.4: no separate settings file). Reads the file only; no secret is needed,
 * the SSH key is a path and the host key is checked against the saved fingerprint. */
export async function readDeployConnection(dataDir: string): Promise<DeploySsh> {
  if (existsSync(join(dataDir, PET_SETTINGS_PENDING))) throw serviceError("DEPLOY_SETTINGS_BUSY", messages.deployCli.DEPLOY_SETTINGS_BUSY);
  const file = join(dataDir, PET_SETTINGS_FILE);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw serviceError("DEPLOY_NOT_REMOTE", messages.deployCli.DEPLOY_NO_SETTINGS(file));
    throw serviceError("CONFIG_INVALID", messages.deployCli.DEPLOY_SETTINGS_UNREADABLE(file, causeOf(error)));
  }
  const { connection } = publicSettingsFromDisk(raw, { token: false, ownerToken: false, aiKey: false });
  if (connection.mode !== "remote" || !connection.ssh) throw serviceError("DEPLOY_NOT_REMOTE", messages.deployCli.DEPLOY_NOT_REMOTE(connection.mode));
  const ssh = connection.ssh;
  for (const key of ["fingerprint", "serverPath", "serverPort"] as const)
    if (ssh[key] === undefined) throw serviceError("DEPLOY_CONNECTION_INCOMPLETE", messages.releaseErrors.RELEASE_CONNECTION_INCOMPLETE(key));
  return ssh as DeploySsh;
}
