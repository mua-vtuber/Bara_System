/**
 * memories-trash.test.ts — POST /memories/:id/trash 검증.
 *
 * 설계 권위 = docs/decisions/2026-08-06-memory-individual-delete-spec.md.
 * UI 개별 삭제 통로 — 영구 삭제(DELETE /memories/:id)가 아니라 trashNodes(cascade) 로
 * 휴지통 이동한다. 원문의 metadata.extractedTo 에 실린 자식 중 실존하는 것만
 * cascade 로 함께 옮긴다.
 *
 * 검증 항목:
 *   1. 원문 + 자식 2개 → trash 후 라이브에서 사라지고 archive 에 3건 등장.
 *   2. extractedTo 에 낡은(존재하지 않는) id 가 섞여도 실존 자식만 이동.
 *   3. extractedTo 없음 → 원문만 이동, cascadeTrashedIds 는 빈 배열.
 *   4. extractedTo 에 없는 무관 노드는 이동 대상에서 제외.
 *   5. 없는 id → 404, 비정수 id → 400.
 *   6. 복원 왕복 — POST /archive/:id/restore 로 원문이 라이브에 되돌아온다.
 *
 * Real bun:sqlite(:memory:) + real Bgem3Embedder. mock 0(MockStore 금지).
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

interface TrashResponse {
  trashed: number;
  cascadeTrashedIds: number[];
}

describe("POST /memories/:id/trash — 개별 삭제(휴지통 이동)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  // 추출 자식은 실제 추출기처럼 llm_extract(파생, 자기 출처 행 없음)로 만든다. WP-B1-20T 설계 3.5 —
  // 출처를 주지 않은 auto_capture 노드는 직접 저장 출처 행을 받고, 설계 5.4 — 자기 출처 행이 있는 자손은
  // 휴지통 연쇄에서 남는다(memories-trash.lineage.test.ts 가 그 경우를 따로 본다).
  test("원문 + 추출 자식 2개 — trash 후 라이브에서 사라지고 archive 에 3건", async () => {
    const child1 = await h.store.addNode({ content: "추출 자식 1", sourceType: "llm_extract" });
    const child2 = await h.store.addNode({ content: "추출 자식 2", sourceType: "llm_extract" });
    const original = await h.store.addNode({
      content: "원문 글",
      metadata: { extractedTo: [child1, child2] },
    });

    const res = await h.app.request(`/memories/${original}/trash`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrashResponse;
    expect(body.trashed).toBe(original);
    expect(body.cascadeTrashedIds.sort()).toEqual([child1, child2].sort());

    expect(await h.store.getNode(original)).toBeNull();
    expect(await h.store.getNode(child1)).toBeNull();
    expect(await h.store.getNode(child2)).toBeNull();

    const archive = await h.store.getArchive({});
    const archivedIds = archive.map((a) => a.id).sort((a, b) => a - b);
    expect(archivedIds).toEqual([original, child1, child2].sort((a, b) => a - b));
  });

  test("낡은 id 무해 — extractedTo 에 존재하지 않는 id 가 섞여도 실존 자식만 이동", async () => {
    const child1 = await h.store.addNode({ content: "실존 자식", sourceType: "llm_extract" });
    const original = await h.store.addNode({
      content: "원문 글",
      metadata: { extractedTo: [child1, 99999] },
    });

    const res = await h.app.request(`/memories/${original}/trash`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrashResponse;
    expect(body.trashed).toBe(original);
    expect(body.cascadeTrashedIds).toEqual([child1]);
  });

  test("extractedTo 없음 — 원문만 이동, cascadeTrashedIds 는 빈 배열", async () => {
    const original = await h.store.addNode({ content: "단독 글" });

    const res = await h.app.request(`/memories/${original}/trash`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrashResponse;
    expect(body.trashed).toBe(original);
    expect(body.cascadeTrashedIds).toEqual([]);

    expect(await h.store.getNode(original)).toBeNull();
  });

  test("extractedTo 에 없는 무관 노드는 이동 대상에서 제외된다", async () => {
    const unrelated = await h.store.addNode({ content: "무관 노드" });
    const original = await h.store.addNode({ content: "원문 글" });

    const res = await h.app.request(`/memories/${original}/trash`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrashResponse;
    expect(body.cascadeTrashedIds).toEqual([]);

    expect(await h.store.getNode(unrelated)).not.toBeNull();
  });

  test("없는 id → 404", async () => {
    const res = await h.app.request(`/memories/99999/trash`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("비정수 id → 400", async () => {
    const res = await h.app.request(`/memories/abc/trash`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("복원 왕복 — POST /archive/:id/restore 로 원문이 라이브에 되돌아온다", async () => {
    const original = await h.store.addNode({ content: "복원될 글" });

    const trashRes = await h.app.request(`/memories/${original}/trash`, {
      method: "POST",
    });
    expect(trashRes.status).toBe(200);
    expect(await h.store.getNode(original)).toBeNull();

    const restoreRes = await h.app.request(`/archive/${original}/restore`, {
      method: "POST",
    });
    expect(restoreRes.status).toBe(200);

    const restored = await h.store.getNode(original);
    expect(restored).not.toBeNull();
    expect(restored?.content).toBe("복원될 글");
  });
});
