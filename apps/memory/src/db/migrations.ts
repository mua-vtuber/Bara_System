/**
 * migrations.ts — 메모리 DB 를 열고, 기준 스키마(v47) 위에 v48+ 마이그레이션을 쌓는 실행기(설계 2026-10-02
 * 마이그레이션 압축 4절).
 *
 * 옛 v1~v47 업그레이드 경로는 기준 스키마 하나(baseline-schema.ts, schema/*.sql)로 접혔다. 여는 순서:
 *   폴더 만들기 → 열기 → sqlite-vec·외래 키·busy_timeout → schema_version 판정(schema-version-gate.ts)
 *   → WAL·synchronous → vec 차원 검사 → 대기 마이그레이션이 있으면 사전 스냅샷 → 새 DB 면 기준 스키마,
 *   그다음 대기 마이그레이션.
 * 판정이 차원 검사·사전 스냅샷보다 앞이라, 옛 DB·더 새 DB·바라 DB 가 아닌 파일은 아무것도 쓰기 전에 이름 붙은 오류로
 * 멈춘다. openMemoryDatabase 는 연 뒤 어디서 멈추든 연결을 닫고 그 오류를 다시 던진다.
 *
 * v48+ 더하는 법: Migration 값을 MIGRATIONS 끝에 더한다(파일이 크면 db/migrations-internal/ 폴더를 새로 만들어
 * v48 파일에서 내보낸다). schema/*.sql 은 고치지 않는다(동결). up() 은 새 DB·기존 DB 모두 같은 길로 돈다 — 새 DB 도 기준 스키마를
 * 만든 뒤 같은 up() 을 탄다. 행이 있는 표를 지우거나 바꿀 때는 행 수·설정 키 db.path/env MEMORY_DB_PATH·
 * KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE 를 담은 이름 붙은 오류로 멈춘다(추측 변환 금지). 그리고
 * scripts/write-schema-snapshot.ts 로 스냅샷을 다시 써서 같은 커밋에 둔다.
 */
import { Database } from "bun:sqlite";
import { assertPortableRestoreReady } from "./portable-restore-gate.ts";
import * as sqliteVec from "sqlite-vec";
import { ensureDbParentDir } from "./migration-safety.ts";
import { applyBusyTimeout, applyConnectionPragmas } from "./connection-pragmas.ts";
import { applyBaselineSchema, BASELINE_VERSION, runImmediateTransaction } from "./baseline-schema.ts";
import { assertSupportedSchemaState, mainDatabaseFile } from "./schema-version-gate.ts";
import { assertVecTableDims, DEFAULT_EMBEDDING_DIM } from "./vec-dimension-guard.ts";
import {
  maybeSnapshotBeforeMigrations,
  type PreMigrationSnapshotOptions,
} from "../backup/pre-migration-snapshot.ts";
import { v48EntityRegister } from "./migrations-internal/v48-entity-register.ts";
import { v49DocumentOcrLedger } from "./migrations-internal/v49-document-ocr-ledger.ts";

export interface Migration {
  version: number;
  name: string;
  /**
   * bun:sqlite는 동기 — async 아님. embeddingDim 은 글/개념 벡터 차원으로, 글 모델 vec0 표를 만들거나 다시 만드는
   * 마이그레이션이 이 값을 쓴다. SigLIP 768 가상 테이블(concept_siglip_vec·image_vec)은 글 임베딩 모델과 무관하므로
   * 이 값을 안 쓰고 768 리터럴 그대로 둔다.
   *
   * 두 문장 이상이 든 SQL 글은 db.run()/db.exec() 에 직접 넘기지 않고 sql-statements.ts 의 runSqlStatements(db, sql, 출처 이름)
   * 로 돌린다. 한 번에 넘기면 bun:sqlite 가 중간 문장의 실행 오류(예: sqlite-vec 의 vec0 표 생성 거부)를 던지지 않고 넘어가,
   * 표가 빠진 채 schema_version 만 올라간다. runSqlStatements 는 첫 실패에서 출처·문장 순번을 담아 던져 트랜잭션을 되돌린다.
   * 이 규칙은 sql-statements.scan.test.ts 가 소스 글자 수준에서 감시한다.
   */
  up: (db: Database, embeddingDim: number) => void;
}

