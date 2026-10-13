/** Populated real-schema data fixture; it implements no production interface. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openMemoryDatabase } from '../../db/migrations.ts';
import { runImmediateTransaction } from '../../db/baseline-schema.ts';
import { COLLECTIONS } from '../collections.ts';
import { sha256 } from '../validate.ts';
import type { PortableRecord } from '../format.ts';
import { expect } from 'bun:test';
import { encodePng } from '../../memory/image-preserve/decode.ts';
export async function expectRestoreAbort(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
    let failure: unknown;
    try {
        await work;
    }
    catch (error) {
        failure = error;
    }
    expect(signal.aborted).toBe(true);
    expect(failure).toBe(signal.reason);
    expect((failure as Error).name).toBe('AbortError');
}
export async function createRestoreFixture(root: string, embeddingDim = 384): Promise<{
    dbPath: string;
    assetDir: string;
    png: Buffer;
    imageHash: string;
    storedAssets: Array<{
        file: string;
        bytes: Uint8Array;
    }>;
}> {
    const dbPath = join(root, 'source.sqlite');
    const assetDir = join(root, 'source-assets');
    await mkdir(join(assetDir, 'content'), { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const imageHash = sha256(png);
    await writeFile(join(assetDir, `content/${imageHash}.png`), png);
    const thumbnail = await encodePng({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) });
    const thumbHash = sha256(thumbnail);
    const markdown = Buffer.from('# Coffee meeting\n\n한글 원문 and exact original stored document.\n');
    const docHash = sha256(markdown);
    const storedAssets = [{ file: `content/${imageHash}.png`, bytes: new Uint8Array(png) }, { file: `content/${thumbHash}.png`, bytes: new Uint8Array(thumbnail) }, { file: `content/${docHash}.md`, bytes: new Uint8Array(markdown) }];
    for (const asset of storedAssets.slice(1))
        await writeFile(join(assetDir, asset.file), asset.bytes);
    const rows: Record<string, PortableRecord[]> = {};
    for (const d of COLLECTIONS)
        rows[d.name] = [Object.fromEntries(Object.entries(d.types).map(([field, t]) => [field, t.nullable ? null : t.type === 'INTEGER' ? 7 : t.type === 'REAL' ? 0.7 : field.endsWith('At') ? '2026-01-02 03:04:05' : field.endsWith('Json') ? ' {"opaque":true} ' : `${d.name}_${field}`]))];
    const override = (name: string, value: PortableRecord) => Object.assign(rows[name]![0]!, value);
    override('memories', { id: 7, body: '한국어 archive original coffee memory', memoryType: 'fact', embeddingText: 'retained optimized input', sourceType: 'manual' });
    override('archivedMemories', { id: 777, body: 'deleted historical original', memoryType: 'fact' });
    override('assets', { sha256: imageHash, assetType: 'image', assetPath: join(assetDir, `content/${imageHash}.png`), byteSize: png.length, mimeType: 'image/png', originalName: 'original.png' });
    override('images', { width: 1, height: 1, mime: 'image/png', preserveMode: 'original', isAnimated: 0, warningsJson: ' [ ] ', hasCaptionAuto: 0 });
    override('concepts', { conceptId: 'cpt_coffee', name: 'coffee', koName: '커피', koAliases: ' ["카페"] ', enAliases: '["cafe"]', description: 'A hot beverage', isTag: 1, isClassificationKey: 0, isClassificationValue: 0 });
    override('people', { personId: 'psn_banjjagi', displayName: 'Banjjagi', embeddingText: 'Banjjagi coffee friend', attributesJson: ' { "preserved" : 1 } ' });
    override('entities', { entityId: 'project_portable', typeName: 'project', name: 'portable memory', koName: '기억', externalRefs: '{}' });
    override('entityAttributes', { attrKey: 'z_topic', attrValue: 'coffee migration', isColumn: 1 });
    override('documents', { documentId: 'doc_coffee', title: 'Meeting coffee', documentType: 'meeting_log', sourceMetadata: ' { "raw" : [1,2] } ', chunkCount: 1, hasSummary: 1, hasExtracted: 1 });
    override('chunkSummaries', { summaryText: 'Coffee meeting summary', hasEmbedding: 0 });
    override('relationSummaries', { summaryText: 'Banjjagi enjoys coffee', hasEmbedding: 0 });
    override('memorySources', { kind: 'direct_save', detailJson: ' {"source":"original"} ' });
    override('archivedMemorySources', { kind: 'archived_lineage' });
    override('revisions', { oldNodeId: 999999, newNodeId: null, revisionType: 'manual', oldContent: 'historical deleted content' });
    override('aliasSuggestions', { status: 'pending' });
    override('cleanupItems', { status: 'applied' });
    override('cleanupStages', { status: 'completed' });
    override('cleanupRuns', { trigger: 'manual', status: 'running' });
    override('classificationOverrides', { slot: 'synonyms' });
    override('sourceEvents', { eventKey: 'direct_save:stable-event', evidenceJson: ' {"dedup":"keep"} ' });
    override('conceptLinks', { sourceConceptId: 'deleted_historical_concept', targetConceptId: 'psn_banjjagi', relation: 'former_friend' });
    for (const d of COLLECTIONS)
        for (const ref of d.references)
            rows[d.name]![0]![ref.field] = rows[ref.collection]![0]![ref.targetField]!;
    rows.assets!.push({ ...rows.assets![0]!, sha256: thumbHash, assetPath: join(assetDir, `content/${thumbHash}.png`), byteSize: thumbnail.length, originalName: 'thumbnail.png' });
    rows.assets!.push({ ...rows.assets![0]!, sha256: docHash, assetType: 'text', assetPath: join(assetDir, `content/${docHash}.md`), byteSize: markdown.length, mimeType: 'text/markdown', originalName: 'meeting.md' });
    rows.images![0]!.thumbSha256 = thumbHash;
    rows.documents![0]!.assetSha256 = docHash;
    rows.memories!.push({ ...rows.memories![0]!, id: 8, body: 'image saved original', memoryType: 'fact', sourceType: 'image_asset', metadataJson: JSON.stringify({ asset_sha256: imageHash }), embeddingText: null });
    rows.entityAttributes!.push({ ...rows.entityAttributes![0]!, attrKey: 'a_first', attrValue: 'ordered first' });
    const db = openMemoryDatabase(dbPath, { embeddingDim });
    try {
        runImmediateTransaction(db, () => {
            db.run('PRAGMA defer_foreign_keys=ON');
            for (const d of COLLECTIONS) {
                const cols = Object.keys(d.fields);
                const query = db.prepare(`INSERT INTO ${d.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`);
                try {
                    for (const r of rows[d.name]!)
                        query.run(...cols.map(c => r[d.fields[c]!]!));
                }
                finally {
                    query.finalize();
                }
            }
            db.run("UPDATE sqlite_sequence SET seq=1000000 WHERE name='knowledge_nodes'");
        });
    }
    finally {
        db.close(true);
    }
    return { dbPath, assetDir, png, imageHash, storedAssets };
}
