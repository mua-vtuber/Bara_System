import type { Database } from 'bun:sqlite';
import { runImmediateTransaction } from '../db/baseline-schema.ts';
import { readFile } from 'node:fs/promises';
import { createEmbedder, createImageEmbedder, embeddingDimensionOf, type EmbedderModel } from '../embedding/factory.ts';
import { BGE_M3_REVISION, SIGLIP2_REVISION } from '../embedding/model-revisions.ts';
import { SIGLIP2_MODEL_ID } from '../embedding/siglip2.ts';
import { embedQuerySiglipText, loadSiglipTextEncoder } from '../embedding/siglip2-text.ts';
import { buildEmbeddingText } from '../db/store-internal/concept-alias-helpers.ts';
import { INDEX_TABLES } from './collections.ts';
import { cursor, checkpoint, restoreAll, restoreGet, restoreRun } from './restore-state.ts';
import { archiveFile } from './paths.ts';
import { sha256 } from './validate.ts';
import type { PortableManifestV1 } from './format.ts';
interface Input {
    id: number;
    text: string;
    hash?: string;
    mime?: string;
}
interface Family {
    table: string;
    key: string;
    dimension: number;
    inputs: Input[];
    kind: 'text' | 'siglipText' | 'image';
    summaryTable?: string;
}
/** Version the synthesis recipe as well as model weights: resumes must never mix different inputs. */
export function restoreModelFingerprint(model: EmbedderModel): string {
    const dimension = embeddingDimensionOf(model);
    return sha256(JSON.stringify({ model, repo: 'Xenova/bge-m3', revision: BGE_M3_REVISION, dtype: 'q8', dimension, pooling: 'cls', normalize: true, tokenBudget: 8192, recipe: 'portable-v1-content-excluding-image/concept-buildEmbeddingText/person-single-trim-embedding-or-display/entity-name-ko-attrs-attr_key/summary-text/other-text-batch8', siglip: { repo: SIGLIP2_MODEL_ID, revision: SIGLIP2_REVISION, dtype: 'q8', dimension: 768, text: 'concept-name,max_length=64,padding=max_length,truncation,L2', image: 'mime-first-frame,jsquash-RGBA-exact256,processor-config-CHW,L2' } }));
}
function families(db: Database, dimension: number): Family[] {
    const select = (sql: string) => restoreAll<Input>(db, sql);
    const concepts = restoreAll<{
        id: number;
        name: string;
        ko_name: string | null;
        ko_aliases: string | null;
        en_aliases: string | null;
        description: string | null;
        embedding_text: string | null;
    }>(db, 'SELECT rowid AS id,name,ko_name,ko_aliases,en_aliases,description,embedding_text FROM concept_nodes ORDER BY rowid');
    const entityRows = restoreAll<{
        id: number;
        entity_id: string;
        name: string;
        ko_name: string | null;
    }>(db, 'SELECT rowid AS id,entity_id,name,ko_name FROM entities ORDER BY rowid');
    const entityInputs = entityRows.map(e => ({ id: e.id, text: [e.name, e.ko_name ?? '', ...restoreAll<{
                attr_value: string;
            }>(db, 'SELECT attr_value FROM entity_attributes WHERE entity_id=? AND is_column=1 ORDER BY attr_key ASC', [e.entity_id]).map(a => a.attr_value)].filter(p => p && p.trim()).join(' ') }));
    const people = restoreAll<{
        id: number;
        display_name: string;
        embedding_text: string | null;
    }>(db, 'SELECT rowid AS id,display_name,embedding_text FROM persons ORDER BY rowid');
    const personInputs = people.map(person => {
        const text = person.embedding_text?.trim() || person.display_name.trim();
        if (!text)
            throw new Error('Empty person embedding input: ' + person.id);
        return { id: person.id, text };
    });
    const imageRows = restoreAll<{
        id: number;
        metadata_json: string;
    }>(db, "SELECT id,metadata_json FROM knowledge_nodes WHERE source_type='image_asset' ORDER BY id");
    const images = imageRows.map(r => {
        let metadata;
        try {
            metadata = JSON.parse(r.metadata_json);
        }
        catch {
            throw new Error('Invalid image metadata for node ' + r.id);
        }
        const hash = metadata?.asset_sha256;
        if (typeof hash !== 'string')
            throw new Error('Missing image asset for node ' + r.id);
        const image = restoreGet<{
            mime: string;
        }>(db, 'SELECT mime FROM images WHERE asset_sha256=?', [hash]);
        if (!image)
            throw new Error('Missing image metadata for node ' + r.id);
        return { id: r.id, text: '', hash, mime: image.mime };
    });
    return [
        { table: 'vec_nodes', key: 'node_id', dimension, kind: 'text', inputs: select("SELECT id,content AS text FROM knowledge_nodes WHERE source_type<>'image_asset' ORDER BY id") },
        { table: 'concept_vec', key: 'concept_rowid', dimension, kind: 'text', inputs: concepts.map(c => ({ id: c.id, text: c.embedding_text ?? buildEmbeddingText({ name: c.name, koName: c.ko_name, koAliases: c.ko_aliases, enAliases: c.en_aliases, description: c.description }) })) },
        { table: 'person_vec', key: 'person_rowid', dimension, kind: 'text', inputs: personInputs },
        { table: 'entities_vec', key: 'entity_rowid', dimension, kind: 'text', inputs: entityInputs },
        { table: 'chunk_summary_vec', key: 'summary_rowid', dimension, kind: 'text', summaryTable: 'chunk_summaries', inputs: select('SELECT rowid AS id,summary_text AS text FROM chunk_summaries ORDER BY rowid') },
        { table: 'relation_summary_vec', key: 'summary_rowid', dimension, kind: 'text', summaryTable: 'relation_summaries', inputs: select('SELECT rowid AS id,summary_text AS text FROM relation_summaries ORDER BY rowid') },
        { table: 'concept_siglip_vec', key: 'concept_rowid', dimension: 768, kind: 'siglipText', inputs: concepts.map(c => ({ id: c.id, text: c.name })) },
        { table: 'image_vec', key: 'node_id', dimension: 768, kind: 'image', inputs: images },
    ];
}
function validVector(vector: Float32Array | null, dimension: number, context: string): Float32Array {
    if (!vector || vector.length !== dimension || vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0))
        throw new Error('Embedding unavailable or invalid: ' + context);
    return vector;
}
export function expectedIndexCounts(db: Database, model: EmbedderModel): Record<string, number> {
    const result = Object.fromEntries(families(db, embeddingDimensionOf(model)).map(f => [f.table, f.inputs.length]));
    for (const [tables, source] of [[['knowledge_nodes_fts', 'knowledge_nodes_trgm'], 'knowledge_nodes'], [['concept_nodes_fts', 'concept_nodes_uni'], 'concept_nodes'], [['persons_fts', 'persons_uni'], 'persons'], [['entities_fts', 'entities_uni'], 'entities']] as const) {
        const n = restoreGet<{
            n: number;
        }>(db, `SELECT COUNT(*) AS n FROM ${source}`)!.n;
        for (const table of tables)
            result[table] = n;
    }
    return result;
}
export async function rebuildPortableIndexes(db: Database, assetDir: string, manifest: PortableManifestV1, model: EmbedderModel, check: () => void, progress: (phase: string, done: number, total: number) => void): Promise<void> {
    const groups = families(db, embeddingDimensionOf(model));
    const embedder = createEmbedder({ model });
    let loaded = false;
    const attachments = new Map(manifest.attachments.map(a => [a.sha256, a]));
    for (const group of groups) {
        const phase = 'index:' + group.table;
        let start = cursor(db, phase);
        if (start > group.inputs.length)
            throw new Error('Invalid vector checkpoint');
        if (start < group.inputs.length) {
            progress(phase, start, group.inputs.length);
            check();
        }
        if (start < group.inputs.length && group.kind === 'text' && !loaded) {
            check();
            await embedder.load();
            loaded = true;
            check();
        }
        if (start < group.inputs.length && group.kind === 'siglipText') {
            // The singleton marks loadAttempted before awaiting initialization; cold batches must
            // finish that one load before concurrent encoder calls can inspect availability.
            if (!await loadSiglipTextEncoder())
                throw new Error('Embedding unavailable: ' + phase);
            check();
        }
        for (; start < group.inputs.length;) {
            check();
            const batch = group.inputs.slice(start, start + 8);
            let vectors: Float32Array[];
            if (group.kind === 'text' && group.table === 'person_vec') {
                // Match PersonRepository's single-input inference as well as its trim/fallback
                // recipe; q8 padding across differently sized batch inputs changes the output.
                vectors = [];
                for (const row of batch) {
                    check();
                    vectors.push(await embedder.embed(row.text));
                }
            }
            else if (group.kind === 'text')
                vectors = await embedder.embedBatch(batch.map(r => r.text));
            else if (group.kind === 'siglipText')
                vectors = await Promise.all(batch.map(async (r) => validVector(await embedQuerySiglipText(r.text), 768, phase)));
            else {
                vectors = [];
                for (const row of batch) {
                    check();
                    const a = attachments.get(row.hash!);
                    if (!a)
                        throw new Error('Image attachment missing');
                    const bytes = await readFile(await archiveFile(assetDir, `content/${a.sha256}.${a.extension}`));
                    if (sha256(bytes) !== a.sha256 || bytes.length !== a.byteSize)
                        throw new Error('Image staging asset changed');
                    vectors.push(validVector(await createImageEmbedder().embedImage(bytes, row.mime), 768, phase));
                }
            }
            check();
            if (vectors.length !== batch.length)
                throw new Error('Embedding batch cardinality mismatch');
            vectors.forEach(v => validVector(v, group.dimension, phase));
            runImmediateTransaction(db, () => {
                const insert = db.prepare(`INSERT INTO ${group.table}(${group.key},embedding) VALUES(?,?)`);
                try {
                    for (let i = 0; i < batch.length; i++) {
                        insert.run(batch[i]!.id, new Uint8Array(vectors[i]!.buffer, vectors[i]!.byteOffset, vectors[i]!.byteLength));
                        if (group.summaryTable)
                            restoreRun(db, `UPDATE ${group.summaryTable} SET has_embedding=1 WHERE rowid=?`, [batch[i]!.id]);
                    }
                    checkpoint(db, phase, start + batch.length);
                }
                finally {
                    insert.finalize();
                }
            });
            start += batch.length;
            progress(phase, start, group.inputs.length);
            check();
        }
    }
}
/** FTS triggers use the baseline synthesis expressions during direct inserts, including attribute changes. */
export function verifyPortableIndexes(db: Database, model: EmbedderModel): Record<string, number> {
    const expected = expectedIndexCounts(db, model);
    const counts: Record<string, number> = {};
    for (const table of INDEX_TABLES) {
        const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
        let n: number;
        try {
            n = (count.get() as {
                n: number;
            }).n;
        }
        finally {
            count.finalize();
        }
        if (n !== expected[table])
            throw new Error(`Index cardinality mismatch: ${table} ${n}/${expected[table]}`);
        counts[table] = n;
        if (table.endsWith('_fts') || table.endsWith('_uni') || table.endsWith('_trgm')) {
            const integrity = db.prepare(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
            try {
                integrity.run();
            }
            finally {
                integrity.finalize();
            }
        }
    }
    return counts;
}
