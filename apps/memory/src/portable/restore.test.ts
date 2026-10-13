import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { openMemoryDatabase, runMigrations } from '../db/migrations.ts';
import { DEFAULT_EMBEDDING_DIM } from '../db/vec-dimension-guard.ts';
import { exportPortableArchive } from './export.ts';
import { restorePortableArchive } from './restore.ts';
import { verifyPortableIndexes, expectedIndexCounts } from './restore-indexes.ts';
import { sha256 } from './validate.ts';
import { expectRestoreAbort } from './test-fixtures/restore-fixture.ts';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'bara-restore-'));
    roots.push(root);
    const dbPath = join(root, 'source.sqlite');
    const assetDir = join(root, 'source-assets');
    await mkdir(assetDir);
    const db = openMemoryDatabase(dbPath);
    db.close();
    const archive = join(root, 'archive');
    await exportPortableArchive({ dbPath, assetDir, destination: archive });
    return { root, archive, destination: join(root, 'target') };
}
test('empty restore publishes current SQLite, pairing and complete receipt', async () => {
    const f = await fixture();
    const report = await restorePortableArchive(f);
    expect(Object.keys(report.counts)).toHaveLength(41);
    expect(report.indexCounts.vec_nodes).toBe(0);
    const receipt = JSON.parse(await readFile(join(f.destination, 'portable-restore.json'), 'utf8'));
    expect(receipt.status).toBe('complete');
    const db = openMemoryDatabase(report.dbPath);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='_portable_restore_checkpoint'").all()).toEqual([]);
    db.close();
});
test('existing empty target is never adopted or overwritten, including resume', async () => {
    const f = await fixture();
    await mkdir(f.destination);
    for (const resume of [false, true])
        await expect(restorePortableArchive({ ...f, resume })).rejects.toThrow('Destination');
    expect(await readFile(join(f.archive, 'manifest.json'), 'utf8')).toContain('bara-memory');
});
test('invalid archive never creates target or stage', async () => {
    const f = await fixture();
    await writeFile(join(f.archive, 'collections/memories.json'), 'broken');
    await expect(restorePortableArchive(f)).rejects.toThrow();
    await expect(readFile(join(f.destination, 'portable-restore.json'))).rejects.toThrow();
});
test('abort at durable row checkpoint resumes without duplicate work', async () => {
    const f = await fixture();
    const controller = new AbortController();
    await expectRestoreAbort(restorePortableArchive({ ...f, signal: controller.signal, onProgress: p => {
            if (p.phase === 'rows')
                controller.abort();
        } }), controller.signal);
    await expect(restorePortableArchive(f)).rejects.toThrow('resume');
    const report = await restorePortableArchive({ ...f, resume: true });
    expect(report.counts.memories).toBe(0);
});
test('external-content FTS verification detects missing terms even when row counts match', () => {
    const db = openMemoryDatabase(':memory:');
    try {
        db.run("INSERT INTO knowledge_nodes(content) VALUES('coffee')");
        const vector = new Float32Array(1024);
        vector[0] = 1;
        db.query('INSERT INTO vec_nodes(node_id,embedding) VALUES(1,?)').run(new Uint8Array(vector.buffer));
        db.run("INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts) VALUES('delete-all')");
        expect(() => verifyPortableIndexes(db, 'bge-m3')).toThrow('database disk image is malformed');
    }
    finally {
        db.close();
    }
});
test('production image source type is excluded from BGE and included in SigLIP inputs', () => {
    const db = openMemoryDatabase(':memory:');
    try {
        db.run("INSERT INTO asset_files(sha256,asset_type,asset_path,byte_size,first_imported_at) VALUES('imagehash','image','content/image.png',1,'2026-01-01')");
        db.run("INSERT INTO images(asset_sha256,width,height,mime,preserve_mode) VALUES('imagehash',1,1,'image/png','original')");
        db.run("INSERT INTO knowledge_nodes(content,memory_type,source_type,metadata_json) VALUES('Image asset','fact','image_asset','{\"asset_sha256\":\"imagehash\"}')");
        const counts = expectedIndexCounts(db, 'bge-m3');
        expect(counts.vec_nodes).toBe(0);
        expect(counts.image_vec).toBe(1);
    }
    finally {
        db.close(true);
    }
});
test('finalization interruptions resume before and after checkpoint removal and partial publication', async () => {
    for (const phase of ['finalizing', 'checkpoint-removed', 'publish', 'all-members-published']) {
        const f = await fixture();
        const controller = new AbortController();
        await expectRestoreAbort(restorePortableArchive({ ...f, signal: controller.signal, onProgress: p => {
                if (p.phase === phase || phase === 'all-members-published' && p.phase === 'publish' && p.completed === p.total)
                    controller.abort();
            } }), controller.signal);
        if (phase === 'publish' || phase === 'all-members-published')
            expect(() => {
                const db = openMemoryDatabase(join(f.destination, 'memory.sqlite'));
                db.close(true);
            }).toThrow('portable restore');
        const report = await restorePortableArchive({ ...f, resume: true });
        const db = openMemoryDatabase(report.dbPath);
        db.close(true);
        expect((await readdir(f.destination)).includes('portable-restore.json')).toBe(true);
    }
}, 30000);
test('changed archive/model and ownerless stage are rejected without adoption', async () => {
    const f = await fixture();
    const controller = new AbortController();
    await expectRestoreAbort(restorePortableArchive({ ...f, signal: controller.signal, onProgress: p => {
            if (p.phase === 'rows')
                controller.abort();
        } }), controller.signal);
    const stage = join(f.root, '.target.portable-restore');
    const receiptPath = join(stage, '.portable-stage.json');
    const original = await readFile(receiptPath, 'utf8');
    const receipt = JSON.parse(original);
    receipt.modelFingerprint = 'f'.repeat(64);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(restorePortableArchive({ ...f, resume: true })).rejects.toThrow('identity');
    await writeFile(receiptPath, original);
    const manifestPath = join(f.archive, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.createdAt = '2026-02-03T04:05:06.000Z';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(restorePortableArchive({ ...f, resume: true })).rejects.toThrow('identity');
    const g = await fixture();
    await mkdir(join(g.root, '.target.portable-restore'));
    await expect(restorePortableArchive({ ...g, resume: true })).rejects.toThrow();
    expect(await readdir(join(g.root, '.target.portable-restore'))).toEqual([]);
});
test('registered tmp-extension asset is published as durable content', async () => {
    const f = await fixture();
    const assetDir = join(f.root, 'source-assets');
    const bytes = Buffer.from('original tmp extension content');
    const hash = sha256(bytes);
    await mkdir(join(assetDir, 'content'));
    await writeFile(join(assetDir, `content/${hash}.tmp`), bytes);
    const db = openMemoryDatabase(join(f.root, 'source.sqlite'));
    db.query("INSERT INTO asset_files(sha256,asset_type,asset_path,byte_size,first_imported_at) VALUES(?,'text',?,?,'2026-01-01 01:02:03')").run(hash, `content/${hash}.tmp`, bytes.length);
    db.close(true);
    const archive = join(f.root, 'asset-archive');
    await exportPortableArchive({ dbPath: join(f.root, 'source.sqlite'), assetDir, destination: archive });
    const report = await restorePortableArchive({ ...f, archive });
    expect(await readFile(join(report.assetDir, `content/${hash}.tmp`))).toEqual(bytes);
    const receipt = JSON.parse(await readFile(join(f.destination, 'portable-restore.json'), 'utf8'));
    expect(receipt.files[`assets/content/${hash}.tmp`].sha256).toBe(hash);
    const live = openMemoryDatabase(report.dbPath);
    live.query('DELETE FROM asset_files WHERE sha256=?').run(hash);
    live.close(true);
    await rm(join(report.assetDir, `content/${hash}.tmp`));
    expect(() => {
        const current = openMemoryDatabase(report.dbPath);
        current.run("INSERT INTO knowledge_nodes(content) VALUES('new live write')");
        current.close(true);
    }).not.toThrow();
});

test('a v47 archive (old deploy) restores into the current schema with empty auto-register tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bara-restore-v47-'));
    roots.push(root);
    const dbPath = join(root, 'source.sqlite');
    const assetDir = join(root, 'source-assets');
    await mkdir(assetDir);
    const source = new Database(dbPath);
    sqliteVec.load(source);
    runMigrations(source, [], DEFAULT_EMBEDDING_DIM);
    source.close();
    const archive = join(root, 'archive');
    await exportPortableArchive({ dbPath, assetDir, destination: archive });
    expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8')).source.schemaVersion).toBe(47);
    const report = await restorePortableArchive({ archive, destination: join(root, 'target') });
    const db = openMemoryDatabase(report.dbPath);
    expect(db.query('SELECT COUNT(*) AS n FROM entity_register_records').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM entity_register_ignores').get()).toEqual({ n: 0 });
    db.close();
});
test('a v48 archive restores with empty auto-register tables (excluded from portable v1)', async () => {
    const f = await fixture();
    const report = await restorePortableArchive(f);
    const db = openMemoryDatabase(report.dbPath);
    expect(db.query('SELECT COUNT(*) AS n FROM entity_register_records').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM entity_register_ignores').get()).toEqual({ n: 0 });
    db.close();
});
