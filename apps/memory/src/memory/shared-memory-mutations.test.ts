import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { contentHash } from "./content-hash.ts";
import { MemoryExtractor } from "./extractor.ts";
import { HybridRetriever } from "./retriever.ts";
import { ContextAssembler } from "./context-assembler.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-schema.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import { saveSharedMemoryInput } from "../server-internal/shared-memory-write.ts";
import { buildBaraMcpServer } from "../mcp/server.ts";
import { McpUsageRecorder } from "../mcp/usage-recorder.ts";
import { readMemoryVisibility } from "./shared-memory-read.ts";

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
beforeAll(async () => { embedder = new Bgem3Embedder(); await embedder.load(); });
beforeEach(() => { db = openMemoryDatabase(":memory:"); store = new SqliteMemoryStore(db, embedder); });
afterEach(() => db.close());

test("legacy edits increment revision, preserve metadata, and refresh the content hash", async () => {
  const id = await store.addNode({ content: "이전 본문", metadata: { messageId: "message-1" } });
  await store.editNodeContent({ nodeId: id, content: "첫 정정" });
  const result = await store.editNodeContent({ nodeId: id, content: "최종 정정" });
  expect(result!.node.metadata).toMatchObject({ messageId: "message-1", sharedMemory: { revision: 2 } });
  expect(db.query("SELECT content_hash FROM knowledge_nodes WHERE id = ?").get(id))
    .toEqual({ content_hash: contentHash("최종 정정") });
  expect(await store.findNodeIdByContentHash("이전 본문")).toBeNull();
  expect(await store.findNodeIdByContentHash("최종 정정")).toBe(id);
});