/** 기준 스키마(v47) 위에 쌓는 마이그레이션. version 은 BASELINE_VERSION + 1 부터, 오름차순으로 더한다. */
export const MIGRATIONS: Migration[] = [v48EntityRegister, v49DocumentOcrLedger];

/** 이 마이그레이션 목록을 아는 코드의 최고 스키마 버전 — 기준 스키마 번호와 목록 최고값 중 큰 쪽. */
function knownMaxVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), BASELINE_VERSION);
}

/** 알려진 최고 스키마 버전 (기준 스키마 + 점진 마이그레이션 최대치). */
export const CURRENT_SCHEMA_VERSION = knownMaxVersion(MIGRATIONS);

export interface OpenOptions {
  /**
   * 글/개념 벡터 차원. 미지정 시 DEFAULT_EMBEDDING_DIM(1024 = bge-m3 / 1.2 T13).
   * legacy 384-dim 비교 회귀는 384 를 명시 전달한다. 새 DB 를 만들 때 기준 스키마의 글 벡터 `float[1024]`
   * 리터럴이 이 값으로 치환된다. SigLIP 768 가상 테이블은 글 임베딩과 무관해 불변.
   *
   * 안전 장치: 이미 만들어진 DB 의 vec 표 차원과 이 값이 다르면 openMemoryDatabase 가 구체 에러로 멈춘다
   * (빈 DB 재시작 유도 / silent fallback 금지). 운영 DB 를 자동 삭제하지 않는다 — 빈 DB cutover 는 사용자 수동.
   */
  embeddingDim?: number;
  /**
   * P4 T4 — 마이그레이션 적용 전 사전 스냅샷 옵션. 주입되면(파일 DB + 대기 v48+ 존재) 적용 직전에 VACUUM INTO 로
   * DB 원본을 떠 둔다. 미주입 시 스냅샷 안 뜬다. 버전 판정 뒤라 옛·새·모르는 DB 에는 뜨지 않는다.
   */
  preMigrationSnapshot?: PreMigrationSnapshotOptions;
}

/**
 * Opens a bara_system memory database. A file or `:memory:` database with no objects gets the baseline
 * schema (v47); a database at a known version gets only its pending migrations; reopening is harmless.
 * An older, newer or non-bara database stops with a named error before anything is written, and the
 * connection is closed before the error is rethrown.
 *
 * Pass `":memory:"` for tests; pass an absolute file path for production.
 */
