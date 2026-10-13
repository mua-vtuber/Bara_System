import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDatabase } from '../db/migrations.ts';
import { exportPortableArchive } from './export.ts';
import { validatePortableArchive } from './validate.ts';
import { restorePortableArchive } from './restore.ts';
import { createRestoreFixture, expectRestoreAbort } from './test-fixtures/restore-fixture.ts';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
test('all41 real collections survive restore/re-export and all8 fresh vectors are searchable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bara-restore-model-'));
    roots.push(root);
    const source = await createRestoreFixture(root);
    const legacy = openMemoryDatabase(source.dbPath, { embeddingDim: 384 });
    try {
        expect((legacy.query("SELECT sql FROM sqlite_master WHERE name='vec_nodes'").get() as {
            sql: string;
        }).sql).toContain('float[384]');
    }
    finally {
        legacy.close(true);
    }
    const archive = join(root, 'archive');
    await exportPortableArchive({ ...source, destination: archive });
    let competing: Promise<unknown> | undefined;
    let vectorCommitted = false;
    let competingRejected = false;
    const controller = new AbortController();
    const timings: Record<string, number> = {};
    const started = Date.now();
    await expectRestoreAbort(restorePortableArchive({ archive, destination: join(root, 'target'), signal: controller.signal, onProgress: p => {
            timings[p.phase] = Date.now() - started;
            if (p.phase === 'rows')
                competing = restorePortableArchive({ archive, destination: join(root, 'target'), resume: true }).then(() => {
                    throw new Error('Concurrent restore unexpectedly succeeded');
                }, error => {
                    expect(error.message).toContain('active');
                    competingRejected = true;
                    if (vectorCommitted)
                        controller.abort();
                });
            if (p.phase === 'index:vec_nodes' && p.completed > 0) {
                vectorCommitted = true;
                if (competingRejected)
                    controller.abort();
            }
        } }), controller.signal);
    await competing;
    const report = await restorePortableArchive({ archive, destination: join(root, 'target'), resume: true, onProgress: p => {
            timings[p.phase] = Date.now() - started;
        } });
    console.log('restore actual model timings ms', JSON.stringify(timings));
    expect(Object.values(report.counts).every(n => n > 0)).toBe(true);
    for (const key of ['vec_nodes', 'concept_vec', 'person_vec', 'entities_vec', 'chunk_summary_vec', 'relation_summary_vec', 'concept_siglip_vec', 'image_vec'])
        expect(report.indexCounts[key]).toBe(1);
    expect(new Uint8Array(await readFile(join(report.assetDir, `content/${source.imageHash}.png`)))).toEqual(new Uint8Array(source.png));
    for (const asset of source.storedAssets)
        expect(new Uint8Array(await readFile(join(report.assetDir, asset.file)))).toEqual(new Uint8Array(asset.bytes));
    expect(await readdir(join(report.assetDir, 'content'))).toHaveLength(3);
    const db = openMemoryDatabase(report.dbPath);
    try {
        expect(db.query("SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH 'coffee'").all()).toEqual([{ rowid: 7 }]);
        expect(db.query("SELECT concept_id FROM concept_nodes_uni WHERE concept_nodes_uni MATCH '커피'").all()).toEqual([{ concept_id: 'cpt_coffee' }]);
        for (const [table, key] of [['vec_nodes', 'node_id'], ['concept_vec', 'concept_rowid'], ['person_vec', 'person_rowid'], ['entities_vec', 'entity_rowid'], ['chunk_summary_vec', 'summary_rowid'], ['relation_summary_vec', 'summary_rowid'], ['concept_siglip_vec', 'concept_rowid'], ['image_vec', 'node_id']]) {
            const q = db.prepare(`SELECT ${key} AS id,embedding FROM ${table}`);
            let v: {
                id: number;
                embedding: Uint8Array;
            };
            try {
                v = q.get() as typeof v;
            }
            finally {
                q.finalize();
            }
            expect(v.embedding.byteLength).toBe(table === 'concept_siglip_vec' || table === 'image_vec' ? 768 * 4 : 1024 * 4);
            const match = db.prepare(`SELECT ${key} AS id,distance FROM ${table} WHERE embedding MATCH ? AND k=1`);
            try {
                const hit = match.get(v.embedding) as {
                    id: number;
                    distance: number;
                };
                expect(hit.id).toBe(v.id);
                expect(hit.distance).toBeLessThan(0.00001);
            }
            finally {
                match.finalize();
            }
        }
        expect(db.query("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name='knowledge_nodes'").get()).toEqual({ seq: '1000000' });
        expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }
    finally {
        db.close(true);
    }
    const second = join(root, 'reexport');
    await exportPortableArchive({ dbPath: report.dbPath, assetDir: report.assetDir, destination: second });
    const before = await validatePortableArchive(archive);
    const after = await validatePortableArchive(second);
    for (const [name, rows] of Object.entries(before.collections)) {
        const normalized = structuredClone(rows);
        if (name === 'assets')
            for (const r of normalized)
                r.assetPath = `content/${r.sha256}.${String(r.assetPath).endsWith('.md') ? 'md' : 'png'}`;
        if (name === 'chunkSummaries' || name === 'relationSummaries')
            for (const r of normalized)
                r.hasEmbedding = 1;
        expect(after.collections[name]).toEqual(normalized);
    }
    expect(after.manifest.allocators).toEqual(before.manifest.allocators);
    const live = openMemoryDatabase(report.dbPath);
    live.run("INSERT INTO knowledge_nodes(content) VALUES('new normal user write')");
    live.close(true);
    await expect(restorePortableArchive({ archive, destination: report.destination, resume: true })).rejects.toThrow();
    const preserved = openMemoryDatabase(report.dbPath);
    expect(preserved.query("SELECT content FROM knowledge_nodes WHERE content='new normal user write'").get()).toEqual({ content: 'new normal user write' });
    preserved.close(true);
}, 180000);
