import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "./retriever.ts";
import { ContextAssembler } from "./context-assembler.ts";
import { SearchCache } from "./search-cache.ts";
import { getProfile, getProfileForRequest } from "../server-internal/profile.ts";
import { globalScope, projectValuesScope } from "../test-utils/resolved-scope.ts";
import { runSearchPipeline } from "../server-internal/routes/search-service.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import {
  countMemoryVisibilityComputations, readMemoryVisibility, readMemoryVisibilityGeneration,
} from "./shared-memory-read.ts";
import { saveSharedMemoryInput } from "../server-internal/shared-memory-write.ts";
import { retractSharedMemory, supersedeSharedMemory, updateSharedMemory } from "./shared-memory-mutations.ts";
import { cleanupTempDir, makeWalTempDir } from "../db/wal-test-helpers.ts";

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
beforeAll(async () => { embedder = new Bgem3Embedder(); await embedder.load(); });
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  store = new SqliteMemoryStore(db, embedder);
  deps = { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), searchCache: new SearchCache() };
});
afterEach(() => db.close());

test("scope and lifecycle filter before candidate limit, preserving a distant valid result", async () => {
  const vector = await embedder.embed("공용 장기 기억");
  for (let i = 0; i < 25; i++) {
    await store.addNode({ content: `공용 장기 기억 다른 프로젝트 ${i}`, embedding: vector, project_id: "B" });
  }
  const global = await store.addNode({ content: "공용 장기 기억 전역", embedding: vector });
  const current = await store.addNode({ content: "공용 장기 기억 프로젝트 A", embedding: vector, project_id: "A" });
  await store.addNode({ content: "공용 장기 기억 폐기", embedding: vector, project_id: "A", metadata: { sharedMemory: { status: "retracted" } } });
  await store.addNode({ content: "공용 장기 기억 만료", embedding: vector, project_id: "A", metadata: { sharedMemory: { validUntil: "2020-01-01T00:00:00Z" } } });
  const result = await deps.retriever.retrieve("공용 장기 기억", { limit: 2, vectorK: 2, ftsLimit: 2, scope: projectValuesScope(["A"], true) });
  expect(new Set(result.map(r => r.node.id))).toEqual(new Set([global, current]));
  const history = await deps.retriever.retrieve("공용 장기 기억", { limit: 100, scope: projectValuesScope(["A"]), includeInactive: true });
  expect(history).toHaveLength(3);
});

test("profile defaults global, project includes global, and omits inactive preferences", async () => {
  const embedding = await embedder.embed("선호");
  const global = await store.addNode({ content: "공통 규칙", memoryType: "preference", embedding });
  const scoped = await store.addNode({ content: "A 규칙", memoryType: "preference", embedding, project_id: "A" });
  await store.addNode({ content: "B 규칙", memoryType: "preference", embedding, project_id: "B" });
  await store.addNode({ content: "철회 규칙", memoryType: "preference", embedding, metadata: { sharedMemory: { status: "superseded" } } });
  expect(Object.values(getProfile(deps, { scope: globalScope() }).facets).flat().map(x => x.id)).toEqual([global]);
  expect(new Set(Object.values((await getProfileForRequest(deps, { scope: { projectId: "A" } })).facets).flat().map(x => x.id))).toEqual(new Set([global, scoped]));
});

test("search scope separates cached results and never relaxes project boundaries", async () => {
  const embedding = await embedder.embed("공용 기억");
  const a = await store.addNode({ content: "공용 기억 A", embedding, project_id: "A" });
  const b = await store.addNode({ content: "공용 기억 B", embedding, project_id: "B" });
  const search = (projectId: string) => runSearchPipeline(deps, { query: "공용 기억", scope: { projectId }, responseMode: "index", relaxFilters: true, filter: { tag: "없는분류" } }, new URLSearchParams());
  expect((await search("A")).results).toEqual([expect.objectContaining({ id: a })]);
  expect((await search("B")).results).toEqual([expect.objectContaining({ id: b })]);
  expect((await search("A")).results).toEqual([expect.objectContaining({ id: a })]);
  await expect(runSearchPipeline(deps, { query: "공용 기억", scope: { projectId: 1 } }, new URLSearchParams())).rejects.toThrow();
});

