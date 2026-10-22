/**
 * shared-memory-visibility-snapshot.test.ts — the cached visibility snapshot answers exactly
 * what the per-call scan answered before WP-B1-02.
 *
 * The oracle below is the previous readMemoryVisibilityFromDatabase copied verbatim (with the
 * previous isCurrentMemory body inlined), so the comparison does not depend on the refactor
 * it checks. Mixed hand-written rows and seeded random rows are compared for every scope shape,
 * both includeInactive values and clock readings on both sides of each validity boundary.
 *
 * Also frozen here: a snapshot computed inside a transaction that rolls back is never reused,
 * a database without migration v43 fails loudly, and a non-finite clock reading is not cached.
 * Mock 0 — real SQLite through openMemoryDatabase; rows are data fixtures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import {
  isDerivedSourceType, matchesMemoryScope, readSharedMemory, readSharedMemoryForNode,
  type ResolvedMemoryScope,
} from "./shared-memory-contract.ts";
import {
  countMemoryVisibilityComputations, getMemoryVisibilitySnapshot, MemoryVisibilityStateError,
  readMemoryVisibilityFromDatabase,
} from "./shared-memory-read.ts";
import { globalScope, projectValuesScope } from "../test-utils/resolved-scope.ts";

type Visibility = { allowedIds: ReadonlySet<number> | undefined; validityEpoch: number };

/** readMemoryVisibilityFromDatabase as committed in d451e3a6 (the pre-snapshot semantics). */
function legacyVisibility(db: Database, scope?: ResolvedMemoryScope, includeInactive = false, now = Date.now()): Visibility {
  const legacyIsCurrent = (metadata: Record<string, unknown>, at: number): boolean => {
    const state = readSharedMemory(metadata);
    return state.status === "active" && Number.isFinite(at)
      && (!state.validFrom || Date.parse(state.validFrom) <= at)
      && (!state.validUntil || at < Date.parse(state.validUntil));
  };
  const rows = db.query("SELECT id, project_id, source_type, metadata_json FROM knowledge_nodes")
    .all() as Array<{ id: number; project_id: string | null; source_type: string; metadata_json: string | null }>;
  const nodes = new Map<number, { projectId: string | null; sourceType: string; current: boolean; parents: Set<number>; metadata: Record<string, unknown> }>();
  const allowed = new Set<number>();
  let validityEpoch = 0;
  for (const row of rows) {
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(row.metadata_json ?? "{}"); }
    catch { continue; }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const state = readSharedMemoryForNode({ sourceType: row.source_type, metadata });
    if (!includeInactive) {
      for (const boundary of [state.validFrom, state.validUntil]) {
        const instant = boundary ? Date.parse(boundary) : NaN;
        if (instant <= now) validityEpoch = Math.max(validityEpoch, instant);
      }
    }
    nodes.set(row.id, { projectId: row.project_id, sourceType: row.source_type,
      current: legacyIsCurrent(metadata, now), parents: new Set(state.evidenceRefs ?? []), metadata });
  }
  if (!includeInactive) {
    const edges = db.query("SELECT source_id, target_id, provenance FROM knowledge_edges WHERE relation IN ('merged_into', 'parent_of')")
      .all() as Array<{ source_id: number; target_id: number; provenance: string }>;
    for (const edge of edges) {
      const child = nodes.get(edge.source_id);
      if (child && (isDerivedSourceType(child.sourceType) || edge.provenance === "regex")) child.parents.add(edge.target_id);
    }
    for (const [id, node] of nodes) {
      if (!Array.isArray(node.metadata.extractedTo)) continue;
      for (const childId of node.metadata.extractedTo) {
        if (typeof childId !== "number") continue;
        const child = nodes.get(childId);
        if (child && isDerivedSourceType(child.sourceType)) child.parents.add(id);
      }
    }
  }
  const supported = new Set<number>();
  const dependents = new Map<number, number[]>();
  for (const [id, node] of nodes) {
    if (includeInactive || (node.current && node.parents.size === 0)) supported.add(id);
    if (!node.current || includeInactive) continue;
    for (const parentId of node.parents) {
      const children = dependents.get(parentId) ?? [];
      children.push(id);
      dependents.set(parentId, children);
    }
  }
  const pending = [...supported];
  for (let i = 0; i < pending.length; i += 1) {
    for (const childId of dependents.get(pending[i]!) ?? []) {
      if (supported.has(childId)) continue;
      supported.add(childId);
      pending.push(childId);
    }
  }
  for (const id of supported) {
    if (matchesMemoryScope(nodes.get(id)!.projectId, scope)) allowed.add(id);
  }
  const filtered = allowed.size !== rows.length;
  // The oracle's former `restricted` flag was removed with the field (WP-B1-03): search
  // ancillary output is now judged per item instead of by a database-wide restriction.
  return { allowedIds: filtered ? allowed : undefined, validityEpoch };
}

