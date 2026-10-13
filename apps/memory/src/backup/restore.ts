/**
 * restore.ts — 서버 회차 복구 + 다운로드 ZIP의 비어 있는 새 폴더 복원.
 *
 * planRestore 는 회차 폴더 또는 ZIP을 검증·나열하는 조회(소스·대상 쓰기 0). manifest 없는
 * 회차(readManifest=null)나 스냅샷(.sqlite) 없는 손상 회차는 RestoreError 로 거부한다
 * — 무효 회차를 복원한 척하는 silent 성공을 막는다. executeRestore 는 그 계획대로
 * 파일을 되돌린다:
 *   0) 덮어쓸 기존 DB·-wal/-shm·회차 파일을 before-restore 폴더로 이동해 보존,
 *   1) DB 스냅샷 → `<dataDir>/<snapshotFile>` (낡은 사이드파일은 보존 폴더에만 둔다),
 *   2) 설정·비밀값·토큰 등 나머지 회차 파일 → `<dataDir>/<name>`,
 *   3) 자산은 manifest.assets 목록만 mirrorDir 에서 `<dataDir>/assets/content/` 로 복사.
 *
 * 위 경로는 한 폴더 방식(flatTargets) 기준이다. 펫 방식 관리 배치(db/, config/, tokens/, assets/)는
 * managedTargets(restore-targets.ts)가 회차 파일마다 자리를 정하고, 보존 폴더는 관리 데이터 폴더 바로 아래다.
 *
 * dataDir 는 "DB·설정·자산의 부모"다. 자산은 asset-store 규약(`<baseDir>/content/`,
 * baseDir=`<dataDir>/assets`)에 맞춰 `<dataDir>/assets/content/` 로 되돌린다. manifest 에
 * 있는 자산이 미러에 없으면 실패이므로 RestoreError 를 던진다(빈 결과로 위장 금지).
 *
 * DB·첨부 폴더 짝(설계 17.19 설계 3): 회차 복원은 파일을 쓰기 전에 복원할 스냅샷의 짝 번호
 * (asset_folder_pairing, 행이 없으면 건너뜀)와 `<dataDir>/assets` 의 짝 표시를
 * 본다 — 빈 폴더면 복원 뒤 그 번호로 표시를 만들고, 같은 번호면 그대로, 다른 번호·표시 없이 항목이
 * 있음·읽을 수 없는 표시면 아무것도 쓰지 않고 RestoreError. 그래서 복원한 DB 의 첫 시작이 짝을 찾는다.
 * 다운로드 ZIP 복원은 자산 없이 새 빈 폴더를 가리켜 첫 시작이 그 폴더에 표시를 만든다.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ASSET_PAIRING_FILE_NAME,
  createAssetFolderMarker,
  readAssetFolderState,
  type AssetPairingFolder,
} from "../assets/asset-folder-pairing.ts";
import { AssetStore } from "../assets/asset-store.ts";
import { AssetFolderPairingRepository } from "../db/store-internal/asset-folder-pairing-repository.ts";
import { nowKst } from "../db/store-internal/helpers.ts";
import { MANIFEST_NAME, readManifest } from "./backup-manifest.ts";
import { readDownloadBackup } from "./download-backup.ts";
import { assertBackupFilename, RestoreError, validateSnapshot } from "./restore-validation.ts";
import { flatTargets, type RestoreTargets } from "./restore-targets.ts";
export { RestoreError } from "./restore-validation.ts";
export { assertManagedRound, flatTargets, managedTargets, readManagedRestoreSettings } from "./restore-targets.ts";
export type { ManagedRestoreSettings, RestoreTargets } from "./restore-targets.ts";

export interface RestorePlan {
  /** Download ZIPs restore only into an explicitly selected empty directory. */
  sourceFormat?: "download-zip" | "server-round";
  /** dataDir 에 `bara.sqlite` 로 되돌릴 DB 스냅샷 파일명(회차 폴더 안). */
  snapshotFile: string;
  /** 스냅샷·manifest 를 제외한 회차 파일들(설정·비밀값·토큰 존재분). */
  extraFiles: string[];
  /** mirrorDir 에서 되돌릴 자산 파일명 목록(manifest.assets). */
  assetsToRestore: string[];
}

