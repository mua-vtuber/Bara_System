/**
 * schema-snapshot.test.ts — 빈 DB 스키마 스냅샷 대조(설계 2026-10-02 마이그레이션 압축 6절).
 *
 * 지금 코드가 빈 DB 를 열 때 만드는 모양(표·가상 표·색인·트리거·뷰 + 시작 행)을
 * test-utils/schema-snapshot.txt 와 글자까지 대조한다. 스키마가 우연히 바뀌면(객체가 빠지거나
 * 더해지거나 정의가 달라지면) 그 객체 이름과 쓰기 명령을 담아 실패한다. 시험은 파일을 스스로
 * 쓰지 않는다 — 다시 쓰기는 scripts/write-schema-snapshot.ts 만 한다.
 *
 * normalizeDdl 단위 시험은 옛 schema-equivalence.test.ts 에서 옮겼다.
 *
 * Mock 0: 실제 openMemoryDatabase(:memory:)·실제 sqlite-vec. 운영 DB 미접촉.
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_VERSION } from "./baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION } from "./migrations.ts";
import { DEFAULT_EMBEDDING_DIM, TEXT_MODEL_VEC_TABLES } from "./vec-dimension-guard.ts";
import {
  SCHEMA_SNAPSHOT_HEADER_KEYS,
  SCHEMA_SNAPSHOT_WRITE_COMMAND,
  baselineSchemaSha256,
  diffSnapshotBodies,
  formatSnapshotMismatch,
  normalizeDdl,
  openSnapshotSourceDatabase,
  readSchemaSnapshotFile,
  renderSchemaSnapshotBody,
} from "../test-utils/schema-snapshot.ts";

// 옛 글 임베딩 모델 차원 — 차원 치환이 글 모델 vec 표에만 닿는지 보는 데 쓴다(다른 시험들의 legacy 384 와 같은 값).
const LEGACY_TEXT_EMBEDDING_DIM = 384;

function renderFreshBody(embeddingDim?: number): string {
  const db = openSnapshotSourceDatabase(embeddingDim);
  try {
    return renderSchemaSnapshotBody(db);
  } finally {
    db.close();
  }
}

describe("스키마 스냅샷 파일 대조", () => {
  test("(1) 지금 코드의 빈 DB 몸통이 스냅샷 파일과 글자까지 같다", () => {
    const { body: fileBody } = readSchemaSnapshotFile();
    const actual = renderFreshBody();
    if (actual !== fileBody) {
      throw new Error(formatSnapshotMismatch(diffSnapshotBodies(fileBody, actual)));
    }
    expect(actual).toBe(fileBody);
  });

  test("(2) 스냅샷 파일이 없으면 만들지 않고 쓰기 명령을 담아 실패한다", () => {
    const missing = join(tmpdir(), `bara-schema-snapshot-missing-${crypto.randomUUID()}`, "schema-snapshot.txt");
    expect(() => readSchemaSnapshotFile(missing)).toThrow(SCHEMA_SNAPSHOT_WRITE_COMMAND);
    expect(existsSync(missing)).toBe(false);
  });

  test("(3) 머리의 baseline-sql-sha256 이 지금 기준 스키마 SQL 파일의 지문과 같다(기준 스키마 동결)", () => {
    // 기준 스키마 SQL 을 고치면 여기서 실패한다 — 스키마는 v48+ 마이그레이션으로 바꾼다.
    const { header } = readSchemaSnapshotFile();
    expect(header.get(SCHEMA_SNAPSHOT_HEADER_KEYS.baselineSqlSha256)).toBe(baselineSchemaSha256());
  });

  test("(4) 머리 버전이 코드 상수와 같다", () => {
    const { header } = readSchemaSnapshotFile();
    expect({
      baseline: header.get(SCHEMA_SNAPSHOT_HEADER_KEYS.baselineVersion),
      current: header.get(SCHEMA_SNAPSHOT_HEADER_KEYS.currentVersion),
    }).toEqual({ baseline: String(BASELINE_VERSION), current: String(CURRENT_SCHEMA_VERSION) });
  });

  test("(5) 384차원 몸통은 글 모델 vec 표 6줄만 다르다", () => {
    const base = renderFreshBody(DEFAULT_EMBEDDING_DIM);
    const legacy = renderFreshBody(LEGACY_TEXT_EMBEDDING_DIM);
    const diff = diffSnapshotBodies(base, legacy);
    const expectedChanged = TEXT_MODEL_VEC_TABLES.map((name) => `virtual-table ${name}`).sort();
    expect(diff).toEqual({ added: [], removed: [], changed: expectedChanged, rowsAdded: [], rowsRemoved: [] });
    // 다른 6줄은 차원 숫자만 다르다: 384 줄의 float[384] 를 기본 차원으로 되돌리면 기본 몸통과 같다.
    const restored = legacy.replaceAll(
      `float[${LEGACY_TEXT_EMBEDDING_DIM}]`,
      `float[${DEFAULT_EMBEDDING_DIM}]`,
    );
    expect(restored).toBe(base);
  });
});

describe("스냅샷 대조 실패 문구", () => {
  // 스키마와 무관한 몸통 글 fixture — 실제 스키마 객체가 바뀌어도 이 시험은 비교·문구 규칙만 본다.
  const body = (objectLines: string[], rowLines: string[]): string =>
    ["[objects]", ...objectLines, "", "[rows]", ...rowLines].join("\n") + "\n";

  test("빠진·더해진·바뀐 객체와 시작 행을 이름으로 짚고 쓰기 명령을 담는다", () => {
    const expected = body(
      ["table\tt\tCREATE TABLE t(a INTEGER)", "index\tidx_t_a\tCREATE INDEX idx_t_a ON t(a)"],
      ['t\t{"a":1}'],
    );
    const actual = body(
      ["table\tt\tCREATE TABLE t(a INTEGER,b TEXT)", "index\tidx_t_b\tCREATE INDEX idx_t_b ON t(b)"],
      ['t\t{"a":2}'],
    );
    const diff = diffSnapshotBodies(expected, actual);
    expect(diff).toEqual({
      added: ["index idx_t_b"],
      removed: ["index idx_t_a"],
      changed: ["table t"],
      rowsAdded: ['t {"a":2}'],
      rowsRemoved: ['t {"a":1}'],
    });
    const message = formatSnapshotMismatch(diff);
    for (const part of ["index idx_t_a", "index idx_t_b", "table t", SCHEMA_SNAPSHOT_WRITE_COMMAND]) {
      expect(message).toContain(part);
    }
  });

  test("이름 차이 없이 줄 순서만 달라도 실패 문구가 그 사실을 말한다", () => {
    const a = body(["index\tidx_a\tCREATE INDEX idx_a ON t(a)", "index\tidx_b\tCREATE INDEX idx_b ON t(b)"], []);
    const b = body(["index\tidx_b\tCREATE INDEX idx_b ON t(b)", "index\tidx_a\tCREATE INDEX idx_a ON t(a)"], []);
    expect(a).not.toBe(b);
    expect(formatSnapshotMismatch(diffSnapshotBodies(a, b))).toContain("줄 순서나 형식이 다릅니다");
  });
});

describe("normalizeDdl — 데이터 fixture", () => {
  test("같은 DDL 의 들여쓰기·줄바꿈 차이는 동일 판정", () => {
    const a = `CREATE TRIGGER x_fts_delete AFTER DELETE ON x BEGIN
    DELETE FROM x_fts WHERE rowid = old.rowid;
END`;
    const b = `CREATE TRIGGER x_fts_delete AFTER DELETE ON x BEGIN
        DELETE FROM x_fts WHERE rowid = old.rowid; END`;
    expect(normalizeDdl(a)).toBe(normalizeDdl(b));
  });

  test("같은 DDL 의 인라인 주석 차이는 동일 판정", () => {
    const withComment = `CREATE TABLE t (
      id TEXT PRIMARY KEY,             -- 'p_' + uuid
      name TEXT NOT NULL               -- canonical
    )`;
    const withoutComment = `CREATE TABLE t (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )`;
    expect(normalizeDdl(withComment)).toBe(normalizeDdl(withoutComment));
  });

  test("CRLF 줄의 인라인 주석 제거는 LF 등가물과 동일 판정 (Windows 체크아웃 회귀)", () => {
    // CRLF 정규화가 없으면 split("\n") 뒤 각 줄 끝에 \r 이 남아 /--.*$/ 의 `$` 가 밀려
    // 인라인 주석이 안 지워지고, 같은 테이블이 LF 체크아웃과 다르게 정규화돼 가짜 drift 가 났다.
    const crlf = "CREATE TABLE t (a TEXT, -- c\r\n b TEXT)";
    const lf = "CREATE TABLE t (a TEXT, -- c\n b TEXT)";
    expect(normalizeDdl(crlf)).toBe(normalizeDdl(lf));
    const noComment = "CREATE TABLE t (a TEXT, b TEXT)";
    expect(normalizeDdl(crlf)).toBe(normalizeDdl(noComment));
  });

  test("같은 DDL 의 괄호·콤마 둘레 공백 차이는 동일 판정", () => {
    const a = `CREATE TABLE t ( a TEXT , b TEXT )`;
    const b = `CREATE TABLE t(a TEXT,b TEXT)`;
    expect(normalizeDdl(a)).toBe(normalizeDdl(b));
  });

  test("식별자 따옴표 차이는 동일 판정 (RENAME TO 부작용 흡수)", () => {
    // 테이블 재작성 마이그레이션의 RENAME TO 가 sqlite_master 에 따옴표를 붙이는 양식. 같은 테이블이다.
    const renamed = `CREATE TABLE "works" (work_id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
    const plain = `CREATE TABLE works (work_id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
    expect(normalizeDdl(renamed)).toBe(normalizeDdl(plain));
  });

  test("따옴표 제거가 칸 정의를 뭉개지 않는다 (의미 보존)", () => {
    const a = `CREATE TABLE "t" (a TEXT)`;
    const b = `CREATE TABLE "t" (a TEXT, b TEXT)`;
    expect(normalizeDdl(a)).not.toBe(normalizeDdl(b));
  });

  test("칸 추가는 다름 판정 (가짜 표준화로 뭉개지 않음)", () => {
    const a = `CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT)`;
    const b = `CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, extra TEXT)`;
    expect(normalizeDdl(a)).not.toBe(normalizeDdl(b));
  });

  test("UNIQUE 제약 추가는 다름 판정", () => {
    const a = `CREATE TABLE t (name TEXT NOT NULL)`;
    const b = `CREATE TABLE t (name TEXT UNIQUE NOT NULL)`;
    expect(normalizeDdl(a)).not.toBe(normalizeDdl(b));
  });

  test("트리거 본문 차이는 다름 판정 (FTS 합성 칸 누락)", () => {
    const a = `CREATE TRIGGER t AFTER INSERT ON x BEGIN
      INSERT INTO x_fts(rowid, text) VALUES (new.rowid, new.name || ' ' || new.ko_name);
    END`;
    const b = `CREATE TRIGGER t AFTER INSERT ON x BEGIN
      INSERT INTO x_fts(rowid, text) VALUES (new.rowid, new.name);
    END`;
    expect(normalizeDdl(a)).not.toBe(normalizeDdl(b));
  });

  test("칸 형 차이는 다름 판정 (INTEGER vs TEXT)", () => {
    const a = `CREATE TABLE e (created_at INTEGER NOT NULL)`;
    const b = `CREATE TABLE e (created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))`;
    expect(normalizeDdl(a)).not.toBe(normalizeDdl(b));
  });
});
