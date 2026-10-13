import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { APP_VERSION, buildVersionInfo } from "./version.ts";
import pkg from "../package.json";
import { openMemoryDatabase, CURRENT_SCHEMA_VERSION } from "./db/migrations.ts";
import { makeWalTempDir, cleanupTempDir } from "./db/wal-test-helpers.ts";

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop()!); });

test("APP_VERSION = package.json version 단일 출처 + semver 형식", () => {
  expect(APP_VERSION).toBe(pkg.version);
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("buildVersionInfo — 실 DB 스키마 버전 동봉", () => {
  const { dir, file } = makeWalTempDir("bara-ver-");
  tempDirs.push(dir);
  const db = openMemoryDatabase(file);
  const info = buildVersionInfo(db);
  expect(info.version).toBe(APP_VERSION);
  expect(info.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  db.close();
});

test("buildVersionInfo — schema_version 테이블이 비어 있으면 loud throw", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE schema_version (version INTEGER)");
  expect(() => buildVersionInfo(db)).toThrow(/schema_version 테이블이 비어 있음/);
  db.close();
});