const comparable = (v: Visibility) => ({
  allowedIds: v.allowedIds === undefined ? null : [...v.allowedIds].sort((a, b) => a - b),
  validityEpoch: v.validityEpoch,
});

const PROJECTS = ["A", "B", "C"] as const;
const SCOPES: Array<ResolvedMemoryScope | undefined> = [
  undefined, globalScope(), { ...globalScope(), includeGlobal: true },
  ...PROJECTS.flatMap((projectId) => [projectValuesScope([projectId]), projectValuesScope([projectId], true)]),
  projectValuesScope(["Z"]), projectValuesScope(["Z"], true),
  // 해석기가 한 프로젝트를 번호 + 옛 글자값 여러 개로 묶은 범위(2026-10-21 spec 10.1).
  projectValuesScope(["A", "B"]), projectValuesScope(["B", "A"], true),
];

function expectSameAsLegacy(db: Database, now: number): void {
  for (const includeInactive of [false, true]) {
    for (const scope of SCOPES) {
      const label = `now=${now} inactive=${includeInactive} scope=${JSON.stringify(scope)}`;
      expect({ label, ...comparable(readMemoryVisibilityFromDatabase(db, scope, includeInactive, now)) })
        .toEqual({ label, ...comparable(legacyVisibility(db, scope, includeInactive, now)) });
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-09-28T00:00:00Z");
const PAST = Date.parse("2026-01-01T00:00:00Z");
const SOON = Date.parse("2026-10-01T00:00:00Z");
const LATER = Date.parse("2027-01-01T00:00:00Z");

let db: Database;
beforeEach(() => { db = openMemoryDatabase(":memory:", { embeddingDim: 8 }); });
afterEach(() => db.close());

function node(id: number, sourceType: string, projectId: string | null, metadata: unknown): void {
  db.query("INSERT INTO knowledge_nodes (id, content, source_type, project_id, metadata_json) VALUES (?, ?, ?, ?, ?)")
    .run(id, `node ${id}`, sourceType, projectId, typeof metadata === "string" ? metadata : JSON.stringify(metadata));
}
function edge(sourceId: number, targetId: number, relation: string, provenance = "system"): void {
  db.query("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance) VALUES (?, ?, ?, ?)")
    .run(sourceId, targetId, relation, provenance);
}
const shared = (sharedMemory: Record<string, unknown>) => ({ sharedMemory: { revision: 0, assertionKind: "unknown", ...sharedMemory } });

/** Every lifecycle state, boundary position, support path and unreadable form in one database. */
function seedMixed(): void {
  node(1, "user_explicit", null, {});
  node(2, "user_explicit", "A", shared({ status: "active" }));
  node(3, "user_explicit", "B", shared({ status: "active" }));
  node(4, "user_explicit", "A", shared({ status: "retracted" }));
  node(5, "user_explicit", null, shared({ status: "superseded", supersededBy: 1 }));
  node(6, "user_explicit", "B", shared({ status: "disputed" }));
  node(7, "user_explicit", null, shared({ status: "active", validUntil: iso(PAST) }));
  node(8, "user_explicit", "A", shared({ status: "active", validFrom: iso(SOON) }));
  node(9, "user_explicit", null, shared({ status: "active", validFrom: iso(PAST), validUntil: iso(LATER) }));
  node(10, "user_explicit", "B", { sharedMemory: { status: "bogus" } });
  node(11, "user_explicit", null, "{bad");
  node(12, "user_explicit", "A", "[1,2]");
  node(13, "user_explicit", null, "null");
  node(14, "user_explicit", "B", "3");
  node(15, "user_explicit", "A", shared({ status: "active", evidenceRefs: [1] }));
  node(16, "user_explicit", "A", shared({ status: "active", evidenceRefs: [4] }));
  node(17, "user_explicit", null, shared({ status: "active", evidenceRefs: [999] }));
  node(18, "user_explicit", "B", shared({ status: "active", evidenceRefs: [16, 1] }));
  node(19, "user_explicit", null, shared({ status: "active", evidenceRefs: [20] }));
  node(20, "user_explicit", null, shared({ status: "active", evidenceRefs: [19] }));
  node(21, "user_explicit", "A", shared({ status: "active", evidenceRefs: [8] }));
  node(22, "document_chunk", "A", { parentNodeId: 2, chunkIndex: 0 });
  node(23, "document_chunk", "A", shared({ status: "active", evidenceRefs: [1] }));
  node(24, "llm_extract", "A", { source: "llm_extract" });
  node(25, "llm_extract", null, {});
  node(26, "image_caption", "A", {});
  node(27, "llm_extract", null, {});
  node(28, "user_explicit", "A", {});
  node(29, "user_explicit", "A", {});
  node(30, "document_chunk", "A", {});
  node(31, "auto_capture", null, { pending_review: true });
  node(32, "auto_capture", "A", { pending_review: 1 });
  node(33, "llm_extract", null, {});
  node(34, "user_explicit", "A", shared({ status: "active", validUntil: iso(SOON) }));
  node(35, "user_explicit", "A", shared({ status: "active", evidenceRefs: [34] }));
  node(36, "user_explicit", "C", { extractedTo: ["x", 22, 26.5] });
  db.run("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = 1", [JSON.stringify({ extractedTo: [27] })]);
  db.run("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = 4", [JSON.stringify({ ...shared({ status: "retracted" }), extractedTo: [26] })]);
  edge(22, 2, "parent_of");
  edge(23, 4, "parent_of");
  edge(24, 2, "merged_into");
  edge(24, 4, "merged_into");
  edge(28, 4, "merged_into", "regex");
  edge(29, 4, "merged_into", "user_input");
  edge(30, 22, "parent_of");
  edge(33, 7, "merged_into");
  edge(2, 3, "related_to", "evolver");
  edge(15, 5, "supersedes", "user_input");
  edge(6, 3, "contradicts");
}

describe("snapshot = the previous per-call scan", () => {
  test("mixed rows: every scope, both includeInactive values, clocks around every boundary", () => {
    seedMixed();
    for (const now of [NOW, NOW + 1, SOON - 1, SOON, SOON + 1, LATER - 1, LATER, LATER + 5, PAST - 1, PAST, NOW]) {
      expectSameAsLegacy(db, now);
    }
  });

  test("one computation serves every view while the generation and window hold", () => {
    seedMixed();
    const start = countMemoryVisibilityComputations(db);
    expectSameAsLegacy(db, NOW);
    expect(countMemoryVisibilityComputations(db)).toBe(start + 1);
    // Still inside [latest passed boundary, next boundary): reused.
    expectSameAsLegacy(db, SOON - 1);
    expect(countMemoryVisibilityComputations(db)).toBe(start + 1);
    // Crossing SOON (node 8 starts, node 34 and its dependent 35 expire) recomputes once.
    expectSameAsLegacy(db, SOON);
    expect(countMemoryVisibilityComputations(db)).toBe(start + 2);
    const boundaryIds = (now: number) => [...readMemoryVisibilityFromDatabase(db, undefined, false, now).allowedIds!]
      .filter((id) => [8, 21, 34, 35].includes(id)).sort((a, b) => a - b);
    expect(boundaryIds(SOON - 1)).toEqual([34, 35]);
    expect(boundaryIds(SOON)).toEqual([8, 21]);
  });

  test("an empty database admits everything", () => {
    expectSameAsLegacy(db, NOW);
    expect(readMemoryVisibilityFromDatabase(db, undefined, false, NOW)).toEqual({ allowedIds: undefined, validityEpoch: 0 });
  });

  // 5 seeds of 300 random rows, each compared with the previous scan at every validity boundary: ~4 s alone, ~5.5 s under the full suite, above the 5 s default.
  test("seeded random graphs match on every scope and clock", () => {
    for (const seed of [1, 7, 42, 2026, 9001]) {
      db.close();
      db = openMemoryDatabase(":memory:", { embeddingDim: 8 });
      const random = mulberry32(seed);
      const boundaries = seedRandom(random, 300);
      for (const now of [NOW, ...boundaries.flatMap((b) => [b - 1, b, b + 1])]) {
        expectSameAsLegacy(db, now);
      }
    }
  }, 60_000);
});

/** Deterministic PRNG so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random rows and edges; returns the validity boundaries it used (for clock sampling). */
function seedRandom(random: () => number, count: number): number[] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const boundaries = [PAST, NOW + 3_600_000, SOON, LATER].concat(
    Array.from({ length: 4 }, () => NOW + Math.floor((random() - 0.5) * 30 * 86_400_000)));
  const sourceTypes = ["user_explicit", "auto_capture", "document", "document_chunk", "llm_extract", "image_caption"];
  const statuses = ["active", "active", "active", "retracted", "superseded", "disputed"];
  for (let id = 1; id <= count; id++) {
    const roll = random();
    let metadata: unknown;
    if (roll < 0.03) metadata = pick(["{bad", "[]", "null", "7", "\"text\""]);
    else if (roll < 0.25) metadata = {};
    else {
      const state: Record<string, unknown> = { status: pick(statuses) };
      if (random() < 0.3) state.validFrom = iso(pick(boundaries));
      if (random() < 0.3) state.validUntil = iso(pick(boundaries) + 1);
      if (state.validFrom !== undefined && state.validUntil !== undefined
        && Date.parse(state.validFrom as string) >= Date.parse(state.validUntil as string)) delete state.validFrom;
      if (random() < 0.3) state.evidenceRefs = Array.from({ length: 1 + Math.floor(random() * 3) }, () => 1 + Math.floor(random() * (count + 20)));
      if (random() < 0.05) state.status = "unknown-status";
      const extra: Record<string, unknown> = {};
      if (random() < 0.1) extra.pending_review = pick([true, 1, false, "1"]);
      if (random() < 0.1) extra.extractedTo = Array.from({ length: 1 + Math.floor(random() * 3) }, () => 1 + Math.floor(random() * count));
      metadata = { ...shared(state), ...extra };
    }
    node(id, pick(sourceTypes), pick([null, null, ...PROJECTS]), metadata);
  }
  const relations = ["merged_into", "parent_of", "merged_into", "related_to", "supersedes"];
  const provenances = ["system", "regex", "user_input", "llm_extract"];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const source = 1 + Math.floor(random() * count);
    const target = 1 + Math.floor(random() * count);
    const relation = pick(relations);
    const key = `${source}:${target}:${relation}`;
    if (source === target || seen.has(key)) continue;
    seen.add(key);
    edge(source, target, relation, pick(provenances));
  }
  return boundaries;
}

describe("snapshot cache safety", () => {
  test("a snapshot computed inside a rolled-back transaction is never reused", () => {
    node(1, "user_explicit", null, {});
    node(2, "user_explicit", null, {});
    const retracted = JSON.stringify(shared({ status: "retracted" }));
    expect(readMemoryVisibilityFromDatabase(db).allowedIds).toBeUndefined();

    // Same connection: the transaction sees its own retraction of node 1, then rolls back.
    db.run("BEGIN");
    db.run("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = 1", [retracted]);
    expect([...readMemoryVisibilityFromDatabase(db).allowedIds!]).toEqual([2]);
    db.run("ROLLBACK");

    // A committed write now reaches the same generation number with different rows.
    db.run("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = 2", [retracted]);
    expect([...readMemoryVisibilityFromDatabase(db).allowedIds!]).toEqual([1]);
    expect(legacyVisibility(db).allowedIds).toEqual(new Set([1]));
  });

  test("a throwing db.transaction (the mutation path) also leaves no reusable snapshot", () => {
    node(1, "user_explicit", null, {});
    node(2, "user_explicit", null, {});
    const retracted = JSON.stringify(shared({ status: "retracted" }));
    expect(() => db.transaction(() => {
      db.run("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = 1", [retracted]);
      expect(getMemoryVisibilitySnapshot(db).isAllowed(1)).toBe(false);
      throw new Error("validation failed after the write");
    })()).toThrow("validation failed after the write");
    db.run("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = 2", [retracted]);
    const snapshot = getMemoryVisibilitySnapshot(db);
    expect(snapshot.isAllowed(1)).toBe(true);
    expect(snapshot.isAllowed(2)).toBe(false);
  });

  test("a non-finite clock reading computes like the old scan but is not cached", () => {
    seedMixed();
    expect(comparable(readMemoryVisibilityFromDatabase(db, undefined, false, NaN)))
      .toEqual(comparable(legacyVisibility(db, undefined, false, NaN)));
    const before = countMemoryVisibilityComputations(db);
    expectSameAsLegacy(db, NOW);
    expectSameAsLegacy(db, NOW + 1);
    expect(countMemoryVisibilityComputations(db)).toBe(before + 1);
  });

  test("the read fails loudly when baseline visibility row is missing", () => {
    node(1, "user_explicit", null, {});
    db.run("DELETE FROM memory_visibility_state");
    expect(() => readMemoryVisibilityFromDatabase(db)).toThrow(MemoryVisibilityStateError);
    expect(() => readMemoryVisibilityFromDatabase(db)).toThrow(/memory_visibility_state id = 1 행이 없습니다/);
    for (const trigger of ["kn_visibility_insert", "kn_visibility_delete", "kn_visibility_update",
      "ke_visibility_insert", "ke_visibility_delete", "ke_visibility_update"]) db.run(`DROP TRIGGER ${trigger}`);
    db.run("DROP TABLE memory_visibility_state");
    expect(() => readMemoryVisibilityFromDatabase(db)).toThrow(MemoryVisibilityStateError);
    expect(() => readMemoryVisibilityFromDatabase(db)).toThrow(/memory_visibility_state/);
  });
});