test("FTS-only search replenishes candidates before applying the requested limit", async () => {
  const embedding = await embedder.embed("공용 기억");
  const allowed = await store.addNode({ content: "공용 기억 " + "보충 문장 ".repeat(40), embedding, project_id: "A" });
  for (let i = 0; i < 30; i++) await store.addNode({ content: "공용 기억", embedding, project_id: "B" });
  const results = await deps.retriever.retrieve("공용 기억", { scope: projectValuesScope(["A"]), limit: 1, ftsLimit: 1,
    channelMask: { vector: false, fts: true, graph: false, concept: false, imageVec: false, person: false, project: false } });
  expect(results.map(r => r.node.id)).toEqual([allowed]);
});

test("full and index expansions cannot substitute an out-of-scope parent", async () => {
  const embedding = await embedder.embed("공용 기억");
  const parent = await store.addNode({ content: "SECRET_PROJECT_B_PARENT", embedding, project_id: "B", sourceType: "auto_capture" });
  const child = await store.addNode({ content: "공용 기억 공개된 자식", embedding, project_id: "A", sourceType: "llm_extract" });
  await store.addEdge({ sourceId: child, targetId: parent, relation: "merged_into", provenance: "user_input", sourceNodeId: null, weight: 1 });
  for (const responseMode of ["index", "full"]) {
    const output = await runSearchPipeline(deps, { query: "공용 기억", scope: { projectId: "A" }, responseMode, withSummaries: true, contextBudget: 1000 }, new URLSearchParams());
    expect(JSON.stringify(output)).not.toContain("SECRET_PROJECT_B_PARENT");
    expect(output.results).toEqual([expect.objectContaining({ id: child })]);
    expect(output.omittedAncillary).toContain("parentSubstitution");
    if (responseMode === "full") {
      expect(output.entityHits).toEqual([]);
      expect(output.results).toEqual([expect.objectContaining({ neighbors: [], chunkSummary: null, relationSummaries: [] })]);
    }
  }
});

test("cached evidence expires without a database write and inactive reads are separate", async () => {
  const embedding = await embedder.embed("공용 기억");
  const expiry = Date.now() + 1200;
  const id = await store.addNode({ content: "공용 기억 임시 규칙", embedding, metadata: { sharedMemory: { validUntil: new Date(expiry).toISOString() } } });
  const body = { query: "공용 기억", responseMode: "index" };
  expect((await runSearchPipeline(deps, body, new URLSearchParams())).results).toEqual([expect.objectContaining({ id })]);
  await Bun.sleep(Math.max(0, expiry - Date.now()) + 20);
  expect((await runSearchPipeline(deps, body, new URLSearchParams())).results).toEqual([]);
  expect((await runSearchPipeline(deps, { ...body, includeInactive: true }, new URLSearchParams())).results).toEqual([expect.objectContaining({ id })]);
});

test("dependent preferences disappear from cached search and profile when their sole evidence expires", async () => {
  const embedding = await embedder.embed("공용 기억");
  const expiry = Date.now() + 1200;
  const source = await store.addNode({ content: "임시 선호의 근거", embedding,
    metadata: { sharedMemory: { validUntil: new Date(expiry).toISOString() } } });
  const dependent = await store.addNode({ content: "공용 기억 임시 선호", memoryType: "preference", embedding,
    metadata: { sharedMemory: { assertionKind: "ai_inference", evidenceRefs: [source] } } });
  const body = { query: "공용 기억", responseMode: "index", memoryType: "preference" };
  expect((await runSearchPipeline(deps, body, new URLSearchParams())).results).toEqual([expect.objectContaining({ id: dependent })]);
  expect(Object.values(getProfile(deps, { scope: globalScope() }).facets).flat().map(x => x.id)).toEqual([dependent]);
  await Bun.sleep(Math.max(0, expiry - Date.now()) + 20);
  expect((await runSearchPipeline(deps, body, new URLSearchParams())).results).toEqual([]);
  expect(Object.values(getProfile(deps, { scope: globalScope() }).facets).flat()).toEqual([]);
  expect(Object.values(getProfile(deps, { scope: globalScope(), includeInactive: true }).facets).flat().map(x => x.id)).toEqual([dependent]);
});

