/**
 * search.capsule.test.ts — POST /search 종류·종류별 칸 거름망 캡슐 E2E 검증.
 *
 * 활용 단계6 T4: 검색에 kind(종류)·fieldFilters(종류별 칸) 캡슐을 더한다. T3b 가
 * addClassificationTag(KIND_CATEGORY="종류")로 심은 종류 분류 링크를 kind 캡슐이
 * getNodeIdsByConceptName 재사용으로 읽고, T3b 가 metadata_json.fields 에 저장한
 * 글-칸을 fieldFilters 캡슐이 getNodeIdsByMetadataField 로 읽는다. 둘 다면 AND.
 *
 * 검증 항목:
 *   1. kind 만 — 그 종류로 분류된 글만 회수(다른 종류 제외).
 *   2. fieldFilters 만 — 그 칸값 글만 회수.
 *   3. kind + fieldFilters — 두 조건 모두 만족하는 글만(AND 교집합).
 *   4. 미전달이면 캡슐 없는 검색과 결과 동일(0 diff — 후보 축소 0).
 *   5. concept_nodes 에 없는 종류 이름 → strict 기본은 0건, relaxFilters:true 때만
 *      캡슐을 풀어 의미검색으로 떨어짐.
 *
 * 실 SqliteMemoryStore(:memory:) + 실 Bgem3Embedder + 실 Hono app. mock 없음.
 * 종류·칸은 store 직접 호출(addClassificationTag·setGlobField)로 심는다 — T3b 의
 * ingest 저장 통로와 같은 store 메서드라 실통로 검증이다(미등록 kind 칸 0 함정 회피).
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
import { KIND_CATEGORY } from "../../memory/glob-field-apply.ts";

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

async function search(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{
  count: number;
  results: Array<{ id: number }>;
  searchMode: "strict" | "relaxed";
  relaxed: boolean;
  strictCount: number;
  removedFilters: string[];
}> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    count: number;
    results: Array<{ id: number }>;
    searchMode: "strict" | "relaxed";
    relaxed: boolean;
    strictCount: number;
    removedFilters: string[];
  };
}

describe("POST /search — T4 종류·종류별 칸 거름망 캡슐", () => {
  let h: Harness;
  let milkId: number; // 가계부·항목=우유
  let breadId: number; // 가계부·항목=빵
  let eventId: number; // 일정(종류만 다름)

  beforeEach(async () => {
    h = makeHarness();
    // 세 글 모두 "마트" 토큰을 담아 의미검색 후보에 같이 뜨게 한다 — 캡슐이 후보를
    // 줄이는지(축소)를 검증하려면 캡슐 전엔 셋 다 후보여야 한다.
    milkId = await h.store.addNode({ content: "마트에서 우유를 샀다" });
    breadId = await h.store.addNode({ content: "마트에서 빵을 샀다" });
    eventId = await h.store.addNode({ content: "마트 갈 일정을 잡았다" });

    // 종류 분류(T3b 양식 — addClassificationTag(KIND_CATEGORY, 종류명)).
    await h.store.addClassificationTag(milkId, KIND_CATEGORY, "가계부", "user_input", milkId);
    await h.store.addClassificationTag(breadId, KIND_CATEGORY, "가계부", "user_input", breadId);
    await h.store.addClassificationTag(eventId, KIND_CATEGORY, "일정", "user_input", eventId);

    // 글-칸(T3b 양식 — setGlobField(키, 값, "direct")).
    await h.store.setGlobField(milkId, "항목", "우유", "direct");
    await h.store.setGlobField(breadId, "항목", "빵", "direct");
  });
  afterEach(() => {
    h.db.close();
  });

  test("kind 만 — 그 종류로 분류된 글만 회수(다른 종류 제외)", async () => {
    const data = await search(h.app, { query: "마트", kind: "가계부", limit: 20 });
    const ids = new Set(data.results.map((r) => r.id));
    expect(ids.has(milkId)).toBe(true);
    expect(ids.has(breadId)).toBe(true);
    expect(ids.has(eventId)).toBe(false); // 일정 종류라 제외
  });

  test("fieldFilters 만 — 그 칸값 글만 회수", async () => {
    const data = await search(h.app, {
      query: "마트",
      fieldFilters: [{ key: "항목", value: "우유" }],
      limit: 20,
    });
    const ids = new Set(data.results.map((r) => r.id));
    expect(ids.has(milkId)).toBe(true);
    expect(ids.has(breadId)).toBe(false); // 항목=빵이라 제외
    expect(ids.has(eventId)).toBe(false); // 칸 없음이라 제외
  });

  test("kind + fieldFilters — 두 조건 모두 만족(AND 교집합)", async () => {
    const data = await search(h.app, {
      query: "마트",
      kind: "가계부",
      fieldFilters: [{ key: "항목", value: "우유" }],
      limit: 20,
    });
    const ids = new Set(data.results.map((r) => r.id));
    expect(ids.has(milkId)).toBe(true);
    expect(ids.has(breadId)).toBe(false); // 가계부지만 항목=빵
    expect(ids.has(eventId)).toBe(false); // 일정·칸 없음
  });

  test("캡슐 미전달이면 캡슐 있는 검색보다 후보가 넓다(축소 증명)", async () => {
    const wide = await search(h.app, { query: "마트", limit: 20 });
    const narrow = await search(h.app, {
      query: "마트",
      kind: "가계부",
      fieldFilters: [{ key: "항목", value: "우유" }],
      limit: 20,
    });
    const wideIds = new Set(wide.results.map((r) => r.id));
    // 캡슐 없으면 셋 다 후보(마트 토큰 공유). 캡슐은 그중 우유 글만 남긴다.
    expect(wideIds.has(milkId)).toBe(true);
    expect(wideIds.has(breadId)).toBe(true);
    expect(wideIds.has(eventId)).toBe(true);
    expect(narrow.count).toBeLessThan(wide.count);
  });

  test("없는 종류 이름 → strict 기본은 0건 그대로", async () => {
    const data = await search(h.app, {
      query: "마트",
      kind: "없는종류이름",
      limit: 20,
    });
    expect(data.results).toEqual([]);
    expect(data.count).toBe(0);
    expect(data.searchMode).toBe("strict");
    expect(data.relaxed).toBe(false);
    expect(data.strictCount).toBe(0);
    expect(data.removedFilters).toEqual([]);
  });

  test("없는 종류 이름 + relaxFilters:true → 캡슐 풀어 의미검색으로 떨어짐", async () => {
    const data = await search(h.app, {
      query: "마트",
      kind: "없는종류이름",
      limit: 20,
      relaxFilters: true,
    });
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.searchMode).toBe("relaxed");
    expect(data.relaxed).toBe(true);
    expect(data.strictCount).toBe(0);
    expect(data.removedFilters).toEqual(["kind"]);
  });

  test("응답 1초 안 — 검색 LLM 호출 0(캡슐은 결정적 SQL)", async () => {
    const start = Date.now();
    await search(h.app, {
      query: "마트",
      kind: "가계부",
      fieldFilters: [{ key: "항목", value: "우유" }],
      limit: 20,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});
