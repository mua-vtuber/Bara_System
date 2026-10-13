export interface RestoreProgress {
    phase: string;
    completed: number;
    total: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}
export interface RestoreReport {
    destination: string;
    dbPath: string;
    assetDir: string;
    counts: Record<string, number>;
    indexCounts: Record<string, number>;
    attachmentBytes: number;
    elapsedMs: number;
}
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMemoryDatabase } from '../db/migrations.ts';
import { runImmediateTransaction } from '../db/baseline-schema.ts';
import { DEFAULT_EMBEDDER_MODEL, embeddingDimensionOf, type EmbedderModel } from '../embedding/factory.ts';
import { PORTABLE_RESTORE_RECEIPT, type RestoreReceipt } from '../db/portable-restore-gate.ts';
import { COLLECTIONS, ALLOCATORS, readPortableCollections } from './collections.ts';
import type { PortableRecord, ValidatedArchive } from './format.ts';
import { archiveFile, assertNoLinks } from './paths.ts';
import { sha256, validatePortableArchive } from './validate.ts';
import { restoreModelFingerprint, rebuildPortableIndexes, verifyPortableIndexes, expectedIndexCounts } from './restore-indexes.ts';
import { STAGE_RECEIPT, CHECKPOINT, exists, readReceipt, writeReceipt, initializeCheckpoints, hasCheckpoints, cursor, checkpoint, collectInventory, verifyInventory, publishRestore, restoreAll, restoreGet, restoreRun, acquireRestoreLock, stageVerifiedAsset } from './restore-state.ts';
function expectedRows(archive: ValidatedArchive): Record<string, PortableRecord[]> {
    const rows = structuredClone(archive.collections);
    const assets = new Map(archive.manifest.attachments.map(a => [a.sha256, a]));
    for (const r of rows.assets!) {
        const a = assets.get(r.sha256 as string)!;
        r.assetPath = `content/${a.sha256}.${a.extension}`;
    }
    for (const name of ['chunkSummaries', 'relationSummaries'])
        for (const row of rows[name]!)
            row.hasEmbedding = 1;
    return rows;
}
function sortedRows(rows: PortableRecord[]): string[] {
    return rows.map(r => JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k => [k, r[k]])))).sort();
}
function verifyDatabase(db: Database, archive: ValidatedArchive, model: EmbedderModel): Record<string, number> {
    const actual = readPortableCollections(db);
    const expected = expectedRows(archive);
    for (const d of COLLECTIONS)
        if (JSON.stringify(sortedRows(actual[d.name]!)) !== JSON.stringify(sortedRows(expected[d.name]!)))
            throw new Error('Restored durable collection mismatch: ' + d.name);
    if (restoreAll(db, 'PRAGMA foreign_key_check').length)
        throw new Error('Restored foreign key violation');
    const integrity = restoreAll<{
        integrity_check: string;
    }>(db, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== 'ok')
        throw new Error('Restored database integrity failure');
    for (const [name, table] of Object.entries(ALLOCATORS)) {
        const row = restoreGet<{
            seq: string;
        }>(db, 'SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name=?', [table]);
        if ((row?.seq ?? '0') !== archive.manifest.allocators[name])
            throw new Error('Restored allocator mismatch: ' + name);
    }
    return verifyPortableIndexes(db, model);
}
function importRows(db: Database, archive: ValidatedArchive): void {
    if (cursor(db, 'rows') === 1)
        return;
    const rows = expectedRows(archive);
    runImmediateTransaction(db, () => {
        db.run('PRAGMA defer_foreign_keys = ON');
        for (const d of COLLECTIONS) {
            const columns = Object.keys(d.fields);
            const insert = db.prepare(`INSERT INTO "${d.table}"(${columns.map(c => '"' + c + '"').join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
            try {
                for (const row of rows[d.name]!) {
                    if (d.name === 'chunkSummaries' || d.name === 'relationSummaries')
                        row.hasEmbedding = 0;
                    insert.run(...columns.map(c => row[d.fields[c]!]!));
                }
            }
            finally {
                insert.finalize();
            }
        }
        for (const [name, table] of Object.entries(ALLOCATORS)) {
            restoreRun(db, 'DELETE FROM sqlite_sequence WHERE name=?', [table]);
            restoreRun(db, 'INSERT INTO sqlite_sequence(name,seq) VALUES(?,CAST(? AS INTEGER))', [table, archive.manifest.allocators[name]!]);
        }
        checkpoint(db, 'rows', 1);
    });
}
export async function restorePortableArchive(options: {
    archive: string;
    destination: string;
    resume?: boolean;
    model?: EmbedderModel;
    signal?: AbortSignal;
    onProgress?: (progress: RestoreProgress) => void;
}): Promise<RestoreReport> {
    const started = Date.now();
    const check = () => options.signal?.throwIfAborted();
    check();
    const archive = await validatePortableArchive(options.archive);
    check();
    const model = options.model ?? DEFAULT_EMBEDDER_MODEL;
    const modelFingerprint = restoreModelFingerprint(model);
    const destination = await assertNoLinks(options.destination, true);
    const delta = relative(archive.directory, destination);
    const inverse = relative(destination, archive.directory);
    if (!delta || (!delta.startsWith('..') && !isAbsolute(delta)) || (!inverse.startsWith('..') && !isAbsolute(inverse)))
        throw new Error('Source and destination overlap');
    const stage = join(dirname(destination), '.' + basename(destination) + '.portable-restore');
    await assertNoLinks(stage, true);
    const counts = Object.fromEntries(COLLECTIONS.map(d => [d.name, archive.collections[d.name]!.length]));
    const attachmentBytes = archive.manifest.attachments.reduce((n, a) => n + a.byteSize, 0);
    const paths = { destination, dbPath: join(destination, 'memory.sqlite'), assetDir: join(destination, 'assets') };
    const identity = (receipt: RestoreReceipt) => {
        if (receipt.destination !== destination || receipt.archiveFingerprint !== archive.fingerprint || receipt.modelFingerprint !== modelFingerprint)
            throw new Error('Restore archive/model/destination identity changed');
    };
    if (await exists(destination)) {
        if (!options.resume)
            throw new Error('Destination already exists');
        let receipt: RestoreReceipt;
        try {
            receipt = await readReceipt(destination, PORTABLE_RESTORE_RECEIPT);
        }
        catch (error) {
            throw new Error('Destination is not owned by this restore; preserved unchanged', { cause: error });
        }
        identity(receipt);
        if (receipt.status === 'complete') {
            await verifyInventory(destination, receipt.files);
            const db = new Database(paths.dbPath, { readonly: true });
            try {
                sqliteVec.load(db);
                return { ...paths, counts, indexCounts: expectedIndexCounts(db, model), attachmentBytes, elapsedMs: receipt.elapsedMs };
            }
            finally {
                db.close(true);
            }
        }
    }
    let receipt: RestoreReceipt;
    if (await exists(stage)) {
        if (!options.resume)
            throw new Error('Restore stage exists; use resume');
        receipt = await readReceipt(stage);
        identity(receipt);
    }
    else {
        if (await exists(destination))
            throw new Error('Destination publication stage is missing; preserved unchanged');
        await mkdir(stage);
        receipt = { format: 'bara-portable-restore', version: 1, operationId: randomUUID(), archiveFingerprint: archive.fingerprint, modelFingerprint, destination, pairingId: randomUUID(), status: 'staging', elapsedMs: 0, files: {} };
        await writeReceipt(stage, receipt, STAGE_RECEIPT, true);
    }
    const release = await acquireRestoreLock(stage, receipt.operationId);
    try {
        receipt = await readReceipt(stage);
        identity(receipt);
    }
    catch (error) {
        await release();
        throw error;
    }
    const priorElapsed = receipt.elapsedMs;
    let phaseStart = Date.now();
    let lastPhase = '';
    const progress = (phase: string, completed: number, total: number) => {
        if (phase !== lastPhase) {
            phaseStart = Date.now();
            lastPhase = phase;
        }
        const duration = Date.now() - phaseStart;
        options.onProgress?.({ phase, completed, total, elapsedMs: priorElapsed + Date.now() - started, estimatedRemainingMs: completed > 0 && duration > 0 ? duration / completed * (total - completed) : null });
    };
    const stageAssets = join(stage, 'assets');
    let db: Database | undefined;
    let indexCounts: Record<string, number> = {};
    try {
        await assertNoLinks(stageAssets, true);
        if (!await exists(stageAssets))
            await mkdir(stageAssets);
        const content = join(stageAssets, 'content');
        await assertNoLinks(content, true);
        if (!await exists(content))
            await mkdir(content);
        check();
        const stageDb = join(stage, 'memory.sqlite');
        await assertNoLinks(stageDb, true);
        db = openMemoryDatabase(stageDb, { embeddingDim: embeddingDimensionOf(model) });
        if (receipt.status === 'staging') {
            initializeCheckpoints(db);
            importRows(db, archive);
            progress('rows', 41, 41);
            check();
            for (let i = 0; i < archive.manifest.attachments.length; i++) {
                check();
                const a = archive.manifest.attachments[i]!;
                const sourceBytes = await readFile(await archiveFile(archive.directory, a.file));
                if (sha256(sourceBytes) !== a.sha256 || sourceBytes.byteLength !== a.byteSize)
                    throw new Error('Archive attachment changed during copy');
                await stageVerifiedAsset(stageAssets, `content/${a.sha256}.${a.extension}`, sourceBytes, a.sha256);
                progress('assets', i + 1, archive.manifest.attachments.length);
            }
            const marker = join(stageAssets, 'bara-asset-pairing.json');
            restoreRun(db, 'INSERT OR IGNORE INTO asset_folder_pairing(id,pairing_id,created_at) VALUES(1,?,?)', [receipt.pairingId, new Date().toISOString()]);
            if (!await exists(marker))
                await writeFile(marker, JSON.stringify({ format: 1, pairingId: receipt.pairingId }), { flag: 'wx' });
            await rebuildPortableIndexes(db, stageAssets, archive.manifest, model, check, progress);
            check();
            indexCounts = verifyDatabase(db, archive, model);
            receipt = { ...receipt, status: 'finalizing', elapsedMs: priorElapsed + Date.now() - started };
            await writeReceipt(stage, receipt);
            progress('finalizing', 0, 1);
            check();
        }
        else if (receipt.status !== 'finalizing')
            throw new Error('Invalid private restore stage state');
        indexCounts = verifyDatabase(db, archive, model);
        const pairing = restoreGet<{
            pairing_id: string;
        }>(db, 'SELECT pairing_id FROM asset_folder_pairing WHERE id=1');
        const marker = JSON.parse(await readFile(await archiveFile(stageAssets, 'bara-asset-pairing.json'), 'utf8'));
        if (pairing?.pairing_id !== receipt.pairingId || marker.format !== 1 || marker.pairingId !== receipt.pairingId)
            throw new Error('Restore pairing mismatch');
        if (hasCheckpoints(db))
            db.run(`DROP TABLE ${CHECKPOINT}`);
        progress('checkpoint-removed', 1, 1);
        check();
        const wal = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)');
        try {
            const result = wal.get() as {
                busy: number;
            };
            if (result.busy !== 0)
                throw new Error('Restore WAL checkpoint is busy');
        }
        finally {
            wal.finalize();
        }
        db.close(true);
        db = undefined;
        for (const suffix of ['-wal', '-shm']) {
            const file = join(stage, 'memory.sqlite' + suffix);
            if (await exists(file)) {
                await assertNoLinks(file);
                await rm(file);
            }
        }
        for (const a of archive.manifest.attachments) {
            const bytes = await readFile(await archiveFile(stageAssets, `content/${a.sha256}.${a.extension}`));
            if (sha256(bytes) !== a.sha256 || bytes.length !== a.byteSize)
                throw new Error('Staging attachment integrity mismatch');
        }
        const files = await collectInventory(stage);
        const expectedFiles = ['memory.sqlite', 'assets/bara-asset-pairing.json', ...archive.manifest.attachments.map(a => `assets/content/${a.sha256}.${a.extension}`)];
        if (Object.keys(files).length !== expectedFiles.length || expectedFiles.some(file => !files[file]))
            throw new Error('Restore attachment publication inventory mismatch');
        receipt = { ...receipt, elapsedMs: priorElapsed + Date.now() - started, files };
        await writeReceipt(stage, receipt);
        check();
        await publishRestore(stage, receipt, check, progress);
        await rm(stage, { recursive: true });
        return { ...paths, counts, indexCounts, attachmentBytes, elapsedMs: priorElapsed + Date.now() - started };
    }
    catch (error) {
        if (receipt.status === 'staging') {
            receipt = { ...receipt, elapsedMs: priorElapsed + Date.now() - started };
            await writeReceipt(stage, receipt);
        }
        throw error;
    }
    finally {
        try {
            if (db) {
                db.close(true);
            }
        }
        finally {
            await release();
        }
    }
}
