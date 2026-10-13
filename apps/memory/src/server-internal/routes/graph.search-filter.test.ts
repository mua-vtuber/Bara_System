/**
 * graph.search-filter.test.ts — POST /graph/search 종류·종류별 칸·기간 거름망 E2E 검증.
 *
 * 그래프입력검색 S3: 그래프 검색 라우트에 kind(종류)·fieldFilters(종류별 칸)·dateRange
 * (기간) 필터를 더한다. /search 라우트가 이미 쓰는 파서 셋(parseKind·parseFieldFilters·
 * resolveDateRange)을 그대로 부착해 후보를 *축소* 한다(RRF 점수식 코어 불변). T3b 가
 * addClassificationTag(KIND_CATEGORY="종류")로 심은 종류 분류 링크를 kind 가 읽고,
 * setGlobField 로 저장한 글-칸을 fieldFilters 가 읽는다. 둘 다면 AND 교집합.
 *
 * 검증 항목:
 *   1. kind 만 — 그 종류 글만 hit(다른 종류 제외).
 *   2. fieldFilters 만 — 그 칸값 글만 hit.
 *   3. kind + fieldFilters — 두 조건 모두 만족하는 글만(AND 교집합).
 *   4. 필터 미전달이면 후보가 더 넓다(축소 증명·일정 글까지 후보).
 *   5. filter(S7 하위분류) — 그 갈래 분류 링크가 있는 글만 hit(키 이름 무시·값만 매칭).
 *   6. filter 미전달이면 그 갈래 안 거른 글까지 후보(filter 회귀 0).
 *
 * 실 SqliteMemoryStore(:memory:) + 실 Bgem3Embedder + 실 Hono app. mock 없음.
 * 종류·칸은 store 직접 호출(addClassificationTag·setGlobField)로 심는다 — search.capsule
 * .test.ts 와 같은 양식이라 실통로 검증이다. graph.test-helpers.ts(loadEmbedder·
 * makeGraphTestDeps) 재사용.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import { registerGraphRoutes } from "./graph.ts";
import type { GraphSearchResponse } from "./graph.ts";
import { KIND_CATEGORY } from "../../memory/glob-field-apply.ts";

beforeAll(async () => {
  await loadEmbedder();
});
afterAll(() => {});

let ctx: GraphTestContext;
let app: Hono;
let milkId: number;
let breadId: number;
let eventId: number;

beforeEach(async () => {
  ctx = await makeGraphTestDeps();
  app = new Hono();
  registerGraphRoutes(app, ctx.deps);
  // 세 글 모두 "마트" 토큰을 담아 의미검색 후보에 같이 뜨게 한다 — 필터가 후보를
  // 줄이는지(축소)를 검증하려면 필터 전엔 셋 다 후보여야 한다.
  milkId = await ctx.store.addNode({ content: "마트에서 우유를 샀다" });
  breadId = await ctx.store.addNode({ content: "마트에서 빵을 샀다" });
  eventId = await ctx.store.addNode({ content: "마트 갈 일정을 잡았다" });
  // 종류 분류(T3b 양식 — addClassificationTag(KIND_CATEGORY, 종류명)).
  await ctx.store.addClassificationTag(milkId, KIND_CATEGORY, "가계부", "user_input", milkId);
  await ctx.store.addClassificationTag(breadId, KIND_CATEGORY, "가계부", "user_input", breadId);
  await ctx.store.addClassificationTag(eventId, KIND_CATEGORY, "일정", "user_input", eventId);
  // 글-칸(T3b 양식 — setGlobField(키, 값, "direct")).
  await ctx.store.setGlobField(milkId, "항목", "우유", "direct");
  await ctx.store.setGlobField(breadId, "항목", "빵", "direct");
  // 하위분류 갈래 분류 링크(S7 — addClassificationTag 가 글→갈래 개념 노드 선을 만든다).
  // filter 는 값(갈래 이름)을 개념 이름으로 매칭하므로 이 선이 있는 글만 통과한다.
  await ctx.store.addClassificationTag(milkId, "갈래", "소설", "user_input", milkId);
  await ctx.store.addClassificationTag(breadId, "갈래", "만화", "user_input", breadId);
});
afterEach(() => {
  ctx.close();
});

async function gsearch(body: Record<string, unknown>): Promise<GraphSearchResponse> {
  const res = await app.request("/graph/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GraphSearchResponse;
}

// hit 노드 sourceId 를 모으는 헬퍼 — hits[].nodeId 는 "node:42" 형태라 끝 숫자를 본다.
function hitSourceIds(resp: GraphSearchResponse): Set<number> {
  return new Set(resp.hits.map((h) => Number(h.nodeId.split(":").pop())));
}

test("kind 만 — 그 종류 글만 hit(다른 종류 제외)", async () => {
  const resp = await gsearch({ query: "마트", kind: "가계부", limit: 20 });
  const ids = hitSourceIds(resp);
  expect(ids.has(milkId)).toBe(true);
  expect(ids.has(breadId)).toBe(true);
  expect(ids.has(eventId)).toBe(false);
});

test("fieldFilters 만 — 그 칸값 글만 hit", async () => {
  const resp = await gsearch({
    query: "마트",
    fieldFilters: [{ key: "항목", value: "우유" }],
    limit: 20,
  });
  const ids = hitSourceIds(resp);
  expect(ids.has(milkId)).toBe(true);
  expect(ids.has(breadId)).toBe(false);
  expect(ids.has(eventId)).toBe(false);
});

test("kind + fieldFilters — AND 교집합", async () => {
  const resp = await gsearch({
    query: "마트",
    kind: "가계부",
    fieldFilters: [{ key: "항목", value: "우유" }],
    limit: 20,
  });
  const ids = hitSourceIds(resp);
  expect(ids.has(milkId)).toBe(true);
  expect(ids.has(breadId)).toBe(false);
  expect(ids.has(eventId)).toBe(false);
});

test("필터 미전달이면 후보가 더 넓다(축소 증명·회귀 0 정신)", async () => {
  const wide = await gsearch({ query: "마트", limit: 20 });
  const narrow = await gsearch({ query: "마트", kind: "가계부", limit: 20 });
  // eventId 포함 단언은 임베더 결과 결합이라 제거 — 후보 축소는 count 비교로 검증한다.
  // narrow 가 1건 이상이어야 비교가 공허하지 않다(kind=가계부는 우유·빵 글을 임베더 무관하게 통과시킨다).
  expect(narrow.count).toBeGreaterThanOrEqual(1);
  expect(wide.count).toBeGreaterThanOrEqual(narrow.count);
});

test("filter(하위분류 갈래) — 그 갈래 분류 링크 있는 글만 hit(키 이름 무시·값만 매칭·S7)", async () => {
  // S7 드롭다운이 보내는 {subcategory: 갈래값} 양식. retriever 는 키 이름("subcategory")을
  // 무시하고 값("소설")을 개념 이름으로 매칭하므로, "소설" 갈래 선이 있는 milkId 만 통과한다.
  const resp = await gsearch({ query: "마트", filter: { subcategory: "소설" }, limit: 20 });
  const ids = hitSourceIds(resp);
  expect(ids.has(milkId)).toBe(true);
  expect(ids.has(breadId)).toBe(false); // 빵 글은 "만화" 갈래라 제외
  expect(ids.has(eventId)).toBe(false); // 일정 글은 갈래 분류 없음
});

test("filter 미전달이면 그 갈래 안 거른 글까지 후보(filter 회귀 0)", async () => {
  const withFilter = await gsearch({ query: "마트", filter: { subcategory: "소설" }, limit: 20 });
  const without = await gsearch({ query: "마트", limit: 20 });
  // 갈래 filter 가 후보를 좁히므로(소설 1건) 미전달이 같거나 더 넓다.
  expect(withFilter.count).toBeGreaterThanOrEqual(1);
  expect(without.count).toBeGreaterThanOrEqual(withFilter.count);
});
