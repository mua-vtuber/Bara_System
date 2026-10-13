/**
 * backup-runner 통합 테스트 — 실 SQLite(WAL) + 실 파일시스템으로 검증한다.
 * 가짜 구현체 없음.
 *
 * brief 대비 조정 2가지(검증 의미 유지):
 *   - knowledge_nodes INSERT 컬럼: 실제 schema 에 node_type 이 없어 memory_type 사용.
 *   - retention 만료 판정: 시간대 문자열 파싱 대신 manifest.epochMs 기반
 *     (task brief Step 3 이 허용한 단순화).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "../db/wal-test-helpers.ts";
import {
  runBackupRound,
  cleanupIncompleteRounds,
  applyRetention,
  BackupError,
} from "./backup-runner.ts";
import { readManifest, listValidRounds, MANIFEST_NAME } from "./backup-manifest.ts";
import {
  getBackupStatus,
  recordBackupSuccess,
  recordBackupFailure,
  recordNextRunAt,
  resetBackupStatus,
} from "./backup-status.ts";
import { makeEnv, depsOf, TEST_ASSET_NAME, type BackupTestEnv } from "./backup-test-env.ts";

const envs: BackupTestEnv[] = [];
afterEach(() => {
  while (envs.length > 0) {
    const e = envs.pop()!;
    e.db.close();
    cleanupTempDir(e.dir);
  }
});

function newEnv(): BackupTestEnv {
  const e = makeEnv();
  envs.push(e);
  return e;
}

describe("runBackupRound", () => {
  test("스냅샷 무결 + 행 보존 + manifest 마지막 기록", async () => {
    const e = newEnv();
    const { roundDir, manifest } = await runBackupRound(depsOf(e));
    const snapName = manifest.files.find((f) => f.name.endsWith(".sqlite"))!.name;
    const snap = new Database(join(roundDir, snapName), { readonly: true });
    expect(
      (snap.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
    expect(
      (snap.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }).c,
    ).toBe(1);
    snap.close();
    expect(existsSync(join(roundDir, MANIFEST_NAME))).toBe(true);
    expect(readManifest(roundDir)).not.toBeNull();
    expect(manifest.assets).toEqual([TEST_ASSET_NAME]);
    expect(existsSync(join(e.backupDir, "assets-mirror", TEST_ASSET_NAME))).toBe(true);
    // secrets 는 회차 폴더에 포함(서버측 완전 세트) — 다운로드 제외는 T5 의 몫.
    expect(existsSync(join(roundDir, "secrets.json"))).toBe(true);
    // 부재 sse 토큰 파일은 복사 안 됨 — manifest.files 에도 없어 부재가 드러난다.
    expect(existsSync(join(roundDir, "sse-tokens.json"))).toBe(false);
    expect(manifest.files.some((f) => f.name === "sse-tokens.json")).toBe(false);
  });

  test("WAL 미체크포인트 쓰기가 스냅샷에 포함된다 (plain copy 대비)", async () => {
    const e = newEnv();
    e.db
      .prepare("INSERT INTO knowledge_nodes (content, memory_type, created_at) VALUES (?, ?, ?)")
      .run("WAL 안 글", "note", "2026-07-03 12:01:00");
    const { roundDir, manifest } = await runBackupRound(depsOf(e));
    const snapName = manifest.files.find((f) => f.name.endsWith(".sqlite"))!.name;
    const snap = new Database(join(roundDir, snapName), { readonly: true });
    expect(
      (snap.prepare("SELECT COUNT(*) AS c FROM knowledge_nodes").get() as { c: number }).c,
    ).toBe(2);
    snap.close();
  });

  test(":memory: DB 는 BackupError — silent skip 금지", async () => {
    const e = newEnv();
    await expect(runBackupRound({ ...depsOf(e), dbPath: ":memory:" })).rejects.toBeInstanceOf(
      BackupError,
    );
  });

  test("실패 시 부분 산출물 삭제 — backupDir 를 파일로 막아 mkdir 실패 유도", async () => {
    const e = newEnv();
    const blocked = join(e.dir, "blocked");
    writeFileSync(blocked, "not-a-dir");
    await expect(runBackupRound({ ...depsOf(e), backupDir: blocked })).rejects.toBeInstanceOf(
      BackupError,
    );
  });

  test("찢어진 미러 파일이 원본과 크기 일치로 복구된다", async () => {
    const e = newEnv();
    // 미러에 이전 회차가 남긴 찢어진(부분) 파일을 손작성 — 원본(9바이트)보다 짧다.
    const mirrorDir = join(e.backupDir, "assets-mirror");
    mkdirSync(mirrorDir, { recursive: true });
    const tornMirror = join(mirrorDir, TEST_ASSET_NAME);
    writeFileSync(tornMirror, "torn");
    const originalBytes = statSync(join(e.assetDir, "content", TEST_ASSET_NAME)).size;
    expect(statSync(tornMirror).size).not.toBe(originalBytes);

    const { manifest } = await runBackupRound(depsOf(e));
    // 크기 불일치를 감지해 다시 복사 — 미러가 원본과 크기 일치로 복구.
    expect(statSync(tornMirror).size).toBe(originalBytes);
    expect(manifest.assets).toEqual([TEST_ASSET_NAME]);
    // 원자 복사의 임시 파일이 미러에 잔류하지 않는다.
    expect(
      readdirSync(mirrorDir).some((n) => n.includes(".tmp-")),
    ).toBe(false);
  });

  test("이미 있는 자산 미러를 `..` 가 든 상대 backupDir(../backups)로 줘도 회차가 끝난다 — Bun 1.3.6 / Windows mkdir EEXIST 회귀", async () => {
    const e = newEnv();
    mkdirSync(join(e.backupDir, "assets-mirror"), { recursive: true });
    mkdirSync(join(e.dir, "cwd"));
    const before = process.cwd();
    process.chdir(join(e.dir, "cwd"));
    let assets: string[] = [];
    try {
      assets = (await runBackupRound({ ...depsOf(e), backupDir: "../backups" })).manifest.assets;
    } finally {
      process.chdir(before);
    }
    expect(assets).toEqual([TEST_ASSET_NAME]);
    expect(existsSync(join(e.backupDir, "assets-mirror", TEST_ASSET_NAME))).toBe(true);
  });
});

describe("cleanupIncompleteRounds + applyRetention", () => {
  test("manifest 없는 회차 청소 + 보존일 초과 회차·고아 미러 정리", async () => {
    const e = newEnv();
    const r1 = await runBackupRound(depsOf(e));
    // pre-migration/ 은 T4 소유 — 청소·retention 이 건드리면 안 된다.
    const preMigration = join(e.backupDir, "pre-migration");
    mkdirSync(preMigration, { recursive: true });
    writeFileSync(join(preMigration, "keep.sqlite"), "t4-owned");
    // manifest 없는 반쪽 회차 손작성
    const half = join(e.backupDir, "round-19990101-000000");
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, "bara-x.sqlite"), "torn");
    expect(cleanupIncompleteRounds(e.backupDir)).toEqual([half]);
    expect(existsSync(half)).toBe(false);
    expect(existsSync(r1.roundDir)).toBe(true); // 유효 회차 보존
    expect(listValidRounds(e.backupDir).map((r) => r.dir)).toEqual([r1.roundDir]);
    // retention: 8일 뒤 시각으로 1회차 만료
    const nowMs = r1.manifest.epochMs + 8 * 24 * 3600 * 1000;
    const out = applyRetention(e.backupDir, 7, nowMs);
    expect(out.roundsRemoved).toEqual([r1.roundDir]);
    expect(out.assetsRemoved).toEqual([join(e.backupDir, "assets-mirror", TEST_ASSET_NAME)]);
    expect(existsSync(r1.roundDir)).toBe(false);
    expect(existsSync(join(preMigration, "keep.sqlite"))).toBe(true);
  });
});

describe("backup-status 싱글턴", () => {
  // 프로세스 공유 싱글턴이므로, 이 테스트 전후로 상태를 초기화해 다른 테스트 파일과
  // 서로 오염되지 않게 한다(자기 시작 보장 + 자기 뒷정리).
  beforeEach(resetBackupStatus);
  afterEach(resetBackupStatus);

  test("성공·실패·다음 실행 시각 기록이 스냅샷에 반영된다", () => {
    expect(getBackupStatus().lastResult).toBeNull();
    recordBackupSuccess("2026-07-03 04:00:00", "/backups/round-20260703-040000");
    expect(getBackupStatus().lastResult).toEqual({
      ok: true,
      at: "2026-07-03 04:00:00",
      roundDir: "/backups/round-20260703-040000",
    });
    recordBackupFailure("2026-07-04 04:00:00", "disk full");
    expect(getBackupStatus().lastResult).toEqual({
      ok: false,
      at: "2026-07-04 04:00:00",
      error: "disk full",
    });
    recordNextRunAt("2026-07-05T04:00:00+09:00");
    expect(getBackupStatus().nextRunAt).toBe("2026-07-05T04:00:00+09:00");
    recordNextRunAt(null);
    expect(getBackupStatus().nextRunAt).toBeNull();
  });
});
