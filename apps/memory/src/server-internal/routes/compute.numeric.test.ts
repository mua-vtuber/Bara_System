/**
 * server-internal/routes/compute.numeric.test.ts — POST /compute sum/avg E2E (단계6b T3).
 *
 * 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 buildMemoryApi. mock 0. compute.test.ts
 * 의 makeHarness/postCompute/nodeWithConcept 양식을 그대로 미러한다. 숫자형 칸은
 * store.setGlobField(nid, '금액', '...', 'direct') 로 채운다(compute-numeric-aggregate.test.ts
 * 선례). 검증 항목:
 *   (a) kind=sum + 종류 칸 + field → 합계 + 제외 건수 + numericFieldPresent
 *   (b) kind=avg + avgDivisor=day 인데 기간 부재 → 400 'period'(0 위장·분모 A 대체 폴백 0)
 *   (c) kind=sum 인데 field 부재 → 400(어느 칸 합산할지 모름·정직 거부)
 *   (d) kind=avg + field + avgDivisor 부재(분모 A·글당) → SUM/읽힌건수·avgDivisorKind='count'
 *   (e) kind=avg + field + avgDivisor=day + 기간 명시(분모 B) → SUM/30·avgDivisor=30·kind='day'
 *   (f) 좁혀진 글에 금액 칸 0건 kind=sum → numericFieldPresent false·value undefined(0 위장 아님)
 *   (g) 좁혀진 글 전부 비숫자 칸 kind=avg(분모 A) → readCount 0·excludedCount>0·value undefined(C1)
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

describe("POST /compute — sum/avg 라우트 E2E (단계6b T3)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  /** 종류(분류값) classification 으로 매단 가계부 글 하나. */
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

  test("(a) kind=sum + 종류 칸 + field=금액 → 합계·제외 건수·numericFieldPresent", async () => {
    const a = await nodeWithConcept("커피", "가계부");
    const b = await nodeWithConcept("점심", "가계부");
    const c = await nodeWithConcept("선물", "가계부");
    await h.store.setGlobField(a, "금액", "3,000원", "direct");
    await h.store.setGlobField(b, "금액", "12000", "direct");
    await h.store.setGlobField(c, "금액", "비쌈", "direct"); // 못 읽음 → 제외

    const res = await postCompute(h.app, {
      query: "합계",
      kind: "sum",
      filter: { 분류: "가계부" },
      field: "금액",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      kind: string;
      value: number;
      readCount: number;
      excludedCount: number;
      numericFieldPresent: boolean;
    };
    expect(data.kind).toBe("sum");
    expect(data.value).toBe(15000); // 3000+12000
    expect(data.readCount).toBe(2); // 숫자로 읽힌 2건(라우트 응답에 readCount 합류)
    expect(data.excludedCount).toBe(1); // '비쌈' 제외(0 안 됨)
    expect(data.numericFieldPresent).toBe(true);
  });

  test("(b) kind=avg + avgDivisor=day 인데 기간 부재 → 400 period required", async () => {
    const a = await nodeWithConcept("커피", "가계부");
    await h.store.setGlobField(a, "금액", "3000", "direct");

    const res = await postCompute(h.app, {
      query: "평균",
      kind: "avg",
      filter: { 분류: "가계부" },
      field: "금액",
      avgDivisor: "day",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("period");
  });

  test("(c) kind=sum 인데 field 부재 → 400", async () => {
    await nodeWithConcept("커피", "가계부");
    const res = await postCompute(h.app, {
      query: "합계",
      kind: "sum",
      filter: { 분류: "가계부" },
    });
    expect(res.status).toBe(400);
  });

  test("(d) kind=avg + field + avgDivisor 부재(분모 A·글당) → SUM÷읽힌건수·avgDivisorKind=count", async () => {
    const a = await nodeWithConcept("커피", "가계부");
    const b = await nodeWithConcept("점심", "가계부");
    await h.store.setGlobField(a, "금액", "10000", "direct");
    await h.store.setGlobField(b, "금액", "20000", "direct");

    const res = await postCompute(h.app, {
      query: "평균",
      kind: "avg",
      filter: { 분류: "가계부" },
      field: "금액",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      kind: string;
      value: number;
      avgDivisorKind: string;
    };
    expect(data.kind).toBe("avg");
    expect(data.value).toBe(15000); // (10000+20000)/2 — 읽힌 건수 2
    expect(data.avgDivisorKind).toBe("count"); // 분모 A·기간 불요
  });

  test("(e) kind=avg + field + avgDivisor=day + 기간 명시(분모 B) → SUM÷30·avgDivisor=30·kind=day", async () => {
    const a = await nodeWithConcept("6월 a", "가계부", "2026-06-10");
    const b = await nodeWithConcept("6월 b", "가계부", "2026-06-20");
    await h.store.setGlobField(a, "금액", "100000", "direct");
    await h.store.setGlobField(b, "금액", "200000", "direct");

    const res = await postCompute(h.app, {
      query: "평균",
      kind: "avg",
      filter: { 분류: "가계부" },
      field: "금액",
      avgDivisor: "day",
      since: "2026-06-01",
      until: "2026-06-30",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      value: number;
      avgDivisor: number;
      avgDivisorKind: string;
    };
    expect(data.value).toBeCloseTo(300000 / 30, 6); // 달력 30일로 나눔
    expect(data.avgDivisor).toBe(30);
    expect(data.avgDivisorKind).toBe("day");
  });

  test("(f) 좁혀진 글에 금액 칸 0건 kind=sum → numericFieldPresent false·value undefined(0 위장 아님)", async () => {
    await nodeWithConcept("금액 칸 안 채운 가계부 글", "가계부");
    const res = await postCompute(h.app, {
      query: "합계",
      kind: "sum",
      filter: { 분류: "가계부" },
      field: "금액",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      numericFieldPresent: boolean;
      value?: number;
    };
    expect(data.numericFieldPresent).toBe(false);
    expect(data.value).toBeUndefined(); // 0 으로 위장 안 함
  });

  test("(g) 좁혀진 글 전부 비숫자 칸 kind=avg(분모 A) → readCount 0·excludedCount>0·value undefined(C1)", async () => {
    // 글 3개 전부 비숫자값으로 금액 칸을 채운다 — 칸은 있으나(numericFieldPresent true) 숫자로
    // 읽힌 0건. avg 분모 A(읽힌 건수 0)면 divisor 0 → value 미산출. 라우트 응답에 readCount 가
    // 합류해 UI 가 "전부 못 읽음"을 "0 평균"으로 오인하지 않는지(C1) 라우트 끝단에서 고정한다.
    const a = await nodeWithConcept("커피", "가계부");
    const b = await nodeWithConcept("점심", "가계부");
    const cc = await nodeWithConcept("선물", "가계부");
    await h.store.setGlobField(a, "금액", "비쌈", "direct");
    await h.store.setGlobField(b, "금액", "많음", "direct");
    await h.store.setGlobField(cc, "금액", "적당", "direct");

    const res = await postCompute(h.app, {
      query: "평균",
      kind: "avg",
      filter: { 분류: "가계부" },
      field: "금액",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      readCount: number;
      excludedCount: number;
      numericFieldPresent: boolean;
      value?: number;
    };
    expect(data.readCount).toBe(0); // 숫자로 읽힌 0건(count=총 글 3 과 다름)
    expect(data.excludedCount).toBeGreaterThan(0); // 못 읽어 제외한 건수
    expect(data.numericFieldPresent).toBe(true); // 칸은 채워짐(부재 아님)
    expect(data.value).toBeUndefined(); // 분모 0 → value 미산출(0 평균 위장 아님)
  });
});
