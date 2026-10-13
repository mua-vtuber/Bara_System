import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestoreFixture } from './test-fixtures/restore-fixture.ts';
import { exportPortableArchive } from './export.ts';
import { validatePortableArchive, sha256 } from './validate.ts';
import { restorePortableArchive } from './restore.ts';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});
async function archiveFixture() {
    const root = await mkdtemp(join(tmpdir(), 'bara-document-owners-'));
    roots.push(root);
    const source = await createRestoreFixture(root);
    const archive = join(root, 'archive');
    await exportPortableArchive({ ...source, destination: archive });
    return { root, archive };
}
async function changeOwners(archive: string, change: (rows: Array<Record<string, unknown>>) => void) {
    const path = join(archive, 'collections/documentOwners.json');
    const rows = JSON.parse(await readFile(path, 'utf8'));
    change(rows);
    const bytes = JSON.stringify(rows);
    await writeFile(path, bytes);
    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.collections.documentOwners.count = rows.length;
    manifest.collections.documentOwners.sha256 = sha256(bytes);
    await writeFile(manifestPath, JSON.stringify(manifest));
}
test('ownerless document is rejected before restore creates target or stage', async () => {
    const f = await archiveFixture();
    await changeOwners(f.archive, rows => rows.splice(0));
    const before = (await readdir(f.root)).sort();
    await expect(validatePortableArchive(f.archive)).rejects.toThrow('Document ownership');
    await expect(restorePortableArchive({ archive: f.archive, destination: join(f.root, 'target') })).rejects.toThrow('Document ownership');
    expect((await readdir(f.root)).sort()).toEqual(before);
});
test('document owner must exist in active or archived memories', async () => {
    const f = await archiveFixture();
    await changeOwners(f.archive, rows => rows[0]!.nodeId = 123456789);
    await expect(validatePortableArchive(f.archive)).rejects.toThrow('Document owner memory');
});
test('archived document owner and intentional historical dangling references remain valid', async () => {
    const f = await archiveFixture();
    await changeOwners(f.archive, rows => rows[0]!.nodeId = 777);
    const validated = await validatePortableArchive(f.archive);
    expect(validated.collections.documentOwners![0]!.nodeId).toBe(777);
    expect(validated.collections.revisions![0]!.oldNodeId).toBe(999999);
    expect(validated.collections.conceptLinks![0]!.sourceConceptId).toBe('deleted_historical_concept');
});
