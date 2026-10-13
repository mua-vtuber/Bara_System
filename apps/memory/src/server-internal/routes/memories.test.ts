/**
 * memories.test.ts — Phase 7 ④ Task 7: GET /memories/:id/revisions 조회 라우트 검증.
 *
 * 설계 권위 = `docs/decisions/2026-06-02-phase7-redesign-design.md` ④ Revision.
 * Task 6 이 conflict-checker supersede 시점에 memory_revisions 행을 기록했고, 이 라우트가
 * 그 이력을 노드 id 로 *보이게* 한다(old_node_id·new_node_id 양쪽 매칭, 시간 역순).
 *
 * 검증 항목:
 *   1. supersede 한 쌍을 만들면 옛 노드 id 로 GET /:id/revisions → 이력 1건.
 *   2. 새 노드 id 로도 같은 이력이 나온다(new_node_id 매칭).
 *   3. revision 없는 노드 → 빈 배열(진짜 빈 상태 — 에러 아님).
 *   4. 잘못된 id(비정수) → 400.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0(MockStore 금지). 운영 DB 비접근.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import type { MemoryRevision } from "../../memory/types.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

/**
 * 옛 노드 → 새 노드 supersede 한 쌍을 만든다. conflict-checker 가 supersede 시점에 하는
 * 두 동작(supersedes 엣지 + memory_revisions 행)을 그대로 재현한다 — Task 6 경로와 동형.
 */
async function makeSupersedePair(
  store: SqliteMemoryStore,
  oldContent: string,
  newContent: string,
): Promise<{ oldId: number; newId: number }> {
  const oldId = await store.addNode({ content: oldContent });
  const newId = await store.addNode({ content: newContent });
  await store.addEdge({
    sourceId: newId,
    targetId: oldId,
    relation: "supersedes",
    provenance: "user_input",
    sourceNodeId: null,
    weight: 0.85,
  });
  await store.insertRevision({
    oldNodeId: oldId,
    newNodeId: newId,
    revisionType: "conflict_supersede",
    reason: "충돌 감지: 유사 0.85, 작성자 동일",
    similarityScore: 0.85,
  });
  return { oldId, newId };
}

interface RevisionsResponse {
  revisions: MemoryRevision[];
}

describe("GET /memories/:id/revisions — Phase 7 ④ Task 7 변경 이력 조회", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("supersede 한 쌍 — 옛 노드 id 로 조회하면 이력 1건", async () => {
    const { oldId, newId } = await makeSupersedePair(
      h.store,
      "이번 주말은 부산 여행",
      "이번 주말은 제주 여행으로 변경",
    );

    const res = await h.app.request(`/memories/${oldId}/revisions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RevisionsResponse;

    expect(body.revisions.length).toBe(1);
    const rev = body.revisions[0]!;
    expect(rev.oldNodeId).toBe(oldId);
    expect(rev.newNodeId).toBe(newId);
    expect(rev.revisionType).toBe("conflict_supersede");
    expect(rev.similarityScore).toBeCloseTo(0.85, 5);
  });

  test("새 노드 id 로 조회해도 같은 이력이 나온다(new_node_id 매칭)", async () => {
    const { oldId, newId } = await makeSupersedePair(
      h.store,
      "오늘 점심은 라멘",
      "오늘 점심은 우동으로 변경",
    );

    const res = await h.app.request(`/memories/${newId}/revisions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RevisionsResponse;

    expect(body.revisions.length).toBe(1);
    expect(body.revisions[0]!.oldNodeId).toBe(oldId);
    expect(body.revisions[0]!.newNodeId).toBe(newId);
  });

  test("여러 supersede 가 한 노드를 가리키면 시간 역순으로 모두 나온다", async () => {
    const oldId = await h.store.addNode({ content: "원본 일정 메모" });
    const newId1 = await h.store.addNode({ content: "1차 변경 일정" });
    const newId2 = await h.store.addNode({ content: "2차 변경 일정" });
    await h.store.insertRevision({
      oldNodeId: oldId,
      newNodeId: newId1,
      revisionType: "conflict_supersede",
      reason: "1차",
      similarityScore: 0.8,
    });
    await h.store.insertRevision({
      oldNodeId: oldId,
      newNodeId: newId2,
      revisionType: "conflict_supersede",
      reason: "2차",
      similarityScore: 0.82,
    });

    const res = await h.app.request(`/memories/${oldId}/revisions`);
    const body = (await res.json()) as RevisionsResponse;
    expect(body.revisions.length).toBe(2);
    // 시간 역순(created_at DESC, id DESC) — 나중 행이 먼저.
    expect(body.revisions[0]!.id).toBeGreaterThan(body.revisions[1]!.id);
  });

  test("revision 없는 노드 → 빈 배열(진짜 빈 상태 — 에러 아님)", async () => {
    const id = await h.store.addNode({ content: "변경 이력 없는 평범한 글" });

    const res = await h.app.request(`/memories/${id}/revisions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RevisionsResponse;
    expect(body.revisions).toEqual([]);
  });

  test("존재하지 않는 노드 id → 빈 배열(없는 노드 = 이력 0, 200)", async () => {
    // getRevisionsForNode 는 노드 존재 검사를 하지 않는다 — 그 노드에 대한 이력이
    // 0건이면 빈 배열이 정직한 답이다(별도 404 분기 없음 / 빈 상태 != 에러).
    const res = await h.app.request("/memories/999999/revisions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RevisionsResponse;
    expect(body.revisions).toEqual([]);
  });

  test("잘못된 id(비정수) → 400", async () => {
    const res = await h.app.request("/memories/abc/revisions");
    expect(res.status).toBe(400);
  });
});
