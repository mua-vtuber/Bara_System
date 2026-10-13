/**
 * 마이그레이션 사전 스냅샷 — openMemoryDatabase 가 pending 마이그레이션(v48+)을 적용하기
 * *직전*에 VACUUM INTO 로 DB 원본을 떠 둔다. (spec D1-d, P4 T4)
 *
 * 순환 차단: 이 모듈은 migrations.ts 로부터 value import 를 하지 않는다 —
 * CURRENT_SCHEMA_VERSION 은 호출측(migrations.ts openMemoryDatabase)이 인자로
 * 전달한다. 판정도 getAppliedSchemaVersion 을 import 하지 않고 인라인 SQL 로
 * 한다(기준 스키마 적용 *전* 시점이라 새 DB 의 테이블 부재를 스스로 다뤄야 함).
 * openMemoryDatabase 는 schema_version 판정 뒤에 부르므로, 기준 스키마 이전·더 새·
 * 바라 DB 가 아닌 파일에는 스냅샷을 뜨지 않는다(판정 오류로 먼저 멈춤).
 *
 * 실패는 throw — 스냅샷 없이 마이그레이션을 강행하지 않는다(spec D1-d).
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { nowInZone } from "../db/store-internal/helpers.ts";

export interface PreMigrationSnapshotOptions {
  /** 스냅샷 보관 뿌리(= settings.backup.dir). 하위 pre-migration/ 에 쌓인다. */
  dir: string;
  appVersion: string;
  /** 보관 개수 상한. 초과분은 오래된 것부터 삭제. default 3. */
  keep?: number;
}

const PRE_MIGRATION_SUBDIR = "pre-migration";
const DEFAULT_KEEP = 3;
const SNAPSHOT_NAME_PATTERN = /^pre-v\d+-\d{8}-\d{6}\.sqlite$/;

/**
 * pending 이 있으면 VACUUM INTO 로 스냅샷을 뜨고 경로 반환, 없으면 null.
 *
 * null 갈래(스냅샷 불필요 — 정직한 판정, 실패 아님):
 *   - filename 이 ":memory:"·빈 문자열 (파일 DB 전용)
 *   - schema_version 테이블 부재 (신규 DB — 지킬 데이터 없음)
 *   - 기록된 최고 버전이 null 또는 currentSchemaVersion 이상 (pending 없음)
 */
export function maybeSnapshotBeforeMigrations(
  db: Database,
  filename: string,
  currentSchemaVersion: number,
  opts: PreMigrationSnapshotOptions,
): string | null {
  if (filename === ":memory:" || filename === "") return null;

  // query(): db.close() 때 함께 정리되는 문장 — prepare() 문장이 남으면 openMemoryDatabase 가 멈추며 닫은 연결이
  // 파일 핸들을 계속 쥔다.
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name: string } | null;
  if (table === null) return null;

  const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as {
    v: number | null;
  };
  if (row.v === null || row.v >= currentSchemaVersion) return null;
  const applied = row.v;

  const snapshotDir = join(opts.dir, PRE_MIGRATION_SUBDIR);
  // 절대 경로로 바꿔 부른다: Bun 1.3.6 / Windows 는 이미 있는 상대 경로에 `..` 가 있으면 recursive mkdir 도 EEXIST 를 던진다.
  mkdirSync(resolve(snapshotDir), { recursive: true, mode: 0o700 });

  // T2(backup-runner)와 같은 타임스탬프·escape 조립 — nowInZone "YYYY-MM-DD HH:MM:SS"
  // → "YYYYMMDD-HHMMSS". VACUUM INTO 파라미터 바인딩은 SQLite 버전 의존이라 escape.
  const compact = nowInZone().replace(/[-: ]/g, "");
  const snapshotPath = join(
    snapshotDir,
    `pre-v${applied}-${compact.slice(0, 8)}-${compact.slice(8)}.sqlite`,
  );
  const escaped = snapshotPath.replaceAll("'", "''");
  db.run(`VACUUM INTO '${escaped}'`);

  pruneOldSnapshots(snapshotDir, opts.keep ?? DEFAULT_KEEP);

  console.log(
    `[pre-migration] snapshot: ${snapshotPath} (applied=v${applied} → target=v${currentSchemaVersion}, app=${opts.appVersion})`,
  );
  return snapshotPath;
}

/**
 * pre-vN-YYYYMMDD-HHMMSS.sqlite 양식 파일이 keep 개를 넘으면 오래된 것부터
 * 삭제한다. 순서 판정은 파일 mtime — 이름의 버전 숫자는 zero-pad 가 아니라
 * 사전순이 시간순과 어긋날 수 있다(pre-v10 < pre-v9).
 */
function pruneOldSnapshots(snapshotDir: string, keep: number): void {
  const snapshots = readdirSync(snapshotDir, { withFileTypes: true })
    .filter((e) => e.isFile() && SNAPSHOT_NAME_PATTERN.test(e.name))
    .map((e) => {
      const path = join(snapshotDir, e.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of snapshots.slice(keep)) {
    rmSync(path);
  }
}
