import type { SqliteMemoryStore } from "../db/store.ts";
import type { Database } from "bun:sqlite";
import {
  matchesMemoryScope, SHARED_MEMORY_LINEAGE_RELATIONS, type MemoryReadScope,
} from "./shared-memory-contract.ts";
import {
  computeMemoryVisibility, type MemoryVisibilityComputation,
  type VisibilityLineageEdgeRow, type VisibilityNodeRow,
} from "./shared-memory-visibility-compute.ts";

const STATE_TABLE = "memory_visibility_state";
const STATE_ROW_ID = 1;
const GENERATION_SQL = `SELECT generation FROM ${STATE_TABLE} WHERE id = ?`;
const NODE_SCAN_SQL = "SELECT id, project_id, source_type, metadata_json FROM knowledge_nodes";
const LINEAGE_EDGE_SQL = "SELECT source_id, target_id, provenance FROM knowledge_edges WHERE relation IN ("
  + SHARED_MEMORY_LINEAGE_RELATIONS.map(() => "?").join(", ") + ")";
/**
 * Scoped allowed sets are built lazily and kept per snapshot. Distinct reads between two
 * visibility writes are few (projects x includeGlobal x includeInactive); the cap bounds memory
 * when a caller walks many projects, evicting the least recently used view.
 */
const SNAPSHOT_VIEW_LIMIT = 32;

/** A database, or a store that exposes the database it reads. */
export type MemoryVisibilityOwner = Database | { getRawDb(): Database };

/** Visibility for one (scope, includeInactive) read, derived from a snapshot without a scan. */
export interface MemoryVisibilityView {
  /** memory_visibility_state.generation the snapshot was computed at. */
  readonly generation: number;
  /** Search-cache epoch: the latest validity boundary already passed (0 for includeInactive). */
  readonly validityEpoch: number;
  /** Admitted rows; undefined when every stored row is admitted. */
  readonly allowedIds: ReadonlySet<number> | undefined;
  /** Rows an unscoped view rejects; undefined for a scoped view, whose complement can be most rows. */
  readonly excludedIds: ReadonlySet<number> | undefined;
  isAllowed(id: number): boolean;
}

/** One evaluation of the default read rules, valid for its generation and time window. */
export interface MemoryVisibilitySnapshot {
  readonly generation: number;
  /** The snapshot answers any `now` in [windowStart, windowEnd): no validity boundary lies inside. */
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Readable rows flagged pending_review, for sizing the retriever's exclusion supply. */
  readonly pendingReviewIds: ReadonlySet<number>;
  view(scope?: MemoryReadScope, includeInactive?: boolean): MemoryVisibilityView;
  isAllowed(id: number, scope?: MemoryReadScope, includeInactive?: boolean): boolean;
}

/** The generation table or its single row is missing: the baseline schema seeds that row, so the database is damaged. */
export class MemoryVisibilityStateError extends Error {
  constructor(options?: { cause: unknown }) {
    super(
      `가시성 변경 번호를 읽을 수 없습니다: 기준 스키마의 ${STATE_TABLE} id = ${STATE_ROW_ID} 행이 없습니다 — ` +
        `DB 가 손상되었거나 손으로 지워졌습니다.`,
      options,
    );
    this.name = "MemoryVisibilityStateError";
  }
}

const snapshots = new WeakMap<Database, VisibilitySnapshot>();
const computationCounts = new WeakMap<Database, number>();

class VisibilitySnapshot implements MemoryVisibilitySnapshot {
  private readonly views = new Map<string, MemoryVisibilityView>();

  constructor(readonly generation: number, private readonly computed: MemoryVisibilityComputation) {}

  get windowStart(): number { return this.computed.windowStart; }
  get windowEnd(): number { return this.computed.windowEnd; }
  get pendingReviewIds(): ReadonlySet<number> { return this.computed.pendingReviewIds; }

  answers(now: number): boolean {
    return Number.isFinite(now) && this.computed.windowStart <= now && now < this.computed.windowEnd;
  }

  view(scope?: MemoryReadScope, includeInactive = false): MemoryVisibilityView {
    // The cached view keeps its own copy: a caller changing its scope object later cannot
    // make the view disagree with the key it is stored under.
    const own: MemoryReadScope | undefined = scope === undefined
      ? undefined
      : { projectId: scope.projectId, includeGlobal: scope.includeGlobal === true };
    const key = `${includeInactive ? "inactive" : "default"}:${own === undefined ? "*" : JSON.stringify([own.projectId, own.includeGlobal])}`;
    const cached = this.views.get(key);
    if (cached !== undefined) {
      this.views.delete(key);
      this.views.set(key, cached);
      return cached;
    }
    const created = createView(this.generation, this.computed, own, includeInactive);
    this.views.set(key, created);
    while (this.views.size > SNAPSHOT_VIEW_LIMIT) {
      const oldest = this.views.keys().next().value;
      if (oldest === undefined) break;
      this.views.delete(oldest);
    }
    return created;
  }

