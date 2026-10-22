/**
 * v52 MCP 도구 호출 횟수 표 — 실제 SQLite + 실제 마이그레이션 (2026-10-21 mcp-usage-and-guidance spec 7.1, A-T1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, openMemoryDatabase, runMigrations } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { USAGE_KINDS, USAGE_OUTCOMES } from "../../mcp/usage-categories.ts";

const DIM = 8;
const V52 = BASELINE_VERSION + 5;
const CHECK_FAILED = "CHECK constraint failed";

let db: Database;
beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: DIM }); });
afterEach(() => db.close());

const hasTable = (target: Database) =>
  target.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_tool_usage_daily'").get() !== null;

function insert(target: Database, kind: string, outcome: string, calls = 1, day = "2026-10-21"): void {
  target.query(
    "INSERT INTO mcp_tool_usage_daily (day, client, kind, name, outcome, calls) VALUES (?, 'claude-code', ?, 'x', ?, ?)",
  ).run(day, kind, outcome, calls);
}

describe("v52 마이그레이션", () => {
  test("새 DB 에 표가 생기고 코드가 아는 최고 버전은 52 이상이다", () => {
    expect(hasTable(db)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(V52);
  });

  test("기존 v51 DB 도 같은 up() 으로 올라간다", () => {
    const old = new Database(":memory:");
    sqliteVec.load(old);
    old.run("PRAGMA foreign_keys = ON");
    runMigrations(old, MIGRATIONS.filter((m) => m.version < V52), DIM);
    expect(hasTable(old)).toBe(false);
    runMigrations(old, MIGRATIONS, DIM);
    expect(hasTable(old)).toBe(true);
    old.close();
  });

  test("기본 키는 (day, client, kind, name, outcome) 이라 같은 열쇠 두 번은 거절된다", () => {
    insert(db, "tool", "ok");
    expect(() => insert(db, "tool", "ok")).toThrow("UNIQUE constraint failed");
    insert(db, "tool", "error");
    insert(db, "tool", "ok", 1, "2026-10-22");
  });

  test("종류·결과·횟수 CHECK 는 모르는 값을 거절한다", () => {
    expect(() => insert(db, "bogus", "ok")).toThrow(CHECK_FAILED);
    expect(() => insert(db, "tool", "bogus")).toThrow(CHECK_FAILED);
    expect(() => insert(db, "tool", "ok", 0)).toThrow(CHECK_FAILED);
  });

  test("CHECK 에 적힌 글자 목록이 코드 상수(USAGE_KINDS·USAGE_OUTCOMES)와 같다", () => {
    const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'mcp_tool_usage_daily'").get() as { sql: string }).sql;
    const listOf = (column: string): string[] => {
      const m = new RegExp(`${column}\\s+TEXT NOT NULL CHECK\\s*\\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
      if (m === null) throw new Error(`${column} CHECK 목록을 표 정의에서 못 찾음`);
      return m[1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    };
    expect(listOf("kind")).toEqual([...USAGE_KINDS]);
    expect(listOf("outcome")).toEqual([...USAGE_OUTCOMES]);
  });
});
