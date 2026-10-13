import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMemoryDatabase } from '../src/db/migrations.ts';
import { parsePortableArgs } from './portable-memory.ts';

const script = join(import.meta.dir, 'portable-memory.ts');
const unusedCache = join(tmpdir(), `portable-cli-must-not-create-cache-${crypto.randomUUID()}`);
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, BARA_HF_CACHE_DIR: unusedCache },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('portable CLI arguments', () => {
  test('requires explicit command paths and accepts registered model', () => {
    expect(parsePortableArgs(['export', '--db', 'source.sqlite', '--assets', 'assets', '--out', 'archive']))
      .toEqual({ command: 'export', db: 'source.sqlite', assets: 'assets', out: 'archive' });
    expect(parsePortableArgs(['restore', '--archive', 'archive', '--out', 'target', '--resume', '--model', 'bge-m3']))
      .toEqual({ command: 'restore', archive: 'archive', out: 'target', resume: true, model: 'bge-m3' });
    expect(parsePortableArgs(['verify', '--archive', 'archive'])).toEqual({ command: 'verify', archive: 'archive' });
  });
  test('help needs no paths', () => {
    expect(parsePortableArgs(['--help'])).toEqual({ command: 'help' });
    expect(parsePortableArgs(['restore', '--help'])).toEqual({ command: 'help' });
  });
  test('rejects missing, unknown, duplicate, empty and unsupported arguments', () => {
    for (const args of [[], ['wat'], ['export'], ['verify', '--archive'],
      ['verify', '--archive', 'x', '--out', 'y'], ['verify', '--archive', 'x', '--archive', 'y'],
      ['verify', '--archive', ''], ['verify', 'x'], ['restore', '--archive', 'x', '--out', 'y', '--resume', '--resume'],
      ['restore', '--archive', 'x', '--out', 'y', '--model', 'future-model'], ['verify', '--archive', '--help']]) {
      expect(() => parsePortableArgs(args)).toThrow();
    }
  });
  test('help and argument errors work in subprocess without selecting a live DB', async () => {
    const help = await run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('portable:export');
    const failure = await run('export');
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toContain('--db');
  });
});

test('real export and read-only verify subprocesses preserve source and reject existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portable-cli-'));
  try {
    const dbPath = join(root, 'source.sqlite');
    const assets = join(root, 'assets');
    await mkdir(assets);
    const db = openMemoryDatabase(dbPath);
    try { db.run('INSERT INTO knowledge_nodes(content) VALUES (?)', ['portable CLI 원문']); }
    finally { db.close(); }
    const before = await readFile(dbPath);
    const archive = join(root, 'archive');
    const exported = await run('export', '--db', dbPath, '--assets', assets, '--out', archive);
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.stdout).collections.memories.count).toBe(1);
    expect(await readFile(dbPath)).toEqual(before);
    const files = (await readdir(archive, { recursive: true })).sort();
    const snapshot = await Promise.all(files.map(async path => {
      const full = join(archive, path);
      return (await stat(full)).isFile() ? [path, await readFile(full)] : [path, null];
    }));
    const verified = await run('verify', '--archive', archive);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout).valid).toBe(true);
    expect((await readdir(archive, { recursive: true })).sort()).toEqual(files);
    expect(await Promise.all(files.map(async path => {
      const full = join(archive, path);
      return (await stat(full)).isFile() ? [path, await readFile(full)] : [path, null];
    }))).toEqual(snapshot);
    expect(await stat(unusedCache).then(() => true, () => false)).toBe(false);
    const rejected = await run('export', '--db', dbPath, '--assets', assets, '--out', archive);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe('');
    const manifestPath = join(archive, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = 999;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const invalidBytes = await readFile(manifestPath);
    const invalid = await run('verify', '--archive', archive);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(await readFile(manifestPath)).toEqual(invalidBytes);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 30_000);
