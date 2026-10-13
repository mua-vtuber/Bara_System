import type { Database } from "bun:sqlite";
import type { MemoryNode } from "./types.ts";
import {
  readSharedMemory, readSharedMemoryForNode, isCurrentMemory, isDerivedSourceType, REGEX_ATOM_SOURCE,
  REGEX_EDGE_PROVENANCE, SHARED_MEMORY_DERIVED_SOURCE_TYPES, SHARED_MEMORY_LINEAGE_RELATIONS,
} from "./shared-memory-contract.ts";
import { createOwnSourceProbe } from "./lineage-removal.ts";
import type { KnowledgeNodeRow } from "../db/store-internal/row-types.ts";
import { rowToNode, nowKst } from "../db/store-internal/helpers.ts";
import { inIdBatches, sqlPlaceholders } from "../db/store-internal/id-batches.ts";

// Derived nodes are reached through lineage only; a copied evidenceRefs entry never links them.
const DERIVED_TYPE_PLACEHOLDERS = SHARED_MEMORY_DERIVED_SOURCE_TYPES.map(() => "?").join(", ");
const LINEAGE_PLACEHOLDERS = SHARED_MEMORY_LINEAGE_RELATIONS.map(() => "?").join(", ");

/**
 * Runs inside the caller's transaction; independent support survives withdrawal.
 *
 * Who is withdrawn with the origin's old claim (WP-B1-20T design 5.8):
 *   - A node reached through lineage (a merged_into or parent_of edge to a withdrawn node, or an
 *     entry of its extractedTo list) that has its own source row (memory_node_sources: a direct save
 *     was absorbed into it, or it is itself a direct save that absorbed a derived input) is kept with
 *     its status. It is detached from the withdrawn lineage: all its lineage edges to the origin and to
 *     the nodes withdrawn here go, whatever their provenance (a same-text absorption's merged_into is a
 *     stale link after the edit just like a regex edge), and its id leaves their extractedTo lists, so
 *     default reads see it as a parent-less memory. It is not traversed, so its own children keep it as
 *     their live parent. Re-extraction of the edited claim may absorb the same fact into it again and
 *     add the edge back (design 3.6); its own source row keeps it either way.
 *   - A node reached through lineage without its own source row is a withdrawal candidate, whatever
 *     its source type (design 3.4: the derived shape no longer decides survival). It stays when another
 *     live lineage parent supports it.
 *   - A memory that names a withdrawn node in its own sharedMemory.evidenceRefs (evidence, not a
 *     content source) keeps the existing rule: it is withdrawn unless another live evidence supports
 *     it. A derived node (derived source type, or a regex atom linked here by a regex edge) is never
 *     judged as evidence; it follows the lineage rule above.
 *
 * revisionId is the memory_revisions row the caller wrote for this edit or withdrawal (the caller inserts
 * it first). Each node retracted here records it as sharedMemory.invalidatedByRevision next to
 * invalidatedBy, so a message delete can find the retracted derivatives of that message's sync edits
 * (WP-B1-20U design 17.7). A node already retracted or superseded keeps its earlier record.
 */