/** 자산 폴더(RestoreTargets.assetDir) 아래 asset-store 가 첨부 파일을 두는 하위 폴더. */
const ASSET_CONTENT_SUBDIR = "content";

/** 회차 파일 하나와 그것을 둘 자리. 스냅샷의 -wal/-shm 은 스냅샷 자리 옆이다. */
interface Placed { name: string; dest: string }
function placedFiles(targets: RestoreTargets, plan: RestorePlan): Placed[] {
  const snapshot = targets.fileDestination(plan.snapshotFile);
  return [{ name: plan.snapshotFile, dest: snapshot }, { name: `${plan.snapshotFile}-wal`, dest: `${snapshot}-wal` },
    { name: `${plan.snapshotFile}-shm`, dest: `${snapshot}-shm` },
    ...plan.extraFiles.map((name) => ({ name, dest: targets.fileDestination(name) }))];
}
const RESTORE_FILE_RETRY_ATTEMPTS = 20;
const RESTORE_FILE_RETRY_DELAY_MS = 50;

/**
 * 회차 또는 다운로드 ZIP을 검증하고 복원 계획을 만든다. 파일 쓰기 없음.
 * manifest 없음 = 무효 회차 → RestoreError (spec D2-d). files 에 .sqlite 가 없으면
 * DB 스냅샷이 없는 손상 회차이므로 역시 RestoreError.
 */
export function planRestore(roundDir: string): RestorePlan {
  if (isDownloadFile(roundDir)) {
    readDownloadBackup(roundDir);
    return { sourceFormat: "download-zip", snapshotFile: "bara.sqlite", extraFiles: ["memory-settings.json"], assetsToRestore: [] };
  }
  const manifest = readManifest(roundDir);
  if (manifest === null) {
    throw new RestoreError(
      `무효 회차 — manifest(${MANIFEST_NAME}) 없거나 파싱 불가: ${roundDir}`,
    );
  }

  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object") throw new RestoreError("무효 회차 — 잘못된 파일 항목");
    assertBackupFilename(file.name);
    if (names.has(file.name) || file.name === MANIFEST_NAME || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new RestoreError("무효 회차 — 파일 목록 중복 또는 크기 오류");
    }
    names.add(file.name);
    const path = requireFile(join(roundDir, file.name), "회차 파일");
    if (lstatSync(path).size !== file.bytes) throw new RestoreError("무효 회차 — 파일 크기 불일치");
  }
  for (const name of manifest.assets) assertBackupFilename(name);
  if (new Set(manifest.assets).size !== manifest.assets.length) throw new RestoreError("무효 회차 — 중복 자산");
  const snapshots = manifest.files.filter((f) => f.name.endsWith(".sqlite"));
  const snapshot = snapshots[0];
  if (snapshot === undefined || snapshots.length !== 1) {
    throw new RestoreError(
      `무효 회차 — DB 스냅샷(.sqlite)이 manifest.files 에 없음: ${roundDir}`,
    );
  }
  validateSnapshot(readFileSync(join(roundDir, snapshot.name)), manifest.schemaVersion);

  const extraFiles = manifest.files
    .filter((f) => f.name !== snapshot.name && f.name !== MANIFEST_NAME)
    .map((f) => f.name);

  return {
    sourceFormat: "server-round",
    snapshotFile: snapshot.name,
    extraFiles,
    assetsToRestore: [...manifest.assets],
  };
}

/**
 * planRestore 계획대로 dataDir 로 되돌린다. 반환 = 복원한 파일 수(스냅샷+나머지)와
 * 자산 수, 기존 파일이 있었다면 보존 폴더의 절대 경로. 보존 폴더는 사용자만 지운다.
 * 회차·미러의 파일이 없으면 RestoreError(빈 결과로 위장 금지).
 */