test("two edits based on one revision commit exactly once", async () => {
  const id = await store.addNode({ content: "공유 원문" });
  const results = await Promise.allSettled([
    store.editNodeContent({ nodeId: id, content: "첫 AI 수정", expectedRevision: 0 }),
    store.editNodeContent({ nodeId: id, content: "둘째 AI 수정", expectedRevision: 0 }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "CONFLICT", currentRevision: 1 });
  expect(await store.getRevisionsForNode(id)).toHaveLength(1);
});

test("source event rows are removed with their node (ON DELETE CASCADE)", async () => {
  const id = await store.addNode({ content: "근거 원장이 붙은 기억" });
  db.query("INSERT INTO memory_source_events (event_key, node_id, created_at) VALUES (?, ?, ?)")
    .run("event:claim", id, "2026-09-20 00:00:00");
  expect(db.query("SELECT COUNT(*) AS n FROM memory_source_events").get()).toEqual({ n: 1 });
  await store.deleteNode(id);
  expect(db.query("SELECT COUNT(*) AS n FROM memory_source_events").get()).toEqual({ n: 0 });
});

async function mutations() { return import("./shared-memory-mutations.ts"); }
const actor = "client-a";

test("durable request replay does not repeat writes and mismatched reuse conflicts", async () => {
  const { updateSharedMemory } = await mutations();
  const id = await store.addNode({ content: "회신을 잃은 수정의 원문" });
  const args = { nodeId: id, content: "새로운 기억", expectedRevision: 0, requestId: "update-once", actor };
  const first = await updateSharedMemory(store, args);
  const replay = await updateSharedMemory(new SqliteMemoryStore(db, embedder), args);
  expect(first).toMatchObject({ revision: 1, replayed: false, affectedNodeIds: [id] });
  expect(replay).toEqual({ ...first, replayed: true });
  expect(await store.getRevisionsForNode(id)).toHaveLength(1);
  await expect(updateSharedMemory(store, { ...args, content: "다른 요청" })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(updateSharedMemory(store, { ...args, actor: "client-b" })).rejects.toMatchObject({ code: "CONFLICT" });
});

test("simultaneous identical requests share one committed mutation", async () => {
  const { updateSharedMemory } = await mutations();
  const id = await store.addNode({ content: "동시 재시도 원문" });
  const args = { nodeId: id, content: "동시에 전달된 정정", expectedRevision: 0, requestId: "race", actor };
  const results = await Promise.all([updateSharedMemory(store, args), updateSharedMemory(store, args)]);
  expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(await store.getRevisionsForNode(id)).toHaveLength(1);
});

test("retraction invalidates owned children, preserves independent evidence, and can be restored by update", async () => {
  const { retractSharedMemory, updateSharedMemory } = await mutations();
  const id = await store.addNode({ content: "철회할 원문", metadata: { sharedMemory: { assertionKind: "user_statement" } } });
  const child = await store.addNode({ content: "그 원문의 추출", sourceType: "llm_extract" });
  const independent = await store.addNode({ content: "독립적인 관찰", sourceType: "user_explicit" });
  await store.addEdge({ sourceId: child, targetId: id, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  await store.addEdge({ sourceId: independent, targetId: id, relation: "related_to", provenance: "system", sourceNodeId: independent, weight: 1 });
  const result = await retractSharedMemory(store, { nodeId: id, expectedRevision: 0, requestId: "retract", actor });
  expect(result.affectedNodeIds).toEqual([id, child]);
  expect(result.node.metadata.sharedMemory).toMatchObject({ status: "retracted", revision: 1, assertionKind: "user_statement" });
  const [retractRevision] = await store.getRevisionsForNode(id);
  expect((await store.getNode(child))!.metadata.sharedMemory)
    .toMatchObject({ status: "retracted", invalidatedBy: id, invalidatedByRevision: retractRevision!.id, revision: 1 });
  expect((await store.getNode(independent))!.metadata.sharedMemory).toBeUndefined();
  const restored = await updateSharedMemory(store, { nodeId: id, content: "검증 후 복원", expectedRevision: 1, requestId: "restore", actor });
  expect(restored.node.metadata.sharedMemory).toMatchObject({ status: "active", revision: 2 });
  expect((await store.getNode(child))!.metadata.sharedMemory).toMatchObject({ status: "retracted" });
});

test("derived child supported by another live source is preserved", async () => {
  const { retractSharedMemory } = await mutations();
  const id = await store.addNode({ content: "첫 출처" });
  const other = await store.addNode({ content: "둘째 출처" });
  const child = await store.addNode({ content: "두 출처가 뒷받침한 추출", sourceType: "llm_extract" });
  for (const parent of [id, other]) {
    await store.addEdge({ sourceId: child, targetId: parent, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  }
  const result = await retractSharedMemory(store, { nodeId: id, expectedRevision: 0, requestId: "shared-child", actor });
  expect(result.affectedNodeIds).toEqual([id]);
  expect((await store.getNode(child))!.metadata.sharedMemory).toBeUndefined();
});

test("explicit replacement changes only the source lifecycle and rejects stale or cross-project targets", async () => {
  const { supersedeSharedMemory } = await mutations();
  const id = await store.addNode({ content: "옛 결정", project_id: "project-a" });
  const replacementId = await store.addNode({ content: "새 결정", project_id: "project-a" });
  const elsewhere = await store.addNode({ content: "다른 프로젝트 결정", project_id: "project-b" });
  await expect(supersedeSharedMemory(store, { nodeId: id, replacementId: elsewhere, expectedRevision: 0, requestId: "wrong-scope", actor }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(supersedeSharedMemory(store, { nodeId: id, replacementId: id, expectedRevision: 0, requestId: "self", actor }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  const result = await supersedeSharedMemory(store, { nodeId: id, replacementId, expectedRevision: 0, requestId: "replacement", actor });
  expect(result.node.metadata.sharedMemory).toMatchObject({ status: "superseded", revision: 1, supersededBy: replacementId });
  expect((await store.getNode(replacementId))!.metadata.sharedMemory).toBeUndefined();
  expect(await store.getSupersededNodeIds([id])).toEqual(new Set([id]));
  await expect(supersedeSharedMemory(store, { nodeId: replacementId, replacementId: id, expectedRevision: 0, requestId: "cycle", actor }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
});

// SL-3 — a conflict candidate the checker recorded (candidate -> prior contradicts) is adopted in one step.
async function conflictPair() {
  const prior = await store.addNode({ content: "답변은 한국어로 해 주세요" });
  const candidate = await store.addNode({ content: "앞으로 답변은 영어로 받고 싶다",
    metadata: { sharedMemory: { status: "disputed", revision: 1 } } });
  return { prior, candidate };
}
async function contradicts(sourceId: number, targetId: number) {
  await store.addEdge({ sourceId, targetId, relation: "contradicts", provenance: "system", sourceNodeId: sourceId, weight: 0.75 });
}
const ledgerRows = () => (db.query("SELECT COUNT(*) AS n FROM memory_mutations").get() as { n: number }).n;

test("a disputed conflict candidate of the replaced memory becomes active in the same mutation", async () => {
  const { supersedeSharedMemory } = await mutations();
  const { prior, candidate } = await conflictPair();
  await contradicts(candidate, prior);
  const args = { nodeId: prior, replacementId: candidate, expectedRevision: 0, requestId: "adopt-candidate", actor };
  const result = await supersedeSharedMemory(store, args);
  expect(result.node.metadata.sharedMemory).toMatchObject({ status: "superseded", revision: 1, supersededBy: candidate });
  expect(result.affectedNodeIds).toEqual([prior, candidate]);
  expect((await store.getNode(candidate))!.metadata.sharedMemory).toEqual({ status: "active", revision: 2, assertionKind: "unknown" });
  const visible = readMemoryVisibility(store).allowedIds!;
  expect(visible.has(candidate)).toBe(true);
  expect(visible.has(prior)).toBe(false);
  expect(await supersedeSharedMemory(store, args)).toEqual({ ...result, replayed: true });
  expect((await store.getNode(candidate))!.metadata.sharedMemory).toMatchObject({ revision: 2 });
});

// WP-B1-10(B1-08R Minor 2) — N contradicts both A and B. Adopting N over A (supersede A -> N)
// resolves N-A but N-B stays open; the response's openConflicts names it so the caller can tell
// the user. supersedeSharedMemory 자체는 A-N 관계만 다루므로 다른 상대(B)는 contradicts 로만
// 미리 이어둔다(대체 채택 로직과 무관 — open-conflicts.ts 판정 대상이라는 점만 확인한다).
test("supersede leaves openConflicts naming a different old memory the adopted replacement still contradicts", async () => {
  const { supersedeSharedMemory } = await mutations();
  const { prior: a, candidate: n } = await conflictPair();
  const b = await store.addNode({ content: "또 다른 옛 진술" });
  await contradicts(n, a);
  await contradicts(n, b);
  const result = await supersedeSharedMemory(store, { nodeId: a, replacementId: n, expectedRevision: 0, requestId: "adopt-with-other-open", actor });
  expect(result.openConflicts).toEqual([b]);
  // replay 시점에도 B-N 관계가 그대로 열려 있으므로 같은 값이 나온다(재계산 결과가 우연히
  // 같은 것이지 저장된 JSON을 그대로 돌려주는 것이 아니다 — 아래 두 테스트가 재계산임을 증명).
  expect((await supersedeSharedMemory(store, { nodeId: a, replacementId: n, expectedRevision: 0, requestId: "adopt-with-other-open", actor })).openConflicts).toEqual([b]);
});

// WP-B1-10(supervisor 지시) — replay는 저장된 openConflicts를 그대로 재생하지 않고, 채택된
// 기억의 "지금" 상태를 다시 계산한다. 저장 시점 값을 그대로 돌려주면, 재생 사이에 다른
// mutation이 상대와의 관계를 닫거나 새로 열었을 때 거짓 답을 준다.
test("replay recomputes openConflicts at replay time instead of returning the stored snapshot", async () => {
  const { supersedeSharedMemory, retractSharedMemory } = await mutations();
  const { prior: a, candidate: n } = await conflictPair();
  const b = await store.addNode({ content: "또 다른 옛 진술" });
  await contradicts(n, a);
  await contradicts(n, b);
  const args = { nodeId: a, replacementId: n, expectedRevision: 0, requestId: "adopt-then-b-resolves", actor };
  const first = await supersedeSharedMemory(store, args);
  expect(first.openConflicts).toEqual([b]);

  // 첫 채택 뒤 B를 별도로 철회해 N-B 관계를 해소한다(재전송 전에 상태가 바뀐 상황을 재현).
  await retractSharedMemory(store, { nodeId: b, expectedRevision: 0, requestId: "retract-b-after-adopt", actor });

  const replay = await supersedeSharedMemory(store, args);
  expect(replay.replayed).toBe(true);
  expect(replay.openConflicts).toEqual([]); // 저장된 [b]가 아니라 지금 상태(해소됨)를 반영한다.
  expect(replay.node).toEqual(first.node); // 재생 계약의 나머지 칸은 그대로 저장된 값이다.
  expect(replay.revision).toBe(first.revision);
  expect(replay.affectedNodeIds).toEqual(first.affectedNodeIds);
});

// 대칭 사례 — replay 시점에 새 상대와 또 충돌이 생겼으면 그 상대도 잡아낸다.
test("replay reflects a conflict that opened after the original commit, not just ones that closed", async () => {
  const { supersedeSharedMemory } = await mutations();
  const { prior, candidate } = await conflictPair();
  await contradicts(candidate, prior);
  const args = { nodeId: prior, replacementId: candidate, expectedRevision: 0, requestId: "adopt-then-new-conflict", actor };
  const first = await supersedeSharedMemory(store, args);
  expect(first.openConflicts).toEqual([]);

  const c = await store.addNode({ content: "채택된 뒤에 생긴 새 충돌" });
  await contradicts(candidate, c);

  const replay = await supersedeSharedMemory(store, args);
  expect(replay.replayed).toBe(true);
  expect(replay.openConflicts).toEqual([c]); // 저장된 []가 아니라 지금 새로 생긴 충돌을 반영한다.
});

test("supersede with no other open conflicts returns an empty openConflicts", async () => {
  const { supersedeSharedMemory } = await mutations();
  const { prior, candidate } = await conflictPair();
  await contradicts(candidate, prior);
  const result = await supersedeSharedMemory(store, { nodeId: prior, replacementId: candidate, expectedRevision: 0, requestId: "adopt-clean", actor });
  expect(result.openConflicts).toEqual([]);
});

test("update and retract report an empty openConflicts (not a supersede)", async () => {
  const { updateSharedMemory, retractSharedMemory } = await mutations();
  const id = await store.addNode({ content: "고칠 기억" });
  const updated = await updateSharedMemory(store, { nodeId: id, content: "고친 기억", expectedRevision: 0, requestId: "update-oc", actor });
  expect(updated.openConflicts).toEqual([]);
  const other = await store.addNode({ content: "철회할 기억" });
  const retracted = await retractSharedMemory(store, { nodeId: other, expectedRevision: 0, requestId: "retract-oc", actor });
  expect(retracted.openConflicts).toEqual([]);
});

test("a disputed replacement that is not this memory's conflict candidate is refused without changes", async () => {
  const { supersedeSharedMemory } = await mutations();
  const { prior, candidate } = await conflictPair();
  const other = await store.addNode({ content: "설명은 짧게 해 주세요" });
  await contradicts(prior, candidate); // reversed: the prior memory was flagged against the candidate
  await contradicts(candidate, other); // the candidate conflicts with a different memory
  const refusal = supersedeSharedMemory(store, { nodeId: prior, replacementId: candidate, expectedRevision: 0, requestId: "unlinked", actor });
  await expect(refusal).rejects.toMatchObject({ code: "INVALID_INPUT", nodeId: prior });
  await expect(refusal).rejects.toThrow(`disputed replacement ${candidate} is not a conflict candidate of memory ${prior}`);
  expect((await store.getNode(candidate))!.metadata.sharedMemory).toEqual({ status: "disputed", revision: 1 });
  expect((await store.getNode(prior))!.metadata.sharedMemory).toBeUndefined();
  expect(ledgerRows()).toBe(0);
});

test("an adopted candidate that fails the replacement checks rolls the adoption back", async () => {
  const { supersedeSharedMemory } = await mutations();
  const prior = await store.addNode({ content: "배포는 금요일에 한다", project_id: "project-a" });
  const candidate = await store.addNode({ content: "배포는 화요일에 한다", project_id: "project-b",
    metadata: { sharedMemory: { status: "disputed", revision: 1 } } });
  await contradicts(candidate, prior);
  await expect(supersedeSharedMemory(store, { nodeId: prior, replacementId: candidate, expectedRevision: 0, requestId: "cross-project", actor }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect((await store.getNode(candidate))!.metadata.sharedMemory).toEqual({ status: "disputed", revision: 1 });
  expect((await store.getNode(prior))!.metadata.sharedMemory).toBeUndefined();
  expect(ledgerRows()).toBe(0);
});

test("invalid mutation arguments and missing nodes are typed, with no ledger side effects", async () => {
  const { retractSharedMemory } = await mutations();
  await expect(retractSharedMemory(store, { nodeId: 9999, expectedRevision: 0, requestId: "missing", actor }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const invalid of [{ expectedRevision: -1 }, { requestId: "" }, { actor: " " }]) {
    await expect(retractSharedMemory(store, { nodeId: 1, expectedRevision: 0, requestId: "bad", actor, ...invalid }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
  expect(db.query("SELECT COUNT(*) AS n FROM memory_mutations").get()).toEqual({ n: 0 });
});

test("retraction follows evidence references and regex children through multiple derivation levels", async () => {
  const { retractSharedMemory } = await mutations();
  const root = await store.addNode({ content: "추론의 최초 근거" });
  const inference = await store.addNode({ content: "AI가 작성한 추론", metadata: { sharedMemory: { assertionKind: "ai_inference", evidenceRefs: [root] } } });
  const descendant = await store.addNode({ content: "추론에서 추가 추출", sourceType: "llm_extract" });
  // A real regex atom carries metadata.source "regex" (buildRegexMetadata). A plain memory that only
  // received a regex edge is an independent save and is not retracted.
  const regex = await store.addNode({ content: "정규식으로 추출한 기억", metadata: { source: "regex" } });
  await store.addEdge({ sourceId: descendant, targetId: inference, relation: "merged_into", provenance: "system", sourceNodeId: descendant, weight: 1 });
  await store.addEdge({ sourceId: regex, targetId: root, relation: "merged_into", provenance: "regex", sourceNodeId: regex, weight: 1 });
  const result = await retractSharedMemory(store, { nodeId: root, expectedRevision: 0, requestId: "recursive", actor });
  expect(result.affectedNodeIds).toEqual([root, inference, descendant, regex]);
  for (const id of [inference, descendant, regex]) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: root });
  }
});

test("an independent live source protects a derived branch but a dependency cycle does not", async () => {
  const { retractSharedMemory } = await mutations();
  const root = await store.addNode({ content: "철회할 첫 근거" });
  const other = await store.addNode({ content: "살아 있는 독립 근거" });
  const supported = await store.addNode({ content: "독립 근거가 남는 추론", metadata: { sharedMemory: { evidenceRefs: [root, other] } } });
  const supportedChild = await store.addNode({ content: "유지 가능한 추론의 후손", metadata: { sharedMemory: { evidenceRefs: [supported] } } });
  const cycleA = await store.addNode({ content: "순환 A", sourceType: "llm_extract" });
  const cycleB = await store.addNode({ content: "순환 B", sourceType: "llm_extract" });
  for (const [child, parent] of [[cycleA, root], [cycleA, cycleB], [cycleB, cycleA]] as const) {
    await store.addEdge({ sourceId: child, targetId: parent, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  }
  const result = await retractSharedMemory(store, { nodeId: root, expectedRevision: 0, requestId: "independent", actor });
  expect(result.affectedNodeIds).toEqual([root, cycleA, cycleB]);
  for (const id of [supported, supportedChild]) expect((await store.getNode(id))!.metadata.sharedMemory).not.toHaveProperty("invalidatedBy");
});

test("retraction removes dependent summaries and vectors but preserves relations supported by another document", async () => {
  const { retractSharedMemory } = await mutations();
  db.query("INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, first_imported_at) VALUES ('asset', 'text', 'fixture.md', 1, '2026-09-20')").run();
  const documentId = store.documentRepo.createDocument({ assetSha256: "asset", title: "문서 근거", documentType: "free" });
  const otherDocumentId = store.documentRepo.createDocument({ assetSha256: "asset", title: "다른 근거", documentType: "free" });
  const root = await store.addNode({ content: "첫 문서", sourceType: "document", metadata: { documentId } });
  const otherRoot = await store.addNode({ content: "둘째 문서", sourceType: "document", metadata: { documentId: otherDocumentId } });
  const child = await store.addNode({ content: "문서에서 나온 청크", sourceType: "document_chunk", metadata: { parentId: documentId } });
  await store.addEdge({ sourceId: child, targetId: root, relation: "parent_of", provenance: "system", sourceNodeId: child, weight: 1 });
  await store.summaryRepo.insertChunkSummary({ summaryId: "cs_fixture", parentChunkId: child, parentDocumentId: documentId, summaryText: "청크의 요약", generatedBy: "llm" });
  const from = await store.findOrCreateTagConcept("원인");
  const to = await store.findOrCreateTagConcept("결과");
  for (const [summaryId, sourceDocumentId] of [["rs_first", documentId], ["rs_second", otherDocumentId]]) {
    await store.summaryRepo.insertRelationSummary({ summaryId: summaryId!, sourceDocumentId: sourceDocumentId!, fromConceptId: from, toConceptId: to, relationName: "원인", summaryText: "관계의 요약", confidence: 0.9, generatedBy: "llm" });
  }
  await store.addConceptEdge({ sourceConceptId: from, targetConceptId: to, relation: "llm_relation", provenance: "llm_extract", sourceNodeId: null, weight: 0.9 });
  await retractSharedMemory(store, { nodeId: root, expectedRevision: 0, requestId: "doc-one", actor });
  expect(db.query("SELECT COUNT(*) AS n FROM chunk_summaries").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM chunk_summary_vec").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM relation_summary_vec").get()).toEqual({ n: 1 });
  expect(await store.listConceptEdges({ relation: "llm_relation" })).toHaveLength(1);
  await retractSharedMemory(store, { nodeId: otherRoot, expectedRevision: 0, requestId: "doc-two", actor });
  expect(db.query("SELECT COUNT(*) AS n FROM relation_summary_vec").get()).toEqual({ n: 0 });
  expect(await store.listConceptEdges({ relation: "llm_relation" })).toHaveLength(0);
});

test("a failed durable ledger write rolls back content, revision, vectors and derivative invalidation", async () => {
  const { updateSharedMemory } = await mutations();
  const root = await store.addNode({ content: "원자성 원문" });
  const child = await store.addNode({ content: "원자성 파생 기억", metadata: { sharedMemory: { evidenceRefs: [root] } } });
  const originalVector = await store.getVectorById(root);
  db.run("CREATE TRIGGER fail_mutation BEFORE INSERT ON memory_mutations BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END");
  await expect(updateSharedMemory(store, { nodeId: root, content: "실패해야 할 수정", expectedRevision: 0, requestId: "fail", actor })).rejects.toThrow("ledger unavailable");
  expect((await store.getNode(root))!.content).toBe("원자성 원문");
  expect((await store.getNode(root))!.metadata.sharedMemory).toBeUndefined();
  expect((await store.getNode(child))!.metadata.sharedMemory).not.toHaveProperty("invalidatedBy");
  expect(await store.getVectorById(root)).toEqual(originalVector);
  expect(await store.getRevisionsForNode(root)).toHaveLength(0);
});

test("replacement cannot leave its new current memory invalidated by the replaced source", async () => {
  const { supersedeSharedMemory } = await mutations();
  const root = await store.addNode({ content: "원래 주장" });
  const replacementId = await store.addNode({ content: "원래 주장에만 의존하는 새 주장", metadata: { sharedMemory: { evidenceRefs: [root] } } });
  await expect(supersedeSharedMemory(store, { nodeId: root, replacementId, expectedRevision: 0, requestId: "dependent-replacement", actor }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect((await store.getNode(root))!.metadata.sharedMemory).toBeUndefined();
  expect((await store.getNode(replacementId))!.metadata.sharedMemory).not.toHaveProperty("invalidatedBy");
  expect(await store.getSupersededNodeIds([root])).toEqual(new Set());
});

test("database mutation lock covers asynchronous post-write work and releases after rejection", async () => {
  const { withMemoryMutationLock } = await import("./shared-memory-mutation-lock.ts");
  const id = await store.addNode({ content: "잠금 검증" });
  const steps: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withMemoryMutationLock(store, async () => { steps.push("write"); await gate; steps.push("rewire"); throw new Error("post-write failure"); });
  const handled = first.catch((error: Error) => error.message);
  const second = withMemoryMutationLock(new SqliteMemoryStore(db, embedder), async () => { steps.push("next-write"); });
  const otherDb = openMemoryDatabase(":memory:");
  try { await withMemoryMutationLock(new SqliteMemoryStore(otherDb, embedder), async () => { steps.push("independent-database"); }); }
  finally { otherDb.close(); }
  expect(steps).toEqual(["write", "independent-database"]);
  release();
  expect(await handled).toBe("post-write failure");
  await second;
  expect(steps).toEqual(["write", "independent-database", "rewire", "next-write"]);
});

test("legacy direct content edits invalidate dependent evidence in the same transaction", async () => {
  const root = await store.addNode({ content: "옛 통로의 근거" });
  const child = await store.addNode({ content: "옛 근거에 의존하는 결론", metadata: { sharedMemory: { evidenceRefs: [root] } } });
  const result = await store.editNodeContent({ nodeId: root, content: "정정된 근거" });
  expect(result!.affectedNodeIds).toEqual([root, child]);
  expect((await store.getNode(child))!.metadata.sharedMemory)
    .toMatchObject({ status: "retracted", invalidatedBy: root, invalidatedByRevision: result!.revision.id });
});

test("supersede records its revision row on invalidated children, and a client's own update drops both markers", async () => {
  const { supersedeSharedMemory, updateSharedMemory } = await mutations();
  const root = await store.addNode({ content: "대체될 원래 주장" });
  const replacementId = await store.addNode({ content: "새로 채택한 주장" });
  const child = await store.addNode({ content: "원래 주장의 추출", sourceType: "llm_extract" });
  await store.addEdge({ sourceId: child, targetId: root, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  await supersedeSharedMemory(store, { nodeId: root, replacementId, expectedRevision: 0, requestId: "supersede-root", actor });
  const [supersedeRevision] = await store.getRevisionsForNode(root);
  expect((await store.getNode(child))!.metadata.sharedMemory)
    .toMatchObject({ status: "retracted", invalidatedBy: root, invalidatedByRevision: supersedeRevision!.id, revision: 1 });

  const revived = await updateSharedMemory(store, { nodeId: child, content: "다시 확인한 추출", expectedRevision: 1, requestId: "revive-child", actor });
  expect(revived.node.metadata.sharedMemory).toMatchObject({ status: "active", revision: 2 });
  expect(revived.node.metadata.sharedMemory).not.toHaveProperty("invalidatedBy");
  expect(revived.node.metadata.sharedMemory).not.toHaveProperty("invalidatedByRevision");
});

test("detached work cannot reuse inherited mutation ownership after its parent lock releases", async () => {
  const { withMemoryMutationLock } = await import("./shared-memory-mutation-lock.ts");
  const steps: string[] = [];
  let allowBackground!: () => void;
  const backgroundGate = new Promise<void>((resolve) => { allowBackground = resolve; });
  let attempted!: () => void;
  const attemptedGate = new Promise<void>((resolve) => { attempted = resolve; });
  let background!: Promise<void>;
  await withMemoryMutationLock(store, async () => {
    background = backgroundGate.then(async () => {
      attempted();
      await withMemoryMutationLock(store, async () => { steps.push("background-write"); });
    });
  });
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
  let started!: () => void;
  const startedGate = new Promise<void>((resolve) => { started = resolve; });
  const active = withMemoryMutationLock(store, async () => {
    steps.push("active-start"); started(); await activeGate; steps.push("active-end");
  });
  await startedGate;
  try {
    allowBackground();
    await attemptedGate;
    expect(steps).toEqual(["active-start"]);
  } finally {
    releaseActive();
    await Promise.all([active, background]);
  }
  expect(steps).toEqual(["active-start", "active-end", "background-write"]);
});

test("replacement with expired dependency cannot withdraw an otherwise current memory", async () => {
  const { supersedeSharedMemory } = await mutations();
  const id = await store.addNode({ content: "현재 사용할 수 있는 결정" });
  const evidence = await store.addNode({ content: "기간이 끝난 근거",
    metadata: { sharedMemory: { validUntil: "2020-01-01T00:00:00Z" } } });
  const replacementId = await store.addNode({ content: "오래된 근거만 있는 대체 결정",
    metadata: { sharedMemory: { evidenceRefs: [evidence] } } });
  await expect(supersedeSharedMemory(store, { nodeId: id, replacementId, expectedRevision: 0, requestId: "expired-replacement", actor }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect((await store.getNode(id))!.metadata.sharedMemory).toBeUndefined();
  expect(await store.getSupersededNodeIds([id])).toEqual(new Set());
});

test("automatic cleanup emitted during a mutation waits before archiving any memory", async () => {
  const { withMemoryMutationLock } = await import("./shared-memory-mutation-lock.ts");
  const { startAutoCleanupTrigger } = await import("./auto-cleanup-trigger.ts");
  const id = await store.addNode({ content: "정리보다 진행 중인 편집이 우선", importance: 0 });
  const trigger = startAutoCleanupTrigger({ store, throttleMs: 0, enabled: () => true,
    cleanupOptions: { valueThreshold: 1 } });
  try {
    await withMemoryMutationLock(store, async () => {
      trigger.emit("node-edited");
      await Bun.sleep(0);
      expect(await store.getNode(id)).not.toBeNull();
      expect(trigger.lastSummary()).toBeNull();
    });
    for (let attempts = 0; attempts < 100 && trigger.lastSummary() === null; attempts += 1) await Bun.sleep(1);
    expect(trigger.lastSummary()).toMatchObject({ nodesArchived: 1 });
    expect(await store.getNode(id)).toBeNull();
  } finally { await trigger.stop(); }
});

// Derived nodes (chunks, extraction children) draw support only from lineage, so a
// parent's evidenceRefs cannot keep them alive once the parent itself is withdrawn.
const DECISION_PARAGRAPHS = [
  "배포 결정문의 첫 문단은 금요일 오후 창구를 쓰기로 한 이유를 적는다.",
  "둘째 문단은 롤백 담당과 알림 경로를 운영팀 채널로 고정한다.",
  "셋째 문단은 점검 목록을 배포 전날 저녁에 한 번 더 확인한다고 정한다.",
];
// Every paragraph fits under the cap while the whole decision does not: one chunk per paragraph.
const PARAGRAPH_CHUNKING = { tokenCap: 60, minChunkTokens: 1 };
const WITHDRAWALS = ["retract", "supersede"] as const;

async function saveEvidence(): Promise<number> {
  return (await saveSharedMemoryInput(store, { content: "운영팀은 매주 배포 공지를 채널에 올린다.", source: "mcp", author: actor })).originNodeId!;
}

async function withdraw(operation: (typeof WITHDRAWALS)[number], nodeId: number) {
  const { retractSharedMemory, supersedeSharedMemory } = await mutations();
  const common = { nodeId, expectedRevision: 0, requestId: `${operation}-${nodeId}`, actor };
  if (operation === "retract") return retractSharedMemory(store, common);
  const replacement = await saveSharedMemoryInput(store, { content: "배포 창구는 이제 화요일 오전으로 옮긴다.", source: "mcp", author: actor });
  return supersedeSharedMemory(store, { ...common, replacementId: replacement.originNodeId! });
}

/** Real OllamaClient against a loopback server answering /api/chat in Ollama's response format. */
function startExtractionServer(items: unknown[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: (request) => request.method === "POST" && new URL(request.url).pathname === "/api/chat"
      ? Response.json({ model: "extraction-fixture", message: { role: "assistant", content: JSON.stringify(items) }, done: true })
      : new Response("not found", { status: 404 }),
  });
}

function immediateExtractorSettings(): MemorySettings["llm"]["extractor"] {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.llm.extractor.enabled = true;
  settings.llm.extractor.mode = "immediate";
  return settings.llm.extractor;
}

for (const operation of WITHDRAWALS) {
  test(`${operation} of an evidence-backed long memory withdraws chunks that carry no copied evidenceRefs`, async () => {
    const evidence = await saveEvidence();
    const saved = await saveSharedMemoryInput(store, {
      content: DECISION_PARAGRAPHS.join("\n\n"), source: "mcp", author: actor, chunking: PARAGRAPH_CHUNKING,
    }, { assertionKind: "user_statement", evidenceRefs: [evidence] });
    const decision = saved.originNodeId!;
    expect(saved.chunkNodeIds).toHaveLength(DECISION_PARAGRAPHS.length);
    for (const id of saved.chunkNodeIds) {
      const state = (await store.getNode(id))!.metadata.sharedMemory;
      expect(state).toMatchObject({ status: "active", revision: 0, assertionKind: "user_statement" });
      expect(state).not.toHaveProperty("evidenceRefs");
    }
    const result = await withdraw(operation, decision);
    expect(result.affectedNodeIds).toEqual([decision, ...saved.chunkNodeIds]);
    for (const id of saved.chunkNodeIds) {
      expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: decision });
    }
    const visible = readMemoryVisibility(store).allowedIds!;
    for (const id of [decision, ...saved.chunkNodeIds]) expect(visible.has(id)).toBe(false);
    expect(visible.has(evidence)).toBe(true);
  });

  test(`${operation} of an evidence-backed memory withdraws its immediate extraction child`, async () => {
    const server = startExtractionServer([{ content: "롤백 담당은 운영팀이 맡는다", memoryType: "episode", importance: 0.8 }]);
    try {
      const extractor = new MemoryExtractor(
        new OllamaClient({ baseUrl: `http://127.0.0.1:${server.port}`, model: "extraction-fixture" }),
        store, embedder, { duplicateSim: 0.999, minImportance: 0 },
      );
      const evidence = await saveEvidence();
      const saved = await saveSharedMemoryInput(store, {
        content: "배포 창구는 금요일 오후로 정했다. 롤백 담당은 운영팀이 맡는다.", source: "mcp", author: actor,
        extractor, extractorSettings: immediateExtractorSettings(),
      }, { assertionKind: "user_statement", evidenceRefs: [evidence] });
      const decision = saved.originNodeId!;
      expect(saved.immediateExtractionRan).toBe(true);
      expect(saved.extracted).toHaveLength(1);
      const child = saved.extracted[0]!;
      const state = (await store.getNode(child))!.metadata.sharedMemory;
      expect(state).toMatchObject({ status: "active", revision: 0, assertionKind: "ai_inference" });
      expect(state).not.toHaveProperty("evidenceRefs");
      const result = await withdraw(operation, decision);
      expect(result.affectedNodeIds).toEqual([decision, child]);
      expect((await store.getNode(child))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: decision });
      const visible = readMemoryVisibility(store).allowedIds!;
      expect(visible.has(child)).toBe(false);
      expect(visible.has(evidence)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
}

test("a chunk with a second live lineage parent survives withdrawal of the first", async () => {
  const { retractSharedMemory } = await mutations();
  const evidence = await saveEvidence();
  const saved = await saveSharedMemoryInput(store, {
    content: DECISION_PARAGRAPHS.join("\n\n"), source: "mcp", author: actor, chunking: PARAGRAPH_CHUNKING,
  }, { assertionKind: "user_statement", evidenceRefs: [evidence] });
  const [shared, ...ownedOnly] = saved.chunkNodeIds;
  const otherParent = await store.addNode({ content: "같은 문단을 인용한 다른 결정 기록" });
  await store.addEdge({ sourceId: shared!, targetId: otherParent, relation: "parent_of", provenance: "system", sourceNodeId: shared!, weight: 1 });
  const result = await retractSharedMemory(store, { nodeId: saved.originNodeId!, expectedRevision: 0, requestId: "two-parents", actor });
  expect(result.affectedNodeIds).toEqual([saved.originNodeId!, ...ownedOnly]);
  expect((await store.getNode(shared!))!.metadata.sharedMemory).toMatchObject({ status: "active", revision: 0 });
  const visible = readMemoryVisibility(store).allowedIds!;
  expect(visible.has(shared!)).toBe(true);
  for (const id of ownedOnly) expect(visible.has(id)).toBe(false);
});

// SL-2 — MCP update_memory rewires inside the tool's mutation lock, and the rewire
// re-chunks an edited long original, so the next backfill extracts the new body.
const REVISED_PARAGRAPHS = [
  "개정 결정문의 첫 문단은 화요일 오전 창구로 옮긴 이유를 적는다.",
  "둘째 문단은 롤백 담당을 플랫폼팀으로 바꾸고 알림을 메일로 보낸다.",
  "셋째 문단은 점검 목록을 배포 당일 아침에 다시 확인한다고 정한다.",
];

/** The real MCP tool server for this store, reached through an in-process linked transport. */
async function connectMcp(): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => Promise<void> }> {
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  settings.chunking.tokenCap = PARAGRAPH_CHUNKING.tokenCap;
  settings.chunking.minChunkTokens = PARAGRAPH_CHUNKING.minChunkTokens;
  const server = buildBaraMcpServer({
    deps: { store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), getSettings: () => settings },
    adapterId: actor, scope: "full", usage: new McpUsageRecorder(() => store.getRawDb()),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: actor, version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      if (result.isError === true) throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
      return payload;
    },
    async close() { await client.close(); await server.close(); },
  };
}

function activeChunks(origin: number): number[] {
  return (db.query(`SELECT e.source_id AS id FROM knowledge_edges e JOIN knowledge_nodes c ON c.id = e.source_id
    WHERE e.target_id = ? AND e.relation = 'parent_of'
      AND COALESCE(c.metadata_json ->> '$.sharedMemory.status', 'active') = 'active' ORDER BY e.source_id`)
    .all(origin) as Array<{ id: number }>).map((row) => row.id);
}

async function saveLongDecision() {
  const saved = await saveSharedMemoryInput(store, {
    content: DECISION_PARAGRAPHS.join("\n\n"), source: "mcp", author: actor, chunking: PARAGRAPH_CHUNKING,
  }, { assertionKind: "user_statement" });
  expect(saved.chunkNodeIds).toHaveLength(DECISION_PARAGRAPHS.length);
  return { origin: saved.originNodeId!, oldChunks: saved.chunkNodeIds };
}

test("MCP update_memory on a long memory withdraws its old chunks and chunks the new body", async () => {
  const { origin, oldChunks } = await saveLongDecision();
  const mcp = await connectMcp();
  try {
    const updated = await mcp.call("update_memory", {
      id: origin, content: REVISED_PARAGRAPHS.join("\n\n"), expectedRevision: 0, requestId: "rechunk-long",
    });
    expect(updated).toMatchObject({ affectedNodeIds: [origin, ...oldChunks], warnings: [] });
  } finally {
    await mcp.close();
  }
  for (const id of oldChunks) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: origin });
  }
  const rechunked = activeChunks(origin);
  const chunks = await store.getNodesByIds(rechunked);
  expect(chunks.map((node) => node.content).sort()).toEqual([...REVISED_PARAGRAPHS].sort());
  for (const node of chunks) {
    expect(node.metadata.sharedMemory).toMatchObject({ status: "active", revision: 0, assertionKind: "user_statement" });
    expect(node.metadata.sharedMemory).not.toHaveProperty("evidenceRefs");
  }
  expect((await store.getNode(origin))!.metadata).not.toHaveProperty("extracted");
  expect((await store.getBackfillCandidates({ limit: 20 })).map((node) => node.id)).toEqual(rechunked);
});

test("reactivating a retracted long memory with the same body re-chunks it for backfill", async () => {
  const { origin, oldChunks } = await saveLongDecision();
  const mcp = await connectMcp();
  try {
    await mcp.call("retract_memory", { id: origin, expectedRevision: 0, requestId: "withdraw-long" });
    expect(await store.getBackfillCandidates({ limit: 20 })).toEqual([]);
    const restored = await mcp.call("update_memory", {
      id: origin, content: DECISION_PARAGRAPHS.join("\n\n"), expectedRevision: 1, requestId: "restore-long",
    });
    expect(restored).toMatchObject({ affectedNodeIds: [origin], warnings: [] });
  } finally {
    await mcp.close();
  }
  for (const id of oldChunks) {
    expect((await store.getNode(id))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: origin });
  }
  const rechunked = activeChunks(origin);
  expect(rechunked).toHaveLength(DECISION_PARAGRAPHS.length);
  expect(rechunked.some((id) => oldChunks.includes(id))).toBe(false);
  expect((await store.getBackfillCandidates({ limit: 20 })).map((node) => node.id)).toEqual(rechunked);
});
