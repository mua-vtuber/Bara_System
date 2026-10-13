/**
 * connection-pragmas.test.ts — T1(W1·W3·W4): WAL/busy_timeout/synchronous 연결
 * PRAGMA 헬퍼 단위 검증.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (Completion Criteria 1)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T1)
 *
 * Mock 0. 실제 bun:sqlite + 실제 파일 DB(temp dir). 데이터 fixture 없음(순수 PRAGMA
 * 검증). 파일 DB 는 mkdtempSync 로 만들고 afterEach 에서 -wal·-shm 포함 recursive 정리.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DB_BUSY_TIMEOUT_MS,
  applyConnectionPragmas,
  applyBusyTimeout,
} from "./connection-pragmas.ts";
import { makeWalTempDir, cleanupTempDir } from "./wal-test-helpers.ts";

const tempDirs: string[] = [];

function makeTempFile(): string {
  const { dir, file } = makeWalTempDir("bara-wal-");
  tempDirs.push(dir);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop()!);
  }
});

// PRAGMA 반환 컬럼명은 대개 pragma 이름과 같으나(journal_mode·synchronous),
// busy_timeout 만 예외로 컬럼명이 timeout 이다(SQLite 실측 확정).
const PRAGMA_RESULT_COLUMN: Record<string, string> = {
  busy_timeout: "timeout",
};

function readPragma(db: Database, name: string): unknown {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  if (row === null) return null;
  return row[PRAGMA_RESULT_COLUMN[name] ?? name];
}

describe("connection-pragmas T1 — applyConnectionPragmas (파일 DB)", () => {
  test("파일 DB 에 WAL·busy_timeout·synchronous 를 모두 건다", () => {
    const file = makeTempFile();
    const db = new Database(file);
    applyConnectionPragmas(db, file);

    expect(readPragma(db, "journal_mode")).toBe("wal");
    expect(readPragma(db, "busy_timeout")).toBe(DB_BUSY_TIMEOUT_MS);
    // synchronous=NORMAL 은 정수 1 로 조회된다.
    expect(readPragma(db, "synchronous")).toBe(1);
    db.close();
  });

  test("DB_BUSY_TIMEOUT_MS 상수값은 5000(명명 상수, 하드코딩 아님)", () => {
    expect(DB_BUSY_TIMEOUT_MS).toBe(5000);
  });

  test("applyBusyTimeout 단독 호출은 busy_timeout 만 건다", () => {
    const file = makeTempFile();
    const db = new Database(file);
    // WAL·synchronous 는 아직 default(각각 delete/memory·2=FULL).
    applyBusyTimeout(db);

    expect(readPragma(db, "busy_timeout")).toBe(DB_BUSY_TIMEOUT_MS);
    // journal_mode 는 파일 DB default(delete) — applyBusyTimeout 이 안 건드림.
    expect(readPragma(db, "journal_mode")).toBe("delete");
    // synchronous 는 default 2(FULL) — applyBusyTimeout 이 안 건드림.
    expect(readPragma(db, "synchronous")).toBe(2);
    db.close();
  });
});

describe("connection-pragmas T1 — :memory: DB", () => {
  test(":memory: 는 throw 하지 않고 WAL 경고도 안 남긴다", () => {
    const db = new Database(":memory:");
    // isMemory=true 경로 — journal_mode 가 memory 로 남아도 정상, 경고 skip.
    expect(() => applyConnectionPragmas(db, ":memory:")).not.toThrow();
    // busy_timeout·synchronous 는 그래도 걸린다(연결 계약).
    expect(readPragma(db, "busy_timeout")).toBe(DB_BUSY_TIMEOUT_MS);
    expect(readPragma(db, "synchronous")).toBe(1);
    db.close();
  });

  test("빈 문자열 경로도 메모리로 간주해 경고 skip", () => {
    const db = new Database(":memory:");
    expect(() => applyConnectionPragmas(db, "")).not.toThrow();
    db.close();
  });
});
