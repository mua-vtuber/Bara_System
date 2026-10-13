/**
 * pre-migration-snapshot.test.ts — 대기 마이그레이션(v48+)을 적용하기 직전의 사전 스냅샷.
 *
 * 압축 뒤에는 기준 스키마 이전 DB 가 판정에서 먼저 멈추므로, "대기 마이그레이션이 있는 DB" 는 최신 DB(CURRENT_SCHEMA_VERSION)를 만든 뒤
 * 코드가 아는 최고 버전을 CURRENT_SCHEMA_VERSION + 1 로 넘겨 만든다(설계 2026-10-02 마이그레이션 압축 7절). Mock 0: 실제 파일 DB.
 */
import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, getAppliedSchemaVersion, openMemoryDatabase } from "../db/migrations.ts";
import { makeWalTempDir, cleanupTempDir } from "../db/wal-test-helpers.ts";
import { maybeSnapshotBeforeMigrations } from "./pre-migration-snapshot.ts";

/** 최신 DB 에 마이그레이션 하나가 대기 중인 것으로 보는 코드의 최고 버전. */
const NEXT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION + 1;

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop()!); });

test("대기 마이그레이션이 있는 최신 DB — 스냅샷 생성 + 현재 버전 그대로 담김", () => {
  const { dir, file } = makeWalTempDir("bara-premig-");
  tempDirs.push(dir);
  const db = openMemoryDatabase(file);
  expect(getAppliedSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  const out = maybeSnapshotBeforeMigrations(db, file, NEXT_SCHEMA_VERSION, { dir: join(dir, "backups"), appVersion: "0.1.0" });
  expect(out).not.toBeNull();
  expect(out!).toContain(`pre-v${CURRENT_SCHEMA_VERSION}-`);
  const snap = new Database(out!, { readonly: true });
  expect((snap.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(CURRENT_SCHEMA_VERSION);
  snap.close();
  db.close();
});

test("이미 있는 pre-migration 폴더를 `..` 가 든 상대 dir(../backups)로 줘도 스냅샷을 만든다 — Bun 1.3.6 / Windows mkdir EEXIST 회귀", () => {
  const { dir, file } = makeWalTempDir("bara-premig-rel-");
  tempDirs.push(dir);
  mkdirSync(join(dir, "backups", "pre-migration"), { recursive: true });
  mkdirSync(join(dir, "cwd"));
  const db = openMemoryDatabase(file);
  const before = process.cwd();
  process.chdir(join(dir, "cwd"));
  let out: string | null = null;
  try {
    out = maybeSnapshotBeforeMigrations(db, file, NEXT_SCHEMA_VERSION, { dir: "../backups", appVersion: "0.1.0" });
  } finally {
    process.chdir(before);
    db.close();
  }
  expect(out).not.toBeNull();
  expect(readdirSync(join(dir, "backups", "pre-migration"))).toHaveLength(1);
});

test("pending 없으면 null — 스냅샷 0", () => {
  const { dir, file } = makeWalTempDir("bara-premig-none-");
  tempDirs.push(dir);
  const db = openMemoryDatabase(file); // 최신까지 전부 적용
  const out = maybeSnapshotBeforeMigrations(db, file, CURRENT_SCHEMA_VERSION, { dir: join(dir, "backups"), appVersion: "0.1.0" });
  expect(out).toBeNull();
  expect(existsSync(join(dir, "backups", "pre-migration"))).toBe(false);
  db.close();
});

test(":memory: 는 null", () => {
  const db = new Database(":memory:");
  expect(maybeSnapshotBeforeMigrations(db, ":memory:", CURRENT_SCHEMA_VERSION, { dir: "/nope", appVersion: "0.1.0" })).toBeNull();
  db.close();
});