export function executeRestore(
  roundDir: string,
  mirrorDir: string,
  target: string | RestoreTargets,
): { files: number; assets: number; beforeRestoreDir?: string } {
  if (isDownloadFile(roundDir)) {
    if (typeof target !== "string") throw new RestoreError("다운로드 ZIP은 --data-dir 로 비어 있는 새 폴더에만 복원할 수 있다.");
    return restoreDownload(roundDir, target);
  }
  // 문자열 = 한 폴더 방식(`<dataDir>/<name>`, 자산 `<dataDir>/assets/content/`). 관리 배치는 managedTargets 로 받는다.
  const targets = typeof target === "string" ? flatTargets(target) : target;
  const plan = planRestore(roundDir);
  const placed = placedFiles(targets, plan);

  // Validate ALL source and destination paths before touching an existing DB.
  for (const name of plan.assetsToRestore) requireFile(join(mirrorDir, name), "자산 미러");
  assertRestoreDestination(targets, placed, plan);
  const assetFolder = new AssetStore(targets.assetDir);
  const pairingToMark = restoreAssetPairing(snapshotPairingId(join(roundDir, plan.snapshotFile)), assetFolder);
  const snapshotSrc = requireFile(join(roundDir, plan.snapshotFile), "DB 스냅샷");

  // 절대 경로로 바꿔 부른다(아래 자산 폴더도): Bun 1.3.6 / Windows 는 이미 있는 상대 경로에 `..` 가 있으면 recursive mkdir 도 EEXIST 를 던진다.
  for (const folder of new Set([targets.preserveRoot, ...placed.map((file) => dirname(file.dest))])) {
    mkdirSync(resolve(folder), { recursive: true });
  }

  // 0) 모든 검증 뒤 기존 파일을 보존한다. 하나라도 이동하지 못하면 원위치로 되돌리고 중단한다.
  const beforeRestoreDir = preserveRestoreFiles(targets.preserveRoot, placed);

  // 보존 이후 단계가 실패하면 DB 자리에 DB 가 없을 수 있다 — 오류에 보존 폴더 경로를 붙여 원본 위치를 알린다.
  try {
    // 1) DB 스냅샷 → 스냅샷 자리. 이전 WAL·SHM 은 보존 폴더에만 있어야 한다.
    const snapshotDest = placed[0]!.dest;
    restoreFileOperation("DB 스냅샷 복사", snapshotDest, () => {
      copyFileSync(snapshotSrc, snapshotDest);
    });
    let files = 1;

    // 2) 설정·비밀값·토큰 등 나머지 회차 파일 → 각 파일의 자리.
    for (const name of plan.extraFiles) {
      const src = requireFile(join(roundDir, name), "회차 파일");
      copyFileSync(src, targets.fileDestination(name));
      files += 1;
    }

    // 3) 자산 → `<assetDir>/content/`. manifest 목록만 미러에서 되돌린다.
    const contentDir = join(targets.assetDir, ASSET_CONTENT_SUBDIR);
    if (plan.assetsToRestore.length > 0) {
      mkdirSync(resolve(contentDir), { recursive: true });
    }
    let assets = 0;
    for (const name of plan.assetsToRestore) {
      const src = requireFile(join(mirrorDir, name), "자산 미러");
      copyFileSync(src, join(contentDir, name));
      assets += 1;
    }

    // 4) 빈 자산 폴더였으면 복원한 DB 의 짝 번호로 짝 표시를 만든다.
    if (pairingToMark !== null) markRestoredAssetFolder(assetFolder, pairingToMark);

    return { files, assets, ...(beforeRestoreDir ? { beforeRestoreDir } : {}) };
  } catch (error) {
    if (beforeRestoreDir === undefined) throw error;
    throw new RestoreError(
      `${(error as Error).message} — 복원이 중간에 멈췄다. 복원 전 파일은 보존 폴더에 있다: ${beforeRestoreDir}`,
    );
  }
}

