import { z } from "zod";
import type { EdgeRelation, SourceType } from "./types.ts";
import type { RegexMetadata } from "./regex-l0/score-decision.ts";
import type { Provenance } from "./provenance-vocabulary.ts";

export const SHARED_MEMORY_STATUSES = ["active", "disputed", "superseded", "retracted"] as const;
export const SHARED_MEMORY_ASSERTION_KINDS = ["unknown", "user_statement", "observation", "ai_inference"] as const;

/**
 * The origin source type for a saved memory (chunked when long, immediate-extracted or
 * backfilled when short). WP-B1-08R (Minor 5) — src/memory/** and src/server-internal/**
 * both need this literal (backfill-extraction.ts's long-origin re-chunk check and
 * save-input-plain.ts's origin save/edit paths); src/memory/** may not import
 * src/server-internal/**, so the single source lives here rather than in either caller.
 */
export const AUTO_CAPTURE_SOURCE_TYPE: SourceType = "auto_capture";

/**
 * Edges that carry lineage support from their target (the parent) to their source.
 * Migration v43 triggers bump the visibility generation for exactly these relations,
 * so changing this list needs a new migration that recreates those triggers.
 */
export const SHARED_MEMORY_LINEAGE_RELATIONS = [
  "merged_into", "parent_of",
] as const satisfies readonly EdgeRelation[];

/**
 * Nodes the server derives from a parent. Their support is lineage only: merged_into /
 * parent_of edges and the parent's extractedTo. Parent evidence reaches them through the parent.
 */
export const SHARED_MEMORY_DERIVED_SOURCE_TYPES = [
  "document_chunk", "llm_extract", "image_caption",
] as const satisfies readonly SourceType[];
const DERIVED_SOURCE_TYPE_SET: ReadonlySet<string> = new Set(SHARED_MEMORY_DERIVED_SOURCE_TYPES);

export function isDerivedSourceType(sourceType: string): boolean {
  return DERIVED_SOURCE_TYPE_SET.has(sourceType);
}

/** Regex atom marker: save-input-regex.ts stores RegexMetadata, whose source is always "regex". */
export const REGEX_ATOM_SOURCE: RegexMetadata["source"] = "regex";

/**
 * Provenance of the lineage edge that links a regex atom to its origin. The atom is a claim of its own,
 * so visibility, invalidation and the conflict origin exclusion all tell this edge from the system
 * edges of derived children by this one value.
 */
export const REGEX_EDGE_PROVENANCE: Provenance = "regex";

/**
 * Derived-shaped node: a derived source type, or a regex atom (auto_capture with the regex marker).
 * The store derives an omitted AddNodeArgs.provenance from this shape (WP-B1-20T design 3.5). The
 * lineage removal plan does not look at the shape: it asks whether a node has its own source row.
 */
export function isDerivedShaped(sourceType: string, metadata: Record<string, unknown> | undefined): boolean {
  return isDerivedSourceType(sourceType) || metadata?.source === REGEX_ATOM_SOURCE;
}

export const memoryReadScopeSchema = z.object({
  projectId: z.string().trim().min(1).nullable(),
  includeGlobal: z.boolean().optional(),
}).strict();
export type MemoryReadScope = z.infer<typeof memoryReadScopeSchema>;

const instant = z.iso.datetime({ offset: true });
export const sharedMemorySchema = z.object({
  status: z.enum(SHARED_MEMORY_STATUSES).default("active"),
  revision: z.number().int().nonnegative().default(0),
  assertionKind: z.enum(SHARED_MEMORY_ASSERTION_KINDS).default("unknown"),
  sourceEventId: z.string().trim().min(1).optional(),
  claimKey: z.string().trim().min(1).optional(),
  sessionRef: z.string().trim().min(1).optional(),
  evidenceRefs: z.array(z.number().int().positive()).optional(),
  validFrom: instant.optional(),
  validUntil: instant.optional(),
  supersededBy: z.number().int().positive().optional(),
  invalidatedBy: z.number().int().positive().optional(),
  /**
   * Lineage invalidation only: the memory_revisions row id of the edit or withdrawal that retracted this
   * node (WP-B1-20U design 17.7). A message delete finds the retracted derivatives of that message's
   * sync edits by it. Server-owned like the whole sharedMemory key (SERVER_OWNED_METADATA_KEYS).
   */
  invalidatedByRevision: z.number().int().positive().optional(),
}).strict().refine(
  (value) => !value.validFrom || !value.validUntil || Date.parse(value.validFrom) < Date.parse(value.validUntil),
  { message: "validUntil must be after validFrom", path: ["validUntil"] },
);
export type SharedMemoryState = z.infer<typeof sharedMemorySchema>;

