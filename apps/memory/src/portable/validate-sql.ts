import { openMemoryDatabase } from '../db/migrations.ts';
import { COLLECTIONS } from './collections.ts';
import type { PortableRecord } from './format.ts';

/** Validate the complete relational contract with the actual current schema, entirely in memory.
 * Deferred foreign keys permit the archive's domain ordering; SQLite enforces all CHECK/UNIQUE
 * constraints and its partial/expression indexes without a second, drifting constraint list.
 * No target, source database, model or ingest workflow is involved.
 */
export function validateRelationalConstraints(collections: Record<string, PortableRecord[]>): void {
  const db = openMemoryDatabase(':memory:');
  try {
    db.run('BEGIN');
    db.run('PRAGMA defer_foreign_keys = ON');
    for (const descriptor of COLLECTIONS) {
      const columns = Object.keys(descriptor.fields);
      const fields = Object.values(descriptor.fields);
      const statement = db.prepare(
        'INSERT INTO "' + descriptor.table + '" (' + columns.map(column => '"' + column + '"').join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')'
      );
      try {
        for (const record of collections[descriptor.name]!) {
          statement.run(...fields.map(field => record[field]!));
        }
      } catch (error) {
        throw new Error('Invalid archive relational constraints: ' + descriptor.name, { cause: error });
      } finally {
        statement.finalize();
      }
    }
    try {
      db.run('COMMIT');
    } catch (error) {
      throw new Error('Invalid archive relational constraints: foreign keys', { cause: error });
    }
  } finally {
    if (db.inTransaction) db.run('ROLLBACK');
    (db as typeof db & { clearQueryCache(): void }).clearQueryCache();
    db.close(true);
  }
}
