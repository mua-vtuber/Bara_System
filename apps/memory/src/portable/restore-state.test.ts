import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireRestoreLock, stageVerifiedAsset } from './restore-state.ts';
import { sha256 } from './validate.ts';
import { openMemoryDatabase } from '../db/migrations.ts';
import { exportPortableArchive } from './export.ts';
import { restorePortableArchive } from './restore.ts';
import { expectRestoreAbort } from './test-fixtures/restore-fixture.ts';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});
async function root() {
    const path = await mkdtemp(join(tmpdir(), 'bara-state-'));
    roots.push(path);
    return path;
}
test('lock refuses active and unknown owners without changing their receipts', async () => {
    const stage = await root();
    const id = randomUUID();
    const release = await acquireRestoreLock(stage, id);
    const path = join(stage, '.portable-lock.json');
    const before = await readFile(path);
    await expect(acquireRestoreLock(stage, id)).rejects.toThrow('active');
    expect(await readFile(path)).toEqual(before);
    await release();
    await writeFile(path, 'unknown owner');
    await expect(acquireRestoreLock(stage, id)).rejects.toThrow('unknown');
    expect(await readFile(path, 'utf8')).toBe('unknown owner');
});
test('crash-stale lock from a terminated test child is recovered conservatively', async () => {
    const stage = await root();
    const id = randomUUID();
    const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
    await child.exited;
    await writeFile(join(stage, '.portable-lock.json'), JSON.stringify({ pid: child.pid, hostname: hostname(), operationId: id, token: randomUUID() }));
    const release = await acquireRestoreLock(stage, id);
    await release();
    expect(await readdir(stage)).toEqual([]);
});
test('interrupted asset temporary file resumes with verified bytes and detects existing tamper', async () => {
    const assets = await root();
    await mkdir(join(assets, 'content'));
    const bytes = Buffer.from('original stored bytes');
    const hash = sha256(bytes);
    const file = `content/${hash}.txt`;
    await writeFile(join(assets, file + '.portable-part'), 'partial crash bytes');
    await stageVerifiedAsset(assets, file, bytes, hash);
    expect(await readFile(join(assets, file))).toEqual(bytes);
    expect(await readdir(join(assets, 'content'))).toEqual([hash + '.txt']);
    await writeFile(join(assets, file), 'tampered');
    await expect(stageVerifiedAsset(assets, file, bytes, hash)).rejects.toThrow('integrity');
    expect(await readFile(join(assets, file), 'utf8')).toBe('tampered');
});
test('resume rejects a linked stage asset folder before making external directories', async () => {
    const r = await root();
    const assets = join(r, 'source-assets');
    await mkdir(assets);
    const source = join(r, 'source.sqlite');
    const db = openMemoryDatabase(source);
    db.close(true);
    const archive = join(r, 'archive');
    await exportPortableArchive({ dbPath: source, assetDir: assets, destination: archive });
    const destination = join(r, 'target');
    const controller = new AbortController();
    await expectRestoreAbort(restorePortableArchive({ archive, destination, signal: controller.signal, onProgress: p => {
            if (p.phase === 'rows')
                controller.abort();
        } }), controller.signal);
    const stage = join(r, '.target.portable-restore');
    await rm(join(stage, 'assets'), { recursive: true });
    const external = join(r, 'external');
    await mkdir(external);
    await writeFile(join(external, 'keep'), 'untouched');
    await symlink(external, join(stage, 'assets'), 'junction');
    await expect(restorePortableArchive({ archive, destination, resume: true })).rejects.toThrow('link');
    expect(await readdir(external)).toEqual(['keep']);
});
