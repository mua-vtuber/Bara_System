import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export const PORTABLE_RESTORE_RECEIPT = 'portable-restore.json';
export interface RestoreReceipt {
    format: 'bara-portable-restore';
    version: 1;
    operationId: string;
    archiveFingerprint: string;
    modelFingerprint: string;
    destination: string;
    pairingId: string;
    status: 'staging' | 'finalizing' | 'incomplete' | 'complete';
    elapsedMs: number;
    files: Record<string, {
        sha256: string;
        byteSize: number;
    }>;
}
export function parseRestoreReceipt(value: unknown): RestoreReceipt {
    const r = value as RestoreReceipt;
    const hash = /^[0-9a-f]{64}$/;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!r || r.format !== 'bara-portable-restore' || r.version !== 1 || !uuid.test(r.operationId) || !uuid.test(r.pairingId) || !hash.test(r.archiveFingerprint) || !hash.test(r.modelFingerprint) || typeof r.destination !== 'string' || resolve(r.destination) !== r.destination || !['staging', 'finalizing', 'incomplete', 'complete'].includes(r.status) || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0 || !r.files || typeof r.files !== 'object' || Array.isArray(r.files))
        throw new Error('Invalid portable restore receipt');
    for (const [file, entry] of Object.entries(r.files))
        if (!/^(memory\.sqlite|assets\/bara-asset-pairing\.json|assets\/content\/[a-f0-9]{64}\.[a-z0-9]{1,16})$/.test(file) || !entry || !hash.test(entry.sha256) || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0)
            throw new Error('Invalid portable restore inventory');
    if (['incomplete', 'complete'].includes(r.status) && (!r.files['memory.sqlite'] || !r.files['assets/bara-asset-pairing.json']))
        throw new Error('Invalid portable restore inventory');
    return r;
}
/** Runs before opening SQLite: ordinary databases have no marker and are unaffected. */
export function assertPortableRestoreReady(filename: string): void {
    if (!filename || filename === ':memory:')
        return;
    const directory = dirname(resolve(filename));
    const marker = join(directory, PORTABLE_RESTORE_RECEIPT);
    let info;
    try {
        info = lstatSync(marker);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return;
        throw error;
    }
    try {
        if (info.isSymbolicLink() || !info.isFile())
            throw new Error('invalid marker');
        const receipt = parseRestoreReceipt(JSON.parse(readFileSync(marker, 'utf8')));
        // Completion records publication history. The live DB/assets may subsequently change or move.
        // Snapshot hashes and absolute identity are checked only by explicit restore/resume operations.
        if (receipt.status !== 'complete')
            throw new Error('incomplete marker');
    }
    catch (error) {
        throw new Error('Cannot open portable restore: publication is incomplete or invalid; resume the restore before opening this database.', { cause: error });
    }
}
