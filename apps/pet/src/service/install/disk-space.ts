import { existsSync } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LOCAL_INSTALL_MARGIN_BYTES, LOCAL_INSTALL_MODEL_BYTES } from "../../shared/contracts.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";

/** Reads the free bytes on the drive holding a path; null when it cannot be read. */
export type FreeSpace = (path: string) => Promise<number | null>;

/** The model folders `managed-prepare` hands the download scripts (`BARA_HF_CACHE_DIR`, `BARA_KIWI_MODEL_DIR`),
 * relative to the managed data root (apps/setup/src/managed-prepare.ts). */
const MODEL_DIRS = [["models", "hf-cache"], ["models", "kiwi-model"]] as const;
/** The model downloader's temporary name for a file still being written (`@huggingface/transformers` FileCache). */
const PARTIAL_DOWNLOAD = /\.tmp\.\d+\./;

/** Free bytes an unprivileged writer may use (`bavail * bsize`) on the drive holding `path`, read at its nearest
 * existing folder because a first install's data folder does not exist yet. */
export const freeBytesAt: FreeSpace = async (path) => {
  let folder = resolve(path);
  while (!existsSync(folder)) {
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  try {
    const stats = await statfs(folder);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch { return null; }
};

/** Bytes of the regular files under `folder`; links are not followed and an unreadable entry counts as 0,
 * which can only make the check ask for more space, never less. A download cut off (cancel, stall, quit) can
 * leave its partial `<file>.tmp.<pid>.<random>` behind; it is not a model the next attempt can reuse, so it
 * does not count as present. */
export async function bytesUnder(folder: string): Promise<number> {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) total += await bytesUnder(path);
    else if (entry.isFile() && !PARTIAL_DOWNLOAD.test(entry.name)) total += await lstat(path).then((stats) => stats.size, () => 0);
  }
  return total;
}

/** Free space a local install needs when `present` model bytes are already on disk (a resumed install keeps
 * what an earlier attempt downloaded). */
export function requiredFreeBytes(present: number): number {
  return Math.max(0, LOCAL_INSTALL_MODEL_BYTES - present) + LOCAL_INSTALL_MARGIN_BYTES;
}

/** Stops a local install with `INSTALL_DISK_LOW` before it writes anything when the drive holding `memoryData`
 * cannot take the models and the database. A drive that cannot be read is not a reason to block. */
export async function assertInstallSpace(memoryData: string, freeSpace: FreeSpace = freeBytesAt): Promise<void> {
  const free = await freeSpace(memoryData);
  if (free === null || free >= requiredFreeBytes(0)) return;
  let present = 0;
  for (const parts of MODEL_DIRS) present += await bytesUnder(join(memoryData, ...parts));
  const required = requiredFreeBytes(present);
  if (free < required) throw serviceError("INSTALL_DISK_LOW", messages.connectionErrors.INSTALL_DISK_LOW(required - free, free));
}
