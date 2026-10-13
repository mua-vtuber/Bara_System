/**
 * 백업 코어 — 한 회차 실행(VACUUM INTO 스냅샷 + 설정/비밀값/토큰 복사 + 자산 미러)
 * + retention + 부팅 청소. (spec D1, P4 T2)
 *
 * 회차 폴더 = `<backupDir>/round-YYYYMMDD-HHMMSS/`. manifest.json 은 반드시
 * 마지막에 기록한다 — manifest 존재가 회차 유효성 기준이다. 중간 실패 시 회차
 * 폴더를 통째로 지우고 BackupError 를 던진다. 자산 미러(`<backupDir>/assets-mirror/`)
 * 는 회차 밖 단일 미러라 실패 회차가 남긴 파일도 무해하다(sha 내용 주소의 불변
 * 파일 — 다음 회차가 재사용). `<backupDir>/pre-migration/` 은 T4 소유 — 청소와
 * retention 은 `round-` 접두사 폴더만 만진다.
 */
import type { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { nowInZone } from "../db/store-internal/helpers.ts";
import {
  ROUND_DIR_PREFIX,
  listValidRounds,
  readManifest,
  writeManifest,
  type BackupManifest,
} from "./backup-manifest.ts";

export class BackupError extends Error {}

export interface BackupRunDeps {
  /** 서버 공유 연결 — 이 연결로 VACUUM INTO 를 실행한다. */
  db: Database;
  /** ":memory:"·"" 이면 BackupError(파일 DB 전용). */
  dbPath: string;
  backupDir: string;
  /** 미지정 시 자산 단계 skip(정직 skip — manifest.assets=[]). */
  assetDir?: string;
  settingsFilePath: string;
  secretsFilePath: string;
  sseTokenFilePath: string;
  appVersion: string;
  schemaVersion: number;
  now?: () => number;
}

export interface BackupRoundResult {
  roundDir: string;
  manifest: BackupManifest;
}

const ASSETS_MIRROR_DIR = "assets-mirror";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 백업 한 회차를 실행한다. 실패 = 부분 산출물(회차 폴더) 삭제 후 BackupError throw.
 * 성공 조건 = manifest 기록까지 완료 — manifest 가 없으면 그 회차는 없던 것이다.
 */
export async function runBackupRound(deps: BackupRunDeps): Promise<BackupRoundResult> {
  const now = deps.now ?? Date.now;
  const startedMs = now();

  if (deps.dbPath === ":memory:" || deps.dbPath === "") {
    throw new BackupError(
      `백업은 파일 DB 전용 — dbPath="${deps.dbPath}" 는 스냅샷을 만들 수 없다 (silent skip 금지)`,
    );
  }

  const timestamp = nowInZone();
  const compact = timestamp.replace(/[-: ]/g, "");
  const roundDir = join(
    deps.backupDir,
    `${ROUND_DIR_PREFIX}${compact.slice(0, 8)}-${compact.slice(8)}`,
  );

  // 같은 초에 회차가 겹치면 기존(유효할 수 있는) 폴더를 실패 정리 경로가 지우게
  // 되므로, 폴더를 만들기 전에 멈춘다.
  if (existsSync(roundDir)) {
    throw new BackupError(`회차 폴더가 이미 존재: ${roundDir}`);
  }

  try {
    mkdirSync(roundDir, { recursive: true, mode: 0o700 });

    // 1) DB 스냅샷 — VACUUM INTO 는 WAL 미체크포인트 쓰기까지 포함한 일관 스냅샷.
    //    파라미터 바인딩 지원이 SQLite 버전 의존이라 escape 조립을 쓴다 (spec D1).
    const snapshotPath = join(roundDir, basename(deps.dbPath));
    const escaped = snapshotPath.replaceAll("'", "''");
    deps.db.run(`VACUUM INTO '${escaped}'`);

    // 2) 설정/비밀값/SSE 토큰 — 존재하는 파일만 복사. 부재 = 정직 skip이며
    //    manifest.files 에 안 나타나 부재가 그대로 드러난다.
    copyIfExists(deps.settingsFilePath, roundDir);
    const secretsCopy = copyIfExists(deps.secretsFilePath, roundDir);
    if (secretsCopy !== null) chmodSync(secretsCopy, 0o600);
    copyIfExists(deps.sseTokenFilePath, roundDir);

    // 3) 자산 미러 — assetDir 미지정 = 자산 단계 skip (정직 skip, assets=[]).
    const assets = deps.assetDir === undefined ? [] : mirrorAssets(deps.assetDir, deps.backupDir);

    // 4) manifest 마지막 기록. files 는 manifest 기록 전 스냅샷이라 manifest 자신은
    //    포함되지 않는다.
    const files = readdirSync(roundDir)
      .sort()
      .map((name) => ({ name, bytes: statSync(join(roundDir, name)).size }));
    const manifest: BackupManifest = {
      timestamp,
      epochMs: startedMs,
      appVersion: deps.appVersion,
      schemaVersion: deps.schemaVersion,
      files,
      assets,
      durationMs: now() - startedMs,
    };
    writeManifest(roundDir, manifest);
    return { roundDir, manifest };
  } catch (e) {
    // manifest 없는 반쪽 회차를 남기지 않는다. 삭제 자체가 실패해도(예: mkdir 가
    // 실패해 폴더 자체가 없음) 원래 실패를 던진다 — 남은 반쪽은 부팅 청소가 회수.
    let cleanupNote = "";
    try {
      rmSync(roundDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      cleanupNote = ` (부분 산출물 삭제도 실패: ${(cleanupErr as Error).message} — 부팅 청소가 회수)`;
    }
    throw new BackupError(`백업 회차 실패: ${(e as Error).message}${cleanupNote}`);
  }
}

/** manifest 없는(무효) round-* 폴더 삭제, 삭제한 폴더 경로 목록 반환. 부팅 시 1회 호출. */
export function cleanupIncompleteRounds(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(ROUND_DIR_PREFIX)) continue;
    const dir = join(backupDir, entry.name);
    if (readManifest(dir) !== null) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/**
 * 보존일(retentionDays) 초과 회차를 지우고, 남은 회차들의 manifest.assets 합집합에
 * 없는 미러 파일(고아 자산)을 지운다. 만료 판정은 manifest.epochMs 산술 비교 —
 * 시간대 문자열 파싱에 기대지 않는다.
 */
export function applyRetention(
  backupDir: string,
  retentionDays: number,
  nowMs: number,
): { roundsRemoved: string[]; assetsRemoved: string[] } {
  const maxAgeMs = retentionDays * MS_PER_DAY;
  const roundsRemoved: string[] = [];
  const keptAssets = new Set<string>();
  for (const { dir, manifest } of listValidRounds(backupDir)) {
    if (nowMs - manifest.epochMs > maxAgeMs) {
      rmSync(dir, { recursive: true, force: true });
      roundsRemoved.push(dir);
    } else {
      for (const name of manifest.assets) keptAssets.add(name);
    }
  }
  const assetsRemoved: string[] = [];
  const mirrorDir = join(backupDir, ASSETS_MIRROR_DIR);
  if (existsSync(mirrorDir)) {
    for (const entry of readdirSync(mirrorDir, { withFileTypes: true })) {
      if (!entry.isFile() || keptAssets.has(entry.name)) continue;
      const file = join(mirrorDir, entry.name);
      rmSync(file);
      assetsRemoved.push(file);
    }
  }
  return { roundsRemoved, assetsRemoved };
}

/** 존재하는 파일만 회차 폴더로 복사한다. 복사했으면 대상 경로, 부재면 null. */
function copyIfExists(src: string, roundDir: string): string | null {
  if (!existsSync(src)) return null;
  const dest = join(roundDir, basename(src));
  copyFileSync(src, dest);
  return dest;
}

/**
 * `${assetDir}/content/` 하위 자산을 `<backupDir>/assets-mirror/` 로 미러한다.
 * 자산은 sha 내용 주소의 불변 파일이라 이름이 같으면 내용도 같다 — 미러에 이미
 * 있고 크기까지 원본과 일치하면 다시 복사하지 않는다. 크기가 다르면(이전 회차의
 * copyFileSync 가 디스크 풀·강제 종료로 중간에 끊긴 찢어진 파일) 다시 복사한다.
 * 복사는 `<dest>.tmp-<pid>` 에 먼저 쓴 뒤 원자 rename 해, 이번 회차가 중간에
 * 끊겨도 미러의 dest 는 완전한 이전 상태이거나 완전한 새 파일 둘 중 하나만 남는다.
 * `.tmp-` 잔재는 applyRetention 의 미러 정리(keptAssets 에 없는 파일 삭제)가 자연
 * 회수한다. content/ 는 asset-store 가 첫 write 시점에 만들므로, 폴더 부재 =
 * 자산 0개(실제 빈 상태)다. 반환 = 그 시점 자산 파일명 목록(정렬).
 */
function mirrorAssets(assetDir: string, backupDir: string): string[] {
  const contentDir = join(assetDir, "content");
  if (!existsSync(contentDir)) return [];
  const mirrorDir = join(backupDir, ASSETS_MIRROR_DIR);
  // 절대 경로로 바꿔 부른다: Bun 1.3.6 / Windows 는 이미 있는 상대 경로에 `..` 가 있으면(예 ../../data/backups) recursive mkdir 도 EEXIST 를 던진다.
  mkdirSync(resolve(mirrorDir), { recursive: true, mode: 0o700 });
  const names: string[] = [];
  for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    names.push(entry.name);
    const src = join(contentDir, entry.name);
    const dest = join(mirrorDir, entry.name);
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue;
    // Windows renameSync 는 dest 존재 시 실패하므로 rm 선행. tmp → rm → rename
    // 순서로 원자 교체한다.
    const tmp = `${dest}.tmp-${process.pid}`;
    copyFileSync(src, tmp);
    rmSync(dest, { force: true });
    renameSync(tmp, dest);
  }
  names.sort();
  return names;
}