test("visibility requires grounded current evidence, allowing independent support but excluding missing sources and cycles", async () => {
  const embedding = await embedder.embed("근거");
  const source = await store.addNode({ content: "제거할 근거", embedding });
  const independent = await store.addNode({ content: "독립적인 전역 근거", embedding });
  const missingOnly = await store.addNode({ content: "삭제된 근거만 있는 선호", memoryType: "preference", embedding,
    metadata: { sharedMemory: { evidenceRefs: [source] } } });
  const supported = await store.addNode({ content: "다른 근거가 남는 선호", memoryType: "preference", project_id: "A", embedding,
    metadata: { sharedMemory: { evidenceRefs: [source, independent] } } });
  const descendant = await store.addNode({ content: "살아 있는 근거의 후손", memoryType: "preference", project_id: "A", embedding,
    metadata: { sharedMemory: { evidenceRefs: [supported] } } });
  const cycleA = await store.addNode({ content: "자체 순환 A", embedding });
  const cycleB = await store.addNode({ content: "자체 순환 B", embedding,
    metadata: { sharedMemory: { evidenceRefs: [cycleA] } } });
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { evidenceRefs: [cycleB] } }), cycleA);
  await store.deleteNode(source);
  const visible = readMemoryVisibility(store).allowedIds!;
  expect(visible.has(missingOnly)).toBe(false);
  expect(visible.has(cycleA)).toBe(false);
  expect(visible.has(cycleB)).toBe(false);
  expect(visible.has(supported)).toBe(true);
  expect(visible.has(descendant)).toBe(true);
  expect(readMemoryVisibility(store, projectValuesScope(["A"])).allowedIds).toEqual(new Set([supported, descendant]));
  expect(Object.values(getProfile(deps, { scope: globalScope() }).facets).flat()).toEqual([]);
  expect(readMemoryVisibility(store, undefined, true).allowedIds).toBeUndefined();
});

test("derived and regex lineage follows source validity while manual relationships remain independent", async () => {
  const embedding = await embedder.embed("근거");
  const source = await store.addNode({ content: "기간이 지난 원문", embedding,
    metadata: { sharedMemory: { validUntil: "2020-01-01T00:00:00Z" } } });
  const derived = await store.addNode({ content: "원문에서 생성된 요약", sourceType: "llm_extract", embedding });
  const regex = await store.addNode({ content: "원문에서 정규식 추출", embedding });
  const manual = await store.addNode({ content: "사용자가 독립적으로 연결한 기억", embedding });
  for (const [id, provenance] of [[derived, "system"], [regex, "regex"], [manual, "user_input"]] as const) {
    await store.addEdge({ sourceId: id, targetId: source, relation: "merged_into", provenance, sourceNodeId: id, weight: 1 });
  }
  expect(readMemoryVisibility(store).allowedIds).toEqual(new Set([manual]));
});

const author = "client-a";
// One chunk per paragraph: each paragraph fits under tokenCap, the whole text does not.
const DECISION = [
  "배포 결정문의 첫 문단은 금요일 오후 창구를 쓰기로 한 이유를 적는다.",
  "둘째 문단은 롤백 담당과 알림 경로를 운영팀 채널로 고정한다.",
  "셋째 문단은 점검 목록을 배포 전날 저녁에 한 번 더 확인한다고 정한다.",
].join("\n\n");