export function validateSharedMemory(value: unknown): SharedMemoryState {
  return sharedMemorySchema.parse(value);
}

export function parseMemoryReadScope(value: unknown): MemoryReadScope | undefined {
  return value === undefined ? undefined : memoryReadScopeSchema.parse(value);
}

/** Legacy rows remain readable; malformed new contracts are disputed, never authoritative. */
export function readSharedMemory(metadata: Record<string, unknown>): SharedMemoryState {
  if (metadata.sharedMemory === undefined) return { status: "active", revision: 0, assertionKind: "unknown" };
  const parsed = sharedMemorySchema.safeParse(metadata.sharedMemory);
  return parsed.success ? parsed.data : { status: "disputed", revision: 0, assertionKind: "unknown" };
}

/**
 * State for a new derived node. evidenceRefs are declared by whoever stored the parent,
 * so the child never receives them; overrides cannot reintroduce them either.
 */
export function inheritSharedMemoryForDerived(
  parent: SharedMemoryState,
  overrides: Partial<Omit<SharedMemoryState, "evidenceRefs">> = {},
): SharedMemoryState {
  const { evidenceRefs: _parentEvidence, ...inherited } = parent;
  return { ...inherited, ...overrides };
}

/**
 * State that applies to this node. Older derived rows stored a copy of the parent's
 * evidenceRefs; that copy is neither support nor this node's own evidence, so it is dropped.
 */
export function readSharedMemoryForNode(
  node: { sourceType: string; metadata: Record<string, unknown> },
): SharedMemoryState {
  const state = readSharedMemory(node.metadata);
  if (!isDerivedSourceType(node.sourceType)) return state;
  const { evidenceRefs: _copiedFromParent, ...own } = state;
  return own;
}

export function matchesMemoryScope(
  projectId: string | null | undefined,
  scope?: MemoryReadScope,
): boolean {
  if (!scope) return true;
  const actual = projectId ?? null;
  return actual === scope.projectId || (scope.projectId !== null && scope.includeGlobal === true && actual === null);
}

/**
 * Withdrawn by lineage invalidation: an edit or withdrawal of a source reached this memory
 * (invalidateSharedMemoryDerivatives records invalidatedBy, and invalidatedByRevision when the caller
 * passes the revision row of that edit or withdrawal). Unlike a memory a client retracted
 * or replaced itself, it no longer stands for any claim, so neither a new extraction nor an
 * identical save is absorbed into it. SQL mirrors this in db/store-internal/extraction-state-sql.ts.
 */
export function isLineageInvalidated(state: SharedMemoryState): boolean {
  return state.status === "retracted" && state.invalidatedBy !== undefined;
}

/** validUntil is exclusive so expiry takes effect at the stated instant. */
export function isCurrentMemory(
  metadata: Record<string, unknown>,
  now: Date | string | number = Date.now(),
): boolean {
  const at = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  return isCurrentSharedMemoryState(readSharedMemory(metadata), at);
}

/** The isCurrentMemory judgement for a state already read; `at` is epoch milliseconds. */
export function isCurrentSharedMemoryState(state: SharedMemoryState, at: number): boolean {
  return state.status === "active" && Number.isFinite(at)
    && (!state.validFrom || Date.parse(state.validFrom) <= at)
    && (!state.validUntil || at < Date.parse(state.validUntil));
}
