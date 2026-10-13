import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";

/** The adapters `deploy:a1 --adapter <name>` knows (spec 6): where each one's source lives in this repository and the
 * settings file `--settings` puts into its data folder. One entry per adapter; nothing else names them. */
export interface AdapterSource { dir: string; settingsFile: string }
export const ADAPTERS: Readonly<Record<string, AdapterSource>> = {
  discord: { dir: "apps/bot-discord", settingsFile: "bot-settings.json" },
};
/** Environment every adapter unit carries (spec 6.3 ② and ③). The adapter side reads the same names
 * (apps/bot-discord/src/data-dir.ts); they are a contract between two programs, not shared code. */
export const ADAPTER_DATA_DIR_ENV = "BARA_ADAPTER_DATA_DIR";
export const ADAPTER_MEMORY_URL_ENV = "MEMORY_API_URL";
/** The memory server reads this to find adapters' manifests (apps/memory/src/federation/discovery.ts `ADAPTERS_DIR_ENV`). */
export const SERVER_ADAPTERS_DIR_ENV = "BARA_ADAPTERS_DIR";
/** `<server path>/adapters/<name>/` (spec 6.2). */
export const ADAPTERS_DIR = "adapters";

export function adapterSource(name: string): AdapterSource {
  const source = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!source) throw serviceError("ADAPTER_UNKNOWN", messages.adapterErrors.ADAPTER_UNKNOWN(name, Object.keys(ADAPTERS).join(", ")));
  return source;
}

/** The file `scripts.start` runs (spec 6.3 ①): `bun run <file>`, a relative path inside the adapter's folder. */
export function adapterStartFile(packageJson: unknown, name: string): string {
  const start = (packageJson as { scripts?: { start?: unknown } } | null)?.scripts?.start;
  const match = typeof start === "string" ? /^bun run ([A-Za-z0-9._/-]+\.ts)$/.exec(start) : null;
  if (!match || match[1]!.split("/").some((part) => part === ".." || part === "." || part === ""))
    throw serviceError("ADAPTER_START_SCRIPT_INVALID", messages.adapterErrors.ADAPTER_START_SCRIPT_INVALID(name));
  return match[1]!;
}