async function saveEvidenceBackedDecision() {
  const evidence = (await saveSharedMemoryInput(store, { content: "운영팀은 매주 배포 공지를 채널에 올린다.", source: "mcp", author })).originNodeId!;
  const saved = await saveSharedMemoryInput(store, {
    content: DECISION, source: "mcp", author, chunking: { tokenCap: 60, minChunkTokens: 1 },
  }, { assertionKind: "user_statement", evidenceRefs: [evidence] });
  expect(saved.chunkNodeIds).toHaveLength(3);
  return { evidence, decision: saved.originNodeId!, chunks: saved.chunkNodeIds };
}

async function searchHitIds(extra: Record<string, unknown> = {}): Promise<number[]> {
  const output = await runSearchPipeline(deps, { query: "롤백 담당과 알림 경로", responseMode: "index", ...extra }, new URLSearchParams());
  return (output.results as Array<{ id: number }>).map((result) => result.id);
}

test("search and recall omit the chunks of a retracted evidence-backed memory while its evidence stays current", async () => {
  const { evidence, decision, chunks } = await saveEvidenceBackedDecision();
  const lineage = new Set([decision, ...chunks]);
  expect((await searchHitIds()).some((id) => lineage.has(id))).toBe(true);
  await retractSharedMemory(store, { nodeId: decision, expectedRevision: 0, requestId: "retract-decision", actor: author });
  for (const responseMode of ["index", "full"]) {
    expect((await searchHitIds({ responseMode })).filter((id) => lineage.has(id))).toEqual([]);
  }
  // recall_context admits only ids inside this global-scope visibility set.
  const recallable = readMemoryVisibility(store, globalScope()).allowedIds!;
  for (const id of lineage) expect(recallable.has(id)).toBe(false);
  expect(recallable.has(evidence)).toBe(true);
  for (const id of chunks) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: decision });
  }
  expect((await searchHitIds({ includeInactive: true })).some((id) => lineage.has(id))).toBe(true);
});

test("retracting the evidence withdraws the memory that cited it together with its chunks", async () => {
  const { evidence, decision, chunks } = await saveEvidenceBackedDecision();
  const result = await retractSharedMemory(store, { nodeId: evidence, expectedRevision: 0, requestId: "retract-evidence", actor: author });
  expect(result.affectedNodeIds).toEqual([evidence, decision, ...chunks]);
  for (const id of [decision, ...chunks]) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: evidence });
  }
  const visible = readMemoryVisibility(store).allowedIds!;
  for (const id of [evidence, decision, ...chunks]) expect(visible.has(id)).toBe(false);
  expect((await searchHitIds()).filter((id) => id === decision || chunks.includes(id))).toEqual([]);
});

/** Rows as older versions stored them: derived children kept a copy of the parent's evidenceRefs. */
async function legacyCopiedEvidenceLineage() {
  const embedding = await embedder.embed("배포 결정");
  const evidence = await store.addNode({ content: "옛 배포 결정의 근거", embedding });
  const parent = await store.addNode({ content: "옛 배포 결정 원문", embedding });
  const chunk = await store.addNode({ content: "옛 배포 결정 원문의 청크", sourceType: "document_chunk", embedding });
  const child = await store.addNode({ content: "배포 소식은 짧은 공지로 알린다", sourceType: "llm_extract", memoryType: "preference", embedding });
  await store.addEdge({ sourceId: chunk, targetId: parent, relation: "parent_of", provenance: "system", sourceNodeId: chunk, weight: 1 });
  await store.addEdge({ sourceId: child, targetId: parent, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  const copied = (assertionKind: string) => ({ status: "active", revision: 0, assertionKind, evidenceRefs: [evidence] });
  const rows: Array<[number, Record<string, unknown>]> = [
    [parent, { sharedMemory: { status: "retracted", revision: 1, assertionKind: "user_statement", evidenceRefs: [evidence] }, extracted: 1, extractedTo: [child] }],
    [chunk, { sharedMemory: copied("user_statement"), parentNodeId: parent, chunkIndex: 0 }],
    [child, { source: "llm_extract", sharedMemory: copied("ai_inference") }],
  ];
  for (const [id, metadata] of rows) {
    db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), id);
  }
  return { evidence, parent, chunk, child, copied };
}

