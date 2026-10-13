/**
 * schema-version-gate.test.ts — schema_version 판정 5행 표(설계 2026-10-02 마이그레이션 압축 4절)를 openMemoryDatabase 로 본다.
 *
 * 멈추는 세 경우(옛·더 새·바라 DB 가 아님)는 오류 문구 전체와, -wal 이 없는 DB 에서는 데이터 폴더(DB 파일·첨부 폴더)가
 * 바이트 하나 바뀌지 않고 사전 스냅샷(pre-migration/)도 생기지 않음을 단언한다. 데이터 폴더 파일 목록에 -wal·-shm 이 남지
 * 않는 것은 멈출 때 연결을 닫았다는 증거이기도 하다(열린 연결이 있으면 SQLite 가 두 사이드파일을 지우지 않는다).
 * -wal 이 남은 DB(옛 서버가 남긴 것)는 연결을 닫을 때 SQLite 가 -wal 을 DB 파일에 합치므로 파일 바이트는 달라질 수 있다 —
 * 그 경우는 모든 표의 행이 같고 integrity_check 가 ok 인지를 단언한다.
 *
 * 옛·더 새 DB 는 기준 DB 를 만든 뒤 schema_version 을 바꾼 데이터다(설계 13절). Mock 0: 실제 bun:sqlite + sqlite-vec,
 * 파일은 OS 임시 폴더.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BASELINE_VERSION } from "./baseline-schema.ts";
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase, runMigrations, type OpenOptions } from "./migrations.ts";
import {
  SchemaVersionTooNewError,
  SchemaVersionTooOldError,
  UnversionedDatabaseError,
  readSchemaState,
} from "./schema-version-gate.ts";
import { EmbeddingDimMismatchError } from "./vec-dimension-guard.ts";
import { removeTempDir } from "./migration-safety.test-helpers.ts";

const DIM = 8;
/** 기준 DB 와 다른 글 벡터 차원 — 옛 DB 를 이 차원으로 열어도 차원 오류가 아니라 버전 오류로 멈추는지 본다. */
const OTHER_DIM = 16;
/** A1 운영 서버가 지금 쓰는 마지막 마이그레이션 번호(설계 2절) — 옛 DB 의 대표값. */
const OLD_VERSION = 42;
const NEWER_VERSION = CURRENT_SCHEMA_VERSION + 1;

/** 옛 기억 보존 안내 — 문구 전체 대조용으로 글자 그대로 적는다(migration-stop-guidance.ts 와 같아야 한다). */
const KEEP_OLD_GUIDANCE =
  "옛 기억을 나중에 되살릴 수 있게 남겨 두려면, DB 파일과 첨부 파일 폴더(설정 키 assets.dir(기본 data/assets) 또는 env BARA_ASSET_DIR)를 " +
  "함께 다른 곳으로 옮긴 뒤 다시 시작하세요. 두 곳에는 같은 짝 표시가 있어, 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈춥니다 — " +
  "DB 만 옮기고 폴더를 그대로 두면 새 DB 의 시작이 멈춥니다.";

/** 세 멈춤 오류의 마지막 문장 — 문구 전체 대조용으로 글자 그대로 적는다(schema-version-gate.ts 의 STOPPED_DATA_UNCHANGED_NOTE 와 같아야 한다). */
const STOPPED_NOTE =
  "표·행·첨부 파일은 지우거나 바꾸지 않았습니다. 다만 DB 파일 옆에 -wal 파일이 남아 있었다면, 연결을 닫을 때 " +
  "SQLite 가 그 내용을 DB 파일에 합치고 -wal·-shm 파일을 지울 수 있습니다(데이터는 같습니다).";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

interface DataDir {
  dir: string;
  file: string;
  backupDir: string;
}

/** 운영 데이터 폴더 모양: DB 파일 자리 + 첨부 폴더(짝 표시·내용 파일 하나). 백업 폴더는 아직 없다. */
function makeDataDir(prefix: string): DataDir {
  const dir = mkdtempSync(join(tmpdir(), `bara-gate-${prefix}-`));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets", "content"), { recursive: true });
  writeFileSync(join(dir, "assets", "content", `${"b".repeat(64)}.png`), "png-bytes");
  writeFileSync(join(dir, "assets", "bara-asset-pairing.json"), JSON.stringify({ pairingId: "gate-test-pairing" }));
  return { dir, file: join(dir, "bara.sqlite"), backupDir: join(dir, "backups") };
}

function openOptions(data: DataDir, embeddingDim = DIM): OpenOptions {
  return { embeddingDim, preMigrationSnapshot: { dir: data.backupDir, appVersion: "0.1.0" } };
}

