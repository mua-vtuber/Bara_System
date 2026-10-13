/**
 * migration-runner.test.ts — 마이그레이션 실행기(openMemoryDatabase·runMigrations)와 기준 스키마 적용(applyBaselineSchema).
 *
 * 설계 2026-10-02 마이그레이션 압축 4절·10절 S3. 옛 migration-safety-wiring 시험(FK 를 트랜잭션 밖에서 끄고 켜기, DB 폴더
 * 만들기)을 압축 뒤 규칙으로 옮겨 다시 썼다 — 주입 마이그레이션 번호는 실제 MIGRATIONS 최고 버전 + 1(NEXT)이다. 주입 마이그레이션은
 * 이 파일 안의 진짜 Migration 값이고, 기준 스키마 원자성은 시험용 훅 없이 자연 실패(embeddingDim 0 이면 sqlite-vec 가
 * vec0 표 생성을 거부한다)로 본다. 판정 5행 표는 schema-version-gate.test.ts 가 본다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 파일 DB 는 OS 임시 폴더에 만들고 removeTempDir 로 지운다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBaselineSchema,
  BASELINE_SCHEMA_DIR,
  BASELINE_SCHEMA_FILES,
  BASELINE_VERSION,
} from "./baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, openMemoryDatabase, runMigrations, type Migration } from "./migrations.ts";
import { splitSqlStatements } from "./sql-statements.ts";
import { SchemaVersionTooNewError } from "./schema-version-gate.ts";
import { removeTempDir } from "./migration-safety.test-helpers.ts";

/** 작은 글 벡터 차원 — 실행기 규칙만 보므로 차원은 결과에 영향이 없다. */
const DIM = 8;
/** 주입 마이그레이션 번호 — 실제 MIGRATIONS 가 아는 최고 버전 바로 다음(실제 v48+ 가 늘어도 시험이 그 뒤에 붙는다). */
const NEXT = CURRENT_SCHEMA_VERSION + 1;
/** openMemoryDatabase 로 연 새 DB 의 schema_version 행 — 기준 스키마 + 실제 MIGRATIONS. */
const OPENED_VERSIONS = [BASELINE_VERSION, ...MIGRATIONS.map((m) => m.version)];
/** sqlite-vec 가 vec0 표 생성을 거부하는 차원(float[0]) — 기준 스키마 중간 실패를 자연스럽게 일으킨다. */
const INVALID_VEC_DIM = 0;

type PragmaFkRow = { foreign_keys: number };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

function tempDbFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bara-${prefix}-`));
  tempDirs.push(dir);
  return join(dir, "bara.sqlite");
}

/** 아무것도 없는 원시 연결 — runMigrations 를 직접 부르는 시험용(sqlite-vec 만 싣는다). */
function rawDb(filename = ":memory:"): Database {
  const db = new Database(filename);
  sqliteVec.load(db);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function versions(db: Database): number[] {
  return (db.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>).map(
    (r) => r.version,
  );
}

function objectCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM sqlite_master").get() as { c: number }).c;
}

function schemaObjects(db: Database): unknown[] {
  return db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

function foreignKeys(db: Database): number {
  return (db.query("PRAGMA foreign_keys").get() as PragmaFkRow).foreign_keys;
}

/** NEXT 자리의 진짜 마이그레이션 — 표 하나를 더한다. */
function addTableMigration(name = "next_probe"): Migration {
  return {
    version: NEXT,
    name: "add-probe-table",
    up: (db) => db.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`),
  };
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