test("legacy derived rows with copied evidenceRefs leave default reads once their parent is withdrawn, without rewriting rows", async () => {
  const { evidence, parent, chunk, child, copied } = await legacyCopiedEvidenceLineage();
  const visible = readMemoryVisibility(store).allowedIds!;
  expect(visible.has(evidence)).toBe(true);
  for (const id of [parent, chunk, child]) expect(visible.has(id)).toBe(false);
  const hits = (await runSearchPipeline(deps, { query: "배포 결정", responseMode: "index" }, new URLSearchParams())).results as Array<{ id: number }>;
  expect(hits.map((hit) => hit.id)).toEqual([evidence]);
  expect(Object.values(getProfile(deps, { scope: globalScope() }).facets).flat()).toEqual([]);
  expect((await store.getNode(chunk))!.metadata.sharedMemory).toEqual(copied("user_statement"));
  expect((await store.getNode(child))!.metadata.sharedMemory).toEqual(copied("ai_inference"));
  const history = Object.values(getProfile(deps, { scope: globalScope(), includeInactive: true }).facets).flat();
  expect(history.map((entry) => entry.id)).toEqual([child]);
  expect(history[0]!.sharedMemory).toEqual({ status: "active", revision: 0, assertionKind: "ai_inference" });
});

test("restoring a legacy parent with its same body shows unmarked derivatives again; correcting the body withdraws them", async () => {
  const { parent, chunk, child } = await legacyCopiedEvidenceLineage();
  const isVisible = (id: number) => {
    const allowed = readMemoryVisibility(store).allowedIds;
    return allowed === undefined || allowed.has(id);
  };
  await updateSharedMemory(store, { nodeId: parent, content: "옛 배포 결정 원문", expectedRevision: 1, requestId: "restore-same-body", actor: author });
  for (const id of [parent, chunk, child]) expect(isVisible(id)).toBe(true);
  const corrected = await updateSharedMemory(store, { nodeId: parent, content: "고친 배포 결정 원문", expectedRevision: 2, requestId: "correct-body", actor: author });
  expect(corrected.affectedNodeIds).toEqual([parent, chunk, child]);
  for (const id of [chunk, child]) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: parent });
    expect(isVisible(id)).toBe(false);
  }
  expect(isVisible(parent)).toBe(true);
});

// ── WP-B1-02: the visibility snapshot is reused until a visibility input or the clock changes ──

/** Counts vec_nodes KNN statements executed on this connection (calls the real methods). */
function countVecKnn(database: Database): () => number {
  let knn = 0;
  let insideQuery = false;
  const isKnn = (sql: string) => /FROM vec_nodes\s+WHERE embedding MATCH/.test(sql);
  const prepare = database.prepare.bind(database);
  const query = database.query.bind(database);
  database.prepare = ((sql: string, ...rest: []) => {
    if (!insideQuery && isKnn(sql)) knn += 1;
    return prepare(sql, ...rest);
  }) as typeof database.prepare;
  database.query = ((sql: string) => {
    if (isKnn(sql)) knn += 1;
    insideQuery = true;
    try { return query(sql); } finally { insideQuery = false; }
  }) as typeof database.query;
  return () => knn;
}