  isAllowed(id: number, scope?: MemoryReadScope, includeInactive = false): boolean {
    return this.view(scope, includeInactive).isAllowed(id);
  }
}

function createView(
  generation: number,
  computed: MemoryVisibilityComputation,
  scope: MemoryReadScope | undefined,
  includeInactive: boolean,
): MemoryVisibilityView {
  // includeInactive admits every readable row; the default rules admit supported rows only.
  const base: ReadonlySet<number> | ReadonlyMap<number, unknown> =
    includeInactive ? computed.projectById : computed.supportedIds;
  const isAllowed = scope === undefined
    ? (id: number) => base.has(id)
    : (id: number) => base.has(id) && matchesMemoryScope(computed.projectById.get(id), scope);
  let allowed: ReadonlySet<number> | undefined | null = null;
  return {
    generation,
    validityEpoch: includeInactive ? 0 : computed.validityEpoch,
    excludedIds: scope !== undefined ? undefined : includeInactive ? computed.unparseableIds : computed.excludedIds,
    isAllowed,
    get allowedIds() {
      if (allowed === null) {
        let set: ReadonlySet<number> = computed.supportedIds;
        if (scope !== undefined || includeInactive) {
          const built = new Set<number>();
          for (const id of base.keys()) if (isAllowed(id)) built.add(id);
          set = built;
        }
        allowed = set.size === computed.rowCount ? undefined : set;
      }
      return allowed;
    },
  };
}

function databaseOf(owner: MemoryVisibilityOwner): Database {
  return "getRawDb" in owner ? owner.getRawDb() : owner;
}

/** The current visibility generation; throws MemoryVisibilityStateError before migration v43. */
export function readMemoryVisibilityGeneration(owner: MemoryVisibilityOwner): number {
  const db = databaseOf(owner);
  let row: { generation: number } | null;
  try {
    row = db.query(GENERATION_SQL).get(STATE_ROW_ID) as { generation: number } | null;
  } catch (error) {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(STATE_TABLE);
    if (table === null) throw new MemoryVisibilityStateError({ cause: error });
    throw error;
  }
  if (row === null) throw new MemoryVisibilityStateError();
  return row.generation;
}

/**
 * Visibility is a function of the database state and the clock. A database's snapshot is
 * reused while memory_visibility_state.generation is unchanged (triggers bump it on every
 * visibility input, from any connection) and `now` stays inside its validity window. The
 * generation read and both scans share one read transaction, so they see a single state even
 * while another process writes.
 */
export function getMemoryVisibilitySnapshot(
  owner: MemoryVisibilityOwner,
  now: number = Date.now(),
): MemoryVisibilitySnapshot {
  const db = databaseOf(owner);
  const cached = snapshots.get(db);
  if (cached !== undefined && cached.answers(now) && cached.generation === readMemoryVisibilityGeneration(db)) {
    return cached;
  }
  const snapshot = db.transaction(() => new VisibilitySnapshot(
    readMemoryVisibilityGeneration(db),
    computeMemoryVisibility(
      db.query(NODE_SCAN_SQL).iterate() as Iterable<VisibilityNodeRow>,
      db.query(LINEAGE_EDGE_SQL).iterate(...SHARED_MEMORY_LINEAGE_RELATIONS) as Iterable<VisibilityLineageEdgeRow>,
      now,
    ),
  ))();
  computationCounts.set(db, (computationCounts.get(db) ?? 0) + 1);
  // Inside an open transaction the rows can include writes that later roll back, after which
  // a committed write can reach the same generation number with different rows. Such a
  // snapshot serves this call only; so does one computed for a non-finite `now`.
  if (!db.inTransaction && Number.isFinite(now)) snapshots.set(db, snapshot);
  return snapshot;
}

/** Snapshot computations for this database in this process; lets tests and diagnostics see reuse. */
export function countMemoryVisibilityComputations(owner: MemoryVisibilityOwner): number {
  return computationCounts.get(databaseOf(owner)) ?? 0;
}

/**
 * One visibility snapshot supplies vector/FTS candidates. Search ancillary output is judged
 * item by item against the same snapshot (search-ancillary-visibility.ts), not by whether
 * some unrelated stored row is excluded.
 */
export function readMemoryVisibility(
  store: SqliteMemoryStore,
  scope?: MemoryReadScope,
  includeInactive = false,
  now = Date.now(),
): { allowedIds: ReadonlySet<number> | undefined; validityEpoch: number } {
  return readMemoryVisibilityFromDatabase(store.getRawDb(), scope, includeInactive, now);
}

/** Repository callers use the same snapshot without constructing another store. */
export function readMemoryVisibilityFromDatabase(
  db: Database,
  scope?: MemoryReadScope,
  includeInactive = false,
  now = Date.now(),
): { allowedIds: ReadonlySet<number> | undefined; validityEpoch: number } {
  const view = getMemoryVisibilitySnapshot(db, now).view(scope, includeInactive);
  return { allowedIds: view.allowedIds, validityEpoch: view.validityEpoch };
}