describe("새 DB 와 다시 열기", () => {
  test("새 DB 는 기준 스키마로 시작하고 schema_version 은 BASELINE_VERSION 한 행이다", () => {
    const db = rawDb();
    try {
      runMigrations(db, [], DIM);
      expect(versions(db)).toEqual([BASELINE_VERSION]);
      expect(BASELINE_VERSION).toBe(47);
    } finally {
      db.close();
    }
  });

  test("openMemoryDatabase 의 새 DB 는 기준 스키마 행 뒤에 실제 MIGRATIONS 행만 더한다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      expect(versions(db)).toEqual([BASELINE_VERSION, ...MIGRATIONS.map((m) => m.version)]);
    } finally {
      db.close();
    }
  });

  test("파일 DB 를 다시 열어도 schema_version 행·스키마 객체·기존 행이 그대로다", () => {
    const file = tempDbFile("runner-reopen");
    const first = openMemoryDatabase(file, { embeddingDim: DIM });
    first.query("INSERT INTO knowledge_nodes (content) VALUES (?)").run("다시 열기 전 기억");
    const versionRows = first.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
    const objects = schemaObjects(first);
    first.close();

    const second = openMemoryDatabase(file, { embeddingDim: DIM });
    try {
      expect(second.query("SELECT version, applied_at FROM schema_version ORDER BY version").all()).toEqual(versionRows);
      expect(schemaObjects(second)).toEqual(objects);
      expect(second.query("SELECT content FROM knowledge_nodes").all()).toEqual([{ content: "다시 열기 전 기억" }]);
    } finally {
      second.close();
    }
  });

  test("없는 하위 폴더 경로로 열면 폴더를 만들고 기준 스키마로 시작한다", () => {
    const base = mkdtempSync(join(tmpdir(), "bara-runner-mkdir-"));
    tempDirs.push(base);
    const target = join(base, "data", "deep", "bara.sqlite");
    expect(existsSync(join(base, "data", "deep"))).toBe(false);
    const db = openMemoryDatabase(target, { embeddingDim: DIM });
    try {
      expect(existsSync(target)).toBe(true);
      expect(versions(db)[0]).toBe(BASELINE_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("주입 다음 번호 마이그레이션", () => {
  test("새 DB: 기준 스키마를 만든 뒤 같은 runMigrations 가 다음 번호를 적용한다", () => {
    const db = rawDb();
    try {
      runMigrations(db, [addTableMigration()], DIM);
      expect(versions(db)).toEqual([BASELINE_VERSION, NEXT]);
      expect(tableExists(db, "next_probe")).toBe(true);
      expect(tableExists(db, "knowledge_nodes")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("현재 DB에 다음 번호만 적용하고 기존 행은 그대로 두며, 그 번호를 모르는 코드는 그 DB 를 더 새 DB 로 보고 멈춘다", () => {
    const file = tempDbFile("runner-next");
    const db = openMemoryDatabase(file, { embeddingDim: DIM });
    db.query("INSERT INTO knowledge_nodes (content) VALUES (?)").run("현재 버전 때 기억");
    runMigrations(db, [addTableMigration()], DIM);
    expect(versions(db)).toEqual([...OPENED_VERSIONS, NEXT]);
    expect(tableExists(db, "next_probe")).toBe(true);
    expect(db.query("SELECT content FROM knowledge_nodes").all()).toEqual([{ content: "현재 버전 때 기억" }]);
    // 다시 돌리면 할 일이 없다.
    runMigrations(db, [addTableMigration()], DIM);
    expect(versions(db)).toEqual([...OPENED_VERSIONS, NEXT]);
    db.close();

    // 실제 MIGRATIONS(NEXT 없음)로 열면 판정이 SchemaVersionTooNewError 로 멈춘다.
    expect(MIGRATIONS.some((m) => m.version === NEXT)).toBe(false);
    expect(() => openMemoryDatabase(file, { embeddingDim: DIM })).toThrow(SchemaVersionTooNewError);
  });
});

describe("대기 마이그레이션의 외래 키 끄고 켜기", () => {
  test("up() 안에서는 foreign_keys = 0, 끝나면 1 로 돌아온다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      const observed: number[] = [];
      runMigrations(db, [{ version: NEXT, name: "observe-fk", up: (d) => observed.push(foreignKeys(d)) }], DIM);
      expect(observed).toEqual([0]);
      expect(foreignKeys(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("대기 마이그레이션이 없으면 외래 키를 건드리지 않는다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      runMigrations(db, MIGRATIONS, DIM);
      expect(foreignKeys(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("up() 이 던지면 외래 키를 다시 켜고, 그 마이그레이션의 변경과 버전 기록을 되돌린다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      const failing: Migration = {
        version: NEXT,
        name: "create-then-fail",
        up: (d) => {
          d.run("CREATE TABLE next_half (id INTEGER PRIMARY KEY)");
          throw new Error("주입 마이그레이션 실패 재현");
        },
      };
      expect(() => runMigrations(db, [failing], DIM)).toThrow("주입 마이그레이션 실패 재현");
      expect(foreignKeys(db)).toBe(1);
      expect(versions(db)).toEqual(OPENED_VERSIONS);
      expect(tableExists(db, "next_half")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("외래 키 위반을 남기면 멈추고 버전을 올리지 않아, 같은 마이그레이션을 다시 시도한다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      let attempts = 0;
      const violating: Migration = {
        version: NEXT,
        name: "leave-fk-violation",
        up: (d) => {
          attempts += 1;
          d.run("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)");
          d.run("CREATE TABLE fk_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fk_parent(id))");
          // 외래 키가 꺼진 동안이라 부모 없는 자식 행이 들어간다.
          d.run("INSERT INTO fk_child (id, parent_id) VALUES (1, 999)");
        },
      };
      expect(() => runMigrations(db, [violating], DIM)).toThrow("마이그레이션 후 FK 위반 1건");
      expect(versions(db)).toEqual(OPENED_VERSIONS);
      expect(tableExists(db, "fk_child")).toBe(false);
      expect(() => runMigrations(db, [violating], DIM)).toThrow("마이그레이션 후 FK 위반 1건");
      expect(attempts).toBe(2);
      expect(versions(db)).toEqual(OPENED_VERSIONS);
      expect(foreignKeys(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("기준 스키마 적용", () => {
  test("중간 문장이 실패하면 한 트랜잭션이 되돌려져 객체 0 인 DB 가 남는다(vec0 생성 실패)", () => {
    const db = rawDb();
    try {
      // 01 파일은 vec_nodes 앞에서 knowledge_nodes·fts5 표·트리거를 먼저 만든다 — 그것까지 모두 되돌려져야 한다.
      expect(() => runMigrations(db, [], INVALID_VEC_DIM)).toThrow("vec0 constructor error");
      expect(objectCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("파일 DB 에서 실패해도 반쯤 만든 DB 가 남지 않아, 다음에 열면 기준 스키마를 처음부터 만든다", () => {
    const file = tempDbFile("runner-atomic");
    expect(() => openMemoryDatabase(file, { embeddingDim: INVALID_VEC_DIM })).toThrow("vec0 constructor error");
    const check = new Database(file, { readonly: true });
    try {
      expect(objectCount(check)).toBe(0);
    } finally {
      check.close();
    }
    const db = openMemoryDatabase(file, { embeddingDim: DIM });
    try {
      expect(versions(db)[0]).toBe(BASELINE_VERSION);
      expect(tableExists(db, "knowledge_nodes")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("이미 만들어진 DB 에 applyBaselineSchema 를 다시 불러도 아무것도 바꾸지 않는다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      db.query("INSERT INTO knowledge_nodes (content) VALUES (?)").run("그대로");
      const objects = schemaObjects(db);
      const rows = db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
      const visibility = db.query("SELECT * FROM memory_visibility_state").all();
      expect(applyBaselineSchema(db, DIM)).toBe(false);
      expect(schemaObjects(db)).toEqual(objects);
      expect(db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all()).toEqual(rows);
      expect(db.query("SELECT * FROM memory_visibility_state").all()).toEqual(visibility);
      expect(db.query("SELECT content FROM knowledge_nodes").all()).toEqual([{ content: "그대로" }]);
    } finally {
      db.close();
    }
  });

  test("기준 스키마는 문장을 하나씩 돌린다 — 파일 중간의 실행 오류도 던져진다", () => {
    // vec_nodes 는 01 파일의 중간 문장이다. 여러 문장을 한 번에 db.run 에 넘기면 bun:sqlite 가 중간 문장의 실행 오류를
    // 던지지 않고 넘어가, 표가 빠진 DB 가 v47 로 기록됐다(이 시험이 그 결함을 잡는다).
    const statements = splitSqlStatements(readFileSync(join(BASELINE_SCHEMA_DIR, BASELINE_SCHEMA_FILES[0]), "utf8"), "01");
    const vecIndex = statements.findIndex((s) => s.includes("CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes"));
    expect(vecIndex).toBeGreaterThan(0);
    expect(vecIndex).toBeLessThan(statements.length - 1);
    const db = rawDb();
    try {
      expect(() => runMigrations(db, [], INVALID_VEC_DIM)).toThrow("vec0 constructor error");
      expect(objectCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("다른 연결이 먼저 만들었으면 쓰기 잠금 안에서 다시 세어 두 번 만들지 않는다", () => {
    const file = tempDbFile("runner-race");
    const late = rawDb(file);
    const early = rawDb(file);
    try {
      // late 가 빈 DB 를 본 뒤, early 가 먼저 기준 스키마를 만든다.
      expect(objectCount(late)).toBe(0);
      expect(applyBaselineSchema(early, DIM)).toBe(true);
      expect(applyBaselineSchema(late, DIM)).toBe(false);
      runMigrations(late, [], DIM);
      expect(versions(late)).toEqual([BASELINE_VERSION]);
    } finally {
      late.close();
      early.close();
    }
  });
});

describe("splitSqlStatements — 데이터 fixture", () => {
  const NL = "\n";

  test("따옴표·주석 안의 ; 는 문장을 끝내지 않는다", () => {
    const sql = [
      "-- 머리 주석; 여기서 끝나면 안 된다",
      "CREATE TABLE a (x TEXT DEFAULT 'a;b', \"y;z\" TEXT); /* 주석 ; */",
      "INSERT INTO a (x) VALUES ('it''s;');",
      "",
    ].join(NL);
    expect(splitSqlStatements(sql, "fixture")).toEqual([
      ["-- 머리 주석; 여기서 끝나면 안 된다", "CREATE TABLE a (x TEXT DEFAULT 'a;b', \"y;z\" TEXT);"].join(NL),
      ["/* 주석 ; */", "INSERT INTO a (x) VALUES ('it''s;');"].join(NL),
    ]);
  });

  test("트리거는 본문 안의 ; 가 아니라 ; END ; 에서 끝난다(CASE … END 는 끝이 아니다)", () => {
    const trigger = [
      "CREATE TRIGGER IF NOT EXISTS t_ins AFTER INSERT ON a BEGIN",
      "    UPDATE b SET n = CASE WHEN new.x IS NULL THEN 0 ELSE 1 END;",
      "    DELETE FROM c WHERE id = new.rowid;",
      "END;",
    ].join(NL);
    const temp = "CREATE TEMP TRIGGER t2 AFTER DELETE ON a BEGIN DELETE FROM c; END;";
    expect(splitSqlStatements([trigger, "CREATE TABLE d (y);", temp].join(NL), "fixture")).toEqual([
      trigger,
      "CREATE TABLE d (y);",
      temp,
    ]);
  });

  test("; 로 끝나지 않은 마지막 문장은 출처를 담아 멈춘다", () => {
    const sql = ["CREATE TABLE a (x);", "CREATE TABLE b (y)", "-- 끝"].join(NL);
    expect(() => splitSqlStatements(sql, "99-fixture.sql")).toThrow(
      "99-fixture.sql: 마지막 문장이 ';' 로 끝나지 않았습니다",
    );
  });

  test("기준 스키마 파일 넷이 모두 문장으로 나뉜다", () => {
    for (const file of BASELINE_SCHEMA_FILES) {
      const statements = splitSqlStatements(readFileSync(join(BASELINE_SCHEMA_DIR, file), "utf8"), file);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) expect(statement.endsWith(";")).toBe(true);
    }
  });
});
