import type { Database } from 'bun:sqlite';
import { readFile, writeFile, rename, lstat, mkdir, link, rm, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseRestoreReceipt, PORTABLE_RESTORE_RECEIPT, type RestoreReceipt } from '../db/portable-restore-gate.ts';
import { archiveFile, assertNoLinks } from './paths.ts';
import { sha256 } from './validate.ts';
export const STAGE_RECEIPT = '.portable-stage.json';
export const CHECKPOINT = '_portable_restore_checkpoint';
export async function acquireRestoreLock(stage: string, operationId: string): Promise<() => Promise<void>> {
    const path = join(stage, '.portable-lock.json');
    const recovery = join(stage, '.portable-lock-recovery');
    const token = randomUUID();
    const value = JSON.stringify({ pid: process.pid, hostname: hostname(), operationId, token });
    const create = () => writeFile(path, value, { flag: 'wx' });
    if (await exists(recovery))
        throw new Error('Restore lock recovery is active or requires inspection');
    try {
        await create();
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw error;
        await assertNoLinks(path);
        let prior: {
            pid: number;
            hostname: string;
            operationId: string;
            token: string;
        };
        try {
            prior = JSON.parse(await readFile(path, 'utf8'));
        }
        catch {
            throw new Error('Restore lock owner is unknown; preserve and inspect the stage');
        }
        if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || prior.hostname !== hostname() || prior.operationId !== operationId || typeof prior.token !== 'string')
            throw new Error('Restore lock owner is unknown; preserve and inspect the stage');
        try {
            process.kill(prior.pid, 0);
            throw new Error('Restore is already active; concurrent resume refused');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
                throw new Error('Restore is already active or owner cannot be checked; concurrent resume refused', { cause: e });
        }
        await writeFile(recovery, token, { flag: 'wx' });
        try {
            const current = JSON.parse(await readFile(path, 'utf8'));
            if (current.token !== prior.token)
                throw new Error('Restore lock changed during recovery');
            await rm(path);
            await create();
        }
        finally {
            await rm(recovery, { force: true });
        }
    }
    return async () => {
        if (!await exists(path))
            return;
        await assertNoLinks(path);
        const owner = JSON.parse(await readFile(path, 'utf8'));
        if (owner.token !== token)
            throw new Error('Restore lock changed unexpectedly');
        await rm(path);
    };
}
type Binding = string | number | null | Uint8Array;
/** Restore scans outlive Bun's cache capacity; finalize every statement before publishing the DB. */
export function restoreAll<T>(db: Database, sql: string, params: Binding[] = []): T[] {
    const q = db.prepare(sql);
    try {
        return q.all(...params) as T[];
    }
    finally {
        q.finalize();
    }
}
export function restoreGet<T>(db: Database, sql: string, params: Binding[] = []): T | null {
    const q = db.prepare(sql);
    try {
        return q.get(...params) as T | null;
    }
    finally {
        q.finalize();
    }
}
export function restoreRun(db: Database, sql: string, params: Binding[] = []): void {
    const q = db.prepare(sql);
    try {
        q.run(...params);
    }
    finally {
        q.finalize();
    }
}
async function durableFile(path: string, bytes: string | Uint8Array): Promise<void> {
    const handle = await open(path, 'wx');
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw error;
    }
}
export async function readReceipt(directory: string, name = STAGE_RECEIPT): Promise<RestoreReceipt> {
    return parseRestoreReceipt(JSON.parse(await readFile(await archiveFile(directory, name), 'utf8')));
}
/** Same-directory replacement is only used for this operation's own receipt, never for user data. */
export async function writeReceipt(directory: string, receipt: RestoreReceipt, name = STAGE_RECEIPT, exclusive = false): Promise<void> {
    const path = join(directory, name);
    const temp = path + '.' + randomUUID() + '.tmp';
    await durableFile(temp, JSON.stringify(receipt, null, 2));
    try {
        if (exclusive)
            await link(temp, path);
        else {
            await assertNoLinks(path);
            for (let attempt = 0;; attempt++) {
                try {
                    await rename(temp, path);
                    break;
                }
                catch (error) {
                    // Windows may temporarily deny replacement while a reader/scanner holds the receipt.
                    // Keep the old marker intact; a persistent failure leaves a resumable operation.
                    if (process.platform !== 'win32' || attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''))
                        throw error;
                    await delay(50 * 2 ** attempt);
                }
            }
        }
    }
    finally {
        await rm(temp, { force: true });
    }
}
export function initializeCheckpoints(db: Database): void {
    db.run(`CREATE TABLE IF NOT EXISTS ${CHECKPOINT}(phase TEXT PRIMARY KEY,cursor INTEGER NOT NULL)`);
}
export function cursor(db: Database, phase: string): number {
    return restoreGet<{
        cursor: number;
    }>(db, `SELECT cursor FROM ${CHECKPOINT} WHERE phase=?`, [phase])?.cursor ?? 0;
}
export function checkpoint(db: Database, phase: string, value: number): void {
    restoreRun(db, `INSERT INTO ${CHECKPOINT}(phase,cursor) VALUES(?,?) ON CONFLICT(phase) DO UPDATE SET cursor=excluded.cursor`, [phase, value]);
}
export function hasCheckpoints(db: Database): boolean {
    return !!restoreGet(db, 'SELECT name FROM sqlite_master WHERE name=?', [CHECKPOINT]);
}
export async function verifyInventory(directory: string, files: RestoreReceipt['files']): Promise<void> {
    for (const [file, entry] of Object.entries(files)) {
        const bytes = await readFile(await archiveFile(directory, file));
        if (bytes.byteLength !== entry.byteSize || sha256(bytes) !== entry.sha256)
            throw new Error('Restore member integrity mismatch: ' + file);
    }
}
/** A private temporary member is fully written and checked before an exclusive hard-link publishes it. */
async function publishMember(stage: string, destination: string, file: string, entry: RestoreReceipt['files'][string]): Promise<void> {
    const source = await archiveFile(stage, file);
    const output = join(destination, file);
    let parent = destination;
    for (const part of file.split('/').slice(0, -1)) {
        parent = join(parent, part);
        await assertNoLinks(parent, true);
        if (!await exists(parent))
            await mkdir(parent);
    }
    const temporary = output + '.portable-part';
    if (await exists(output)) {
        await verifyInventory(destination, { [file]: entry });
        if (await exists(temporary)) {
            await assertNoLinks(temporary);
            await rm(temporary);
        }
        return;
    }
    if (await exists(temporary)) {
        await assertNoLinks(temporary);
        const bytes = await readFile(temporary);
        if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byteSize)
            await rm(temporary);
    }
    if (!await exists(temporary)) {
        const bytes = await readFile(source);
        if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byteSize)
            throw new Error('Staging member changed: ' + file);
        await durableFile(temporary, bytes);
    }
    try {
        await link(temporary, output);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw error;
        await verifyInventory(destination, { [file]: entry });
    }
    await rm(temporary, { force: true });
}
export async function stageVerifiedAsset(assetDir: string, file: string, bytes: Uint8Array, hash: string): Promise<void> {
    if (sha256(bytes) !== hash)
        throw new Error('Source asset changed');
    const output = join(assetDir, file);
    await assertNoLinks(output, true);
    const temporary = output + '.portable-part';
    if (await exists(output)) {
        const current = await readFile(output);
        if (current.length !== bytes.length || sha256(current) !== hash)
            throw new Error('Staging attachment integrity mismatch');
        if (await exists(temporary)) {
            await assertNoLinks(temporary);
            await rm(temporary);
        }
        return;
    }
    if (await exists(temporary)) {
        await assertNoLinks(temporary);
        await rm(temporary);
    }
    await durableFile(temporary, bytes);
    try {
        await link(temporary, output);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
export async function publishRestore(stage: string, receipt: RestoreReceipt, check: () => void, progress: (phase: string, done: number, total: number) => void): Promise<void> {
    const destination = receipt.destination;
    if (!await exists(destination)) {
        await mkdir(destination);
        await writeReceipt(destination, { ...receipt, status: 'incomplete' }, PORTABLE_RESTORE_RECEIPT, true);
    }
    const existing = await readReceipt(destination, PORTABLE_RESTORE_RECEIPT);
    if (existing.operationId !== receipt.operationId || existing.archiveFingerprint !== receipt.archiveFingerprint || existing.modelFingerprint !== receipt.modelFingerprint || existing.destination !== destination)
        throw new Error('Destination belongs to a different restore');
    if (existing.status === 'complete') {
        await verifyInventory(destination, existing.files);
        return;
    }
    if (existing.status !== 'incomplete')
        throw new Error('Destination has invalid portable restore state');
    const files = Object.entries(receipt.files);
    for (let i = 0; i < files.length; i++) {
        check();
        const [file, entry] = files[i]!;
        await publishMember(stage, destination, file, entry);
        progress('publish', i + 1, files.length);
    }
    await verifyInventory(destination, receipt.files);
    check();
    await writeReceipt(destination, { ...receipt, status: 'complete' }, PORTABLE_RESTORE_RECEIPT);
}
export async function collectInventory(directory: string): Promise<RestoreReceipt['files']> {
    const files: RestoreReceipt['files'] = {};
    async function scan(dir: string, prefix = ''): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const file = prefix + entry.name;
            if (prefix === '' && (entry.name === STAGE_RECEIPT || entry.name === '.portable-lock.json' || /^\.portable-stage\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name)))
                continue;
            const path = join(dir, entry.name);
            await assertNoLinks(path);
            if (entry.isDirectory())
                await scan(path, file + '/');
            else if (entry.isFile()) {
                const bytes = await readFile(path);
                files[file] = { sha256: sha256(bytes), byteSize: bytes.byteLength };
            }
            else
                throw new Error('Invalid stage member');
        }
    }
    await scan(directory);
    parseRestoreReceipt({ format: 'bara-portable-restore', version: 1, operationId: randomUUID(), pairingId: randomUUID(), archiveFingerprint: '0'.repeat(64), modelFingerprint: '0'.repeat(64), destination: directory, status: 'incomplete', elapsedMs: 0, files });
    return files;
}
