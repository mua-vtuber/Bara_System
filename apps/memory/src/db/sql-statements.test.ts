/**
 * sql-statements.test.ts — runSqlStatements / runSqlStatementList: 여러 문장을 한 문장씩 돌리고 첫 실패에서 출처·순번을 담아 멈춘다.
 *
 * 문장 나누기(splitSqlStatements) 규칙 시험은 migration-runner.test.ts 의 "splitSqlStatements — 데이터 fixture" 에 있다.
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 실패는 자연 실패로 만든다 — sqlite-vec 는 차원이 8192 를 넘는 vec0 표 생성을 거부한다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { runImmediateTransaction } from "./baseline-schema.ts";
import { runSqlStatementList, runSqlStatements } from "./sql-statements.ts";

/** sqlite-vec 가 vec0 표 생성을 거부하는 차원(최대 8192 초과). */
const TOO_LARGE_VEC_DIM = 9000;
const SOURCE = "fixture-up.sql";

const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openDb(): Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  opened.push(db);
  return db;
}

function tableNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

/** 둘째 문장이 vec0 거부로 실패하는 세 문장짜리 SQL. */
const FAILS_IN_THE_MIDDLE = [
  "CREATE TABLE before_fail (x);",
  `CREATE VIRTUAL TABLE too_wide USING vec0(node_id INTEGER PRIMARY KEY, embedding float[${TOO_LARGE_VEC_DIM}]);`,
  "CREATE TABLE after_fail (y);",
].join("\n");

describe("runSqlStatements", () => {
  test("문장을 순서대로 모두 돌린다", () => {
    const db = openDb();
    runSqlStatements(db, "CREATE TABLE a (x INTEGER); INSERT INTO a VALUES (1); INSERT INTO a VALUES (2);", SOURCE);
    expect(db.query("SELECT x FROM a ORDER BY x").all()).toEqual([{ x: 1 }, { x: 2 }]);
  });

  test("본문에 ; 가 든 트리거도 한 문장으로 돌려 실제로 동작한다", () => {
    const db = openDb();
    runSqlStatements(
      db,
      [
        "CREATE TABLE src (v INTEGER);",
        "CREATE TABLE log (v INTEGER);",
        "CREATE TRIGGER src_ins AFTER INSERT ON src BEGIN",
        "  INSERT INTO log (v) VALUES (new.v);",
        "  INSERT INTO log (v) VALUES (new.v * 10);",
        "END;",
        "INSERT INTO src VALUES (3);",
      ].join("\n"),
      SOURCE,
    );
    expect(db.query("SELECT v FROM log ORDER BY v").all()).toEqual([{ v: 3 }, { v: 30 }]);
  });

  test("중간 문장이 실패하면 출처와 문장 순번을 담아 던지고 뒤 문장은 돌리지 않는다", () => {
    const db = openDb();
    let thrown: unknown;
    try {
      runSqlStatements(db, FAILS_IN_THE_MIDDLE, SOURCE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toContain(SOURCE);
    expect(error.message).toContain("2번째 문장(전체 3개)");
    expect(error.message).toContain("vec0 constructor error");
    expect(error.message).toContain("CREATE VIRTUAL TABLE too_wide");
    expect((error.cause as Error).message).toContain("Dimension on vector column too large");
    // 앞 문장은 이미 돌았고(트랜잭션은 호출자 몫), 뒤 문장은 돌지 않았다.
    expect(tableNames(db)).toEqual(["before_fail"]);
  });

  test("호출자의 트랜잭션 안에서 실패하면 앞 문장까지 모두 되돌려진다", () => {
    const db = openDb();
    expect(() => runImmediateTransaction(db, () => runSqlStatements(db, FAILS_IN_THE_MIDDLE, SOURCE))).toThrow(
      "2번째 문장",
    );
    expect(tableNames(db)).toEqual([]);
  });

  test("나누기에서 멈추면 아무 문장도 돌리기 전에 던진다", () => {
    const db = openDb();
    expect(() => runSqlStatements(db, "CREATE TABLE a (x); CREATE TABLE b (y)", SOURCE)).toThrow(
      `${SOURCE}: 마지막 문장이 ';' 로 끝나지 않았습니다`,
    );
    expect(tableNames(db)).toEqual([]);
  });
});

describe("runSqlStatementList", () => {
  test("이미 나눈 목록도 첫 실패에서 순번과 함께 멈춘다", () => {
    const db = openDb();
    expect(() =>
      runSqlStatementList(db, ["CREATE TABLE a (x);", "INSERT INTO missing_table VALUES (1);", "CREATE TABLE b (y);"], SOURCE),
    ).toThrow(`${SOURCE} 의 2번째 문장(전체 3개) 실행 실패: no such table: missing_table`);
    expect(tableNames(db)).toEqual(["a"]);
  });
});
