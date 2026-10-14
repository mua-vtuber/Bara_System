import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { CURRENT_SCHEMA_VERSION, openMemoryDatabase, runMigrations } from '../db/migrations.ts';
import { DEFAULT_EMBEDDING_DIM } from '../db/vec-dimension-guard.ts';
import { removeTempDir } from '../db/migration-safety.test-helpers.ts';
import { COLLECTIONS, assertSourceSchema } from './collections.ts';
import { exportPortableArchive } from './export.ts';
import { validatePortableArchive } from './validate.ts';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    removeTempDir(root);
});
/** 기준 스키마(v47)만 적용한 파일 DB — 업데이트 직전 펫이 새 프로그램으로 읽는 옛 배포 DB 와 같다. */
async function fixtureV47() {
  const f = await fixture();
  await rm(f.dbPath);
  const db = new Database(f.dbPath);
  sqliteVec.load(db);
  runMigrations(db, [], DEFAULT_EMBEDDING_DIM);
  db.close();
  return f;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bara-portable-'));
  roots.push(root);
  const dbPath = join(root, 'source.sqlite');
  const assetDir = join(root, 'assets');
  await mkdir(join(assetDir, 'content'), {
    recursive: true
  });
  const db = openMemoryDatabase(dbPath);
  db.run("INSERT INTO knowledge_nodes(id,content,metadata_json) VALUES(7,'한국어 body',' {\"unknown\":true} ')");
  db.run("UPDATE sqlite_sequence SET seq=100 WHERE name='knowledge_nodes'");
  db.close();
  return {
    root, dbPath, assetDir, destination: join(root, 'archive')
  };
}
test('explicit descriptors cover all 41 tables and every current column', async () => {
  const f = await fixture();
  const db = openMemoryDatabase(f.dbPath);
  try {
    expect(COLLECTIONS).toHaveLength(41);
    expect(() => assertSourceSchema(db)).not.toThrow();
    db.run('ALTER TABLE knowledge_nodes ADD COLUMN unclassified TEXT');
    expect(() => assertSourceSchema(db)).toThrow('source field shape');
  }
  finally {
    db.close();
  }
});
test('export is read-only and preserves exact text, null, allocators', async () => {
  const f = await fixture();
  const before = await readFile(f.dbPath);
  await exportPortableArchive(f);
  const archive = await validatePortableArchive(f.destination);
  expect(Object.keys(archive.collections)).toHaveLength(41);
  expect(archive.collections.memories![0]!.body).toBe('한국어 body');
  expect(archive.collections.memories![0]!.metadataJson).toBe(' {"unknown":true} ');
  expect(archive.collections.memories![0]!.updatedAt).toBeNull();
  expect(archive.manifest.allocators.memories).toBe('100');
  expect(await readFile(f.dbPath)).toEqual(before);
});
test('reject existing destination and source overlap without writes', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await writeFile(join(f.destination, 'keep'), 'untouched');
  await expect(exportPortableArchive(f)).rejects.toThrow('exists');
  expect(await readFile(join(f.destination, 'keep'), 'utf8')).toBe('untouched');
  await expect(exportPortableArchive({
    ...f, destination: f.assetDir
  })).rejects.toThrow();
});
test('reject unknown source table and unsafe integer rather than omit/round', async () => {
  const f = await fixture();
  let db = openMemoryDatabase(f.dbPath);
  db.run('CREATE TABLE unclassified(id INTEGER)');
  db.close();
  await expect(exportPortableArchive(f)).rejects.toThrow('Unclassified');
  db = openMemoryDatabase(f.dbPath);
  db.run('DROP TABLE unclassified');
  db.run('UPDATE knowledge_nodes SET access_count=9007199254740993');
  db.close();
  await expect(exportPortableArchive(f)).rejects.toThrow('Unsafe integer');
});
test('verify rejects wrong version, count/hash, paths and malformed records', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const path = join(f.destination, 'manifest.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mutate of [(m: any) => m.version = 2, (m: any) => m.collections.memories.count++, (m: any) => m.collections.memories.file = '../source.sqlite', (m: any) => m.collections.memories.sha256 = '0'.repeat(64), (m: any) => m.allocators.memories = '-1']) {
    const m = structuredClone(original);
    mutate(m);
    await writeFile(path, JSON.stringify(m));
    await expect(validatePortableArchive(f.destination)).rejects.toThrow();
  }
  await writeFile(path, JSON.stringify(original));
  await writeFile(join(f.destination, 'collections/memories.json'), '[{}]');
  await expect(validatePortableArchive(f.destination)).rejects.toThrow();
});
test('reject linked archive files', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const path = join(f.destination, 'collections');
  const original = join(f.root, 'real-collections');
  await rename(path, original);
  await symlink(original, path, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(validatePortableArchive(f.destination)).rejects.toThrow();
});
import { sha256 } from './validate.ts';
import { assertPortableScalar } from './format.ts';
import { publishDirectory } from './paths.ts';
async function rewriteMemories(directory: string, transform: (rows: any[]) => void) {
  const file = join(directory, 'collections/memories.json');
  const rows = JSON.parse(await readFile(file, 'utf8'));
  transform(rows);
  const bytes = JSON.stringify(rows);
  await writeFile(file, bytes);
  const path = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.collections.memories.sha256 = sha256(bytes);
  manifest.collections.memories.count = rows.length;
  await writeFile(path, JSON.stringify(manifest));
}
test('reject missing/extra fields, invalid types/nulls and duplicate identities with valid hashes', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const original = await readFile(join(f.destination, 'collections/memories.json'), 'utf8');
  for (const transform of [(r: any[]) => delete r[0].body, (r: any[]) => r[0].extra = 'x', (r: any[]) => r[0].body = null, (r: any[]) => r[0].accessCount = '1', (r: any[]) => r[0].accessCount = 9007199254740992, (r: any[]) => r.push({
      ...r[0]
    })]) {
    await writeFile(join(f.destination, 'collections/memories.json'), original);
    await rewriteMemories(f.destination, transform);
    await expect(validatePortableArchive(f.destination)).rejects.toThrow();
  }
});
test('scalar validation rejects non-finite and unsafe integers', () => {
  for (const value of [NaN, Infinity, -Infinity, 9007199254740993n, {}, true])
    expect(() => assertPortableScalar(value)).toThrow();
  expect(assertPortableScalar(9007199254740991n)).toBe(9007199254740991);
  expect(assertPortableScalar(0.5)).toBe(0.5);
});
test('registered canonical attachment bytes survive; tampered/missing bytes fail', async () => {
  const f = await fixture();
  const bytes = new Uint8Array([0, 1, 255, 42]);
  const hash = sha256(bytes);
  const db = openMemoryDatabase(f.dbPath);
  db.query("INSERT INTO asset_files(sha256,asset_type,asset_path,byte_size,first_imported_at) VALUES(?,'image',?,?,'2026-10-04')").run(hash, '/old/source/content/' + hash + '.png', bytes.length);
  db.close();
  const source = join(f.assetDir, 'content', hash + '.png');
  await writeFile(source, bytes);
  await exportPortableArchive(f);
  const archive = await validatePortableArchive(f.destination);
  expect(archive.manifest.attachments).toHaveLength(1);
  const stored = join(f.destination, archive.manifest.attachments[0]!.file);
  expect(await readFile(stored)).toEqual(Buffer.from(bytes));
  await writeFile(stored, 'tampered');
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('hash/size');
  await rm(stored);
  await expect(validatePortableArchive(f.destination)).rejects.toThrow();
  await rm(f.destination, {
    recursive: true
  });
  await writeFile(source, 'tampered');
  await expect(exportPortableArchive(f)).rejects.toThrow('hash/size');
  expect(await readFile(source, 'utf8')).toBe('tampered');
});
test('unsupported version and index-like ordinary tables fail closed', async () => {
  const f = await fixture();
  let db = openMemoryDatabase(f.dbPath);
  db.run('UPDATE schema_version SET version=999 WHERE version=(SELECT MAX(version) FROM schema_version)');
  db.close();
  await expect(exportPortableArchive(f)).rejects.toThrow('version');
  db = openMemoryDatabase(':memory:');
  try {
    expect(() => assertSourceSchema(db)).not.toThrow();
    db.run('CREATE TABLE vec_nodes_unclassified(secret TEXT)');
    expect(() => assertSourceSchema(db)).toThrow('Unclassified');
  }
  finally {
    db.close();
  }
});
test('publication cannot replace empty directory and incomplete outputs cannot verify', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const target = join(f.root, 'reserved');
  await mkdir(target);
  await expect(publishDirectory(f.destination, target)).rejects.toThrow('exists');
  await expect(validatePortableArchive(target)).rejects.toThrow();
});
test('undeclared files, linked source folder and abort preserve unrelated bytes', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  await writeFile(join(f.destination, 'secret-settings.json'), 'outside contract');
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('Unexpected archive file');
  const alias = join(f.root, 'linked-assets');
  await symlink(f.assetDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(exportPortableArchive({
    ...f, assetDir: alias, destination: join(f.root, 'second')
  })).rejects.toThrow('Symbolic');
  const controller = new AbortController();
  controller.abort();
  await expect(exportPortableArchive({
    ...f, destination: join(f.root, 'aborted'), signal: controller.signal
  })).rejects.toThrow();
  expect(await readFile(join(f.destination, 'secret-settings.json'), 'utf8')).toBe('outside contract');
});
test('matching hash cannot legitimize malformed UTF-8 text', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const path = join(f.destination, 'collections/memories.json');
  const bytes = Buffer.from(await readFile(path));
  const index = bytes.indexOf(Buffer.from('한국어'));
  bytes[index] = 255;
  await writeFile(path, bytes);
  const manifestPath = join(f.destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.collections.memories.sha256 = sha256(bytes);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('UTF-8');
});
test('incomplete restored source is rejected before it can export', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'portable-restore.json'), JSON.stringify({
    complete: false
  }));
  await expect(exportPortableArchive(f)).rejects.toThrow();
});
test('source TEXT with malformed UTF-8 fails instead of replacing prose', async () => {
  const f = await fixture();
  const db = openMemoryDatabase(f.dbPath);
  db.run("UPDATE knowledge_nodes SET content=CAST(x'ff' AS TEXT)");
  db.close();
  await expect(exportPortableArchive(f)).rejects.toThrow('Invalid source scalar');
});
test('unexpected SQLite storage classes are rejected rather than coerced', async () => {
  const f = await fixture();
  const db = openMemoryDatabase(f.dbPath);
  db.run("UPDATE knowledge_nodes SET importance='not-a-number'");
  db.close();
  await expect(exportPortableArchive(f)).rejects.toThrow('source storage type');
});
async function rewriteCollection(directory: string, name: string, transform: (rows: any[]) => void): Promise<void> {
  const file = join(directory, 'collections', name + '.json');
  const rows = JSON.parse(await readFile(file, 'utf8'));
  transform(rows);
  const bytes = JSON.stringify(rows);
  await writeFile(file, bytes);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.collections[name].sha256 = sha256(bytes);
  manifest.collections[name].count = rows.length;
  await writeFile(manifestPath, JSON.stringify(manifest));
}
test('escaped lone UTF-16 surrogate cannot silently change during restore', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  await rewriteCollection(f.destination, 'memories', rows => rows[0].body = '\ud800');
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('Unpaired UTF-16 surrogate');
  expect(() => assertPortableScalar('\udc00')).toThrow('Unpaired UTF-16 surrogate');
  expect(assertPortableScalar('paired 😀 text')).toBe('paired 😀 text');
});
test('matching hashes cannot bypass database UNIQUE constraints', async () => {
  const f = await fixture();
  const db = openMemoryDatabase(f.dbPath);
  db.run("INSERT INTO concept_nodes(concept_id,name) VALUES('c1','unique name')");
  db.close();
  await exportPortableArchive(f);
  await rewriteCollection(f.destination, 'concepts', rows => rows.push({ ...rows[0], conceptId: 'c2' }));
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('relational constraints');
});
test('matching hashes cannot bypass database CHECK constraints', async () => {
  const f = await fixture();
  const db = openMemoryDatabase(f.dbPath);
  db.run("INSERT INTO classify_vocab_overrides(override_id,type_name,slot,value) VALUES('override','person','synonyms','x')");
  db.close();
  await exportPortableArchive(f);
  await rewriteCollection(f.destination, 'classificationOverrides', rows => rows[0].slot = 'invalid slot');
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('relational constraints');
});
test('relational validation fails before an exporter creates any staging directory', async () => {
  const f = await fixture();
  const db = openMemoryDatabase(f.dbPath);
  db.run('PRAGMA ignore_check_constraints = ON');
  db.run("INSERT INTO classify_vocab_overrides(override_id,type_name,slot,value) VALUES('override','person','invalid','x')");
  db.close();
  const before = await readdir(f.root);
  await expect(exportPortableArchive(f)).rejects.toThrow('relational constraints');
  const after = await import('node:fs/promises').then(fs => fs.readdir(f.root));
  // SQLite's read-only WAL connection may create its usual shared-memory sidecars.
  expect(after.filter(name => name !== 'source.sqlite-wal' && name !== 'source.sqlite-shm')).toEqual(before);
});

