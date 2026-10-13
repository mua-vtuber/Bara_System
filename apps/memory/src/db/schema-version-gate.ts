/**
 * schema-version-gate.ts — 메모리 DB 를 열 때 schema_version 으로 "열어도 되는 DB 인가"를 가른다(설계 2026-10-02
 * 마이그레이션 압축 4절).
 *
 * | DB 상태 (sqlite_master 객체 수, schema_version MAX)   | 판정                                             |
 * | 객체 0 (새 파일, :memory:)                            | empty — 호출자가 기준 스키마를 만든다             |
 * | BASELINE_VERSION <= v <= 코드가 아는 최고             | versioned — 호출자가 대기 마이그레이션만 돌린다   |
 * | v < BASELINE_VERSION                                  | SchemaVersionTooOldError                          |
 * | v > 코드가 아는 최고                                  | SchemaVersionTooNewError                          |
 * | 객체가 있는데 schema_version 표나 행이 없음           | UnversionedDatabaseError                          |
 *
 * 판정은 읽기만 한다 — 멈출 때 표·행을 쓰지 않는다. 다만 DB 옆에 -wal 이 남아 있으면 멈추며 연결을 닫을 때 SQLite 가
 * 그 내용을 DB 파일에 합치고 -wal·-shm 을 지울 수 있다(데이터는 같고 파일 바이트만 달라진다). openMemoryDatabase 가
 * 차원 검사·사전 스냅샷보다 먼저 부른다: 옛 DB 가 "임베딩 모델을 바꾸라"는 차원 오류로 잘못 안내되지 않게, 재시작이
 * 반복될 때 스냅샷 파일이 쌓이지 않게. 옛 DB 를 변환하거나 내용을 추측해 옮기지 않는다(새로 시작 결정).
 */
import type { Database } from "bun:sqlite";
import { BASELINE_VERSION, countSchemaObjects } from "./baseline-schema.ts";
import { KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE } from "./migration-stop-guidance.ts";

/**
 * 세 멈춤 오류가 공유하는 마지막 문장. 표·행·첨부 파일은 건드리지 않지만, DB 옆에 -wal 이 남아 있으면(옛 서버가 남긴 것)
 * 연결을 닫을 때 SQLite 가 그 내용을 DB 파일에 합치고 -wal·-shm 을 지우므로 "파일이 그대로"라고는 적지 않는다.
 */
const STOPPED_DATA_UNCHANGED_NOTE =
  "표·행·첨부 파일은 지우거나 바꾸지 않았습니다. 다만 DB 파일 옆에 -wal 파일이 남아 있었다면, 연결을 닫을 때 " +
  "SQLite 가 그 내용을 DB 파일에 합치고 -wal·-shm 파일을 지울 수 있습니다(데이터는 같습니다).";

/** 판정 결과. versioned 의 version 은 schema_version 의 MAX(version). */
export type SchemaState =
  | { readonly kind: "empty" }
  | { readonly kind: "versioned"; readonly version: number; readonly objectCount: number }
  | { readonly kind: "unversioned"; readonly objectCount: number };

/** 열어도 되는 상태 — 새 DB 이거나, 기준 스키마 이후 이 코드가 아는 버전까지의 DB. */
export type SupportedSchemaState = Exclude<SchemaState, { kind: "unversioned" }>;

/** 이 DB 는 기준 스키마(새로 시작) 이전 버전으로 만들어졌다. */
export class SchemaVersionTooOldError extends Error {
  constructor(
    readonly foundVersion: number,
    readonly databaseFile: string,
  ) {
    super(
      `메모리 DB 를 열지 않고 멈췄습니다: 이 DB 는 새로 시작하기 전 버전(schema_version v${foundVersion})으로 만들어졌고, ` +
        `이 버전은 기준 스키마 v${BASELINE_VERSION} 이후의 DB 만 엽니다. 옛 DB 를 변환하거나 내용을 추측해 옮기지 않습니다. ` +
        `DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH 가 가리키며, 지금 연 파일은 '${databaseFile}' 입니다. ` +
        `이 파일을 같은 이름의 -wal·-shm 파일과 함께 다른 곳으로 옮긴 뒤 다시 시작하면 빈 DB 가 새로 만들어집니다` +
        `(이전 버전의 설정 페이지 '데이터 초기화'는 schema_version 을 그대로 두므로 이 멈춤을 풀지 못합니다). ` +
        `${KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE} ${STOPPED_DATA_UNCHANGED_NOTE}`,
    );
    this.name = "SchemaVersionTooOldError";
  }
}

