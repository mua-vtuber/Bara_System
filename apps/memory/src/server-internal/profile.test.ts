/**
 * server-internal/profile.test.ts — getProfile 단위 검증 (T25 / spec H).
 *
 * 실 SQLite + 실 bge-m3(mock 금지·CLAUDE.md). facet 지정 저장 → facet 조회 회신,
 * 미지정 저장분 unclassified 합류, 선호 0건 시 설명 포함 성공 응답, ALL-facets vs
 * 단일 facet, idx_kn_memory_type 인덱스 사용(EXPLAIN QUERY PLAN)을 검증한다.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { retractSharedMemory } from "../memory/shared-memory-mutations.ts";
import type { MemoryApiDeps } from "./types.ts";
import { globalScope, projectValuesScope } from "../test-utils/resolved-scope.ts";
import { getProfile, NOTE_NONE_CURRENT, NOTE_NONE_STORED, noteForFacet, PROFILE_FACETS } from "./profile.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let deps: MemoryApiDeps;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
  deps = { store, retriever: {} as never, assembler: {} as never };
});
afterEach(() => {
  db.close();
});

test("선호 0건 — 에러가 아닌 설명 포함 성공 응답", () => {
  const report = getProfile(deps, { scope: globalScope() });
  expect(report).toEqual({ facets: {}, note: NOTE_NONE_STORED });
});

// ── WP-B1-16(SA-7) — 0건 문구 원인 구분 ──────────────────────────────────────
// 옛 동작은 "저장분 자체가 없다"와 "저장은 됐지만 가시성 필터로 지금 안 보인다"를
// 구분하지 않고 똑같이 NOTE_NONE_STORED 를 돌려줬다. 유일한 선호를 철회하면
// "선호를 저장한 적이 없다"는 거짓 인상을 준다.

test("유일한 선호를 철회하면 NOTE_NONE_STORED 가 아니라 NOTE_NONE_CURRENT + 비활성 1건", async () => {
  const id = await store.addNode({
    content: "설명은 항상 짧게 한다",
    memoryType: "preference",
    metadata: { facet: "communication" },
  });
  await retractSharedMemory(store, {
    nodeId: id, expectedRevision: 0, requestId: "retract-only-preference", actor: "ai-a",
  });

  const report = getProfile(deps, { scope: globalScope() });
  expect(report).toEqual({
    facets: {}, note: NOTE_NONE_CURRENT, omitted: { outOfScope: 0, notCurrent: 1 },
  });
});

test("다른 프로젝트 소속이라 scope 밖으로 빠진 선호는 outOfScope 로 센다", async () => {
  await store.addNode({
    content: "다른 프로젝트 전용 선호",
    memoryType: "preference",
    project_id: "other-project",
    metadata: { facet: "stack" },
  });

  const report = getProfile(deps, { scope: projectValuesScope(["my-project"], true) });
  expect(report).toEqual({
    facets: {}, note: NOTE_NONE_CURRENT, omitted: { outOfScope: 1, notCurrent: 0 },
  });
});

test("facet 지정 조회인데 그 facet 이 비어 있으면 facet 전용 문구(가시 항목이 있어도)", async () => {
  await store.addNode({
    content: "communication facet 선호",
    memoryType: "preference",
    metadata: { facet: "communication" },
  });

  const report = getProfile(deps, { facet: "stack", scope: globalScope() });
  expect(report).toEqual({ facets: {}, note: noteForFacet("stack") });
});

test("facet 지정 저장 → 그 facet 조회 시 회신, 다른 facet엔 안 섞임", async () => {
  await store.addNode({
    content: "탭 대신 스페이스 4칸을 쓴다",
    memoryType: "preference",
    metadata: { facet: "stack" },
  });
  await store.addNode({
    content: "커밋 메시지는 한글로 쓴다",
    memoryType: "preference",
    metadata: { facet: "workflow" },
  });

  const stackOnly = getProfile(deps, { facet: "stack", scope: globalScope() });
  expect(Object.keys(stackOnly.facets)).toEqual(["stack"]);
  expect(stackOnly.facets.stack).toHaveLength(1);
  expect(stackOnly.facets.stack![0]!.content).toBe("탭 대신 스페이스 4칸을 쓴다");
  expect(stackOnly.note).toBeUndefined();
});

test("facet 미지정 조회 — 전 facet + unclassified 를 함께 회신", async () => {
  await store.addNode({
    content: "직설적인 어투를 쓴다",
    memoryType: "preference",
    metadata: { facet: "communication" },
  });
  await store.addNode({
    content: "facet 없이 저장된 옛 선호",
    memoryType: "preference",
  });

  const report = getProfile(deps, { scope: globalScope() });
  expect(report.facets.communication).toHaveLength(1);
  expect(report.facets.unclassified).toHaveLength(1);
  expect(report.facets.unclassified![0]!.content).toBe("facet 없이 저장된 옛 선호");
  // 지정하지 않은 다른 facet 키는 항목이 없으면 아예 생략된다(빈 배열로 채우지 않음).
  expect(report.facets.directives).toBeUndefined();
});

test("facet 미지정 저장분(오타·구버전 값 포함) — 추론 없이 전부 unclassified 로 묶임", async () => {
  await store.addNode({
    content: "칸 부재",
    memoryType: "preference",
  });
  await store.addNode({
    content: "잘못된 facet 값(닫힌 enum 밖)",
    memoryType: "preference",
    metadata: { facet: "존재하지않는facet" },
  });

  const report = getProfile(deps, { scope: globalScope() });
  expect(report.facets.unclassified).toHaveLength(2);
});

test("preference 아닌 memoryType 은 get_profile 결과에 섞이지 않음", async () => {
  await store.addNode({ content: "일반 사실", memoryType: "fact" });
  await store.addNode({
    content: "선호 하나",
    memoryType: "preference",
    metadata: { facet: "directives" },
  });

  const report = getProfile(deps, { scope: globalScope() });
  const allEntries = Object.values(report.facets).flat();
  expect(allEntries).toHaveLength(1);
  expect(allEntries[0]!.content).toBe("선호 하나");
});

test("응답 항목은 id·content·createdAt 을 포함하고 최근순으로 정렬됨(통째 주입 — 검색 결과 excerpt 와 다름)", async () => {
  const first = await store.addNode({
    content: "먼저 저장된 선호",
    memoryType: "preference",
    metadata: { facet: "stack" },
  });
  const second = await store.addNode({
    content: "나중에 저장된 선호",
    memoryType: "preference",
    metadata: { facet: "stack" },
  });

  const report = getProfile(deps, { facet: "stack", scope: globalScope() });
  const entries = report.facets.stack!;
  expect(entries).toHaveLength(2);
  expect(entries.map((e) => e.id)).toEqual([second, first]);
  for (const e of entries) {
    expect(typeof e.content).toBe("string");
    expect(typeof e.createdAt).toBe("string");
  }
});

test("PROFILE_FACETS 닫힌 enum — 다섯 종 정확히(spec H)", () => {
  expect(PROFILE_FACETS).toEqual([
    "directives",
    "anti_preferences",
    "communication",
    "workflow",
    "stack",
  ]);
});

// ── WP-B1-10(SL-3 표시) — 아직 해소되지 않은 충돌 상대 id ────────────────────

test("WP-B1-10 — disputed 선호가 옛 선호와 contradicts로 이어지면 옛 선호 항목에 상대 id가 붙는다", async () => {
  const oldId = await store.addNode({
    content: "답변은 한국어로 해 주세요", memoryType: "preference", metadata: { facet: "communication" },
  });
  const newId = await store.addNode({
    content: "답변은 영어로 해 주세요", memoryType: "preference",
    metadata: { facet: "communication", sharedMemory: { status: "disputed" } },
  });
  await store.addEdge({ sourceId: newId, targetId: oldId, relation: "contradicts", provenance: "system", sourceNodeId: newId, weight: 0.9 });

  const report = getProfile(deps, { facet: "communication", scope: globalScope() });
  const entries = report.facets.communication!;
  expect(entries).toHaveLength(1);
  expect(entries[0]!.id).toBe(oldId);
  expect(entries[0]!.conflicts).toEqual([newId]);
});

test("WP-B1-10 — 충돌이 없는 선호는 conflicts가 빈 배열", async () => {
  await store.addNode({ content: "충돌 없는 선호", memoryType: "preference", metadata: { facet: "stack" } });
  const report = getProfile(deps, { facet: "stack", scope: globalScope() });
  expect(report.facets.stack![0]!.conflicts).toEqual([]);
});

test("WP-B1-10 — supersede로 해소된 뒤에는 표시가 사라진다", async () => {
  const oldId = await store.addNode({
    content: "옛 진술", memoryType: "preference", metadata: { facet: "workflow" },
  });
  const newId = await store.addNode({
    content: "새 진술", memoryType: "preference",
    metadata: { facet: "workflow", sharedMemory: { status: "disputed" } },
  });
  await store.addEdge({ sourceId: newId, targetId: oldId, relation: "contradicts", provenance: "system", sourceNodeId: newId, weight: 0.9 });

  const { supersedeSharedMemory } = await import("../memory/shared-memory-mutations.ts");
  await supersedeSharedMemory(store, {
    nodeId: oldId, replacementId: newId, expectedRevision: 0, requestId: "resolve-1", actor: "ai-a",
  });

  const report = getProfile(deps, { facet: "workflow", scope: globalScope() });
  const entries = report.facets.workflow!;
  expect(entries).toHaveLength(1);
  expect(entries[0]!.id).toBe(newId);
  expect(entries[0]!.conflicts).toEqual([]);
});

// ── WP-B1-10R — 원문(preference 원문 포함)에 자식 계보 표시 ─────────────────

test("WP-B1-10R — 원문에서 추출된 자식이 supersede되면 원문 항목에 '대체된 주장' 표시가 붙는다", async () => {
  const origin = await store.addNode({
    content: "옛 선호 원문입니다", memoryType: "preference", metadata: { facet: "stack" },
  });
  const child = await store.addNode({
    content: "옛 선호 추출 자식", memoryType: "preference", sourceType: "llm_extract",
    metadata: { facet: "stack", sharedMemory: { assertionKind: "ai_inference" } },
  });
  await store.addEdge({ sourceId: child, targetId: origin, relation: "merged_into", provenance: "system", sourceNodeId: child, weight: 1 });
  const replacement = await store.addNode({ content: "대체 선호", memoryType: "preference" });
  await store.db.query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ facet: "stack", sharedMemory: { status: "superseded", revision: 1, assertionKind: "ai_inference", supersededBy: replacement } }), child);

  const report = getProfile(deps, { facet: "stack", scope: globalScope() });
  const originEntry = report.facets.stack!.find((e) => e.id === origin)!;
  expect(originEntry.originMarks).toEqual({ openConflicts: [], supersededClaims: [{ childId: child, replacementId: replacement }] });
});

test("전역 memory_type='preference' 조회는 idx_kn_memory_type 커버링 색인을 탄다(전수 스캔 아님 — D-D)", async () => {
  await store.addNode({ content: "색인 확인용 선호", memoryType: "preference" });
  // 프로덕션 getProfile 과 같은 파라미터 바인딩 형태로 계획을 본다(리터럴 SQL 을
  // 복제하면 프로덕션 쿼리가 바뀔 때 검증 대상이 어긋난다).
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM knowledge_nodes WHERE memory_type = ? ORDER BY created_at DESC, id DESC",
    )
    .all("preference") as Array<{ detail: string }>;
  const detail = plan.map((p) => p.detail).join(" ");
  expect(detail).toContain("idx_kn_memory_type");
});