export function invalidateSharedMemoryDerivatives(db: Database, origin: MemoryNode, revisionId?: number): number[] {
  const holdsOwnSource = createOwnSourceProbe(db);
  const selectOwnLineage = db.query(
    `SELECT target_id FROM knowledge_edges WHERE source_id = ? AND relation IN (${LINEAGE_PLACEHOLDERS})`,
  );
  const reachable = new Map<number, MemoryNode>([[origin.id, origin]]);
  const supports = new Map<number, Set<number>>();
  const detached = new Set<number>();
  const pending = [origin];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const parent = pending[cursor]!;
    const edges = db.query(`SELECT source_id, provenance FROM knowledge_edges WHERE target_id = ? AND relation IN (${LINEAGE_PLACEHOLDERS})`)
      .all(parent.id, ...SHARED_MEMORY_LINEAGE_RELATIONS) as Array<{ source_id: number; provenance: string }>;
    const regexIds = new Set(edges.filter((e) => e.provenance === REGEX_EDGE_PROVENANCE).map((e) => e.source_id));
    const referenced = db.query(`SELECT DISTINCT n.id FROM knowledge_nodes n,
      json_each(n.metadata_json, '$.sharedMemory.evidenceRefs') ref
      WHERE ref.type = 'integer' AND ref.value = ? AND n.source_type NOT IN (${DERIVED_TYPE_PLACEHOLDERS})`)
      .all(parent.id, ...SHARED_MEMORY_DERIVED_SOURCE_TYPES) as Array<{ id: number }>;
    const referenceIds = new Set(referenced.map((r) => r.id));
    const candidates = new Set([...edges.map((e) => e.source_id), ...referenceIds]);
    if (Array.isArray(parent.metadata.extractedTo)) {
      for (const id of parent.metadata.extractedTo) {
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) candidates.add(id);
      }
    }
    for (const id of candidates) {
      if (reachable.has(id) || detached.has(id)) continue;
      const row = db.query("SELECT * FROM knowledge_nodes WHERE id = ?").get(id) as KnowledgeNodeRow | null;
      if (!row) continue;
      const child = rowToNode(row);
      const lineageParents = new Set((selectOwnLineage.all(id, ...SHARED_MEMORY_LINEAGE_RELATIONS) as Array<{ target_id: number }>)
        .map((r) => r.target_id));
      const derived = isDerivedSourceType(child.sourceType) ||
        (child.metadata.source === REGEX_ATOM_SOURCE && regexIds.has(id));
      const judgedAsEvidence = !derived && referenceIds.has(id);
      if (!judgedAsEvidence && holdsOwnSource(id)) {
        detached.add(id);
        continue;
      }
      reachable.set(id, child);
      pending.push(child);
      const sourceIds = lineageParents;
      // Only a non-derived child's own evidenceRefs are independent support.
      for (const ref of readSharedMemoryForNode(child).evidenceRefs ?? []) sourceIds.add(ref);
      supports.set(id, sourceIds);
    }
  }

  // First find external, live support, then propagate it into the reachable graph.
  // A cycle within the withdrawn graph cannot count as its own independent source.
  const preserved = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of reachable) {
      if (id === origin.id || preserved.has(id) || !isCurrentMemory(node.metadata)) continue;
      const independent = [...(supports.get(id) ?? [])].some((sourceId) => {
        if (preserved.has(sourceId)) return true;
        if (reachable.has(sourceId)) return false;
        const source = db.query("SELECT * FROM knowledge_nodes WHERE id = ?").get(sourceId) as KnowledgeNodeRow | null;
        return source !== null && isCurrentMemory(rowToNode(source).metadata);
      });
      if (independent) { preserved.add(id); changed = true; }
    }
  }
  const withdrawn = new Set([...reachable.keys()].filter((id) => !preserved.has(id)));
  const affected: number[] = [];
  const sourceNodes = [origin];
  for (const [id, child] of [...reachable].sort(([a], [b]) => a - b)) {
    if (id === origin.id || preserved.has(id)) continue;
    sourceNodes.push(child);
    const state = readSharedMemory(child.metadata);
    if (state.status === "retracted" || state.status === "superseded") continue;
    const metadata = { ...child.metadata, sharedMemory: {
      ...state, status: "retracted", revision: state.revision + 1, invalidatedBy: origin.id,
      ...(revisionId === undefined ? {} : { invalidatedByRevision: revisionId }),
    } };
    db.query("UPDATE knowledge_nodes SET metadata_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(metadata), nowKst(), id);
    affected.push(id);
  }
  detachFromWithdrawnLineage(db, detached, withdrawn);
  // Summary vectors are removed by the existing deletion triggers. A changed chunk
  // invalidates document-wide relation summaries, whose dependency is the document.
  const documents = new Set<string>();
  for (const node of sourceNodes) {
    db.query("DELETE FROM chunk_summaries WHERE parent_chunk_id = ?").run(node.id);
    const documentId = node.metadata.documentId ?? (node.sourceType === "document_chunk" ? node.metadata.parentId : undefined);
    if (typeof documentId === "string") documents.add(documentId);
  }
  for (const documentId of documents) {
    const pairs = db.query("SELECT from_concept_id, to_concept_id FROM relation_summaries WHERE source_document_id = ?")
      .all(documentId) as Array<{ from_concept_id: string; to_concept_id: string }>;
    db.query("DELETE FROM chunk_summaries WHERE parent_document_id = ?").run(documentId);
    db.query("DELETE FROM relation_summaries WHERE source_document_id = ?").run(documentId);
    db.query("UPDATE documents SET has_summary = 0 WHERE document_id = ?").run(documentId);
    for (const pair of pairs) {
      if (db.query("SELECT 1 FROM relation_summaries WHERE from_concept_id = ? AND to_concept_id = ? LIMIT 1")
        .get(pair.from_concept_id, pair.to_concept_id)) continue;
      db.query(`DELETE FROM concept_edges WHERE source_concept_id = ? AND target_concept_id = ?
        AND relation = 'llm_relation' AND provenance = 'llm_extract' AND source_node_id IS NULL`)
        .run(pair.from_concept_id, pair.to_concept_id);
    }
  }
  return affected;
}

/**
 * Cuts kept nodes loose from the withdrawn lineage (the origin and every reachable node that was not
 * preserved): all their lineage edges to it are deleted and their ids leave its extractedTo lists. The
 * lists are read from the stored rows, not from the snapshots above: the caller may have rewritten the
 * origin row already (a claim edit clears extractedTo when it marks extraction pending).
 */
function detachFromWithdrawnLineage(
  db: Database,
  detached: ReadonlySet<number>,
  withdrawn: ReadonlySet<number>,
): void {
  if (detached.size === 0) return;
  const withdrawnIds = [...withdrawn];
  for (const id of detached) {
    for (const batch of inIdBatches(withdrawnIds)) {
      // dynamic SQL: placeholder count varies, keep prepare()
      db.prepare(
        `DELETE FROM knowledge_edges WHERE source_id = ? AND relation IN (${LINEAGE_PLACEHOLDERS})
          AND target_id IN (${sqlPlaceholders(batch.length)})`,
      ).run(id, ...SHARED_MEMORY_LINEAGE_RELATIONS, ...batch);
    }
  }
  const selectNode = db.query("SELECT * FROM knowledge_nodes WHERE id = ?");
  const updateMetadata = db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?");
  for (const parentId of withdrawn) {
    const row = selectNode.get(parentId) as KnowledgeNodeRow | null;
    if (!row) continue;
    const { metadata } = rowToNode(row);
    const list: unknown = metadata.extractedTo;
    if (!Array.isArray(list)) continue;
    const kept = list.filter((childId) => !(typeof childId === "number" && detached.has(childId)));
    if (kept.length === list.length) continue;
    updateMetadata.run(JSON.stringify({ ...metadata, extractedTo: kept }), parentId);
  }
}
