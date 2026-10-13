import {
  isCurrentSharedMemoryState, isDerivedSourceType, readSharedMemoryForNode, REGEX_EDGE_PROVENANCE,
} from "./shared-memory-contract.ts";

/** One knowledge_nodes row as the visibility scan reads it. */
export interface VisibilityNodeRow {
  id: number;
  project_id: string | null;
  source_type: string;
  metadata_json: string | null;
}

/** One lineage edge (SHARED_MEMORY_LINEAGE_RELATIONS) as the visibility scan reads it. */
export interface VisibilityLineageEdgeRow {
  source_id: number;
  target_id: number;
  provenance: string;
}

/**
 * The default read rules evaluated once for every stored row. Scope and includeInactive
 * views are derived from it without another scan (shared-memory-read.ts).
 */
export interface MemoryVisibilityComputation {
  /** Every knowledge_nodes row, readable or not. */
  readonly rowCount: number;
  /** Project of each row whose metadata is a JSON object: the rows includeInactive admits. */
  readonly projectById: ReadonlyMap<number, string | null>;
  /** Rows the default rules admit, before any scope narrows them. */
  readonly supportedIds: ReadonlySet<number>;
  /** Rows the default rules reject, including rows whose metadata could not be read. */
  readonly excludedIds: ReadonlySet<number>;
  /** Rows whose metadata is not a JSON object; no read admits them. */
  readonly unparseableIds: ReadonlySet<number>;
  /**
   * Readable rows flagged pending_review (JSON true or 1). Not part of visibility: the
   * retriever sizes its exclusion supply with it and re-checks each hit with the SQL rule.
   */
  readonly pendingReviewIds: ReadonlySet<number>;
  /** Latest validFrom/validUntil at or before `now`; -Infinity when there is none. */
  readonly windowStart: number;
  /** Earliest validFrom/validUntil after `now`; Infinity when there is none. */
  readonly windowEnd: number;
  /** Search-cache epoch: the latest boundary already passed, never below 0. */
  readonly validityEpoch: number;
}

interface ScannedNode {
  sourceType: string;
  current: boolean;
  parents: Set<number>;
  extractedTo: unknown;
}

/**
 * evidenceRefs are alternative/corroborating support, matching invalidation: one grounded
 * current source preserves a claim. Independent current memories seed support, which then
 * propagates to current dependents, so missing sources and ungrounded cycles fail closed.
 * Health is resolved before scope: a global source can support a project claim.
 *
 * Every boundary at or before `now` compares true for any instant in [windowStart, windowEnd)
 * and every later one compares false, so the result holds for that whole interval.
 */
export function computeMemoryVisibility(
  rows: Iterable<VisibilityNodeRow>,
  lineageEdges: Iterable<VisibilityLineageEdgeRow>,
  now: number,
): MemoryVisibilityComputation {
  const nodes = new Map<number, ScannedNode>();
  const projectById = new Map<number, string | null>();
  const unparseableIds = new Set<number>();
  const pendingReviewIds = new Set<number>();
  let windowStart = -Infinity;
  let windowEnd = Infinity;
  for (const row of rows) {
    const metadata = readMetadataObject(row.metadata_json);
    if (metadata === undefined) {
      unparseableIds.add(row.id);
      continue;
    }
    // A derived node's own evidence is empty: lineage below is its only support.
    const state = readSharedMemoryForNode({ sourceType: row.source_type, metadata });
    for (const boundary of [state.validFrom, state.validUntil]) {
      const instant = boundary ? Date.parse(boundary) : NaN;
      if (instant <= now) windowStart = Math.max(windowStart, instant);
      else if (instant > now) windowEnd = Math.min(windowEnd, instant);
    }
    projectById.set(row.id, row.project_id);
    if (metadata.pending_review === true || metadata.pending_review === 1) pendingReviewIds.add(row.id);
    nodes.set(row.id, {
      sourceType: row.source_type, current: isCurrentSharedMemoryState(state, now),
      parents: new Set(state.evidenceRefs ?? []), extractedTo: metadata.extractedTo,
    });
  }

  for (const edge of lineageEdges) {
    const child = nodes.get(edge.source_id);
    // Regex extraction links a plain child to its source by lineage, like a derived node.
    if (child && (isDerivedSourceType(child.sourceType) || edge.provenance === REGEX_EDGE_PROVENANCE)) {
      child.parents.add(edge.target_id);
    }
  }
  for (const [id, node] of nodes) {
    if (!Array.isArray(node.extractedTo)) continue;
    for (const childId of node.extractedTo) {
      if (typeof childId !== "number") continue;
      const child = nodes.get(childId);
      if (child && isDerivedSourceType(child.sourceType)) child.parents.add(id);
    }
  }

  const supportedIds = new Set<number>();
  const dependents = new Map<number, number[]>();
  for (const [id, node] of nodes) {
    if (!node.current) continue;
    if (node.parents.size === 0) supportedIds.add(id);
    for (const parentId of node.parents) {
      const children = dependents.get(parentId);
      if (children) children.push(id);
      else dependents.set(parentId, [id]);
    }
  }
  const pending = [...supportedIds];
  for (let i = 0; i < pending.length; i += 1) {
    for (const childId of dependents.get(pending[i]!) ?? []) {
      if (supportedIds.has(childId)) continue;
      supportedIds.add(childId);
      pending.push(childId);
    }
  }

  const excludedIds = new Set<number>(unparseableIds);
  for (const id of nodes.keys()) if (!supportedIds.has(id)) excludedIds.add(id);
  return {
    rowCount: nodes.size + unparseableIds.size,
    projectById, supportedIds, excludedIds, unparseableIds, pendingReviewIds,
    windowStart, windowEnd, validityEpoch: Math.max(0, windowStart),
  };
}

/** A row whose metadata is not a JSON object is never visible: it fails closed. */
function readMetadataObject(json: string | null): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json ?? "{}");
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
