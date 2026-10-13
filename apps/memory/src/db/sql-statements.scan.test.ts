/**
 * sql-statements.scan.test.ts — 제품 소스에서 문장 둘 이상이 든 SQL 글을 db.run()/db.exec() 에 직접 넘기지 않는지 감시한다.
 *
 * 규칙(sql-statements.ts 머리): 두 문장 이상이 든 SQL 은 runSqlStatements 로 돌린다. bun:sqlite 의 db.run() 은 여러 문장을
 * 한 번에 받으면 중간 문장의 실행 오류(예: vec0 표 생성 거부)를 던지지 않고 넘어가기 때문이다.
 *
 * 검사 방법: apps/memory/src 와 apps/memory/scripts 의 제품 .ts(시험·시험 도우미·fixture 제외)에서 `.run(` / `.exec(` 바로 뒤에
 * 오는 문자열·템플릿 리터럴을 꺼내, 공용 splitSqlStatements 로 문장 수를 센다. `${…}` 는 자리표시자로 바꾼다.
 *
 * 사각지대(이 감시가 보지 못하는 것):
 *  - SQL 이 변수·상수·문자열 이어 붙이기("a;" + "b")에 담겨 db.run(변수) 로 넘어가는 경우.
 *  - 런타임에 파일에서 읽은 SQL 글(기준 스키마 파일처럼). 그 길은 runSqlStatementList 를 쓰는지 코드 검토로 본다.
 *  - 받는 쪽이 데이터베이스인지는 가리지 않는다 — 정규식 RegExp#exec("a; b") 같은 리터럴도 걸린다(지금 제품 소스엔 없다).
 *  - 시험 파일은 대상이 아니다.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { splitSqlStatements } from "./sql-statements.ts";

/** apps/memory 폴더 — 이 파일은 apps/memory/src/db 에 있다. */
const MEMORY_APP_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "scripts"] as const;
/** 감시하지 않는 파일: 시험, 시험 도우미, fixture, test-utils 폴더. */
const NON_PRODUCT_FILE = /(?:\.test|\.test-helpers|\.fixture)\.ts$|[\\/]test-utils[\\/]/;
/** `.run(` / `.exec(` 바로 뒤에 따옴표 또는 백틱 리터럴이 오는 호출의 시작. */
const CALL_WITH_LITERAL = /\.(?:run|exec)\(\s*(?=[`'"])/g;
/** `${…}` 를 대신하는 자리표시자 — SQL 낱말로 읽혀 문장 경계에 영향을 주지 않는다. */
const INTERPOLATION_PLACEHOLDER = "__EXPR__";
const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

/** source[quoteAt] 의 따옴표로 시작하는 리터럴 본문을 읽는다(이스케이프 풀고 `${…}` 는 자리표시자로). 끝이 없으면 null. */
function readLiteral(source: string, quoteAt: number): string | null {
  const quote = source[quoteAt]!;
  let text = "";
  let i = quoteAt + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      const escaped = source[i + 1] ?? "";
      text += ESCAPES[escaped] ?? escaped;
      i += 2;
    } else if (ch === quote) {
      return text;
    } else if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        i += 1;
      }
      text += INTERPOLATION_PLACEHOLDER;
    } else {
      text += ch;
      i += 1;
    }
  }
  return null;
}

/** 한 소스 글에서 문장 둘 이상을 넘기는 호출을 `label:줄번호 …` 로 돌려준다. 분석하지 못한 리터럴도 숨기지 않고 돌려준다. */
function findMultiStatementCalls(source: string, label: string): string[] {
  const findings: string[] = [];
  for (const match of source.matchAll(CALL_WITH_LITERAL)) {
    const quoteAt = match.index! + match[0].length;
    const line = source.slice(0, quoteAt).split("\n").length;
    const where = `${label}:${line}`;
    const literal = readLiteral(source, quoteAt);
    if (literal === null) {
      findings.push(`${where} 끝나지 않은 리터럴이라 분석하지 못했습니다`);
      continue;
    }
    try {
      // 끝에 "\n;" 를 붙여 ';' 없이 끝나는 단일 문장도 나눌 수 있게 한다(이미 ';' 로 끝나면 빈 문장이라 세지 않는다).
      const count = splitSqlStatements(`${literal}\n;`, where).length;
      if (count > 1) findings.push(`${where} 문장 ${count}개를 한 번에 넘깁니다`);
    } catch (err) {
      findings.push(`${where} 분석하지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}

function productSourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const root = join(MEMORY_APP_ROOT, dir);
    for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (entry.endsWith(".ts") && !NON_PRODUCT_FILE.test(join(root, entry))) files.push(join(root, entry));
    }
  }
  return files;
}

