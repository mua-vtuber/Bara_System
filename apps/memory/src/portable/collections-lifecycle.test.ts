import { expect,test } from 'bun:test';
import { openMemoryDatabase } from '../db/migrations.ts';
import { assertSourceSchema,readPortableCollections } from './collections.ts';
test('all41 schema scans and row reads finalize before strict SQLite close',()=>{
 const db=openMemoryDatabase(':memory:');assertSourceSchema(db);expect(Object.keys(readPortableCollections(db))).toHaveLength(41);
 expect(()=>db.close(true)).not.toThrow();
});
