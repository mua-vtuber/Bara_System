import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { createEmbedder } from "../../embedding/factory.ts";
import type { MemoryApiDeps } from "../../server-internal/types.ts";
import { recomputeExternalFingerprint } from "../../server-internal/cleanup-external/candidates.ts";
import { submitExternalProposal } from "../../server-internal/cleanup-external/proposals.ts";
import { externalStageContractOf } from "../../server-internal/cleanup-external/stage-map.ts";
import { EventRepository } from "../../db/store-internal/event-repository.ts";
import { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import { NodeAbsorption } from "../../db/store-internal/node-absorption.ts";
import { EventBus } from "../../server-internal/event-bus.ts";
import { RegexL0Extractor } from "../regex-l0/extractor.ts";
import { queryCandidates as personCandidates } from "../person-link-candidate-query.ts";
import { runMetadataInferCycle } from "../metadata-infer-cycle.ts";
import { runPersonLinkInferCycle } from "../person-link-infer-cycle.ts";
import { collectEntityRegisterCandidates, readOriginalMemo } from "./entity-register/candidate-query.ts";
import { findRegexMissedCandidates } from "./candidate-query.ts";
import { findChunkSummaryCandidates } from "./summary-candidate-query.ts";
import { detectLensDraftCandidates, entityTargetKey } from "./lens-draft-candidate-query.ts";
import { processEntityRegisterMemo } from "./entity-register/process.ts";
import { EntityRegisterRecordsRepository } from "./entity-register/records-repository.ts";
import { judgeProfileFromLanguage } from "./entity-register/judge.ts";
import { isCleanupExcludedNode } from "./cleanup-eligibility.ts";
import { describeInputSource } from "../node-sources/source-ref.ts";

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  // These paths only read SQLite; the real embedder is never asked to embed or load a model.
  store = new SqliteMemoryStore(db, createEmbedder({ model: "bge-m3" }));
});
afterEach(() => db.close());

function node(options: { project?: string; platform?: string; type?: string; metadata?: Record<string, unknown> } = {}): number {
  return Number(db.query(`INSERT INTO knowledge_nodes (content, source_type, project_id, platform, metadata_json)
    VALUES ('이거 진짜 몰랐어', ?, ?, ?, ?)`).run(
    options.type ?? "auto_capture", options.project ?? null, options.platform ?? "", JSON.stringify(options.metadata ?? {}),
  ).lastInsertRowid);
}

function derived(parent: number, type = "llm_extract", metadata: Record<string, unknown> = {}): number {
  const child = node({ type, metadata });
  db.run("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance) VALUES (?, ?, 'merged_into', 'llm_extract')", [child, parent]);
  return child;
}

function tag(id: number, marker = "ai기록"): void {
  const conceptId = `cpt_${id}`;
  db.run("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)", [conceptId, marker]);
  db.run("INSERT INTO node_concept_edges (node_id, concept_id, role, provenance) VALUES (?, ?, 'tag', 'hashtag')", [id, conceptId]);
}

test("entity registration excludes AI project notes before limits but retains personal MCP and human project notes", () => {
  const ai = node({ project: "bara_system", platform: "mcp" });
  const tagged = node({ project: "legacy", metadata: { tags: ["ai기록"] } });
  const edgeTagged = node({ project: "legacy" });
  tag(edgeTagged);
  const personal = node({ platform: "mcp" });
  const human = node({ project: "bara_system", platform: "pet" });
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 2 }).map((r) => r.nodeId)).toEqual([personal, human]);
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10, nodeIds: [ai, tagged, edgeTagged] })).toEqual([]);
  expect(readOriginalMemo(db, ai)).toBeNull();
  expect(db.query("SELECT content FROM knowledge_nodes WHERE id = ?").get(ai)).toEqual({ content: "이거 진짜 몰랐어" });
});

test("person candidates inherit project AI exclusion through lineage without losing eligible rows to LIMIT", () => {
  const ai = node({ project: "p", platform: "mcp" });
  const child = derived(ai, "document_chunk");
  const grandchild = derived(child);
  const personal = node({ type: "llm_extract", platform: "mcp" });
  expect(personCandidates(db, 1).map((r) => r.id)).toEqual([personal]);
  expect(personCandidates(db, 10, [grandchild])).toEqual([]);
  // A malformed lineage cycle must not recurse forever.
  db.run("INSERT INTO knowledge_edges (source_id, target_id, relation, provenance) VALUES (?, ?, 'parent_of', 'system')", [ai, grandchild]);
  expect(personCandidates(db, 1).map((r) => r.id)).toEqual([personal]);
});

