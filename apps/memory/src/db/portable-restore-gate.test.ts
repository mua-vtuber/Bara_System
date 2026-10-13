import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openMemoryDatabase } from './migrations.ts';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
test('DB opening refuses incomplete and malformed portable publication before creating database', () => {
    const root = mkdtempSync(join(tmpdir(), 'bara-gate-'));
    roots.push(root);
    for (const value of ['{}', 'invalid JSON', JSON.stringify({ format: 'bara-portable-restore', version: 1, status: 'incomplete' })]) {
        writeFileSync(join(root, 'portable-restore.json'), value);
        expect(() => openMemoryDatabase(join(root, 'memory.sqlite'))).toThrow('portable restore');
    }
});
test('normal database without portable publication receipt still opens', () => {
    const db = openMemoryDatabase(':memory:');
    expect(db.query('SELECT COUNT(*) AS c FROM schema_version').get()).toEqual({ c: 1 + MIGRATIONS.length });
    db.close();
});
test('completed receipt allows live attachment deletion, new writes and folder relocation', () => {
    const root = mkdtempSync(join(tmpdir(), 'bara-gate-live-'));
    roots.push(root);
    const dbPath = join(root, 'memory.sqlite');
    const db = openMemoryDatabase(dbPath);
    db.close(true);
    writeFileSync(join(root, 'portable-restore.json'), JSON.stringify({ format: 'bara-portable-restore', version: 1, operationId: randomUUID(), pairingId: randomUUID(), archiveFingerprint: '0'.repeat(64), modelFingerprint: '0'.repeat(64), destination: root, status: 'complete', elapsedMs: 1, files: { 'memory.sqlite': { sha256: '0'.repeat(64), byteSize: 1 }, 'assets/bara-asset-pairing.json': { sha256: '0'.repeat(64), byteSize: 1 }, ['assets/content/' + '0'.repeat(64) + '.txt']: { sha256: '0'.repeat(64), byteSize: 1 } } }));
    let reopened;
    expect(() => {
        reopened = openMemoryDatabase(dbPath);
        reopened.run("INSERT INTO knowledge_nodes(content) VALUES('normal new write')");
        reopened.close(true);
    }).not.toThrow();
    const moved = root + '-moved';
    renameSync(root, moved);
    roots.push(moved);
    expect(() => {
        const current = openMemoryDatabase(join(moved, 'memory.sqlite'));
        current.close(true);
    }).not.toThrow();
});
