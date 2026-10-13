/**
 * wal-migration-e2e.test.ts — 빈 파일 DB 를 openMemoryDatabase 로 열면 기준 스키마가 만들어지고
 * journal_mode=WAL 이 걸리며 FK 검사 위반이 0 인지 e2e 검증한다.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (Completion Criteria 2)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T3)
 *
 * Mock 0. 실제 bun:sqlite + sqlite-vec + 실제 파일 DB(temp dir).
 *
 * 왜 필요한가: WAL 진입은 runMigrations 의 트랜잭션보다 먼저 일어나야 한다(PRAGMA
 * journal_mode=WAL 은 활성 트랜잭션 중 적용 불가). 이 테스트는 파일 DB 라야 WAL 이 실제로
 * 걸리므로 :memory: 가 아닌 temp dir 의 파일 DB 로 열어 "WAL 진입이 스키마 적용과 충돌하지
 * 않는다"를 동결한다. (옛 v20 장수 DB 를 v35 까지 올리는 시험은 업그레이드 경로가 없어져 지웠다.)
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  openMemoryDatabase,
  getAppliedSchemaVersion,
  CURRENT_SCHEMA_VERSION,
} from "./migrations.ts";
import { makeWalTempDir, cleanupTempDir } from "./wal-test-helpers.ts";

const DIM = 384;
const tempDirs: string[] = [];

function makeTempFile(): string {
  const { dir, file } = makeWalTempDir("bara-wal-mig-");
  tempDirs.push(dir);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

describe("T3 — WAL 로 연 빈 파일 DB", () => {
  test("빈 파일 DB → openMemoryDatabase → 정상 baseline + WAL(pending 0 경로)", () => {
    const file = makeTempFile();
    const db = openMemoryDatabase(file, { embeddingDim: DIM });

    expect(getAppliedSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    expect(db.prepare("PRAGMA foreign_key_check").all().length).toBe(0);
    db.close();
  });
});
