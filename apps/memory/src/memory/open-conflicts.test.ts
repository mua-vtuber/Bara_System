/**
 * open-conflicts.test.ts — listOpenConflicts (WP-B1-10 / SL-3 표시).
 *
 * 실제 SQLite로 검증한다(순수 DB 조회라 bge-m3 로드는 불필요 — embedding은 직접 주입).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { listOpenConflicts, listOriginMarks } from "./open-conflicts.ts";

let db: Database;
let store: SqliteMemoryStore;
const vec = () => new Float32Array(1024);

beforeEach(() => { db = openMemoryDatabase(":memory:"); store = new SqliteMemoryStore(db, new Bgem3Embedder()); });
afterEach(() => db.close());

async function contradicts(sourceId: number, targetId: number) {
  await store.addEdge({ sourceId, targetId, relation: "contradicts", provenance: "system", sourceNodeId: sourceId, weight: 0.9 });
}

test("no contradicts edge means no open conflicts", async () => {
  const id = await store.addNode({ content: "충돌 없는 기억", embedding: vec() });
  expect(listOpenConflicts(db, [id])).toEqual(new Map());
});

test("a disputed new memory shows the active old memory's id and vice versa", async () => {
  const oldId = await store.addNode({ content: "옛 기억", embedding: vec() });
  const newId = await store.addNode({ content: "새 기억", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(newId, oldId);
  const result = listOpenConflicts(db, [oldId, newId]);
  expect(result.get(oldId)).toEqual([newId]);
  expect(result.get(newId)).toEqual([oldId]);
});

test("A-B-N case: superseding A with N closes the N-A relation but leaves N-B open on both N and B", async () => {
  const a = await store.addNode({ content: "옛 기억 A", embedding: vec() });
  const b = await store.addNode({ content: "옛 기억 B", embedding: vec() });
  const n = await store.addNode({ content: "새 기억 N", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(n, a);
  await contradicts(n, b);

  // supersede_memory(A -> N) 채택 뒤 상태를 직접 구성한다(이 테스트는 open-conflicts 판정만
  // 검증한다 — supersede 경로 자체는 shared-memory-mutations.test.ts 가 별도로 본다).
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "superseded", revision: 1, assertionKind: "unknown", supersededBy: n } }), a);
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "active", revision: 1, assertionKind: "unknown" } }), n);

  const result = listOpenConflicts(db, [a, b, n]);
  expect(result.has(a)).toBe(false); // A는 해소됨 — 표시 없음
  expect(result.get(n)).toEqual([b]); // N-B는 여전히 열림
  expect(result.get(b)).toEqual([n]); // B에서도 보여야 한다
});

test("resolving the last conflict by retract leaves no mark on either side", async () => {
  const oldId = await store.addNode({ content: "옛 기억", embedding: vec() });
  const newId = await store.addNode({ content: "새 기억", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(newId, oldId);
  expect(listOpenConflicts(db, [oldId, newId]).get(oldId)).toEqual([newId]);

  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } }), newId);

  const result = listOpenConflicts(db, [oldId, newId]);
  expect(result.has(oldId)).toBe(false);
  expect(result.has(newId)).toBe(false);
});

test("one batch call resolves multiple requested ids without per-id queries", async () => {
  const a = await store.addNode({ content: "A", embedding: vec() });
  const b = await store.addNode({ content: "B", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  const c = await store.addNode({ content: "C", embedding: vec() });
  const d = await store.addNode({ content: "D", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(b, a);
  await contradicts(d, c);
  const result = listOpenConflicts(db, [a, b, c, d]);
  expect(result.get(a)).toEqual([b]);
  expect(result.get(b)).toEqual([a]);
  expect(result.get(c)).toEqual([d]);
  expect(result.get(d)).toEqual([c]);
});

test("ids with no requested counterpart in conflict are omitted from the map", async () => {
  const a = await store.addNode({ content: "충돌 없음 1", embedding: vec() });
  const b = await store.addNode({ content: "충돌 없음 2", embedding: vec() });
  expect(listOpenConflicts(db, [a, b])).toEqual(new Map());
  expect(listOpenConflicts(db, [])).toEqual(new Map());
});

// ── listOriginMarks (WP-B1-10R) ─────────────────────────────────────────────

async function mergedInto(childId: number, originId: number) {
  await store.addEdge({ sourceId: childId, targetId: originId, relation: "merged_into", provenance: "system", sourceNodeId: childId, weight: 1 });
}

test("origin with no merged_into children has no marks", async () => {
  const origin = await store.addNode({ content: "원문", embedding: vec() });
  expect(listOriginMarks(db, [origin])).toEqual(new Map());
  expect(listOriginMarks(db, [])).toEqual(new Map());
});

test("origin shows the open conflict id of its extracted child", async () => {
  const origin = await store.addNode({ content: "원문", embedding: vec() });
  const child = await store.addNode({ content: "자식", embedding: vec() });
  await mergedInto(child, origin);
  const rival = await store.addNode({ content: "반대 주장", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(rival, child);

  const result = listOriginMarks(db, [origin]);
  expect(result.get(origin)).toEqual({ openConflicts: [rival], supersededClaims: [] });
});

test("origin shows a superseded-claim mark when its child is superseded and the replacement is current", async () => {
  const origin = await store.addNode({ content: "원문", embedding: vec() });
  const child = await store.addNode({ content: "자식", embedding: vec() });
  await mergedInto(child, origin);
  const replacement = await store.addNode({ content: "대체 기억", embedding: vec() });

  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "superseded", revision: 1, assertionKind: "unknown", supersededBy: replacement } }), child);

  const result = listOriginMarks(db, [origin]);
  expect(result.get(origin)).toEqual({ openConflicts: [], supersededClaims: [{ childId: child, replacementId: replacement }] });
});

test("the superseded-claim mark disappears once the replacement itself is no longer current", async () => {
  const origin = await store.addNode({ content: "원문", embedding: vec() });
  const child = await store.addNode({ content: "자식", embedding: vec() });
  await mergedInto(child, origin);
  const replacement = await store.addNode({ content: "대체 기억", embedding: vec() });

  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "superseded", revision: 1, assertionKind: "unknown", supersededBy: replacement } }), child);
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } }), replacement);

  expect(listOriginMarks(db, [origin])).toEqual(new Map());
});

test("a lineage-invalidated child produces no marks even though it carries supersededBy or a conflict", async () => {
  const origin = await store.addNode({ content: "원문", embedding: vec() });
  const child = await store.addNode({ content: "자식", embedding: vec() });
  await mergedInto(child, origin);
  const rival = await store.addNode({ content: "반대 주장", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(rival, child);

  // B1-06 편집 재추출이 계보 무효화로 이 자식을 거둔다 — invalidatedBy 가 있는 retracted.
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown", invalidatedBy: origin } }), child);

  expect(listOriginMarks(db, [origin])).toEqual(new Map());
});

test("all resolved or reverted leaves no marks on the origin", async () => {
  const origin = await store.addNode({ content: "원문", embedding: vec() });
  const child = await store.addNode({ content: "자식", embedding: vec() });
  await mergedInto(child, origin);
  const rival = await store.addNode({ content: "반대 주장", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(rival, child);

  // 충돌을 retract 로 해소 — 더 이상 열린 충돌이 아니다. 자식 자신은 active 그대로.
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } }), rival);

  expect(listOriginMarks(db, [origin])).toEqual(new Map());
});

test("one batch call resolves marks for multiple origins without per-origin queries", async () => {
  const originA = await store.addNode({ content: "원문 A", embedding: vec() });
  const childA = await store.addNode({ content: "자식 A", embedding: vec() });
  await mergedInto(childA, originA);
  const rivalA = await store.addNode({ content: "반대 A", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(rivalA, childA);

  const originB = await store.addNode({ content: "원문 B", embedding: vec() });
  const childB = await store.addNode({ content: "자식 B", embedding: vec() });
  await mergedInto(childB, originB);
  const replacementB = await store.addNode({ content: "대체 B", embedding: vec() });
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "superseded", revision: 1, assertionKind: "unknown", supersededBy: replacementB } }), childB);

  const result = listOriginMarks(db, [originA, originB]);
  expect(result.get(originA)).toEqual({ openConflicts: [rivalA], supersededClaims: [] });
  expect(result.get(originB)).toEqual({ openConflicts: [], supersededClaims: [{ childId: childB, replacementId: replacementB }] });
});

// ── listOriginMarks 청크 두 단계 경유 (WP-B1-10S Medium 2) ──────────────────
// 긴 auto_capture 원문·document 는 원문 -parent_of-> 청크 -merged_into-> 주장의 두 단계
// 계보다(origin-chunks.ts / ingest-document.ts). listOriginMarks 는 이 한 단을 더 봐야 한다.

async function parentOf(chunkId: number, originId: number) {
  await store.addEdge({ sourceId: chunkId, targetId: originId, relation: "parent_of", provenance: "system", sourceNodeId: chunkId, weight: 1 });
}

test("청크를 거친 주장의 열린 충돌이 원문에 실린다(두 단계 계보)", async () => {
  const origin = await store.addNode({ content: "긴 원문", embedding: vec() });
  const chunk = await store.addNode({ content: "청크", embedding: vec(), sourceType: "document_chunk" });
  await parentOf(chunk, origin);
  const claim = await store.addNode({ content: "청크에서 뽑은 주장", embedding: vec() });
  await mergedInto(claim, chunk);
  const rival = await store.addNode({ content: "반대 주장", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(rival, claim);

  const result = listOriginMarks(db, [origin]);
  expect(result.get(origin)).toEqual({ openConflicts: [rival], supersededClaims: [] });
});

test("청크를 거친 주장이 supersede되면 원문에 '대체된 주장' 표시가 붙는다", async () => {
  const origin = await store.addNode({ content: "긴 원문", embedding: vec() });
  const chunk = await store.addNode({ content: "청크", embedding: vec(), sourceType: "document_chunk" });
  await parentOf(chunk, origin);
  const claim = await store.addNode({ content: "청크에서 뽑은 주장", embedding: vec() });
  await mergedInto(claim, chunk);
  const replacement = await store.addNode({ content: "대체 기억", embedding: vec() });
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "superseded", revision: 1, assertionKind: "unknown", supersededBy: replacement } }), claim);

  const result = listOriginMarks(db, [origin]);
  expect(result.get(origin)).toEqual({ openConflicts: [], supersededClaims: [{ childId: claim, replacementId: replacement }] });
});

test("계보 무효화된 청크는 그 밑 주장까지 함께 제외한다", async () => {
  const origin = await store.addNode({ content: "긴 원문", embedding: vec() });
  const chunk = await store.addNode({ content: "청크", embedding: vec(), sourceType: "document_chunk" });
  await parentOf(chunk, origin);
  const claim = await store.addNode({ content: "청크에서 뽑은 주장", embedding: vec() });
  await mergedInto(claim, chunk);
  const rival = await store.addNode({ content: "반대 주장", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(rival, claim);

  // 원문 재청크(편집)가 옛 청크를 계보 무효화로 거둔다 — invalidatedBy 가 있는 retracted.
  db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown", invalidatedBy: origin } }), chunk);

  expect(listOriginMarks(db, [origin])).toEqual(new Map());
});

test("직속 자식과 청크 경유 자식이 함께 있으면 두 표시가 합쳐진다", async () => {
  const origin = await store.addNode({ content: "혼합 원문", embedding: vec() });
  const directChild = await store.addNode({ content: "직속 자식", embedding: vec() });
  await mergedInto(directChild, origin);
  const directRival = await store.addNode({ content: "직속 반대", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(directRival, directChild);

  const chunk = await store.addNode({ content: "청크", embedding: vec(), sourceType: "document_chunk" });
  await parentOf(chunk, origin);
  const chunkedClaim = await store.addNode({ content: "청크 경유 자식", embedding: vec() });
  await mergedInto(chunkedClaim, chunk);
  const chunkedRival = await store.addNode({ content: "청크 경유 반대", embedding: vec(), metadata: { sharedMemory: { status: "disputed" } } });
  await contradicts(chunkedRival, chunkedClaim);

  const result = listOriginMarks(db, [origin]);
  expect(result.get(origin)?.openConflicts.sort((a, b) => a - b)).toEqual(
    [directRival, chunkedRival].sort((a, b) => a - b),
  );
});
