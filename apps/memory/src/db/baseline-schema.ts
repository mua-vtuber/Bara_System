/**
 * baseline-schema.ts — 기준 스키마 v47 을 빈 DB 에 한 트랜잭션으로 만든다(설계 2026-10-02 마이그레이션 압축 3절).
 *
 * 기준 스키마 = 압축 직전 코드가 빈 DB 에 만들던 모양 그대로(표·가상 표·색인·트리거 248개 + memory_visibility_state
 * 시작 행 1개)다. 옛 v1~v47 업그레이드 경로는 없어졌다 — 이 스키마는 객체가 하나도 없는 DB 에만 쓰이고, 그보다 오래된
 * DB 는 schema-version-gate.ts 가 멈춘다. SQL 은 schema/ 아래 네 파일에 있고 동결이다: 네 파일을 LF 로 맞춰 이은 내용의
 * sha256 이 src/test-utils/schema-snapshot.txt 머리에 적혀 있어, 파일을 고치면 스냅샷 시험이 실패한다. 스키마를 바꿀
 * 때는 migrations.ts 의 MIGRATIONS 에 v48+ 마이그레이션을 더한다.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSqlStatementList, splitSqlStatements } from "./sql-statements.ts";
import { DEFAULT_EMBEDDING_DIM } from "./vec-dimension-guard.ts";

/** 기준 스키마 번호. 빈 DB 는 schema_version 이 이 번호 한 행으로 시작하고, 이보다 낮은 번호의 DB 는 열지 않는다. */
export const BASELINE_VERSION = 47;

/** 기준 스키마 SQL 파일 폴더. */
export const BASELINE_SCHEMA_DIR = join(import.meta.dir, "schema");

/** 기준 스키마 SQL 파일 — 이 순서대로 적용한다(적용 순서는 이 목록 한 곳에만 적는다). */
export const BASELINE_SCHEMA_FILES = [
  "01-memory-nodes.sql",
  "02-concepts-persons.sql",
  "03-entities-vocab.sql",
  "04-assets-cleanup.sql",
] as const;

/** SQL 파일이 적어 둔 글 벡터 차원 리터럴. 적용할 때 요청 차원으로 바꾼다(SigLIP 768 표는 이 리터럴이 아니라 그대로). */
const BASELINE_TEXT_VECTOR_LITERAL = `float[${DEFAULT_EMBEDDING_DIM}]`;

/** SQL 파일 하나와 그 파일의 문장들(파일 안 순서 그대로). */
interface BaselineFileStatements {
  /** 오류 메시지에 싣는 출처 이름. */
  source: string;
  statements: readonly string[];
}

/**
 * 네 파일의 문장(순서 = BASELINE_SCHEMA_FILES). 모듈을 불러올 때 한 번 읽고 나눈다 — 파일이 없으면 그 경로를 담은
 * ENOENT 로, 문장 경계가 깨졌으면 파일 이름을 담은 오류로 멈춘다. 나누기는 sql-statements.ts 의 공용 도우미가 한다.
 */
const BASELINE_SCHEMA_STATEMENTS: readonly BaselineFileStatements[] = BASELINE_SCHEMA_FILES.map((file) => {
  const source = `기준 스키마 ${file}`;
  return { source, statements: splitSqlStatements(readFileSync(join(BASELINE_SCHEMA_DIR, file), "utf8"), source) };
});

/**
 * work 를 BEGIN IMMEDIATE … COMMIT 안에서 돌린다. work 나 COMMIT 이 던지면 ROLLBACK 하고 그 오류를 다시 던진다.
 *
 * bun:sqlite 의 db.transaction() 대신 쓰는 이유: db.transaction() 이 연결에 남기는 내부 문장 때문에 그 연결은 db.close()
 * 뒤에도(가비지 수거 뒤에도) 실제로 닫히지 않아 DB 파일 핸들과 -wal·-shm 을 계속 쥔다. openMemoryDatabase 는 멈출 때
 * 연결을 닫아 파일을 놓아야 하므로(설계 4절), 여는 길의 두 트랜잭션(기준 스키마 적용·대기 마이그레이션)은 문장을 남기지
 * 않는 db.run 으로 시작하고 끝낸다. 이미 트랜잭션 안이면 BEGIN 이 SQLite 오류로 멈춘다(중첩하지 않는다).
 */
export function runImmediateTransaction<T>(db: Database, work: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.run("COMMIT");
    return result;
  } catch (err) {
    // SQLite 가 오류와 함께 트랜잭션을 이미 끝냈으면(예: 디스크 가득 참) 되돌릴 것이 없다.
    if (db.inTransaction) db.run("ROLLBACK");
    throw err;
  }
}

/** sqlite_master 의 객체 수(표·색인·트리거·뷰, SQLite 내부 객체 포함). 0 이면 아무것도 없는 새 DB 다. */
export function countSchemaObjects(db: Database): number {
  return (db.query("SELECT COUNT(*) AS c FROM sqlite_master").get() as { c: number }).c;
}

/**
 * 객체가 하나도 없는 DB 에 기준 스키마를 만들고 schema_version 에 BASELINE_VERSION 한 행을 적는다. 만들었으면 true.
 *
 * IMMEDIATE 트랜잭션 안에서 객체 수를 다시 센다: 같은 파일을 연 다른 연결이 먼저 만들었으면(0 이 아니면) 아무것도 하지
 * 않고 false 를 돌려주고, 호출자가 버전 판정을 다시 한다. 네 파일의 문장을 한 문장씩 돌리고 버전 기록까지 한 트랜잭션이라,
 * 중간 문장이 실패하면 그 오류가 던져지고 fts5·vec0 가상 표까지 모두 되돌려져 객체 0 인 DB 가 남는다(반쯤 만든 DB 가
 * 남지 않는다).
 *
 * @param embeddingDim 글 모델 vec0 표 6개의 차원. SQL 파일의 `float[1024]` 를 이 값으로 바꾼다.
 */
export function applyBaselineSchema(db: Database, embeddingDim: number): boolean {
  return runImmediateTransaction(db, (): boolean => {
    if (countSchemaObjects(db) !== 0) return false;
    const requestedLiteral = `float[${embeddingDim}]`;
    for (const { source, statements } of BASELINE_SCHEMA_STATEMENTS) {
      runSqlStatementList(
        db,
        statements.map((statement) => statement.replaceAll(BASELINE_TEXT_VECTOR_LITERAL, requestedLiteral)),
        source,
      );
    }
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(BASELINE_VERSION);
    return true;
  });
}