test("consecutive searches reuse one snapshot, and an unscoped search with exclusions runs one KNN", async () => {
  const embedding = await embedder.embed("배포 절차 기억");
  for (let i = 0; i < 6; i++) await store.addNode({ content: `배포 절차 기억 ${i}`, embedding });
  const retracted = await store.addNode({ content: "배포 절차 기억 철회본", embedding,
    metadata: { sharedMemory: { status: "retracted" } } });
  const first = await runSearchPipeline(deps, { query: "배포 절차", responseMode: "index" }, new URLSearchParams());
  expect((first.results as Array<{ id: number }>).map((r) => r.id)).not.toContain(retracted);
  const computed = countMemoryVisibilityComputations(store);
  expect(computed).toBeGreaterThanOrEqual(1);

  const knn = countVecKnn(db);
  const second = await runSearchPipeline(deps, { query: "배포 절차 기억", responseMode: "index" }, new URLSearchParams());
  const secondIds = (second.results as Array<{ id: number }>).map((r) => r.id);
  expect(secondIds.length).toBeGreaterThan(0);
  expect(secondIds).not.toContain(retracted);
  // Cache key, retriever and final filter all read the snapshot the first search computed.
  expect(countMemoryVisibilityComputations(store)).toBe(computed);
  expect(knn()).toBe(1);
});

test("every visibility write bumps the generation and the next read recomputes; other writes do not", async () => {
  const embedding = await embedder.embed("가시성 쓰기 종류");
  const a = await store.addNode({ content: "가시성 쓰기 종류 A", embedding, project_id: "P" });
  const b = await store.addNode({ content: "가시성 쓰기 종류 B", embedding, project_id: "P" });
  const c = await store.addNode({ content: "가시성 쓰기 종류 C", embedding });
  const parent = await store.addNode({ content: "가시성 쓰기 종류 부모", embedding });
  const child = await store.addNode({ content: "가시성 쓰기 종류 자식", sourceType: "llm_extract", embedding });
  const visible = (id: number) => {
    const allowed = readMemoryVisibility(store).allowedIds;
    return allowed === undefined || allowed.has(id);
  };
  // The write itself may compute inside its own transaction (supersede re-checks visibility
  // there); what matters is that the first read after it recomputes exactly once.
  const expectRecompute = async (label: string, write: () => Promise<unknown> | unknown) => {
    visible(a);
    const generation = readMemoryVisibilityGeneration(store);
    await write();
    expect({ label, bumped: readMemoryVisibilityGeneration(store) > generation }).toEqual({ label, bumped: true });
    const computed = countMemoryVisibilityComputations(store);
    visible(a);
    visible(b);
    expect({ label, recomputed: countMemoryVisibilityComputations(store) - computed }).toEqual({ label, recomputed: 1 });
  };
  const expectReuse = async (label: string, write: () => Promise<unknown> | unknown) => {
    visible(a);
    const generation = readMemoryVisibilityGeneration(store);
    await write();
    const computed = countMemoryVisibilityComputations(store);
    visible(a);
    expect({ label, generation: readMemoryVisibilityGeneration(store), computed: countMemoryVisibilityComputations(store) })
      .toEqual({ label, generation, computed });
  };
  const author = "client-a";

  await expectRecompute("retract", () => retractSharedMemory(store, { nodeId: parent, expectedRevision: 0, requestId: "wk-retract", actor: author }));
  expect(visible(parent)).toBe(false);
  expect(visible(child)).toBe(true);
  // Linking the independent child to the withdrawn parent removes its only support, and back.
  await expectRecompute("lineage edge added", () => store.addEdge({ sourceId: child, targetId: parent, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 }));
  expect(visible(child)).toBe(false);
  await expectRecompute("lineage edge removed", () => store.removeEdge(child, parent, "merged_into"));
  expect(visible(child)).toBe(true);
  await expectRecompute("supersede", () => supersedeSharedMemory(store, { nodeId: a, replacementId: b, expectedRevision: 0, requestId: "wk-supersede", actor: author }));
  expect(visible(a)).toBe(false);
  expect(visible(b)).toBe(true);
  await expectRecompute("dispute", () => {
    // The conflict checker's write: a contradicts edge plus disputed status on the new memory.
    db.query("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id, weight) VALUES (?, ?, 'contradicts', 'system', ?, 0.7)").run(c, b, c);
    db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ sharedMemory: { status: "disputed", revision: 1, assertionKind: "unknown" } }), c);
  });
  expect(visible(c)).toBe(false);
  await expectRecompute("metadata updated directly", () =>
    db.query("UPDATE knowledge_nodes SET metadata_json = '{}' WHERE id = ?").run(c));
  expect(visible(c)).toBe(true);
  await expectRecompute("extractedTo marked", () => store.markNodeExtracted(c, [child]));
  let added = 0;
  await expectRecompute("node added", async () => {
    added = await store.addNode({ content: "가시성 쓰기 종류 신규", embedding, metadata: { sharedMemory: { status: "retracted" } } });
  });
  expect(visible(added)).toBe(false);
  await expectRecompute("node deleted", () => store.deleteNode(added));

  await expectReuse("access touch", () => store.touchNodesBatch([b, c]));
  await expectReuse("mention bump", () => store.bumpMention(b));
  await expectReuse("importance", () => store.updateNodeImportance(b, 0.9));
  await expectReuse("non-lineage edge", () => store.addEdge({ sourceId: b, targetId: c, relation: "related_to", provenance: "evolver", sourceNodeId: null, weight: 0.3 }));
});