export function openMemoryDatabase(filename: string, options: OpenOptions = {}): Database {
  assertPortableRestoreReady(filename);
  // 첫 배포자 정합(D7): 파일 경로의 부모 폴더가 없으면 new Database 가 즉시
  // 크래시하므로, 열기 전에 부모 폴더를 recursive 로 만든다. ":memory:"·빈 문자열은
  // skip. 생성 실패는 조용한 no-op 없이 설정 키 이름 담은 에러로 멈춘다.
  ensureDbParentDir(filename);

  const db = new Database(filename);
  try {
    sqliteVec.load(db);
    db.run("PRAGMA foreign_keys = ON");
    // 판정 읽기가 다른 연결의 쓰기와 겹쳐도 바로 SQLITE_BUSY 로 실패하지 않게, 연결 설정인 busy_timeout 만 먼저 건다.
    applyBusyTimeout(db);

    // 버전 판정을 가장 먼저(읽기만): 옛 DB 가 차원 오류로 잘못 안내되거나 사전 스냅샷이 쌓이지 않게. journal_mode=WAL
    // 보다도 앞이다 — WAL 로 바꾸면 파일 머리가 바뀌므로, 바라 DB 가 아닌 파일(rollback journal 모드)에서 멈출 때도
    // 그 파일을 한 바이트도 바꾸지 않는다.
    assertSupportedSchemaState(db, CURRENT_SCHEMA_VERSION);

    // 동시성 계약(P1-C): journal_mode=WAL + busy_timeout + synchronous=NORMAL 을 건다.
    // PRAGMA journal_mode=WAL 은 활성 트랜잭션 중 적용되지 않으므로 트랜잭션 밖인 여기서 건다.
    applyConnectionPragmas(db, filename);

    const embeddingDim = options.embeddingDim ?? DEFAULT_EMBEDDING_DIM;

    // 차원 불일치 안전: 이미 벡터 표를 가진 DB 를 다른 차원으로 열려 하면 구체 에러로 멈춘다(빈 DB 재시작 안내).
    // 현존 8 vec0 테이블 전부(글 모델 6 + SigLIP 2)를 검사한다. 운영 DB 자동 삭제 금지.
    assertVecTableDims(db, embeddingDim);

    // P4 T4 — 대기 마이그레이션이 있으면 적용 전에 사전 스냅샷을 뜬다(파일 DB 한정·판정은 모듈 내부).
    // 스냅샷 실패는 throw 되어 마이그레이션을 강행하지 않는다.
    if (options.preMigrationSnapshot) {
      maybeSnapshotBeforeMigrations(db, filename, CURRENT_SCHEMA_VERSION, options.preMigrationSnapshot);
    }

    runMigrations(db, MIGRATIONS, embeddingDim);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * 판정 → (새 DB 면) 기준 스키마 → 대기 마이그레이션. 멱등 — 다시 돌려도 할 일이 없으면 아무것도 바꾸지 않는다.
 *
 * 대기 마이그레이션은 외래 키를 트랜잭션 밖에서 끄고(SQLite 는 트랜잭션 안의 PRAGMA foreign_keys 변경을 무시한다),
 * IMMEDIATE 트랜잭션 안에서 버전을 다시 읽은 뒤 적용·버전 기록·PRAGMA foreign_key_check 를 한 번에 한다. 그래서
 * 검사 실패도 schema_version 을 올리지 않아 같은 마이그레이션을 다시 시도할 수 있다.
 *
 * migrations 인자는 테스트 주입용(default = 실제 MIGRATIONS). 코드가 아는 최고 버전은 이 목록에서 정한다.
 */
export function runMigrations(
  db: Database,
  migrations: Migration[] = MIGRATIONS,
  embeddingDim: number = DEFAULT_EMBEDDING_DIM,
): void {
  const knownMax = knownMaxVersion(migrations);
  const initial = assertSupportedSchemaState(db, knownMax);
  if (initial.kind === "empty") {
    // 다른 연결이 먼저 만들었으면 applyBaselineSchema 는 아무것도 하지 않고, 아래 판정이 그 DB 를 본다.
    applyBaselineSchema(db, embeddingDim);
  }
  const applied = requireSchemaVersion(db, knownMax);

  const pending = migrations
    .filter((m) => m.version > applied)
    .sort((a, b) => a.version - b.version);

  // pending 이 없으면(정상 부팅 대다수) FK 를 안 건드린다 — openMemoryDatabase 초입의 ON 이 그대로 유지된다.
  if (pending.length === 0) {
    return;
  }

  db.run("PRAGMA foreign_keys = OFF");
  try {
    runImmediateTransaction(db, () => {
      // 쓰기 잠금을 잡은 뒤 다시 읽는다 — 그사이 다른 연결이 적용한 마이그레이션은 건너뛴다.
      const current = requireSchemaVersion(db, knownMax);
      for (const migration of pending) {
        if (migration.version <= current) continue;
        migration.up(db, embeddingDim);
        db.query("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      }
      // 마이그레이션이 FK 위반을 남겼으면 silent 방치 없이 loud fail. 위반 0건이면 통과.
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `마이그레이션 후 FK 위반 ${violations.length}건 — foreign_key_check 가 참조 무결성이 깨진 행을 발견했습니다. ` +
            `마지막에 적용한 마이그레이션이 참조 대상 없는 행을 남겼는지 확인하세요.`,
        );
      }
    });
  } finally {
    // pending 이 있었으면 항상 ON 으로 복원한다(throw 경로 포함).
    db.run("PRAGMA foreign_keys = ON");
  }
}

/** 판정을 다시 하고 schema_version 을 돌려준다. 기준 스키마를 만든 뒤에도 객체가 0 이면 그 사실을 담아 멈춘다. */
function requireSchemaVersion(db: Database, knownMax: number): number {
  const state = assertSupportedSchemaState(db, knownMax);
  if (state.kind === "empty") {
    throw new Error(
      `기준 스키마 v${BASELINE_VERSION} 을 적용했는데 DB '${mainDatabaseFile(db)}' 에 객체가 없습니다 — ` +
        `같은 파일을 다른 프로그램이 동시에 비웠는지 확인하세요.`,
    );
  }
  return state.version;
}

export function getAppliedSchemaVersion(db: Database): number | null {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  return row.v;
}
