/**
 * DB 스냅샷 CLI — 바라 펫이 새 버전으로 DB 를 열기 *전에* 원본의 일관된 사본을 떠 둔다(펫 7B 업데이트 전 백업).
 *
 *   cd apps/memory
 *   bun run scripts/db-snapshot.ts --db <sqlite-file> --out <new-file>
 *
 * 원본은 읽기 전용 연결로만 연다(sqlite-vec 를 export.ts 와 같은 방식으로 적재 — vec0 가상 표 정의를 복사하려면
 * 모듈이 있어야 한다). VACUUM INTO 는 한 읽기 트랜잭션의 일관된 사본을 만들며 WAL 에만 있는 커밋도 담는다.
 * 그래서 서버가 열어 둔 DB 도 원본을 한 바이트도 바꾸지 않고 뜰 수 있다(단순 파일 복사는 WAL 을 빠뜨린다).
 *
 * 순서: --out 이 이미 있으면 거절 → 같은 폴더의 임시 이름으로 VACUUM INTO → 사본을 열어 integrity_check 와
 * schema_version 읽기 → 이름 바꿔 게시. 실패하면 임시 파일을 지우고 stderr 한 줄 + exit 1, --out 은 생기지 않는다.
 * 결과는 stdout 한 줄 JSON {path, bytes, schemaVersion}.
 *
 * 스키마를 판정하지 않는다: 펫은 *새* 프로그램으로 *옛* DB 를 뜨므로 버전을 고르지 않고 무엇이든 그대로 복사하고,
 * schema_version 이 읽히는지만 확인한다(바라 DB 가 아닌 파일은 거절).
 */
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertPortableRestoreReady } from "../src/db/portable-restore-gate.ts";

export interface SnapshotArgs { db: string; out: string }
export interface SnapshotResult { path: string; bytes: number; schemaVersion: number }

/** 원본 연결이 서버의 쓰기·체크포인트와 겹칠 때 바로 SQLITE_BUSY 로 실패하지 않도록 기다리는 시간. */
const BUSY_TIMEOUT_MS = 30_000;

export function parseSnapshotArgs(argv: string[]): SnapshotArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const key = arg.slice(2);
    if (!arg.startsWith("--") || (key !== "db" && key !== "out")) throw new Error(`Unknown argument: ${arg}`);
    if (key in values) throw new Error(`Duplicate argument: ${arg}`);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values[key] = value;
  }
  if (!values.db || !values.out) throw new Error("Both --db and --out are required");
  return { db: values.db, out: values.out };
}

/** ENOENT 만 "없음"이다. 링크·폴더·파일 무엇이든 그 이름을 차지하면 있음으로 본다. */
function occupied(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function removeCopy(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
}

export function snapshotDatabase(args: SnapshotArgs): SnapshotResult {
  const db = resolve(args.db);
  const out = resolve(args.out);
  const source = lstatSync(db, { throwIfNoEntry: false });
  if (!source?.isFile()) throw new Error("Source database is not a regular file");
  if ([db, `${db}-wal`, `${db}-shm`].includes(out)) throw new Error("Output must not be the source database or its sidecar files");
  if (occupied(out)) throw new Error("Output already exists");
  if (!lstatSync(dirname(out), { throwIfNoEntry: false })?.isDirectory()) throw new Error("Output folder does not exist");
  assertPortableRestoreReady(db);

  const temporary = join(dirname(out), `.${basename(out)}.snapshot-${randomUUID()}`);
  try {
    const reader = new Database(db, { readonly: true });
    try {
      sqliteVec.load(reader);
      reader.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      // VACUUM INTO 의 파일 이름 바인딩은 SQLite 버전 의존이라 pre-migration-snapshot.ts 와 같이 escape 한다.
      reader.run(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
    } finally { reader.close(); }

    let schemaVersion: number;
    const copy = new Database(temporary, { readonly: true });
    try {
      sqliteVec.load(copy);
      const checks = copy.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      if (checks.length !== 1 || checks[0]!.integrity_check !== "ok") throw new Error("Snapshot integrity check failed");
      let row: { v: unknown } | null;
      try { row = copy.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: unknown } | null; }
      catch { throw new Error("Snapshot has no readable schema_version"); }
      if (typeof row?.v !== "number" || !Number.isSafeInteger(row.v)) throw new Error("Snapshot has no readable schema_version");
      schemaVersion = row.v;
    } finally { copy.close(); }

    // 확인과 이름 바꾸기 사이에 생긴 --out 을 덮어쓰지 않도록 한 번 더 본다(펫은 매번 새 폴더에 뜬다).
    if (occupied(out)) throw new Error("Output already exists");
    renameSync(temporary, out);
    return { path: out, bytes: statSync(out).size, schemaVersion };
  } catch (error) {
    removeCopy(temporary);
    throw error;
  }
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const result = snapshotDatabase(parseSnapshotArgs(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    console.error(`db-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main();
