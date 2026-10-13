import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase } from '../src/db/migrations.ts';
import { parseSnapshotArgs, snapshotDatabase } from './db-snapshot.ts';

const script = join(import.meta.dir, 'db-snapshot.ts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'db-snapshot-'));
  roots.push(root);
  return root;
}
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const hash = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
/** 원본 DB 와 -wal 의 해시 — 스냅샷이 원본을 바꾸지 않았는지 비교한다. -shm 은 내용이 아니라 연결들이 나눠 쓰는
 * 색인이라(읽는 연결도 읽기 표시를 남긴다) 비교하지 않는다. */
const fingerprint = (db: string) => [db, `${db}-wal`].map(hash);

/** 서버처럼 쓰기 연결을 열어 둔 실제 DB: 두 기억은 커밋했지만 체크포인트 전이라 WAL 에만 있다. */
function liveDatabase(root: string): { db: string; writer: Database } {
  const db = join(root, 'db', 'bara.sqlite');
  mkdirSync(join(root, 'db'));
  const writer = openMemoryDatabase(db);
  writer.run("PRAGMA wal_autocheckpoint = 0");
  writer.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('스냅샷 기억 하나', '{}')");
  writer.run("INSERT INTO knowledge_nodes(content, metadata_json) VALUES('스냅샷 기억 둘', '{}')");
  return { db, writer };
}

describe('db-snapshot arguments', () => {
  test('needs exactly --db and --out', () => {
    expect(parseSnapshotArgs(['--db', 'a.sqlite', '--out', 'b.sqlite'])).toEqual({ db: 'a.sqlite', out: 'b.sqlite' });
    for (const args of [[], ['--db', 'a'], ['--out', 'b'], ['--db', 'a', '--out'], ['--db', 'a', '--db', 'b', '--out', 'c'],
      ['--db', 'a', '--out', 'b', '--model', 'x'], ['a', 'b'], ['--db', '--out', 'b'], ['--db', ' ', '--out', 'b']])
      expect(() => parseSnapshotArgs(args)).toThrow();
  });
});

describe('db-snapshot on a real memory database', () => {
  test('copies the committed rows of a live database, WAL included, without touching the source', () => {
    const root = scratch();
    const { db, writer } = liveDatabase(root);
    try {
      expect(existsSync(`${db}-wal`)).toBe(true);
      const before = fingerprint(db);
      const out = join(root, 'backup', 'bara.sqlite');
      mkdirSync(join(root, 'backup'));
      const result = snapshotDatabase({ db, out });
      expect(result).toEqual({ path: out, bytes: readFileSync(out).byteLength, schemaVersion: CURRENT_SCHEMA_VERSION });
      expect(fingerprint(db)).toEqual(before);
      // 사본은 혼자 서는 파일이다(rollback journal 모드, 곁 파일 없음).
      expect(readdirSync(join(root, 'backup'))).toEqual(['bara.sqlite']);
      const copy = new Database(out, { readonly: true });
      try {
        sqliteVec.load(copy);
        expect((copy.query('SELECT content FROM knowledge_nodes ORDER BY id').all() as Array<{ content: string }>).map((row) => row.content))
          .toEqual(['스냅샷 기억 하나', '스냅샷 기억 둘']);
        expect(copy.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      } finally { copy.close(); }
    } finally { writer.close(); }
  });

  test('the CLI prints one JSON line and refuses an output that exists, leaving it as it was', async () => {
    const root = scratch();
    const { db, writer } = liveDatabase(root);
    writer.close();
    const out = join(root, 'snapshot.sqlite');
    const first = await run('--db', db, '--out', out);
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' });
    expect(first.stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(first.stdout)).toEqual({ path: out, bytes: readFileSync(out).byteLength, schemaVersion: CURRENT_SCHEMA_VERSION });
    const kept = hash(out);
    const again = await run('--db', db, '--out', out);
    expect(again).toMatchObject({ code: 1, stdout: '' });
    expect(again.stderr.trim()).toBe('db-snapshot: Output already exists');
    expect(hash(out)).toBe(kept);
    expect(readdirSync(root).sort()).toEqual(['db', 'snapshot.sqlite']);
  });

  test('a file that is not a memory database is refused and no output or temporary file is left', async () => {
    const root = scratch();
    const foreign = join(root, 'foreign.sqlite');
    const other = new Database(foreign);
    other.run('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
    other.close();
    const before = hash(foreign);
    const result = await run('--db', foreign, '--out', join(root, 'out.sqlite'));
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('db-snapshot: Snapshot has no readable schema_version');
    expect(readdirSync(root)).toEqual(['foreign.sqlite']);
    expect(hash(foreign)).toBe(before);
  });

  test('a missing source, a missing output folder or the source itself as output is refused', async () => {
    const root = scratch();
    const { db, writer } = liveDatabase(root);
    writer.close();
    const cases: Array<[string[], string]> = [
      [['--db', join(root, 'missing.sqlite'), '--out', join(root, 'a.sqlite')], 'Source database is not a regular file'],
      [['--db', join(root, 'db'), '--out', join(root, 'a.sqlite')], 'Source database is not a regular file'],
      [['--db', db, '--out', join(root, 'nowhere', 'a.sqlite')], 'Output folder does not exist'],
      [['--db', db, '--out', db], 'Output must not be the source database or its sidecar files'],
      [['--db', db, '--out', `${db}-wal`], 'Output must not be the source database or its sidecar files'],
    ];
    for (const [args, message] of cases) {
      const result = await run(...args);
      expect({ code: result.code, stderr: result.stderr.trim(), stdout: result.stdout }).toEqual({ code: 1, stderr: `db-snapshot: ${message}`, stdout: '' });
    }
    expect(readdirSync(root)).toEqual(['db']);
    writeFileSync(join(root, 'taken'), '');
    expect(() => snapshotDatabase({ db, out: join(root, 'taken') })).toThrow('Output already exists');
  });
});
