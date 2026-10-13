/**
 * restore-targets.ts — where a server-round restore puts each round file and the attachments.
 *
 * `flatTargets` is the one-folder layout restores always used (`<dataDir>/<name>`, attachments under
 * `<dataDir>/assets/content/`). `managedTargets` is the pet-managed layout (db/, config/, tokens/, assets/) that
 * `managedLayout` defines; the managed settings file's paths must sit inside it (and db.path on layout.dbPath). restore.ts
 * re-exports everything here; `executeRestore` takes either layout.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isInsideRoot, type ManagedLayout } from "../settings/managed-layout.ts";
import { RestoreError } from "./restore-validation.ts";

/** Asset store base under a one-folder data dir: `<dataDir>/assets`, whose `content/` holds the attachments. */
export const FLAT_ASSET_SUBDIR = "assets";
/** Round file that carries the settings the round was made with. */
const ROUND_SETTINGS_FILE = "memory-settings.json";

/** Where a restore puts each round file and the attachments. */
export interface RestoreTargets {
  /** Folder that receives `before-restore-<time>/`. */
  preserveRoot: string;
  /** Destination of round file `name` (the snapshot and the settings, secrets and token files). */
  fileDestination(name: string): string;
  /** Asset store base; attachments go to its `content/`. */
  assetDir: string;
}

export function flatTargets(dataDir: string): RestoreTargets {
  return { preserveRoot: dataDir, fileDestination: (name) => join(dataDir, name), assetDir: join(dataDir, FLAT_ASSET_SUBDIR) };
}

/** The managed settings the restore needs: where the database, attachments and backups live. */
export interface ManagedRestoreSettings { db: { path: string }; assets: { dir: string }; backup: { dir: string } }

/** The managed settings file read as written, plus the port the CLI probes. A missing file or key stops with an error
 * naming it; there are no defaults here, because a default path would restore somewhere the server does not read. */
export function readManagedRestoreSettings(layout: ManagedLayout): ManagedRestoreSettings & { db: { path: string; port: number } } {
  if (!existsSync(layout.settingsPath)) throw new RestoreError(`관리 설정 파일이 없다: ${layout.settingsPath}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(layout.settingsPath, "utf8")); }
  catch (error) { throw new RestoreError(`관리 설정 파일을 읽을 수 없다: ${layout.settingsPath} — ${(error as Error).message}`); }
  const value = (key: string): unknown => key.split(".").reduce<unknown>((node, part) =>
    node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined, raw);
  const text = (key: string): string => {
    const found = value(key);
    if (typeof found !== "string" || found.trim() === "") throw new RestoreError(`관리 설정 파일에 ${key} 가 없다: ${layout.settingsPath}`);
    return found;
  };
  const port = value("db.port");
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new RestoreError(`관리 설정 파일에 올바른 db.port 가 없다: ${layout.settingsPath}`);
  return { db: { path: text("db.path"), port }, assets: { dir: text("assets.dir") }, backup: { dir: text("backup.dir") } };
}

/**
 * The managed layout. The files go where the running managed server reads them: managed-prepare starts it with
 * MEMORY_DB_PATH = settings.db.path and BARA_ASSET_DIR = layout.assetDir (the env wins over the settings file), so the
 * attachments always go to layout.assetDir even when the dashboard edited assets.dir, and a db.path other than
 * layout.dbPath is refused — which database the server would open after the restore cannot be told safely.
 */
export function managedTargets(layout: ManagedLayout, settings: ManagedRestoreSettings): RestoreTargets {
  for (const path of [settings.db.path, settings.assets.dir, settings.backup.dir]) {
    if (!isAbsolute(path) || !isInsideRoot(layout.root, path))
      throw new RestoreError(`관리 데이터 폴더(${layout.root}) 밖을 가리키는 설정이다: ${path}`);
  }
  if (resolve(settings.db.path) !== resolve(layout.dbPath))
    throw new RestoreError(`관리 설정의 db.path(${settings.db.path})가 관리 배치의 DB 자리(${layout.dbPath})와 달라 복원할 DB 자리를 정할 수 없다`);
  const places = new Map<string, string>([[basename(layout.dbPath), layout.dbPath], [basename(layout.settingsPath), layout.settingsPath],
    [basename(layout.secretsPath), layout.secretsPath], [basename(layout.tokenPath), layout.tokenPath]]);
  return {
    preserveRoot: layout.root, assetDir: layout.assetDir,
    fileDestination: (name) => {
      const place = places.get(name);
      if (!place) throw new RestoreError(`관리 배치에 둘 곳이 없는 회차 파일이다: ${name}`);
      return place;
    },
  };
}

/**
 * A round another server folder made carries settings naming that folder's database, attachments and backups;
 * restoring it here would leave the restored settings pointing elsewhere. A managed server always backs up its
 * settings file, so a round without one cannot be shown to belong here. Both are refused before anything moves.
 */
export function assertManagedRound(roundDir: string, plan: { extraFiles: string[] }, settings: ManagedRestoreSettings): void {
  if (!plan.extraFiles.includes(ROUND_SETTINGS_FILE))
    throw new RestoreError(`회차에 설정 파일(${ROUND_SETTINGS_FILE})이 없어 이 서버 폴더의 회차인지 확인할 수 없다: ${roundDir}`);
  let round: { db?: { path?: unknown }; assets?: { dir?: unknown }; backup?: { dir?: unknown } };
  try { round = JSON.parse(readFileSync(join(roundDir, ROUND_SETTINGS_FILE), "utf8")); }
  catch (error) { throw new RestoreError(`회차 설정 파일을 읽을 수 없다: ${join(roundDir, ROUND_SETTINGS_FILE)} — ${(error as Error).message}`); }
  const pairs: Array<[string, unknown, string]> = [["db.path", round.db?.path, settings.db.path],
    ["assets.dir", round.assets?.dir, settings.assets.dir], ["backup.dir", round.backup?.dir, settings.backup.dir]];
  for (const [key, inRound, current] of pairs) {
    if (typeof inRound !== "string" || resolve(inRound) !== resolve(current))
      throw new RestoreError(`다른 서버 폴더의 회차다 — 회차 설정의 ${key}(${String(inRound)})가 지금 설정(${current})과 다르다`);
  }
}
