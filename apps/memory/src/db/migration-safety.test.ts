/**
 * migration-safety.test.ts — openMemoryDatabase 의 DB 폴더 만들기(ensureDbParentDir) 검증.
 *
 * spec: docs/decisions/2026-07-02-migration-safety-spec.md (D7)
 * plan: T7 (ensureDbParentDir).
 *
 * Mock 객체 0. 실제 bun:sqlite 와 OS 임시 폴더.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDbParentDir } from "./migration-safety.ts";
import { removeTempDir } from "./migration-safety.test-helpers.ts";

describe("ensureDbParentDir", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      removeTempDir(dir);
    }
  });

  test(":memory: — 폴더 생성 skip, throw 안 함", () => {
    expect(() => ensureDbParentDir(":memory:")).not.toThrow();
  });

  test("빈 문자열 — skip, throw 안 함", () => {
    expect(() => ensureDbParentDir("")).not.toThrow();
  });

  test("없는 하위 폴더 경로 — 부모 폴더가 생긴다", () => {
    const base = mkdtempSync(join(tmpdir(), "bara-migsafety-"));
    created.push(base);
    const target = join(base, "sub", "deep", "bara.sqlite");
    expect(existsSync(join(base, "sub", "deep"))).toBe(false);
    ensureDbParentDir(target);
    expect(existsSync(join(base, "sub", "deep"))).toBe(true);
  });

  test("이미 있는 부모 폴더를 `..` 가 든 상대 경로(../data/bara.sqlite)로 줘도 throw 안 함 — Bun 1.3.6 / Windows EEXIST 회귀", () => {
    const base = mkdtempSync(join(tmpdir(), "bara-migsafety-"));
    created.push(base);
    mkdirSync(join(base, "data"));
    mkdirSync(join(base, "cwd"));
    const before = process.cwd();
    process.chdir(join(base, "cwd"));
    try {
      expect(() => ensureDbParentDir("../data/bara.sqlite")).not.toThrow();
    } finally {
      process.chdir(before);
    }
    expect(existsSync(join(base, "data"))).toBe(true);
  });

  test("폴더 생성 후 실제 new Database 가 정상 열린다(부팅 정합)", () => {
    const base = mkdtempSync(join(tmpdir(), "bara-migsafety-"));
    created.push(base);
    const target = join(base, "created", "bara.sqlite");
    ensureDbParentDir(target);
    const db = new Database(target);
    db.run("CREATE TABLE t (a INTEGER)");
    db.close();
    expect(existsSync(target)).toBe(true);
  });

  test("폴더 생성 불가 경로 — 설정 키 이름 담은 구체 에러로 throw(silent no-op 금지)", () => {
    // mkdir 실패를 실제 fs 로 유발한다(권한 조작 없이 플랫폼 의존 최소): 먼저 파일을
    // 하나 만든 뒤, 그 *파일*을 부모로 갖는 하위 경로를 준다. mkdirSync 는 부모가
    // 디렉토리가 아니므로 실패한다(실측: Windows·POSIX 모두 ENOTDIR). ensureDbParentDir
    // 은 이 실패를 조용히 삼키지 않고 설정 키 이름을 담은 구체 에러로 승격해야 한다.
    const base = mkdtempSync(join(tmpdir(), "bara-migsafety-"));
    created.push(base);
    const filePath = join(base, "not-a-dir");
    writeFileSync(filePath, "occupied");
    // filePath 가 파일이므로, 그 밑 폴더는 만들 수 없다.
    const target = join(filePath, "child", "bara.sqlite");

    let message = "";
    expect(() => ensureDbParentDir(target)).toThrow();
    try {
      ensureDbParentDir(target);
    } catch (e) {
      message = (e as Error).message;
    }
    // plan T7 이 명시한 에러 형식: "DB 폴더 생성 실패" + 설정 키 이름 + 원인 message.
    expect(message).toContain("DB 폴더 생성 실패");
    expect(message).toContain("db.path");
    expect(message).toContain("MEMORY_DB_PATH");
    // 원인(하위 fs 에러 message)을 삼키지 않고 담는다.
    expect(message).toContain("원인");
  });
});