test("crossing a validity boundary recomputes without any write", async () => {
  const embedding = await embedder.embed("시간 경계");
  const now = Date.now();
  const expiry = now + 60_000;
  const id = await store.addNode({ content: "시간 경계 임시 기억", embedding,
    metadata: { sharedMemory: { validUntil: new Date(expiry).toISOString() } } });
  const generation = readMemoryVisibilityGeneration(store);
  expect(readMemoryVisibility(store, undefined, false, now).allowedIds).toBeUndefined();
  const computed = countMemoryVisibilityComputations(store);
  expect(readMemoryVisibility(store, undefined, false, expiry - 1).allowedIds).toBeUndefined();
  expect(countMemoryVisibilityComputations(store)).toBe(computed);
  const expired = readMemoryVisibility(store, undefined, false, expiry);
  expect(expired.allowedIds!.has(id)).toBe(false);
  expect(expired.validityEpoch).toBe(expiry);
  expect(countMemoryVisibilityComputations(store)).toBe(computed + 1);
  expect(readMemoryVisibilityGeneration(store)).toBe(generation);
});

test("a write through a second connection to the same file is reflected on the next read", async () => {
  const { dir, file } = makeWalTempDir("bara-visibility-");
  const server = openMemoryDatabase(file, { embeddingDim: embedder.dimension });
  const tool = openMemoryDatabase(file, { embeddingDim: embedder.dimension });
  try {
    const serverStore = new SqliteMemoryStore(server, embedder);
    const toolStore = new SqliteMemoryStore(tool, embedder);
    const embedding = await embedder.embed("다른 연결");
    const id = await serverStore.addNode({ content: "다른 연결이 철회할 기억", embedding });
    const other = await serverStore.addNode({ content: "다른 연결이 건드리지 않을 기억", embedding });
    expect(readMemoryVisibility(serverStore).allowedIds).toBeUndefined();
    const computed = countMemoryVisibilityComputations(serverStore);

    await toolStore.touchNodesBatch([id, other]);
    expect(readMemoryVisibility(serverStore).allowedIds).toBeUndefined();
    expect(countMemoryVisibilityComputations(serverStore)).toBe(computed);

    await retractSharedMemory(toolStore, { nodeId: id, expectedRevision: 0, requestId: "other-connection", actor: "client-b" });
    expect(readMemoryVisibility(serverStore).allowedIds).toEqual(new Set([other]));
    expect(countMemoryVisibilityComputations(serverStore)).toBe(computed + 1);
    expect(readMemoryVisibilityGeneration(serverStore)).toBe(readMemoryVisibilityGeneration(toolStore));
  } finally {
    tool.close();
    server.close();
    cleanupTempDir(dir);
  }
});
