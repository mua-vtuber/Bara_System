import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDatabase } from '../db/migrations.ts';
import { exportPortableArchive } from './export.ts';
import { restorePortableArchive } from './restore.ts';
import { createEmbedder } from '../embedding/factory.ts';
import { PersonRepository } from '../db/store-internal/person-repository.ts';
import { restoreAll } from './restore-state.ts';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'bara-restore-review-'));
    roots.push(root);
    const dbPath = join(root, 'source.sqlite');
    const assetDir = join(root, 'assets');
    await mkdir(assetDir);
    return { root, dbPath, assetDir, archive: join(root, 'archive'), destination: join(root, 'target') };
}
test('cold subprocess restores at least two concepts into both actual vector spaces', async () => {
    const f = await fixture();
    const source = openMemoryDatabase(f.dbPath);
    source.run("INSERT INTO concept_nodes(concept_id,name) VALUES('cpt_coffee','coffee'),('cpt_tea','tea')");
    source.close(true);
    await exportPortableArchive({ ...f, destination: f.archive });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../scripts/portable-memory.ts'), 'restore', '--archive', f.archive, '--out', f.destination], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).not.toContain('Embedding unavailable');
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.indexCounts.concept_vec).toBe(2);
    expect(report.indexCounts.concept_siglip_vec).toBe(2);
    const db = openMemoryDatabase(report.dbPath);
    try {
        for (const table of ['concept_vec', 'concept_siglip_vec']) {
            const rows = restoreAll<{
                concept_rowid: number;
                embedding: Uint8Array;
            }>(db, `SELECT concept_rowid,embedding FROM ${table}`);
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                const q = db.prepare(`SELECT concept_rowid,distance FROM ${table} WHERE embedding MATCH ? AND k=1`);
                try {
                    const hit = q.get(row.embedding) as {
                        concept_rowid: number;
                        distance: number;
                    };
                    expect(hit.concept_rowid).toBe(row.concept_rowid);
                    expect(hit.distance).toBeLessThan(0.00001);
                }
                finally {
                    q.finalize();
                }
            }
        }
    }
    finally {
        db.close(true);
    }
}, 180000);
test('person restore vectors match actual production trimming and fallback without rewriting fields', async () => {
    const f = await fixture();
    const people = [{ id: 'psn_blank', name: '  coffee person  ', embedding: '' }, { id: 'psn_space', name: '\t tea person \n', embedding: '\t \n' }, { id: 'psn_custom', name: '  fallback name ', embedding: ' \t custom remembered person \n' }];
    const source = openMemoryDatabase(f.dbPath);
    for (const person of people)
        source.query('INSERT INTO persons(person_id,display_name,embedding_text) VALUES(?,?,?)').run(person.id, person.name, person.embedding);
    source.close(true);
    await exportPortableArchive({ ...f, destination: f.archive });
    const report = await restorePortableArchive({ archive: f.archive, destination: f.destination });
    const restored = openMemoryDatabase(report.dbPath);
    const reference = openMemoryDatabase(':memory:');
    try {
        const embedder = createEmbedder();
        await embedder.load();
        const repository = new PersonRepository(reference, embedder);
        for (const person of people) {
            reference.query('INSERT INTO persons(person_id,display_name,embedding_text) VALUES(?,?,?)').run(person.id, person.name, person.embedding);
            await repository.applyPersonEmbedding(person.id);
        }
        for (const person of people) {
            const get = (db: typeof reference) => restoreAll<{
                embedding: Uint8Array;
                embedding_text: string;
                display_name: string;
            }>(db, 'SELECT v.embedding,p.embedding_text,p.display_name FROM person_vec v JOIN persons p ON p.rowid=v.person_rowid WHERE p.person_id=?', [person.id])[0]!;
            const actual = get(restored);
            const expected = get(reference);
            expect(actual.embedding_text).toBe(person.embedding);
            expect(actual.display_name).toBe(person.name);
            const gotFloats = new Float32Array(actual.embedding.buffer, actual.embedding.byteOffset, 1024);
            const expectedFloats = new Float32Array(expected.embedding.buffer, expected.embedding.byteOffset, 1024);
            expect(Math.max(...gotFloats.map((v, i) => Math.abs(v - expectedFloats[i]!)))).toBeLessThan(0.00001);
        }
    }
    finally {
        restored.close(true);
        reference.close(true);
    }
}, 180000);
