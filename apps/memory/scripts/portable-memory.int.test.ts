import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMemoryDatabase } from '../src/db/migrations.ts';
import { exportPortableArchive } from '../src/portable/export.ts';

test('restore CLI creates a ready searchable database with actual embedding and rejects existing target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-cli-restore-'));
  try {
    const dbPath = join(root, 'source.sqlite');
    const assets = join(root, 'source-assets');
    await mkdir(assets);
    const source = openMemoryDatabase(dbPath);
    try { source.run('INSERT INTO knowledge_nodes(content) VALUES (?)', ['포터블 기억 CLI 검색 검증']); }
    finally { source.close(); }
    const archive = join(root, 'archive');
    await exportPortableArchive({ dbPath, assetDir: assets, destination: archive });
    const destination = join(root, 'restored');
    async function restore() {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'portable-memory.ts'),
        'restore', '--archive', archive, '--out', destination, '--model', 'bge-m3'], {
        stdout: 'pipe', stderr: 'pipe', env: process.env,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { stdout, stderr, code };
    }
    const result = await restore();
    if (result.code !== 0) throw new Error(`Restore subprocess failed (${result.code}): ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    expect(report.counts.memories).toBe(1);
    expect(report.indexCounts.vec_nodes).toBe(1);
    expect(result.stderr).toContain('ETA');
    expect(JSON.parse(await readFile(join(destination, 'portable-restore.json'), 'utf8')).status).toBe('complete');
    const db = openMemoryDatabase(report.dbPath);
    try {
      expect(db.query('SELECT content FROM knowledge_nodes').get()).toEqual({ content: '포터블 기억 CLI 검색 검증' });
      expect(db.query('SELECT count(*) AS count FROM vec_nodes').get()).toEqual({ count: 1 });
      expect(db.query("SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH 'CLI'").all()).toEqual([{ rowid: 1 }]);
      const vector = db.query<{ embedding: Uint8Array }, []>('SELECT embedding FROM vec_nodes').get()!;
      expect(db.query('SELECT node_id FROM vec_nodes WHERE embedding MATCH ? AND k = 1').all(vector.embedding)).toEqual([{ node_id: 1 }]);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
    const before = await readFile(report.dbPath);
    const repeated = await restore();
    expect(repeated.code).toBe(1);
    expect(repeated.stdout).toBe('');
    expect(await readFile(report.dbPath)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 180_000);
