import { extOfAssetPath } from '../assets/asset-store.ts';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { COLLECTIONS, ALLOCATORS, INDEX_TABLES, SUPPORTED_SOURCE_SCHEMA_VERSIONS, excludedTablesFor } from './collections.ts';
import type { PortableManifestV1, PortableRecord, ValidatedArchive } from './format.ts';
import { validateRelationalConstraints } from './validate-sql.ts';
import { assertPortableScalar } from './format.ts';
import { archiveFile, assertNoLinks } from './paths.ts';
function decodeJson(bytes: Uint8Array, context: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', {
      fatal: true
    }).decode(bytes));
  }
  catch (error) {
    throw new Error('Invalid UTF-8/JSON in ' + context, {
      cause: error
    });
  }
}
export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object: ' + context);
  }
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(k => !keys.includes(k))) {
    throw new Error('Unexpected or missing fields: ' + context);
  }
}
const hashPattern = /^[a-f0-9]{64}$/;
const extensionPattern = /^[a-z0-9]{1,16}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
function count(value: unknown, context: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid count: ' + context);
  }
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !hashPattern.test(value)) {
    throw new Error('Invalid sha256');
  }
}
function text(value: unknown): asserts value is string {
  assertPortableScalar(value, 'manifest string');
  if (typeof value !== 'string') {
    throw new Error('Expected string');
  }
}
export function validateManifest(value: unknown): PortableManifestV1 {
  const m = object(value, 'manifest');
  exactKeys(m, ['format', 'version', 'archiveId', 'createdAt', 'source', 'collections', 'allocators', 'attachments', 'indexes', 'exclusions'], 'manifest');
  if (m.format !== 'bara-memory' || m.version !== 1) {
    throw new Error('Unsupported archive format/version');
  }
  text(m.archiveId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.archiveId)) {
    throw new Error('Invalid archive ID');
  }
  text(m.createdAt);
  if (!Number.isFinite(Date.parse(m.createdAt))) {
    throw new Error('Invalid creation timestamp');
  }
  const source = object(m.source, 'source');
  exactKeys(source, ['appVersion', 'schemaVersion'], 'source');
  text(source.appVersion);
  if (!SUPPORTED_SOURCE_SCHEMA_VERSIONS.includes(source.schemaVersion as number)) {
    throw new Error('Unsupported source schema version');
  }
  const collections = object(m.collections, 'collections');
  exactKeys(collections, COLLECTIONS.map(d => d.name), 'collections');
  for (const d of COLLECTIONS) {
    const entry = object(collections[d.name], d.name);
    exactKeys(entry, ['file', 'count', 'sha256'], d.name);
    if (entry.file !== `collections/${d.name}.json`) {
      throw new Error('Invalid collection path');
    }
    count(entry.count, d.name);
    hash(entry.sha256);
  }
  const allocators = object(m.allocators, 'allocators');
  exactKeys(allocators, Object.keys(ALLOCATORS), 'allocators');
  for (const v of Object.values(allocators)) {
    text(v);
    if (!decimalPattern.test(v) || BigInt(v) > 9223372036854775807n) {
      throw new Error('Invalid allocator');
    }
  }
  const indexes = object(m.indexes, 'indexes');
  exactKeys(indexes, ['policy', 'sourceCounts'], 'indexes');
  if (indexes.policy !== 'recompute') {
    throw new Error('Unsupported index policy');
  }
  const counts = object(indexes.sourceCounts, 'sourceCounts');
  exactKeys(counts, INDEX_TABLES, 'sourceCounts');
  for (const [k, v] of Object.entries(counts))
    count(v, k);
  if (!Array.isArray(m.attachments)) {
    throw new Error('Invalid attachments');
  }
  const seen = new Set<string>();
  for (const value of m.attachments) {
    const a = object(value, 'attachment');
    exactKeys(a, ['sha256', 'extension', 'byteSize', 'file'], 'attachment');
    hash(a.sha256);
    text(a.extension);
    if (!extensionPattern.test(a.extension)) {
      throw new Error('Unsafe attachment extension');
    }
    count(a.byteSize, 'attachment');
    if (a.file !== `attachments/content/${a.sha256}.${a.extension}` || seen.has(a.sha256)) {
      throw new Error('Invalid or duplicate attachment');
    }
    seen.add(a.sha256);
  }
  if (!Array.isArray(m.exclusions)) {
    throw new Error('Invalid exclusions');
  }
  const expected = [...Object.keys(excludedTablesFor(source.schemaVersion as number)), 'sqlite-internals', 'fts-indexes', 'vector-indexes'];
  const excluded = new Set<string>();
  for (const v of m.exclusions) {
    const e = object(v, 'exclusion');
    exactKeys(e, ['name', 'reason'], 'exclusion');
    text(e.name);
    text(e.reason);
    if (!expected.includes(e.name) || excluded.has(e.name) || !e.reason) {
      throw new Error('Invalid exclusion');
    }
    excluded.add(e.name);
  }
  if (excluded.size !== expected.length) {
    throw new Error('Missing exclusions');
  }
  return m as unknown as PortableManifestV1;
}
export function validatePortableRecords(collections: Record<string, PortableRecord[]>): void {
  const identities = new Map<string, Set<string>>();
  for (const d of COLLECTIONS) {
    const rows = collections[d.name];
    if (!Array.isArray(rows)) {
      throw new Error('Missing collection: ' + d.name);
    }
    const seen = new Set<string>();
    identities.set(d.name, seen);
    for (const value of rows) {
      const row = object(value, d.name);
      exactKeys(row, Object.values(d.fields), d.name);
      for (const [field, spec] of Object.entries(d.types)) {
        const v = assertPortableScalar(row[field], d.name + '.' + field);
        if (v === null) {
          if (!spec.nullable) {
            throw new Error('Nonnullable field: ' + d.name + '.' + field);
          }
        }
        else if (spec.type === 'TEXT' ? typeof v !== 'string' : typeof v !== 'number' || (spec.type === 'INTEGER' && !Number.isSafeInteger(v))) {
          throw new Error('Invalid field type: ' + d.name + '.' + field);
        }
      }
      if (d.primaryKey.length) {
        const key = JSON.stringify(d.primaryKey.map(k => row[k]));
        if (seen.has(key)) {
          throw new Error('Duplicate identity: ' + d.name);
        }
        seen.add(key);
      }
    }
  }
  for (const d of COLLECTIONS)
    for (const ref of d.references) {
      const targets = new Set(collections[ref.collection]!.map(r => r[ref.targetField]));
      for (const row of collections[d.name]!) {
        const value = row[ref.field];
        if (value !== null && !targets.has(value)) {
          throw new Error('Dangling reference: ' + d.name + '.' + ref.field);
        }
      }
    }
  // Document startup cleanup treats ownerless records as released. Ownership must survive
  // transport even though its node reference intentionally spans active and archived tables.
  const documentOwners = new Set(collections.documentOwners!.map(owner => owner.documentId));
  for (const document of collections.documents!) {
    if (!documentOwners.has(document.documentId)) {
      throw new Error('Document ownership missing: ' + document.documentId);
    }
  }
  const memoryIds = new Set([...collections.memories!, ...collections.archivedMemories!].map(memory => memory.id));
  for (const owner of collections.documentOwners!) {
    if (!memoryIds.has(owner.nodeId)) {
      throw new Error('Document owner memory missing: ' + owner.nodeId);
    }
  }
  // Thumbnail references are not declared as foreign keys by the source schema.
  const assets = new Set(collections.assets!.map(r => r.sha256));
  for (const image of collections.images!)
    if (image.thumbSha256 !== null && !assets.has(image.thumbSha256)) {
      throw new Error('Missing thumbnail asset');
    }
  validateRelationalConstraints(collections);
}
/** Validate every byte before a restorer can create its target. No models or source database are opened. */
export async function validatePortableArchive(directory: string): Promise<ValidatedArchive> {
  const root = await assertNoLinks(directory);
  if (!(await lstat(root)).isDirectory()) {
    throw new Error('Archive is not a directory');
  }
  const manifestBytes = await readFile(await archiveFile(root, 'manifest.json'));
  const manifest = validateManifest(decodeJson(manifestBytes, 'manifest'));
  const collections: Record<string, PortableRecord[]> = {};
  const files = new Set(['manifest.json']);
  for (const d of COLLECTIONS) {
    const entry = manifest.collections[d.name]!;
    const bytes = await readFile(await archiveFile(root, entry.file));
    if (sha256(bytes) !== entry.sha256) {
      throw new Error('Collection hash mismatch: ' + d.name);
    }
    const rows: unknown = decodeJson(bytes, d.name);
    if (!Array.isArray(rows) || rows.length !== entry.count) {
      throw new Error('Collection count mismatch: ' + d.name);
    }
    collections[d.name] = rows as PortableRecord[];
    files.add(entry.file);
  }
  validatePortableRecords(collections);
  for (const [name] of Object.entries(ALLOCATORS)) {
    let maximum = 0n;
    for (const row of collections[name]!)
      maximum = maximum > BigInt(row.id as number) ? maximum : BigInt(row.id as number);
    if (name === 'memories') {
      for (const row of collections.archivedMemories!)
        maximum = maximum > BigInt(row.id as number) ? maximum : BigInt(row.id as number);
    }
    if (BigInt(manifest.allocators[name]!) < maximum) {
      throw new Error('Allocator below preserved IDs: ' + name);
    }
  }
  const assetRows = new Map(collections.assets!.map(row => [row.sha256, row]));
  if (assetRows.size !== manifest.attachments.length) {
    throw new Error('Attachment inventory mismatch');
  }
  for (const attachment of manifest.attachments) {
    const row = assetRows.get(attachment.sha256);
    if (!row || row.byteSize !== attachment.byteSize || typeof row.assetPath !== 'string' || extOfAssetPath(row.assetPath) !== attachment.extension) {
      throw new Error('Attachment metadata mismatch');
    }
    const bytes = await readFile(await archiveFile(root, attachment.file));
    if (bytes.byteLength !== attachment.byteSize || sha256(bytes) !== attachment.sha256) {
      throw new Error('Attachment hash/size mismatch');
    }
    files.add(attachment.file);
  }
  async function inspect(dir: string, prefix = ''): Promise<void> {
    for (const item of await readdir(dir, {
      withFileTypes: true
    })) {
      const name = prefix + item.name;
      const path = join(dir, item.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error('Symbolic link forbidden');
      }
      if (stat.isDirectory()) {
        if (!['collections', 'attachments', 'attachments/content'].includes(name)) {
          throw new Error('Unexpected archive directory');
        }
        await inspect(path, name + '/');
      }
      else if (!stat.isFile() || !files.has(name)) {
        throw new Error('Unexpected archive file: ' + name);
      }
    }
  }
  await inspect(root);
  return {
    directory: root, manifest, fingerprint: sha256(manifestBytes), collections
  };
}