describe("findMultiStatementCalls — 데이터 fixture", () => {
  test("따옴표 리터럴의 두 문장을 잡는다", () => {
    const source = `db.run("CREATE TABLE a (x); CREATE TABLE b (y);");`;
    expect(findMultiStatementCalls(source, "f.ts")).toEqual(["f.ts:1 문장 2개를 한 번에 넘깁니다"]);
  });

  test("템플릿 리터럴(${} 포함, 여러 줄)의 두 문장을 잡고 줄 번호를 돌려준다", () => {
    const source = ["const a = 1;", "this.db.exec(`", "  DROP TABLE ${name};", "  CREATE TABLE ${name} (x)", "`);"].join("\n");
    expect(findMultiStatementCalls(source, "g.ts")).toEqual(["g.ts:2 문장 2개를 한 번에 넘깁니다"]);
  });

  test("이스케이프된 줄바꿈 뒤의 ; 문장도 센다", () => {
    const source = `db.run('PRAGMA foreign_keys = OFF;\\nPRAGMA synchronous = NORMAL');`;
    expect(findMultiStatementCalls(source, "h.ts")).toEqual(["h.ts:1 문장 2개를 한 번에 넘깁니다"]);
  });

  test("문장 하나는 통과시킨다 — 끝의 ;·문자열 안의 ;·바인딩 인자·트리거 본문의 ;", () => {
    const trigger = "db.run(`CREATE TRIGGER t AFTER DELETE ON a BEGIN DELETE FROM b WHERE id = old.id; DELETE FROM c; END`);";
    const source = [
      `db.run("BEGIN IMMEDIATE");`,
      `db.run("CREATE TABLE a (x);");`,
      `db.run("INSERT INTO a (x) VALUES ('a;b')");`,
      "db.run(`VACUUM INTO '${escaped}'`);",
      `db.run("UPDATE a SET x = ? WHERE y = ?", [1, 2]);`,
      `db.run("SELECT 1 -- 끝 주석");`,
      trigger,
    ].join("\n");
    expect(findMultiStatementCalls(source, "i.ts")).toEqual([]);
  });

  test("사각지대: 변수에 담긴 SQL 은 보지 않는다", () => {
    const source = `const sql = "CREATE TABLE a (x); CREATE TABLE b (y);";\ndb.run(sql);`;
    expect(findMultiStatementCalls(source, "j.ts")).toEqual([]);
  });

  test("분석하지 못한 리터럴은 조용히 넘기지 않고 알린다", () => {
    expect(findMultiStatementCalls(`db.run("CREATE TABLE a (x`, "k.ts")).toEqual([
      "k.ts:1 끝나지 않은 리터럴이라 분석하지 못했습니다",
    ]);
  });
});

describe("제품 소스는 문장 둘 이상을 db.run()/db.exec() 에 직접 넘기지 않는다", () => {
  test("apps/memory/src 와 apps/memory/scripts", () => {
    const files = productSourceFiles();
    // 걸음이 비어 있어 통과하는 일을 막는다.
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((file) =>
      findMultiStatementCalls(readFileSync(file, "utf8"), relative(MEMORY_APP_ROOT, file).replaceAll("\\", "/")),
    );
    expect(findings).toEqual([]);
  });
});
