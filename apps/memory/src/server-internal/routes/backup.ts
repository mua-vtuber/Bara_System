/**
 * server-internal/routes/backup.ts — 백업 상태·다운로드 라우트 등록기 (P4 D2 / T5)
 *
 * GET /backup/status   — 회차 manifest 스캔(디스크) + 마지막 결과(메모리) 합쳐 회신.
 * GET /backup/download — 즉석 DB 스냅샷 zip 회신(비밀값·자산·토큰 미포함).
 *
 * 절대 제약:
 *   deps.backup 은 createMemoryApi 가 나중에 채우는 선택 의존이므로 구조분해로 미리
 *   꺼내지 않는다. 핸들러 안에서 호출 시점에 deps.backup 으로 lookup — undefined 면
 *   503(archive.ts / assets.ts 선택 의존 양식 정합 — 정직한 비활성, silent no-op 아님).
 *
 *   다운로드 zip 에는 DB 스냅샷 + memory-settings.json + manifest.json 만 담는다.
 *   secrets.json·SSE 토큰·자산 미러는 절대 넣지 않는다 — 브라우저에 평문 비밀값이
 *   잔존하지 않게 하는 사용자 확정 사항. (회차 백업 backup-runner.ts 와 다르다 —
 *   그쪽은 A1 로컬 회차라 비밀값을 포함하나, 이 통로는 브라우저로 내려보내는 사본이다.)
 */

import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { getBackupStatus } from "../../backup/backup-status.ts";
import { listValidRounds } from "../../backup/backup-manifest.ts";
import { DOWNLOAD_BACKUP_CONTENTS, DOWNLOAD_BACKUP_FORMAT } from "../../backup/download-backup.ts";
import { sanitizeDownloadSettings } from "../../backup/restore-validation.ts";

/** 회차 한 항목의 상태 요약(GET /backup/status rounds 원소). */
interface BackupRoundSummary {
  /** 회차 폴더 이름(전체 경로가 아니라 basename — 디스크 경로 비노출). */
  dir: string;
  timestamp: string;
  /** 회차 파일 개수(manifest.files 길이). */
  files: number;
  /** 그 시점 자산 개수(manifest.assets 길이). */
  assets: number;
  /** 회차 파일 바이트 합(manifest.files 각 bytes 합산). */
  bytes: number;
}

/**
 * 백업 상태·다운로드 두 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다(backup 구조분해 금지 — createMemoryApi 가 나중에 채우는
 * 선택 의존이라 호출 시점 lookup 이라야 한다).
 */
export function registerBackupRoutes(app: Hono, deps: MemoryApiDeps): void {
  // ── GET /backup/status — 회차 목록(디스크) + 마지막 결과(메모리) ────────────
  app.get("/backup/status", (c) => {
    const backup = deps.backup;
    if (backup === undefined) {
      return err(c, 503, "backup 미주입 — 백업 상태를 조회할 수 없다");
    }
    const status = getBackupStatus();
    const rounds: BackupRoundSummary[] = listValidRounds(backup.backupDir).map(
      ({ dir, manifest }) => ({
        dir: basename(dir),
        timestamp: manifest.timestamp,
        files: manifest.files.length,
        assets: manifest.assets.length,
        bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
      }),
    );
    return c.json({
      lastResult: status.lastResult,
      nextRunAt: status.nextRunAt,
      appVersion: backup.appVersion,
      schemaVersion: backup.schemaVersion,
      rounds,
    });
  });

  // ── GET /backup/download — 즉석 스냅샷 zip(비밀값·자산·토큰 미포함) ──────────
  app.get("/backup/download", (c) => {
    const backup = deps.backup;
    if (backup === undefined) {
      return err(c, 503, "backup 미주입 — 스냅샷을 만들 수 없다");
    }
    // 파일 DB 전용 — :memory: 는 스냅샷을 만들 수 없어 정직 거부(silent skip 금지).
    if (backup.dbPath === ":memory:" || backup.dbPath === "") {
      return err(c, 400, `백업 다운로드는 파일 DB 전용 — dbPath="${backup.dbPath}"`);
    }

    // 임시 폴더에 VACUUM INTO 스냅샷을 만들고, 읽어 zip 한 뒤 폴더를 정리한다. 실패
    // 어느 지점에서든 임시 폴더를 지우고 500 — 부분 zip 은 회신하지 않는다.
    const tmpDir = mkdtempSync(join(tmpdir(), "bara-dl-"));
    try {
      const snapshotPath = join(tmpDir, basename(backup.dbPath));
      // VACUUM INTO 는 WAL 미체크포인트 쓰기까지 포함한 일관 스냅샷. 파라미터 바인딩
      // 지원이 SQLite 버전 의존이라 escape 조립을 쓴다(backup-runner.ts 와 같은 패턴).
      const escaped = snapshotPath.replaceAll("'", "''");
      deps.store.getRawDb().run(`VACUUM INTO '${escaped}'`);

      const snapshotBytes = readFileSync(snapshotPath);
      const settingsBytes = sanitizeDownloadSettings(readFileSync(backup.settingsFilePath));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const manifest = {
        format: DOWNLOAD_BACKUP_FORMAT,
        timestamp: stamp,
        appVersion: backup.appVersion,
        schemaVersion: backup.schemaVersion,
        contents: DOWNLOAD_BACKUP_CONTENTS,
        excludes: ["assets", "secrets", "tokens"],
      };
      const zipBytes = zipSync({
        "bara.sqlite": new Uint8Array(snapshotBytes),
        "memory-settings.json": new Uint8Array(settingsBytes),
        "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
      });

      // 바이너리는 c.body 대신 new Response 직접 반환 — assets.ts 확립 idiom(Hono
      // Uint8Array 타입 양식 우회). Content-Disposition 으로 브라우저 다운로드 유도.
      return new Response(zipBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="bara-backup-${stamp}.zip"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return err(c, 500, `스냅샷 다운로드 실패: ${(e as Error).message}`);
    } finally {
      // 성공·실패 어느 경로든 임시 스냅샷 폴더를 반드시 지운다(디스크 잔재 0).
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}
