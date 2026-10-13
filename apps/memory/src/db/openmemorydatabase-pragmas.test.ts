/**
 * openmemorydatabase-pragmas.test.ts — T2(W2): openMemoryDatabase 통로가 WAL·
 * busy_timeout·synchronous 를 실제로 거는지 검증.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (Completion Criteria 1)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T2)
 *
 * Mock 0. 실제 openMemoryDatabase + 실제 파일 DB(temp dir). 파일 DB 를 열어야 WAL 이
 * 실제로 걸리므로(:memory: 는 WAL 이 memory 로 남음) temp file 로 검증한다.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { openMemoryDatabase, getAppliedSchemaVersion, CURRENT_SCHEMA_VERSION } from "./migrations.ts";
import { DB_BUSY_TIMEOUT_MS } from "./connection-pragmas.ts";
import { makeWalTempDir, cleanupTempDir } from "./wal-test-helpers.ts";

const tempDirs: string[] = [];

function makeTempFile(): string {
  const { dir, file } = makeWalTempDir("bara-wal-open-");
  tempDirs.push(dir);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

describe("T2 — openMemoryDatabase 배선 (파일 DB)", () => {
  test("파일 DB 를 열면 journal_mode=wal, busy_timeout=5000, synchronous=1", () => {
    const file = makeTempFile();
    const db = openMemoryDatabase(file, { embeddingDim: 384 });

    expect(
      (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    expect(
      (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    ).toBe(DB_BUSY_TIMEOUT_MS);
    expect(
      (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
    ).toBe(1);
    // FK 는 부팅 후 ON(1) 유지 — P0-B 처리 무충돌.
    expect(
      (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
    ).toBe(1);
    db.close();
  });

  test("파일 DB 는 -wal·-shm 사이드파일과 함께 정상 스키마 부팅", () => {
    const file = makeTempFile();
    const db = openMemoryDatabase(file, { embeddingDim: 384 });
    // 정상 baseline 마이그레이션 완료.
    expect(getAppliedSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});

describe("T2 — :memory: 회귀 0", () => {
  test(":memory: DB 는 throw 없이 정상 부팅(WAL 은 memory 로 남음, 회귀 0)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    expect(getAppliedSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // busy_timeout·synchronous 는 :memory: 에도 걸린다.
    expect(
      (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    ).toBe(DB_BUSY_TIMEOUT_MS);
    db.close();
  });
});