/** 이 DB 는 이 코드가 아는 최고 버전보다 새 버전의 바라가 만들었다. */
export class SchemaVersionTooNewError extends Error {
  constructor(
    readonly foundVersion: number,
    readonly knownMaxVersion: number,
    readonly databaseFile: string,
  ) {
    super(
      `메모리 DB 를 열지 않고 멈췄습니다: 이 DB 는 더 새 버전의 바라가 만든 것입니다` +
        `(schema_version v${foundVersion}, 이 버전이 아는 최고 v${knownMaxVersion}). ` +
        `모르는 표 구조에 쓰면 데이터가 상할 수 있습니다. 그 DB 를 만든 버전으로 실행하거나, ` +
        `그 버전으로 올리기 직전에 서버가 떠 둔 스냅샷(설정 키 backup.dir 아래 pre-migration/)으로 되돌리세요. ` +
        `DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH 가 가리키며, 지금 연 파일은 '${databaseFile}' 입니다. ` +
        STOPPED_DATA_UNCHANGED_NOTE,
    );
    this.name = "SchemaVersionTooNewError";
  }
}

/** 객체가 있지만 schema_version 기록이 없어 바라 메모리 DB 로 볼 수 없다. */
export class UnversionedDatabaseError extends Error {
  constructor(
    readonly objectCount: number,
    readonly databaseFile: string,
  ) {
    super(
      `메모리 DB 를 열지 않고 멈췄습니다: '${databaseFile}' 에는 표·색인 등 ${objectCount}개가 있지만 ` +
        `schema_version 기록이 없어 바라 메모리 DB 로 볼 수 없습니다(다른 프로그램의 파일이거나 손으로 만든 파일). ` +
        `이 파일에 바라 표를 덧붙이지 않습니다. 설정 키 db.path 또는 env MEMORY_DB_PATH 가 바라용 DB 파일` +
        `(또는 아직 없는 새 경로)을 가리키는지 확인하세요. ${STOPPED_DATA_UNCHANGED_NOTE}`,
    );
    this.name = "UnversionedDatabaseError";
  }
}

/** 지금 연 DB 파일 경로(PRAGMA database_list 의 main). 메모리 DB 는 ':memory:'. */
export function mainDatabaseFile(db: Database): string {
  const rows = db.query("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const main = rows.find((row) => row.name === "main");
  if (!main) throw new Error("PRAGMA database_list 에 main DB 가 없습니다 — 연결 상태를 확인하세요.");
  return main.file === "" ? ":memory:" : main.file;
}

/** DB 상태를 읽는다(읽기만 한다). */
export function readSchemaState(db: Database): SchemaState {
  const objectCount = countSchemaObjects(db);
  if (objectCount === 0) return { kind: "empty" };
  const versionTable = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (versionTable === null) return { kind: "unversioned", objectCount };
  const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  if (row.v === null) return { kind: "unversioned", objectCount };
  return { kind: "versioned", version: row.v, objectCount };
}

/**
 * 열어도 되는 DB 인지 판정한다. 아니면 이름 붙은 오류로 멈춘다(표·행은 건드리지 않는다. -wal 이 남아 있으면 호출자가
 * 연결을 닫을 때 SQLite 가 그것을 DB 파일에 합칠 수 있다).
 *
 * @param knownMaxVersion 이 코드가 아는 최고 버전 — BASELINE_VERSION 과 적용할 마이그레이션 목록의 최고값.
 */
export function assertSupportedSchemaState(db: Database, knownMaxVersion: number): SupportedSchemaState {
  const state = readSchemaState(db);
  if (state.kind === "empty") return state;
  if (state.kind === "unversioned") {
    throw new UnversionedDatabaseError(state.objectCount, mainDatabaseFile(db));
  }
  if (state.version < BASELINE_VERSION) {
    throw new SchemaVersionTooOldError(state.version, mainDatabaseFile(db));
  }
  if (state.version > knownMaxVersion) {
    throw new SchemaVersionTooNewError(state.version, knownMaxVersion, mainDatabaseFile(db));
  }
  return state;
}
