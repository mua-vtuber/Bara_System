import { assertPortableRestoreReady } from '../db/portable-restore-gate.ts';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { extOfAssetPath } from '../assets/asset-store.ts';
import { COLLECTIONS, ALLOCATORS, INDEX_TABLES, assertSourceSchema, exclusionEntriesFor, readPortableCollections } from './collections.ts';
import type { PortableManifestV1 } from './format.ts';
import { assertNoLinks, archiveFile, assertNewDestination, publishDirectory } from './paths.ts';
import { sha256, validatePortableArchive, validatePortableRecords } from './validate.ts';
import memoryPackage from '../../package.json';
export async function exportPortableArchive(options: {
  dbPath: string;
  assetDir: string;
  destination: string;
  signal?: AbortSignal;
}): Promise<PortableManifestV1> {
  const { signal } = options;
  const check = () => signal?.throwIfAborted();
  check();
  const dbPath = await assertNoLinks(options.dbPath);
  const assetDir = await assertNoLinks(options.assetDir);
  const destination = await assertNewDestination(options.destination, [dbPath, assetDir]);
  assertPortableRestoreReady(dbPath);
  const db = new Database(dbPath, {
    readonly: true, safeIntegers: true
  });
  let stage: string | undefined;
  try {
    sqliteVec.load(db);
    db.run('PRAGMA query_only = ON');
    db.run('BEGIN');
    const sourceVersion = assertSourceSchema(db);
    const collections = readPortableCollections(db);
    validatePortableRecords(collections);
    check();
    stage = await mkdtemp(join(dirname(destination), '.' + basename(destination) + '.export-'));
    await mkdir(join(stage, 'collections'));
    await mkdir(join(stage, 'attachments/content'), {
      recursive: true
    });
    const manifest: PortableManifestV1 = {
      format: 'bara-memory', version: 1, archiveId: randomUUID(), createdAt: new Date().toISOString(), source: {
        appVersion: memoryPackage.version, schemaVersion: sourceVersion
      }, collections: {}, allocators: {}, attachments: [], indexes: {
        policy: 'recompute', sourceCounts: {}
      }, exclusions: [...exclusionEntriesFor(sourceVersion), {
          name: 'sqlite-internals', reason: 'SQLite implementation state is not portable'
        }, {
          name: 'fts-indexes', reason: 'Full-text indexes are recomputed'
        }, {
          name: 'vector-indexes', reason: 'Vectors lack trustworthy source model provenance and are recomputed'
        }]
    };
    for (const d of COLLECTIONS) {
      check();
      const bytes = JSON.stringify(collections[d.name]);
      const file = `collections/${d.name}.json`;
      await writeFile(join(stage, file), bytes, {
        flag: 'wx'
      });
      manifest.collections[d.name] = {
        file, count: collections[d.name]!.length, sha256: sha256(bytes)
      };
    }
    for (const [name, table] of Object.entries(ALLOCATORS)) {
      const sequence = db.query('SELECT CAST(seq AS TEXT) AS value FROM sqlite_sequence WHERE name=?').get(table) as {
        value: string;
      } | null;
      let maximum = BigInt(sequence?.value ?? '0');
      for (const row of collections[name]!)
        maximum = maximum > BigInt(row.id as number) ? maximum : BigInt(row.id as number);
      if (name === 'memories') {
        for (const row of collections.archivedMemories!)
          maximum = maximum > BigInt(row.id as number) ? maximum : BigInt(row.id as number);
      }
      manifest.allocators[name] = maximum.toString();
    }
    for (const table of INDEX_TABLES) {
      const result = db.query(`SELECT CAST(COUNT(*) AS TEXT) AS count FROM "${table}"`).get() as {
        count: string;
      };
      const count = Number(result.count);
      if (!Number.isSafeInteger(count)) {
        throw new Error('Unsafe index count');
      }
      manifest.indexes.sourceCounts[table] = count;
    }
    for (const row of collections.assets!) {
      check();
      const hash = row.sha256;
      const extension = typeof row.assetPath === 'string' ? extOfAssetPath(row.assetPath) : null;
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !extension || !/^[a-z0-9]{1,16}$/.test(extension)) {
        throw new Error('Invalid registered asset path/hash');
      }
      const bytes = await readFile(await archiveFile(assetDir, `content/${hash}.${extension}`));
      if (sha256(bytes) !== hash || bytes.byteLength !== row.byteSize) {
        throw new Error('Source asset hash/size mismatch');
      }
      const file = `attachments/content/${hash}.${extension}`;
      await writeFile(join(stage, file), bytes, {
        flag: 'wx'
      });
      manifest.attachments.push({
        sha256: hash, extension, byteSize: bytes.byteLength, file
      });
    }
    db.run('COMMIT');
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx'
    });
    await validatePortableArchive(stage);
    check();
    await publishDirectory(stage, destination);
    return manifest;
  }
  finally {
    if (db.inTransaction) {
      db.run('ROLLBACK');
    }
    db.close();
    if (stage) {
      await rm(stage, {
        recursive: true, force: true
      });
    }
  }
}