test('a current source exports and lists the auto-register, server OCR ledger and backfill retry tables as excluded with a reason', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const manifest = JSON.parse(await readFile(join(f.destination, 'manifest.json'), 'utf8'));
  expect(manifest.source.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  const byName = new Map<string, string>(manifest.exclusions.map((e: { name: string; reason: string }) => [e.name, e.reason]));
  expect(byName.get('entity_register_records')).toBeTruthy();
  expect(byName.get('entity_register_ignores')).toBeTruthy();
  expect(byName.get('document_ocr_page_results')).toBeTruthy();
  expect(byName.get('document_ocr_daily_usage')).toBeTruthy();
  expect(byName.get('backfill_attempts')).toBeTruthy();
  await validatePortableArchive(f.destination);
});
test('a v47 source (before the upgrade) still exports without the v48 exclusions', async () => {
  const f = await fixtureV47();
  await exportPortableArchive(f);
  const manifest = JSON.parse(await readFile(join(f.destination, 'manifest.json'), 'utf8'));
  expect(manifest.source.schemaVersion).toBe(47);
  const names = manifest.exclusions.map((e: { name: string }) => e.name);
  expect(names).not.toContain('entity_register_records');
  expect(names).not.toContain('entity_register_ignores');
  await validatePortableArchive(f.destination);
});
test('a v47 manifest listing v48 exclusions, and a v48 manifest missing them, are rejected', async () => {
  const f = await fixture();
  await exportPortableArchive(f);
  const path = join(f.destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...manifest, source: { ...manifest.source, schemaVersion: 47 } }));
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('exclusion');
  await writeFile(path, JSON.stringify({ ...manifest, exclusions: manifest.exclusions.filter((e: { name: string }) => e.name !== 'entity_register_ignores') }));
  await expect(validatePortableArchive(f.destination)).rejects.toThrow('exclusions');
});
