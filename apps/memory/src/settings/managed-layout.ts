import { isAbsolute, join, relative, resolve } from "node:path";

/** The managed data root a pet-installed server runs on. One definition for apps/setup/src/managed-prepare.ts, which
 * creates it, and scripts/restore-backup.ts --managed-data, which restores a server round into it. */
export interface ManagedLayout {
  root: string; settingsPath: string; secretsPath: string; dbPath: string; assetDir: string;
  hfCacheDir: string; kiwiModelDir: string; tokenPath: string; backupDir: string;
}

export function managedLayout(dataRoot: string): ManagedLayout {
  if (!isAbsolute(dataRoot)) throw new Error("managed data root must be absolute");
  const root = resolve(dataRoot);
  return { root, settingsPath: join(root, "config", "memory-settings.json"), secretsPath: join(root, "config", "secrets.json"),
    dbPath: join(root, "db", "bara.sqlite"), assetDir: join(root, "assets"), hfCacheDir: join(root, "models", "hf-cache"),
    kiwiModelDir: join(root, "models", "kiwi-model"), tokenPath: join(root, "tokens", "sse-tokens.json"), backupDir: join(root, "backups") };
}

/** True when `path` is strictly below `root` (the root itself is not inside). Lexical: symbolic links are checked by
 * the callers that touch the files. */
export function isInsideRoot(root: string, path: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}