/** 폴더 아래 모든 파일의 (상대 경로 → sha256). 파일이 생기거나 사라지거나 한 바이트라도 바뀌면 달라진다. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** 기준 DB 를 만든 뒤 schema_version 을 versions 로 바꾼다(행 하나씩). */
function makeBaselineDbWithVersions(file: string, versions: number[]): void {
  openMemoryDatabase(file, { embeddingDim: DIM }).close();
  const db = new Database(file);
  try {
    db.run("DELETE FROM schema_version");
    for (const v of versions) db.query("INSERT INTO schema_version (version) VALUES (?)").run(v);
  } finally {
    db.close();
  }
}

/** 멈춰야 하는 열기를 시도하고, 던진 오류를 돌려준다. 데이터 폴더가 바이트 하나 바뀌지 않았는지도 본다. */
function expectStopWithoutChanges(data: DataDir, embeddingDim = DIM): Error {
  const before = treeDigest(data.dir);
  let caught: unknown;
  try {
    openMemoryDatabase(data.file, openOptions(data, embeddingDim)).close();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(treeDigest(data.dir)).toEqual(before);
  expect(existsSync(data.backupDir)).toBe(false);
  return caught as Error;
}

function versionsOf(file: string): number[] {
  const db = new Database(file, { readonly: true });
  try {
    return (db.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>).map(
      (r) => r.version,
    );
  } finally {
    db.close();
  }
}

describe("판정 5행 표", () => {
  test("1행 — 객체 0(새 파일·:memory:): 기준 스키마를 만들고 BASELINE_VERSION 을 적는다", () => {
    const data = makeDataDir("empty");
    expect(existsSync(data.file)).toBe(false);
    openMemoryDatabase(data.file, openOptions(data)).close();
    expect(versionsOf(data.file)[0]).toBe(BASELINE_VERSION);
    // 새 DB 에는 지킬 데이터가 없어 사전 스냅샷을 뜨지 않는다.
    expect(existsSync(data.backupDir)).toBe(false);

    const memory = openMemoryDatabase(":memory:", { embeddingDim: DIM });
    try {
      expect(readSchemaState(memory)).toMatchObject({ kind: "versioned", version: CURRENT_SCHEMA_VERSION });
    } finally {
      memory.close();
    }
  });

  test("2행 — BASELINE_VERSION ≤ v ≤ 아는 최고: 그대로 열고 대기 마이그레이션만 돌린다", () => {
    const data = makeDataDir("current");
    openMemoryDatabase(data.file, openOptions(data)).close();
    const versionsBefore = versionsOf(data.file);
    const db = openMemoryDatabase(data.file, openOptions(data));
    try {
      expect(readSchemaState(db)).toMatchObject({ kind: "versioned", version: CURRENT_SCHEMA_VERSION });
    } finally {
      db.close();
    }
    expect(versionsOf(data.file)).toEqual(versionsBefore);
    expect(existsSync(data.backupDir)).toBe(false);
  });

  test("3행 — v < BASELINE_VERSION(A1 의 v42): SchemaVersionTooOldError, 차원 검사·사전 스냅샷보다 먼저, 파일 불변", () => {
    const data = makeDataDir("old");
    makeBaselineDbWithVersions(data.file, Array.from({ length: OLD_VERSION }, (_, i) => i + 1));
    // 기준 DB 와 다른 차원으로 열어도 차원 오류가 아니라 버전 오류다(옛 DB 를 "모델을 바꾸라"로 잘못 안내하지 않는다).
    const err = expectStopWithoutChanges(data, OTHER_DIM);
    expect(err).toBeInstanceOf(SchemaVersionTooOldError);
    expect(err).not.toBeInstanceOf(EmbeddingDimMismatchError);
    expect(err.message).toBe(
      `메모리 DB 를 열지 않고 멈췄습니다: 이 DB 는 새로 시작하기 전 버전(schema_version v42)으로 만들어졌고, ` +
        `이 버전은 기준 스키마 v47 이후의 DB 만 엽니다. 옛 DB 를 변환하거나 내용을 추측해 옮기지 않습니다. ` +
        `DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH 가 가리키며, 지금 연 파일은 '${data.file}' 입니다. ` +
        `이 파일을 같은 이름의 -wal·-shm 파일과 함께 다른 곳으로 옮긴 뒤 다시 시작하면 빈 DB 가 새로 만들어집니다` +
        `(이전 버전의 설정 페이지 '데이터 초기화'는 schema_version 을 그대로 두므로 이 멈춤을 풀지 못합니다). ` +
        `${KEEP_OLD_GUIDANCE} ${STOPPED_NOTE}`,
    );
    const typed = err as SchemaVersionTooOldError;
    expect({ found: typed.foundVersion, file: typed.databaseFile }).toEqual({ found: OLD_VERSION, file: data.file });
    // runMigrations 를 원시 연결에 바로 불러도 같은 판정으로 멈춘다.
    const raw = new Database(data.file);
    sqliteVec.load(raw);
    try {
      expect(() => runMigrations(raw, [], DIM)).toThrow(SchemaVersionTooOldError);
    } finally {
      raw.close();
    }
  });

  test("4행 — v > 아는 최고: SchemaVersionTooNewError, 파일 불변", () => {
    const data = makeDataDir("newer");
    makeBaselineDbWithVersions(data.file, [BASELINE_VERSION, NEWER_VERSION]);
    const err = expectStopWithoutChanges(data);
    expect(err).toBeInstanceOf(SchemaVersionTooNewError);
    expect(err.message).toBe(
      `메모리 DB 를 열지 않고 멈췄습니다: 이 DB 는 더 새 버전의 바라가 만든 것입니다` +
        `(schema_version v${NEWER_VERSION}, 이 버전이 아는 최고 v${CURRENT_SCHEMA_VERSION}). ` +
        `모르는 표 구조에 쓰면 데이터가 상할 수 있습니다. 그 DB 를 만든 버전으로 실행하거나, ` +
        `그 버전으로 올리기 직전에 서버가 떠 둔 스냅샷(설정 키 backup.dir 아래 pre-migration/)으로 되돌리세요. ` +
        `DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH 가 가리키며, 지금 연 파일은 '${data.file}' 입니다. ` +
        STOPPED_NOTE,
    );
    const typed = err as SchemaVersionTooNewError;
    expect({ found: typed.foundVersion, knownMax: typed.knownMaxVersion }).toEqual({
      found: NEWER_VERSION,
      knownMax: CURRENT_SCHEMA_VERSION,
    });
  });

  test("5행 — 객체가 있는데 schema_version 이 없음(다른 프로그램의 파일): UnversionedDatabaseError, 파일 불변", () => {
    const data = makeDataDir("foreign");
    // 다른 프로그램이 만든 보통 SQLite 파일 — rollback journal 모드 그대로다(WAL 로 바꾸면 파일 머리가 바뀐다).
    const foreign = new Database(data.file);
    foreign.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    foreign.query("INSERT INTO notes (body) VALUES (?)").run("다른 앱의 기록");
    foreign.close();
    const err = expectStopWithoutChanges(data);
    expect(err).toBeInstanceOf(UnversionedDatabaseError);
    expect(err.message).toBe(
      `메모리 DB 를 열지 않고 멈췄습니다: '${data.file}' 에는 표·색인 등 1개가 있지만 ` +
        `schema_version 기록이 없어 바라 메모리 DB 로 볼 수 없습니다(다른 프로그램의 파일이거나 손으로 만든 파일). ` +
        `이 파일에 바라 표를 덧붙이지 않습니다. 설정 키 db.path 또는 env MEMORY_DB_PATH 가 바라용 DB 파일` +
        `(또는 아직 없는 새 경로)을 가리키는지 확인하세요. ${STOPPED_NOTE}`,
    );
    expect((err as UnversionedDatabaseError).objectCount).toBe(1);
  });

  test("5행 — schema_version 표는 있지만 행이 없는 DB 도 바라 DB 로 보지 않는다", () => {
    const data = makeDataDir("no-rows");
    makeBaselineDbWithVersions(data.file, []);
    const err = expectStopWithoutChanges(data);
    expect(err).toBeInstanceOf(UnversionedDatabaseError);
    const counted = new Database(data.file, { readonly: true });
    try {
      const objectCount = (counted.query("SELECT COUNT(*) AS c FROM sqlite_master").get() as { c: number }).c;
      expect((err as UnversionedDatabaseError).objectCount).toBe(objectCount);
      expect(err.message).toContain(`'${data.file}' 에는 표·색인 등 ${objectCount}개가 있지만 schema_version 기록이 없어`);
    } finally {
      counted.close();
    }
  });
});

/** 표 하나의 행 수와 행 내용 sha256. */
interface TableDigest {
  rows: number;
  sha256: string;
}

/**
 * 질의 하나를 돌리고 바로 마무리(finalize)한다. 모든 표를 db.query() 로 하나씩 읽은 연결은 close() 를 불러도 실제로 닫히지
 * 않는 것을 관측했다(-wal 이 합쳐지지 않고 임시 폴더도 지워지지 않는다). 이 파일의 읽기 확인은 모두 이 함수로 한다.
 */
function allRows(db: Database, sql: string): Array<Record<string, unknown>> {
  const statement = db.prepare(sql);
  try {
    return statement.all() as Array<Record<string, unknown>>;
  } finally {
    statement.finalize();
  }
}

/**
 * 모든 일반 표의 행 내용 해시(표 이름 → 해시). 가상 표(vec0·FTS)는 데이터가 그림자 표에 있어 그림자 표로 본다.
 * BLOB 은 16진수로 적고 행 문자열을 정렬해 읽는 순서와 무관하게 한다. 파일 바이트가 아니라 내용을 견주는 용도다.
 */
function contentDigest(db: Database): Record<string, TableDigest> {
  const tables = allRows(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
  ) as Array<{ name: string }>;
  const out: Record<string, TableDigest> = {};
  for (const { name } of tables) {
    const rows = allRows(db, `SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .map((row) =>
        JSON.stringify(row, (_key, value) => {
          if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
          return typeof value === "bigint" ? value.toString() : value;
        }),
      )
      .sort();
    out[name] = { rows: rows.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
  }
  return out;
}

interface StrandedWal {
  /** 복사 직전 쓰던 연결이 본 표 내용 — -wal 에만 있는 쓰기까지 포함한다. */
  before: Record<string, TableDigest>;
  /** 복사해 둔 -wal 의 크기(바이트). */
  walBytes: number;
}

/**
 * 옛 서버가 남긴 모습을 만든다: DB 파일 옆에 내용이 든 -wal 이 있고 열린 연결은 없다. 연결을 모두 닫으면 SQLite 가 -wal 을
 * DB 파일에 합치고 지우므로, 쓰던 연결을 연 채로 DB 파일과 -wal 을 데이터 폴더로 복사한다(전원이 꺼진 뒤 남는 파일 모습).
 * 자동 합치기를 꺼서 아래 쓰기(schema_version 교체, 정규식 강조어 한 행)가 -wal 에만 있다.
 */
function makeStrandedWalDb(data: DataDir, versions: number[]): StrandedWal {
  const scratch = mkdtempSync(join(tmpdir(), "bara-gate-wal-src-"));
  tempDirs.push(scratch);
  const source = join(scratch, "bara.sqlite");
  const live = openMemoryDatabase(source, { embeddingDim: DIM });
  try {
    live.run("PRAGMA wal_autocheckpoint = 0");
    live.run("DELETE FROM schema_version");
    for (const v of versions) live.query("INSERT INTO schema_version (version) VALUES (?)").run(v);
    live
      .query("INSERT INTO regex_user_boosters (booster_id, word, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("rbst_user_gate_wal", "남은 단어", 2, "2026-10-02 00:00:00", "2026-10-02 00:00:00");
    copyFileSync(source, data.file);
    copyFileSync(`${source}-wal`, `${data.file}-wal`);
    return { before: contentDigest(live), walBytes: statSync(`${data.file}-wal`).size };
  } finally {
    live.close();
  }
}

const WAL_STOP_CASES = [
  {
    label: "옛 버전(A1 의 v42)",
    versions: Array.from({ length: OLD_VERSION }, (_, i) => i + 1),
    error: SchemaVersionTooOldError,
  },
  { label: "더 새 버전", versions: [BASELINE_VERSION, NEWER_VERSION], error: SchemaVersionTooNewError },
];

describe("멈출 때 -wal 이 남은 DB — 파일 바이트는 달라질 수 있어도 표·행은 그대로다", () => {
  for (const { label, versions, error } of WAL_STOP_CASES) {
    test(`${label}: 멈추고, 모든 표의 행이 같고, integrity_check 가 ok 다`, () => {
      const data = makeDataDir("wal");
      const stranded = makeStrandedWalDb(data, versions);
      // 전제: DB 파일 옆에 내용이 든 -wal 이 있고 -shm 은 없다(열린 연결 없음). 이 전제가 깨지면 아래 단언이 의미를 잃는다.
      expect(stranded.walBytes).toBeGreaterThan(0);
      expect(existsSync(`${data.file}-shm`)).toBe(false);
      expect(stranded.before.schema_version?.rows).toBe(versions.length);
      expect(stranded.before.regex_user_boosters?.rows).toBe(1);
      const assetsBefore = treeDigest(join(data.dir, "assets"));

      let caught: unknown;
      try {
        openMemoryDatabase(data.file, openOptions(data)).close();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(error);
      expect((caught as Error).message).toContain(STOPPED_NOTE);
      expect(existsSync(data.backupDir)).toBe(false);
      expect(treeDigest(join(data.dir, "assets"))).toEqual(assetsBefore);

      const after = new Database(data.file, { readonly: true });
      sqliteVec.load(after);
      try {
        expect(contentDigest(after)).toEqual(stranded.before);
        expect(allRows(after, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        after.close();
      }
    });
  }
});