/** 회차 복원의 기존 파일만 rename 한다. 자산과 이전 보존 폴더는 이동·삭제하지 않는다. */
function preserveRestoreFiles(preserveRoot: string, placed: Placed[]): string | undefined {
  const existing = placed.filter((file) => {
    try { lstatSync(file.dest); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new RestoreError(`복원 실패 — 보존 대상 확인: ${file.dest} — ${(error as Error).message}`);
    }
  });
  if (existing.length === 0) return undefined;

  // 펫과 같은 로컬 시각 이름과 같은 초 충돌 시 -2, -3, ... 규칙. 기존 폴더를 재사용하지 않는다.
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const base = resolve(preserveRoot, `before-restore-${stamp}`);
  let beforeDir: string | undefined;
  for (let attempt = 1; attempt <= 1_000; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      mkdirSync(candidate, { mode: 0o700 });
      beforeDir = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new RestoreError(`복원 실패 — 보존 폴더 생성: ${candidate} — ${(error as Error).message}`);
    }
  }
  if (!beforeDir) throw new RestoreError(`복원 실패 — 보존 폴더 이름을 확보할 수 없다: ${base}`);

  const moved: Placed[] = [];
  try {
    for (const file of existing) {
      restoreFileOperation("기존 파일 보존 이동", file.dest, () => renameSync(file.dest, join(beforeDir!, file.name)));
      moved.push(file);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const file of moved.reverse()) {
      try {
        restoreFileOperation("보존 파일 원위치 이동", file.dest, () => renameSync(join(beforeDir!, file.name), file.dest));
      } catch (rollbackError) {
        rollbackErrors.push((rollbackError as Error).message);
      }
    }
    // 이번 시도에서 만든 빈 폴더만 제거한다. 되돌리지 못한 파일이 있으면 보존한다.
    if (rollbackErrors.length === 0) {
      try { rmdirSync(beforeDir); }
      catch (cleanupError) { rollbackErrors.push((cleanupError as Error).message); }
    }
    throw new RestoreError(
      `${(error as Error).message}` + (rollbackErrors.length > 0
        ? ` — 원위치 복구/빈 폴더 정리 실패, 보존 폴더를 확인하라: ${beforeDir} — ${rollbackErrors.join("; ")}`
        : " — 이미 옮긴 파일은 원위치로 되돌렸다"),
    );
  }
  return beforeDir;
}

/** 복원할 자산 폴더가 다른 DB 의 것일 때(설계 17.19 설계 3). */
const RESTORE_PAIRING_MISMATCH =
  "복원할 첨부 파일 폴더가 다른 DB 의 것이거나 짝 표시 없이 파일이 있습니다 — 빈 폴더로 복원하거나 그 폴더를 다른 곳으로 옮긴 뒤 다시 하세요";

/**
 * 스냅샷의 짝 번호 — 메모리에서 읽기 전용으로 연다(회차 폴더에 사이드파일을 만들지 않는다). 행이 없으면 null.
 * 기준 스키마 이전 스냅샷은 planRestore 의 validateSnapshot 이 먼저 거부하므로 짝 표는 늘 있다 — 그래도 표를 읽지 못하면
 * (손상·손으로 지운 표) 그 SQLite 오류를 담은 RestoreError 로 멈춘다.
 */
function snapshotPairingId(snapshotPath: string): string | null {
  const db = Database.deserialize(readFileSync(snapshotPath), { readonly: true });
  try {
    return new AssetFolderPairingRepository(db).getPairingIdSync();
  } catch (err) {
    throw new RestoreError(
      `복원 거부 — 스냅샷 ${snapshotPath} 의 DB·첨부 폴더 짝 표를 읽을 수 없다: ${(err as Error).message}`,
    );
  } finally {
    db.close();
  }
}

/**
 * 파일을 쓰기 전에 자산 폴더의 짝 표시를 판정한다. 반환 = 복원 뒤 표시를 만들 짝 번호(빈 폴더), 아니면 null(짝 번호가 없는
 * 스냅샷이거나 이미 같은 번호). 다른 번호·표시 없는 항목·읽을 수 없는 표시는 RestoreError.
 */
function restoreAssetPairing(pairingId: string | null, folder: AssetPairingFolder): string | null {
  if (pairingId === null) return null;
  const state = readAssetFolderState(folder);
  switch (state.kind) {
    case "empty":
      return pairingId;
    case "marked":
      if (state.pairingId === pairingId) return null;
      throw new RestoreError(RESTORE_PAIRING_MISMATCH);
    case "unmarked-items":
      throw new RestoreError(RESTORE_PAIRING_MISMATCH);
    case "invalid":
      throw new RestoreError(
        `복원할 첨부 파일 폴더의 짝 표시 파일 ${ASSET_PAIRING_FILE_NAME} 을 읽을 수 없습니다(${state.cause}) — 빈 폴더로 복원하거나 그 폴더를 다른 곳으로 옮긴 뒤 다시 하세요`,
      );
    case "unset":
      throw new RestoreError("복원할 첨부 파일 폴더 경로가 비어 있습니다");
  }
}