test("regex strengthening excludes project AI originals before its batch limit", () => {
  const ai = node({ project: "p", platform: "mcp" });
  derived(ai);
  const personal = node({ platform: "mcp" });
  derived(personal);
  const extractor = new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] });
  expect(findRegexMissedCandidates(db, extractor, 1).map((r) => r.id)).toEqual([personal]);
});

test("summary candidates inherit exclusion from their AI project original", () => {
  const ai = node({ project: "p", platform: "mcp" });
  const excluded = derived(ai, "document_chunk", { parentId: "doc_ai", chunkIndex: 0 });
  derived(excluded);
  const eligible = node({ type: "document_chunk", metadata: { parentId: "doc_human", chunkIndex: 0 } });
  derived(eligible);
  expect(findChunkSummaryCandidates(db, 1, 1).map((r) => r.chunkId)).toEqual([eligible]);
});

test("lens drafts omit excluded evidence and skip entities whose evidence is entirely excluded", async () => {
  const ai = node({ project: "p", platform: "mcp" });
  const personal = node();
  for (const [id, evidence] of [["plc_excluded", [ai]], ["plc_mixed", [ai, personal]], ["plc_empty", []]] as const) {
    db.run("INSERT INTO entities (entity_id, type_name, name) VALUES (?, 'place', ?)", [id, id]);
    for (const evidenceId of evidence) {
      const conceptId = `cpt_${id}_${evidenceId}`;
      db.run("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)", [conceptId, conceptId]);
      db.run("INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'identity', 'hashtag', ?)", [id, conceptId, evidenceId]);
    }
  }
  db.run("INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES ('cp_old_mixed', 'lens_draft', ?)", [JSON.stringify({
    typeName: "place", entityId: "plc_mixed", fingerprintGuard: { evidenceNodeIds: [ai, personal] },
  })]);
  const stageVersion = externalStageContractOf("lensDraft")!.stageVersion;
  const rows = await detectLensDraftCandidates({ deps: { store }, batchSize: 10, stageVersion });
  expect(rows.map((r) => r.entityId).sort()).toEqual(["plc_empty", "plc_mixed"]);
  expect(rows.find((r) => r.entityId === "plc_mixed")?.evidenceNodeIds).toEqual([personal]);
  expect(await recomputeExternalFingerprint({ store } as MemoryApiDeps, "lensDraft", entityTargetKey("place", "plc_excluded"))).toBeNull();
  const mixed = rows.find((r) => r.entityId === "plc_mixed")!;
  const submitted = await submitExternalProposal({ store } as MemoryApiDeps, {
    kind: "lens_draft", payload: { typeName: "place", entityId: mixed.entityId, values: { columns: { address: "서울" } } },
    candidate: { stage: "lensDraft", targetKey: mixed.targetKey, inputFingerprint: mixed.inputFingerprint, stageVersion },
  });
  expect(submitted.ok).toBe(true);
  if (!submitted.ok) throw new Error(submitted.message);
  const proposal = db.query("SELECT payload_json FROM cleanup_proposals WHERE id = ?").get(submitted.proposalId) as { payload_json: string };
  expect(JSON.parse(proposal.payload_json).fingerprintGuard.evidenceNodeIds).toEqual([personal]);
});

test("previously issued external candidates cannot bypass exclusion by direct target key", async () => {
  const ai = node({ project: "p", platform: "mcp" });
  const child = derived(ai);
  const deps = { store } as MemoryApiDeps;
  expect(await recomputeExternalFingerprint(deps, "entityRegister", String(ai))).toBeNull();
  expect(await recomputeExternalFingerprint(deps, "regexStrengthen", String(ai))).toBeNull();
  expect(await recomputeExternalFingerprint(deps, "personLink", String(child))).toBeNull();
});

test("metadata inference also excludes imported AI project tags while preserving its broader MCP exclusion", async () => {
  node({ project: "p", type: "user_explicit", metadata: { tags: ["AI기록"] } });
  node({ platform: "mcp", type: "user_explicit" });
  node({ type: "user_explicit", platform: "pet", project: "p" });
  const result = await runMetadataInferCycle({
    db, infer: async () => [], eventBus: new EventBus(new EventRepository(db)),
    gapMinutes: 180, batchSize: 10, maxOutputTokens: 1024,
  });
  expect(result.candidatesFound).toBe(1);
});

