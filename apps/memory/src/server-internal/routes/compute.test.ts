/**
 * server-internal/routes/compute.test.ts — POST /compute 라우트 E2E 검증 (단계5 T5).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder. mock 0. 검증 항목:
 *   (a) 집계 종류별 응답 모양(list·count·timeline·log)
 *   (b) 빈 결과 정직(0건·가짜 행 0)
 *   (c) 잘못된 입력 방어(query 없음 400)
 *   (d) 칸 0개 → "조건 필요" 회신(전 노드 폭주 차단)
 *   (e) 집계 의도 없는 query → 400(찾기 경로 안내)
 *   (f) 명시 kind 가 query 의도보다 우선
 *   (g) POST /search 불변(별 입구 — 계산 경로 추가 후에도 검색 정상)
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

async function postCompute(app: Hono, body: unknown): Promise<Response> {
  return app.request("/compute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /compute — 계산 경로 E2E (단계5 T5)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  /** 종류(분류값) classification 으로 매단 글 하나(+선택 event_at). */
  async function nodeWithConcept(
    content: string,
    conceptValue: string,
    eventAt?: string,
  ): Promise<number> {
    const cid = await h.store.findOrCreateTagConcept(conceptValue);
    const nid = await h.store.addNode({ content, eventAt });
    await h.store.addNodeConceptEdge(nid, cid, "classification", "user_input", nid);
    return nid;
  }

  test("(a) count — 명시 kind=count + 종류 칸 → 개수", async () => {
    await nodeWithConcept("커피 한 잔", "가계부");
    await nodeWithConcept("점심", "가계부");
    const res = await postCompute(h.app, {
      query: "가계부 몇 개",
      kind: "count",
      filter: { 분류: "가계부" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; count: number };
    expect(body.kind).toBe("count");
    expect(body.count).toBe(2);
  });

  test("(a) list — 종류 칸 글 전부 나열", async () => {
    await nodeWithConcept("항목1", "가계부");
    await nodeWithConcept("항목2", "가계부");
    const res = await postCompute(h.app, {
      query: "가계부 목록",
      filter: { 분류: "가계부" },
    });
    const body = (await res.json()) as {
      kind: string;
      count: number;
      items: Array<{ id: number; content: string }>;
    };
    expect(body.kind).toBe("list");
    expect(body.count).toBe(2);
    expect(body.items.length).toBe(2);
    expect(body.items[0]).toHaveProperty("content");
  });

  test("(a) timeline — event_at ASC 정렬", async () => {
    await nodeWithConcept("늦은", "일정", "2026-05-20");
    await nodeWithConcept("이른", "일정", "2026-05-01");
    const res = await postCompute(h.app, {
      query: "일정 언제였지",
      filter: { 분류: "일정" },
    });
    const body = (await res.json()) as {
      kind: string;
      orderedBy: string;
      items: Array<{ content: string }>;
    };
    expect(body.kind).toBe("timeline");
    expect(body.orderedBy).toBe("event_asc");
    expect(body.items.map((i) => i.content)).toEqual(["이른", "늦은"]);
  });

  test("(a) log — 명시 kind=log + 프로젝트 칸 시간순", async () => {
    await h.store.addNode({
      content: "나중 작업",
      project_id: "prj_a",
      eventAt: "2026-06-10",
    });
    await h.store.addNode({
      content: "먼저 작업",
      project_id: "prj_a",
      eventAt: "2026-06-01",
    });
    const res = await postCompute(h.app, {
      query: "진행상황",
      kind: "log",
      project: "prj_a",
    });
    const body = (await res.json()) as {
      kind: string;
      items: Array<{ content: string }>;
    };
    expect(body.kind).toBe("log");
    expect(body.items.map((i) => i.content)).toEqual(["먼저 작업", "나중 작업"]);
  });

  test("(b) 빈 결과 정직 — 종류 매칭 0건이면 count 0·빈 목록(가짜 행 0)", async () => {
    await nodeWithConcept("커피", "가계부");
    const res = await postCompute(h.app, {
      query: "없는분류 목록",
      filter: { 분류: "존재안함" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; items: unknown[] };
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });

  test("(c) query 없음 → 400", async () => {
    const res = await postCompute(h.app, { kind: "list" });
    expect(res.status).toBe(400);
  });

  test("(c) invalid JSON → 400", async () => {
    const res = await h.app.request("/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  test("(d) 칸 0개 → 조건 필요 회신(전 노드 폭주 차단)", async () => {
    await nodeWithConcept("아무 글", "가계부");
    // 집계 의도는 있으나(목록) 좁힐 칸이 하나도 없음.
    const res = await postCompute(h.app, { query: "목록 보여줘" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      needsCondition: boolean;
    };
    expect(body.needsCondition).toBe(true);
    expect(body.error).toBe("condition required");
  });

  test("(e) 집계 의도 없는 query → 400(찾기 경로 안내)", async () => {
    const res = await postCompute(h.app, {
      query: "고양이가 귀엽다",
      filter: { 분류: "가계부" },
    });
    expect(res.status).toBe(400);
  });

  test("(e) 수치 집계어('얼마')는 집계 의도 아님 → 400(Q1=C·찾기 경로)", async () => {
    const res = await postCompute(h.app, {
      query: "가계부 얼마 썼지",
      filter: { 분류: "가계부" },
    });
    expect(res.status).toBe(400);
  });

  test("(f) 명시 kind 가 query 의도보다 우선(query=목록, kind=count)", async () => {
    await nodeWithConcept("a", "가계부");
    await nodeWithConcept("b", "가계부");
    const res = await postCompute(h.app, {
      query: "가계부 목록 보여줘",
      kind: "count",
      filter: { 분류: "가계부" },
    });
    const body = (await res.json()) as { kind: string; count: number };
    expect(body.kind).toBe("count");
    expect(body.count).toBe(2);
  });

  test("(g) POST /search 정상(별 입구 — 계산 경로 추가 후에도 검색 동작)", async () => {
    await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "주술회전 고죠가 좋다" }),
    });
    const res = await h.app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "주술회전", limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });
});