/** 복원 뒤 빈 폴더에 짝 표시를 만든다. 그 사이 다른 표시가 생겼으면(같은 폴더에 동시에 쓴 경우) RestoreError. */
function markRestoredAssetFolder(folder: AssetStore, pairingId: string): void {
  if (createAssetFolderMarker(folder.baseDir, { pairingId, createdAt: nowKst() }) === "created") return;
  const state = readAssetFolderState(folder);
  if (state.kind !== "marked" || state.pairingId !== pairingId) throw new RestoreError(RESTORE_PAIRING_MISMATCH);
}

/** 복원 소스 파일이 실재하는지 확인한다. 부재 = RestoreError(빈 결과로 위장 금지). */
function requireFile(path: string, label: string): string {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new RestoreError(`복원 실패 — ${label} 파일 없음: ${path}`);
  }
  return path;
}

function isDownloadFile(source: string): boolean {
  if (!existsSync(source) || lstatSync(source).isSymbolicLink()) throw new RestoreError("복원 소스가 없거나 심볼릭 링크다");
  return lstatSync(source).isFile();
}

function assertRestoreDestination(targets: RestoreTargets, placed: Placed[], plan: RestorePlan): void {
  const directories = [...new Set([targets.preserveRoot, ...placed.map((file) => dirname(file.dest))])];
  const files = placed.map((file) => file.dest);
  if (plan.assetsToRestore.length) {
    directories.push(targets.assetDir, join(targets.assetDir, ASSET_CONTENT_SUBDIR));
    files.push(...plan.assetsToRestore.map((name) => join(targets.assetDir, ASSET_CONTENT_SUBDIR, name)));
  }
  for (const path of [...directories, ...files]) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (directories.includes(path) ? !stat.isDirectory() : !stat.isFile())) {
        throw new RestoreError("복원 대상의 파일·폴더 형식이 올바르지 않거나 심볼릭 링크다");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof RestoreError) throw error;
        throw new RestoreError("복원 대상 경로를 확인할 수 없다");
      }
    }
  }
}

function restoreDownload(source: string, dataDir: string): { files: number; assets: number } {
  const { entries, settings } = readDownloadBackup(source);
  if (existsSync(dataDir) && (lstatSync(dataDir).isSymbolicLink() || !lstatSync(dataDir).isDirectory() || readdirSync(dataDir).length > 0)) {
    throw new RestoreError("다운로드 ZIP은 비어 있는 새 폴더에만 복원할 수 있다. 기존 운영 데이터를 덮어쓰지 않는다.");
  }
  const target = resolve(dataDir);
  // Keep user settings, but never carry production storage paths into a rehearsal.
  settings.db = { ...(settings.db as object), path: join(target, "bara.sqlite") };
  settings.assets = { ...(settings.assets as object), dir: join(target, "assets") };
  settings.backup = { ...(settings.backup as object), dir: join(target, "backups") };
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(target, "bara.sqlite"), entries["bara.sqlite"]!, { flag: "wx", mode: 0o600 });
    writeFileSync(join(target, "memory-settings.json"), JSON.stringify(settings, null, 2), { flag: "wx", mode: 0o600 });
  } catch {
    // Do not delete the directory: a concurrent writer may own other files.
    throw new RestoreError("복원 파일 쓰기 실패 — 대상 폴더를 확인하고 다른 비어 있는 폴더로 다시 복원하라.");
  }
  return { files: 2, assets: 0 };
}

function restoreFileOperation(label: string, path: string, op: () => void): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESTORE_FILE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      op();
      return;
    } catch (err) {
      lastError = err;
      if (!isBusyFileError(err)) {
        throw new RestoreError(`복원 실패 — ${label}: ${path} — ${(err as Error).message}`);
      }
      if (attempt < RESTORE_FILE_RETRY_ATTEMPTS) {
        sleepSync(RESTORE_FILE_RETRY_DELAY_MS);
      }
    }
  }

  throw new RestoreError(
    `복원 실패 — ${label} 대상이 계속 잠겨 있다. 서버가 완전히 정지됐는지 확인하라: ` +
      `${path} — ${(lastError as Error | undefined)?.message ?? "unknown error"}`,
  );
}

function isBusyFileError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}