test("AI markers require a nonblank project and do not match similar ordinary tags", () => {
  const globalTag = node({ metadata: { tags: ["ai기록"] } });
  const blankProject = node({ platform: "mcp", project: "   " });
  const similar = node({ project: "p", metadata: { tags: ["ai기록방식"] } });
  const legacy = node({ project: "p", metadata: { tags: ["#AI기록"] } });
  const edgeLegacy = node({ project: "p" });
  tag(edgeLegacy, "AI기록");
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 }).map((r) => r.nodeId)).toEqual([globalTag, blankProject, similar]);
  expect(readOriginalMemo(db, legacy)).toBeNull();
});

test("entity results arriving after project assignment are excluded without a proposal or completed ledger", async () => {
  const id = node({ platform: "mcp" });
  const [memo] = collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 });
  db.run("UPDATE knowledge_nodes SET project_id = 'p' WHERE id = ?", [id]);
  const outcome = await processEntityRegisterMemo({
    store, proposals: new CleanupProposalsRepository(db), records: new EntityRegisterRecordsRepository(db),
    index: { byType: new Map() }, allowedTypes: new Set(["place"]), profile: judgeProfileFromLanguage(),
    autoApply: false, stageVersion: 1, maxAttemptsPerTarget: 1, runId: null,
  }, memo!, {
    nodeId: id, entities: [{ type: "place", name: "이거" }], eventDateText: null, eventDate: null, scheduleTitle: null,
  });
  expect(outcome).toMatchObject({ ledger: "excluded", autoApplied: 0, proposalId: null });
  expect(db.query("SELECT COUNT(*) AS n FROM cleanup_proposals").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM cleanup_stage_results").get()).toEqual({ n: 0 });
});

test("person results arriving after project assignment cannot auto-link or complete the excluded node", async () => {
  const id = node({ platform: "mcp", type: "llm_extract", metadata: { personCandidates: ["민수"] } });
  db.run("INSERT INTO persons (person_id, display_name, aliases, external_refs) VALUES ('psn_1', '민수', '[]', '{}')");
  const result = await runPersonLinkInferCycle({
    db, store, eventBus: new EventBus(new EventRepository(db)), batchSize: 10,
    stageVersion: 1, maxAttemptsPerTarget: 1, perCallInputCap: 30000, autoApply: true,
    infer: async () => {
      db.run("UPDATE knowledge_nodes SET project_id = 'p' WHERE id = ?", [id]);
      return { kind: "ok", parsed: [{ nodeId: id, personId: "psn_1", confidence: 1, candidateText: "민수" }] };
    },
  });
  expect(result).toMatchObject({ candidatesFound: 1, autoLinked: 0, proposalsInserted: 0, completed: 0, completedNoop: 0, coverageMisses: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM node_person_edges").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM cleanup_stage_results").get()).toEqual({ n: 0 });
});

test("AI extraction absorption does not turn an independent human original into an excluded memory", () => {
  const ai = node({ project: "p", platform: "mcp" });
  const human = node({ project: "p", platform: "dashboard" });
  const absorption = new NodeAbsorption(db);
  absorption.recordNewNodeSync(human, { kind: "source", source: describeInputSource({ source: "dashboard", author: "owner" }) });
  expect(isCleanupExcludedNode(db, human)).toBe(false);
  absorption.absorbInputSync(human, { kind: "derived", parentId: ai, relation: "merged_into", edgeProvenance: "llm_extract" });
  expect(db.query("SELECT target_id FROM knowledge_edges WHERE source_id = ? AND relation = 'merged_into'").get(human)).toEqual({ target_id: ai });
  expect(isCleanupExcludedNode(db, human)).toBe(false);
  expect(collectEntityRegisterCandidates({ db, stageVersion: 1, limit: 10 }).map((r) => r.nodeId)).toEqual([human]);
  expect(isCleanupExcludedNode(db, derived(human))).toBe(false);
  // Regex atoms use auto_capture plus metadata.source, not a dedicated derived source type.
  expect(isCleanupExcludedNode(db, derived(ai, "auto_capture", { source: "regex" }))).toBe(true);
});
