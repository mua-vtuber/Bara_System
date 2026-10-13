/**
 * sql-statements.ts — 문장이 여럿 든 SQL 글을 한 문장씩 나눠 돌리는 공용 도우미.
 *
 * 왜 한 문장씩 돌리는가: bun:sqlite 의 db.run() 에 여러 문장을 한 번에 넘기면, 중간 문장이 실행 단계에서 실패해도(예:
 * sqlite-vec 가 vec0 표 생성을 거부) 오류를 던지지 않고 다음 문장으로 넘어간다 — 문법 오류만 잡힌다. 그러면 표가 빠진
 * DB 가 조용히 성공으로 기록된다. 한 문장씩 돌리면 그 문장의 오류가 그대로 던져져, 호출자의 트랜잭션이 통째로 되돌려진다.
 *
 * 규칙: 두 문장 이상이 든 SQL 글(기준 스키마 파일, v48+ 마이그레이션의 up() 안 SQL, 도구 스크립트의 DDL 묶음)은
 * db.run()/db.exec() 에 직접 넘기지 않고 runSqlStatements 로 돌린다. 문장 하나짜리 db.run() 은 그대로 써도 된다.
 * 이 규칙은 src/db/sql-statements.scan.test.ts 가 소스 글자 수준에서 감시한다.
 */
import type { Database } from "bun:sqlite";

/** 트리거 문장 판별에 쓰는 낱말 — CREATE [TEMP|TEMPORARY] TRIGGER. */
const TRIGGER_KEYWORD = "TRIGGER";
const TEMP_KEYWORDS: ReadonlySet<string> = new Set(["TEMP", "TEMPORARY"]);
const END_KEYWORD = "END";

/** 오류 메시지에 싣는 문장 앞부분의 최대 글자 수. */
const STATEMENT_PREVIEW_LENGTH = 80;

/**
 * SQL 글을 문장 하나씩으로 나눈다. 규칙은 SQLite 의 sqlite3_complete 와 같다: 따옴표('…' "…" `…` […])·주석(-- …, /* … *\/)
 * 밖의 `;` 가 문장을 끝내고, CREATE [TEMP] TRIGGER 문장은 본문 안의 `;` 로 끝나지 않고 `; END ;` 에서 끝난다.
 *
 * 마지막 `;` 뒤에 주석·공백이 아닌 글이 남으면(끝나지 않은 문장) source 를 담아 멈춘다.
 *
 * @param source 오류 메시지에 싣는 출처 이름(파일 이름 등).
 */
export function splitSqlStatements(sql: string, source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let words: string[] = [];
  let isTrigger = false;
  let lastTokens: string[] = [];
  let hasContent = false;
  let i = 0;
  const finish = (end: number): void => {
    if (hasContent) statements.push(sql.slice(start, end).trim());
    start = end;
    words = [];
    isTrigger = false;
    lastTokens = [];
    hasContent = false;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol < 0 ? sql.length : eol + 1;
    } else if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) throw new Error(`${source}: 닫히지 않은 /* 주석이 있습니다.`);
      i = close + 2;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const closer = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        const at = sql.indexOf(closer, j);
        if (at < 0) throw new Error(`${source}: 닫히지 않은 ${ch} 따옴표가 있습니다.`);
        // '' "" `` 는 따옴표 안의 따옴표 하나다.
        if (closer !== "]" && sql[at + 1] === closer) {
          j = at + 2;
          continue;
        }
        i = at + 1;
        break;
      }
      hasContent = true;
      lastTokens = [...lastTokens.slice(-1), "OTHER"];
    } else if (ch === ";") {
      i += 1;
      const triggerEnds = lastTokens.length === 2 && lastTokens[0] === ";" && lastTokens[1] === END_KEYWORD;
      if (!isTrigger || triggerEnds) {
        finish(i);
      } else {
        lastTokens = [...lastTokens.slice(-1), ";"];
      }
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j += 1;
      const word = sql.slice(i, j).toUpperCase();
      i = j;
      hasContent = true;
      if (words.length < 3) {
        words.push(word);
        isTrigger =
          words[0] === "CREATE" &&
          (words[1] === TRIGGER_KEYWORD || (TEMP_KEYWORDS.has(words[1] ?? "") && words[2] === TRIGGER_KEYWORD));
      }
      lastTokens = [...lastTokens.slice(-1), word];
    } else {
      i += 1;
      hasContent = true;
      lastTokens = [...lastTokens.slice(-1), "OTHER"];
    }
  }
  if (hasContent) {
    throw new Error(`${source}: 마지막 문장이 ';' 로 끝나지 않았습니다 — '${sql.slice(start).trim().slice(0, STATEMENT_PREVIEW_LENGTH)}'`);
  }
  return statements;
}

/**
 * 이미 나눈 문장 목록을 차례로 돌린다. 한 문장이 던지면 source 와 그 문장의 순번(1부터)·앞부분을 담은 오류로 바꿔 던지고
 * (원래 오류는 cause), 뒤 문장은 돌리지 않는다. 트랜잭션은 호출자가 잡는다 — 이 함수는 BEGIN/COMMIT 을 하지 않는다.
 */
export function runSqlStatementList(db: Database, statements: readonly string[], source: string): void {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    try {
      db.run(statement);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const preview = statement.replace(/\s+/g, " ").slice(0, STATEMENT_PREVIEW_LENGTH);
      throw new Error(
        `${source} 의 ${index + 1}번째 문장(전체 ${statements.length}개) 실행 실패: ${reason} — '${preview}'`,
        { cause: err },
      );
    }
  }
}

/**
 * SQL 글(문장 여럿 가능)을 한 문장씩 나눠 차례로 돌린다. 첫 실패에서 멈추고 source·문장 순번을 담은 오류를 던진다.
 * 닫히지 않은 따옴표·주석이나 ';' 로 끝나지 않은 마지막 문장은 아무 문장도 돌리기 전에 멈춘다.
 */
export function runSqlStatements(db: Database, sql: string, source: string): void {
  runSqlStatementList(db, splitSqlStatements(sql, source), source);
}
