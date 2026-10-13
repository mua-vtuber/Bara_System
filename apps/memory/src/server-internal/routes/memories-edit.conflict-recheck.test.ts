/**
 * PATCH /memories/:id · /memories/by-source — 편집 후 충돌 재검사 라우트 검증.
 *
 * 실제 SQLite + 실제 bge-m3 임베더 + buildMemoryApi 로 end-to-end:
 *  - 유사한 편집 → disputed 후보만 기록하고 기존 기억의 중요도는 유지.
 *  - 기존 supersedes 엣지는 유사도 재검사로 바꾸지 않음.
 *  - 본문 무변경 편집 → 충돌 작업 0 (엣지·revision 불변).
 *  - by-source 편집 경로도 같은 재검사를 탄다 (두 편집 surface 정합).
 *
 * 실제 임베더라 두 글의 정확한 cosine 은 고정할 수 없으므로, 테스트별로
 * ConflictChecker 의 band 임계를 결과가 강제되는 값으로 주입한다(설정 주입이지
 * mock 아님): 도입 검증은 [0.05, 0.9999) — 관련 한국어 문장 쌍은 확실히 안쪽,
 * 해소 검증은 [0.99, 0.9999) — 서로 다른 문장 쌍은 확실히 바깥.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
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
import { ConflictChecker } from "../../memory/conflict-checker.ts";
import { buildMemoryApi } from "../../server.ts";

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

const harnesses: Harness[] = [];

function makeHarness(simLow: number, simHigh: number): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const conflictChecker = new ConflictChecker(store, { simLow, simHigh });
  const app = buildMemoryApi({ store, retriever, assembler, conflictChecker });
  const h = { app, db, store };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function countSupersedeEdges(
  db: Database,
  sourceId: number,
  targetId: number,
): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM knowledge_edges
         WHERE relation = 'supersedes' AND source_id = ? AND target_id = ?`,
      )
      .get(sourceId, targetId) as { c: number }
  ).c;
}

async function patchMemory(
  app: Hono,
  id: number,
  content: string,
): Promise<Response> {
  return app.request(`/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, editor: "owner", source: "test" }),
  });
}

describe("PATCH /memories/:id — 충돌 재검사", () => {
  test("동일 revision의 동시 수정은 하나만 반영하고 파생 근거를 무효화한다", async () => {
    const h = makeHarness(0.99, 0.9999);
    const id = await h.store.addNode({ content: "여러 AI가 읽은 원문" });
    const child = await h.store.addNode({ content: "원문에 의존하는 추론", metadata: { sharedMemory: { evidenceRefs: [id] } } });
    const responses = await Promise.all(["첫 수정", "둘째 수정"].map((content) => h.app.request(`/memories/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, expectedRevision: 0 }),
    })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((r) => r.status === 409)!;
    expect(await conflict.json()).toMatchObject({ code: "CONFLICT", currentRevision: 1 });
    expect((await h.store.getNode(child))!.metadata.sharedMemory).toMatchObject({ status: "retracted", invalidatedBy: id });
    const latest = (await h.store.getNode(id))!;
    const noop = await h.app.request(`/memories/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: latest.content, expectedRevision: 0 }),
    });
    expect(noop.status).toBe(409);
    const invalid = await h.app.request(`/memories/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "잘못된 버전", expectedRevision: -1 }),
    });
    expect(invalid.status).toBe(400);
  });

  test("유사한 편집: disputed 후보 기록, 기존 기억 유지", async () => {
    const h = makeHarness(0.05, 0.9999);
    const cId = await h.store.addNode({
      content: "커피를 좋아한다",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
    });
    const eId = await h.store.addNode({
      content: "등산 모임 일정",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.6,
    });
    expect(countSupersedeEdges(h.db, eId, cId)).toBe(0);

    const res = await patchMemory(h.app, eId, "커피를 정말 좋아한다");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; warnings: string[] };
    expect(body.changed).toBe(true);
    expect(body.warnings).toEqual([]);

    expect(countSupersedeEdges(h.db, eId, cId)).toBe(0);
    const c = await h.store.getNode(cId);
    expect(c!.importance).toBeCloseTo(0.7);
    const rev = (await h.store.getRevisionsForNode(cId)).find(
      (r) => r.revisionType === "manual" && r.reason?.includes("충돌 후보"),
    );
    expect(rev).toBeDefined();
    expect(rev!.newNodeId).toBe(eId);
  });

  test("유사성이 사라진 편집도 기존 supersedes 이력은 유지", async () => {
    const h = makeHarness(0.99, 0.9999);
    const cId = await h.store.addNode({
      content: "커피를 사랑한다",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
    });
    const eId = await h.store.addNode({
      content: "커피를 좋아한다",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.6,
    });
    await h.store.addEdge({
      sourceId: eId,
      targetId: cId,
      relation: "supersedes",
      provenance: "system",
      sourceNodeId: eId,
      weight: 0.7,
    });

    const res = await patchMemory(h.app, eId, "등산 계획은 다음 주 토요일");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; warnings: string[] };
    expect(body.changed).toBe(true);
    expect(body.warnings).toEqual([]);

    expect(countSupersedeEdges(h.db, eId, cId)).toBe(1);
    const resolve = (await h.store.getRevisionsForNode(cId)).find(
      (r) => r.revisionType === "manual" && r.reason?.includes("충돌 해소"),
    );
    expect(resolve).toBeUndefined();
  });

  test("본문 무변경 편집: 충돌 작업 0 (엣지·revision 불변)", async () => {
    const h = makeHarness(0.05, 0.9999);
    const cId = await h.store.addNode({
      content: "커피를 사랑한다",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
    });
    const eId = await h.store.addNode({
      content: "커피를 좋아한다",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.6,
    });
    await h.store.addEdge({
      sourceId: eId,
      targetId: cId,
      relation: "supersedes",
      provenance: "system",
      sourceNodeId: eId,
      weight: 0.7,
    });

    const res = await patchMemory(h.app, eId, "커피를 좋아한다");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(false);

    // early-return 이라 편집·재검사 어느 쪽도 안 돈다 — 엣지 유지, revision 0,
    // 상대 importance 그대로.
    expect(countSupersedeEdges(h.db, eId, cId)).toBe(1);
    expect((await h.store.getRevisionsForNode(eId)).length).toBe(0);
    expect((await h.store.getRevisionsForNode(cId)).length).toBe(0);
    expect((await h.store.getNode(cId))!.importance).toBeCloseTo(0.7, 5);
  });
});

describe("PATCH /memories/by-source — 충돌 재검사 (편집 surface 정합)", () => {
  test("by-source 편집도 기존 기억을 대체하지 않고 후보만 기록한다", async () => {
    const h = makeHarness(0.05, 0.9999);
    const cId = await h.store.addNode({
      content: "커피를 좋아한다",
      memoryType: "fact",
      sourceType: "user_explicit",
      author: "owner",
      importance: 0.7,
    });
    const rId = await h.store.addNode({
      content: "등산 모임 일정",
      memoryType: "fact",
      sourceType: "auto_capture",
      author: "owner",
      platform: "discord",
      metadata: { messageId: "msg-conflict-1", source: "discord-channel" },
    });

    const res = await h.app.request("/memories/by-source", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: "msg-conflict-1",
        platform: "discord",
        content: "커피를 아주 좋아한다",
        editor: "discord-owner",
        source: "discord",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      editedIds: number[];
      warnings: string[];
    };
    expect(body.changed).toBe(true);
    expect(body.editedIds).toEqual([rId]);
    expect(body.warnings).toEqual([]);

    expect(countSupersedeEdges(h.db, rId, cId)).toBe(0);
    const rev = (await h.store.getRevisionsForNode(cId)).find(
      (r) => r.revisionType === "manual" && r.reason?.includes("충돌 후보"),
    );
    expect(rev).toBeDefined();
    expect(rev!.newNodeId).toBe(rId);
  });

  // SL-6 — 같은 messageId 로 매칭되는 auto_capture 노드가 둘 이상일 때, expectedRevision
  // 이 하나라도 어긋나면 아무것도 쓰지 않고 409 + 전체 conflicts 를 돌려준다. 옛 구현은
  // 노드마다 확인 즉시 커밋해 앞 노드가 이미 바뀐 채로 남는 부분 적용이 있었다.
  test("같은 messageId 노드 2개(revision 0, 1)에 expectedRevision:0 → 409, 두 노드 모두 무변경", async () => {
    const h = makeHarness(0.99, 0.9999);
    const idA = await h.store.addNode({
      content: "첫 번째 원본",
      sourceType: "auto_capture",
      platform: "discord",
      metadata: { messageId: "msg-multi-conflict", source: "discord" },
    });
    const idB = await h.store.addNode({
      content: "두 번째 원본",
      sourceType: "auto_capture",
      platform: "discord",
      metadata: { messageId: "msg-multi-conflict", source: "discord" },
    });
    // idB 만 먼저 한 번 편집해 revision 을 1로 올려 두 노드의 revision 이 어긋나게 만든다.
    const bumped = await h.store.editNodeContent({ nodeId: idB, content: "두 번째 원본 수정판" });
    expect(bumped).not.toBeNull();

    const before = {
      a: (await h.store.getNode(idA))!,
      b: (await h.store.getNode(idB))!,
    };

    const res = await h.app.request("/memories/by-source", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: "msg-multi-conflict",
        platform: "discord",
        content: "동시 편집 시도",
        expectedRevision: 0,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      conflicts: Array<{ nodeId: number; currentRevision: number }>;
    };
    expect(body.code).toBe("CONFLICT");
    // QA Medium(WP-B1-05R) — WP-B1-05 완료 기준대로 conflicts 에는 대상
    // auto_capture 노드 *전부*의 {nodeId, currentRevision} 이 실린다. idA 는
    // expectedRevision(0) 과 실제로 일치하는 노드지만, 호출자가 "무엇과 비교해
    // idB 가 어긋났는지" 판단하려면 일치하는 노드의 currentRevision 도 필요하다.
    expect(body.conflicts.length).toBe(2);
    const byId = new Map(body.conflicts.map((c) => [c.nodeId, c.currentRevision]));
    expect(byId.get(idA)).toBe(0);
    expect(byId.get(idB)).toBe(1);
    // idA 는 expectedRevision(0) 과 일치하더라도, idB 가 어긋나면 idA 도 conflicts 에
    // 실려야 "아무것도 쓰지 않는다" 계약이 성립한다 — idA 만 따로 커밋되지 않았는지
    // 아래 무변경 단언으로 확인한다.

    const after = {
      a: (await h.store.getNode(idA))!,
      b: (await h.store.getNode(idB))!,
    };
    expect(after.a.content).toBe(before.a.content);
    expect(after.b.content).toBe(before.b.content);
    expect((await h.store.getRevisionsForNode(idA)).length).toBe(0);
  });
});
