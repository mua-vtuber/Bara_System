import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type SetupMode = "desktop-windows" | "local";

export interface SetupPathEnv {
  LOCALAPPDATA?: string;
  HOME?: string;
  MEMORY_SETTINGS_PATH?: string;
  BARA_SECRETS_PATH?: string;
  BARA_ASSET_DIR?: string;
  BARA_HF_CACHE_DIR?: string;
  BARA_KIWI_MODEL_DIR?: string;
  SSE_TOKEN_PATH?: string;
  TZ?: string;
}

export interface SetupPaths {
  mode: SetupMode;
  repoRoot: string;
  memoryAppDir: string;
  dataDir: string;
  dbPath: string;
  settingsPath: string;
  secretsPath: string;
  assetDir: string;
  hfCacheDir: string;
  kiwiModelDir: string;
  setupStatePath: string;
  env: {
    MEMORY_SETTINGS_PATH: string;
    BARA_SECRETS_PATH: string;
    BARA_ASSET_DIR: string;
    BARA_HF_CACHE_DIR: string;
    BARA_KIWI_MODEL_DIR: string;
    SSE_TOKEN_PATH: string;
    TZ: string;
  };
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function defaultLocalAppData(env: SetupPathEnv): string {
  const appData = clean(env.LOCALAPPDATA);
  if (appData) return appData;
  const home = clean(env.HOME);
  if (home) return join(home, "AppData", "Local");
  return join(process.cwd(), ".local-appdata");
}

export function resolveSetupPaths(args: {
  mode: SetupMode;
  repoRoot: string;
  env?: SetupPathEnv;
}): SetupPaths {
  const env = (args.env ?? process.env) as SetupPathEnv;
  const repoRoot = resolve(args.repoRoot);
  const memoryAppDir = join(repoRoot, "apps", "memory");
  const override = (value: string | undefined): string | null => {
    const path = clean(value);
    return path === null ? null : isAbsolute(path) || /^[a-z]:[/\\]/i.test(path) ? path : resolve(memoryAppDir, path);
  };

  const baseDir =
    args.mode === "desktop-windows"
      ? join(defaultLocalAppData(env), "Bara", "memory")
      : join(memoryAppDir, "data");

  const dataDir =
    args.mode === "desktop-windows" ? join(baseDir, "data") : baseDir;
  const dbPath = join(dataDir, "bara.sqlite");
  const settingsPath =
    override(env.MEMORY_SETTINGS_PATH) ??
    (args.mode === "desktop-windows"
      ? join(baseDir, "memory-settings.json")
      : join(dataDir, "memory-settings.json"));
  const existingSettings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8")) as { assets?: { dir?: string }; time?: { zone?: string } }
    : undefined;
  // Keep the same adjacent-secret naming rule as memory-settings-io.ts.
  const secretName = basename(settingsPath).includes("settings") ? "secrets.json" : `${basename(settingsPath)}.secrets.json`;
  const secretsPath =
    override(env.BARA_SECRETS_PATH) ?? join(dirname(settingsPath), secretName);
  const assetDir =
    override(env.BARA_ASSET_DIR) ??
    (existingSettings ? override(existingSettings.assets?.dir ?? "data/assets") : null) ??
    (args.mode === "desktop-windows"
      ? join(baseDir, "assets")
      : join(dataDir, "assets"));
  const hfCacheDir =
    override(env.BARA_HF_CACHE_DIR) ??
    (args.mode === "desktop-windows"
      ? join(baseDir, "models", "hf-cache")
      : join(memoryAppDir, "assets", "hf-cache"));
  const kiwiModelDir =
    override(env.BARA_KIWI_MODEL_DIR) ??
    (args.mode === "desktop-windows"
      ? join(baseDir, "models", "kiwi-model")
      : join(memoryAppDir, "assets", "kiwi-model"));
  const setupStatePath = join(dirname(settingsPath), "setup-state.json");

  return {
    mode: args.mode,
    repoRoot,
    memoryAppDir,
    dataDir,
    dbPath,
    settingsPath,
    secretsPath,
    assetDir,
    hfCacheDir,
    kiwiModelDir,
    setupStatePath,
    env: {
      MEMORY_SETTINGS_PATH: settingsPath,
      BARA_SECRETS_PATH: secretsPath,
      BARA_ASSET_DIR: assetDir,
      BARA_HF_CACHE_DIR: hfCacheDir,
      BARA_KIWI_MODEL_DIR: kiwiModelDir,
      SSE_TOKEN_PATH: override(env.SSE_TOKEN_PATH) ?? join(dataDir, "sse-tokens.json"),
      // Legacy wall-clock schedulers use Date.setHours, so the child process must
      // share the configured clock before any scheduler modules are loaded.
      TZ: clean(env.TZ) ?? clean(existingSettings?.time?.zone) ?? "Asia/Seoul",
    },
  };
}
