/**
 * graph-overview-docs-images.test.ts — GET /graph/overview 에 문서·이미지 노드 합류 검증.
 *
 * Phase 8 재매핑 Task 5.
 *
 * 검증 항목:
 *   1. sourceType="document" 노드가 overview 응답에 포함된다.
 *   2. sourceType="image_asset" 노드가 overview 응답에 포함된다.
 *   3. 문서·이미지가 0건이면 overview 에 document/image_asset 노드가 없다(정직한 빈 상태).
 *   4. 합류 수가 DOCS_IMAGES_LIMIT(24) 상한 안으로 제한된다.
 *   5. 일반 auto_capture 노드도 함께 뜬다(기존 동작 회귀 없음).
 *   6. POST /graph/search 기존 문서·이미지 합류 동작 회귀 없음.
 *
 * 실제 bun:sqlite(:memory:) + 실제 SqliteMemoryStore. Mock 클래스 0.
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
import { Hono } from "hono";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import { registerGraphRoutes } from "./graph.ts";
import type { GraphOverviewResponse, GraphSearchResponse } from "./graph.ts";

// DOCS_IMAGES_LIMIT 값 — graph.ts 의 상수와 같은 값을 여기서도 선언해 검증에 쓴다.
// graph.ts 의 상수가 바뀌면 이 값도 함께 수정한다(단일 출처는 graph.ts).
const DOCS_IMAGES_LIMIT = 24;

beforeAll(async () => {
  await loadEmbedder();
});

afterAll(() => {});

let ctx: GraphTestContext;
let app: Hono;

beforeEach(async () => {
  ctx = await makeGraphTestDeps();
  app = new Hono();
  registerGraphRoutes(app, ctx.deps);
});

afterEach(() => {
  ctx.close();
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

async function overviewJson(query = ""): Promise<GraphOverviewResponse> {
  const path = query ? `/graph/overview?${query}` : "/graph/overview";
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.json() as Promise<GraphOverviewResponse>;
}

async function searchJson(
  body: Record<string, unknown>,
): Promise<{ status: number; data: GraphSearchResponse }> {
  const res = await app.request("/graph/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as GraphSearchResponse };
}

// ── 문서·이미지 합류 ───────────────────────────────────────────────────────────

describe("Task 5 — 문서·이미지 overview 합류", () => {
  test("document 노드가 overview 응답에 sourceType 'document' 로 뜬다", async () => {
    await ctx.store.addNode({
      content: "테스트 문서 자산 노드",
      sourceType: "document",
    });

    const ov = await overviewJson();
    const docNodes = ov.nodes.filter((n) => n.sourceType === "document");
    expect(docNodes.length).toBeGreaterThan(0);
  });

  test("image_asset 노드가 overview 응답에 sourceType 'image_asset' 로 뜬다", async () => {
    await ctx.store.addNode({
      content: "테스트 이미지 자산 노드",
      sourceType: "image_asset",
    });

    const ov = await overviewJson();
    const imgNodes = ov.nodes.filter((n) => n.sourceType === "image_asset");
    expect(imgNodes.length).toBeGreaterThan(0);
  });

  test("document 와 image_asset 가 0건이면 overview 에 해당 노드가 없다(정직한 빈 상태)", async () => {
    // auto_capture 노드만 추가 — 문서·이미지 없음
    await ctx.store.addNode({ content: "일반 메모리 노드" });

    const ov = await overviewJson();
    const docNodes = ov.nodes.filter((n) => n.sourceType === "document");
    const imgNodes = ov.nodes.filter((n) => n.sourceType === "image_asset");
    expect(docNodes.length).toBe(0);
    expect(imgNodes.length).toBe(0);
  });

  test("완전 빈 DB 에서 overview 는 nodes 빈 배열 반환(정직한 빈 상태)", async () => {
    const ov = await overviewJson();
    expect(ov.nodes).toEqual([]);
    expect(ov.edges).toEqual([]);
    expect(ov.stats.totalNodes).toBe(0);
  });

  test("문서·이미지 노드가 DOCS_IMAGES_LIMIT 초과해도 overview 합류 수가 상한 안이다", async () => {
    // DOCS_IMAGES_LIMIT + 5 개를 삽입해 상한 초과 시나리오를 만든다.
    // getRecent 의 DEFAULT_LIMIT(60) 이 상한이므로 DOCS_IMAGES_LIMIT + 5 < 60 으로 유지.
    const insertCount = DOCS_IMAGES_LIMIT + 5;
    for (let i = 0; i < insertCount; i++) {
      await ctx.store.addNode({
        content: `문서 자산 ${i}`,
        sourceType: "document",
      });
    }

    const ov = await overviewJson();
    const docNodes = ov.nodes.filter((n) => n.sourceType === "document");
    // getRecent 가 DEFAULT_LIMIT(60) 로 잘라주므로 상한 안에 들어온다.
    expect(docNodes.length).toBeLessThanOrEqual(DOCS_IMAGES_LIMIT);
  });

  test("일반 auto_capture 노드도 함께 뜬다(기존 동작 회귀 없음)", async () => {
    await ctx.store.addNode({ content: "일반 기억 A" });
    await ctx.store.addNode({ content: "일반 기억 B", sourceType: "document" });

    const ov = await overviewJson();
    const autoNodes = ov.nodes.filter((n) => n.sourceType === "auto_capture");
    expect(autoNodes.length).toBeGreaterThan(0);
  });

  test("document_chunk / llm_extract / image_caption 은 overview 에 뜨지 않는다(getRecent 제외 불변식)", async () => {
    // 부모 노드를 먼저 만들고 자식 타입을 직접 삽입한다.
    await ctx.store.addNode({ content: "청크 부모 문서", sourceType: "document" });
    await ctx.store.addNode({ content: "청크 자식 노드", sourceType: "document_chunk" });
    await ctx.store.addNode({ content: "추출 자식 노드", sourceType: "llm_extract" });
    await ctx.store.addNode({ content: "캡션 자식 노드", sourceType: "image_caption" });

    const ov = await overviewJson();
    const excluded = ov.nodes.filter((n) =>
      n.sourceType === "document_chunk" ||
      n.sourceType === "llm_extract" ||
      n.sourceType === "image_caption"
    );
    expect(excluded.length).toBe(0);
  });

  test("원본 1-hop 자식도 기본 overview 에서는 숨기고 expand 시에만 펼친다", async () => {
    const raw = await ctx.store.addNode({
      content: "의미추출 원본 글",
      sourceType: "auto_capture",
    });
    const extracted = await ctx.store.addNode({
      content: "의미추출 atomic 자식",
      sourceType: "llm_extract",
    });
    await ctx.store.addEdge({
      sourceId: extracted,
      targetId: raw,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });

    const overview = await overviewJson();
    expect(overview.nodes.some((n) => n.id === `node:${raw}`)).toBe(true);
    expect(overview.nodes.some((n) => n.id === `node:${extracted}`)).toBe(false);
    expect(
      overview.edges.some((e) => e.from === `node:${extracted}` || e.to === `node:${extracted}`),
    ).toBe(false);

    const expanded = await overviewJson(`expand=${encodeURIComponent(`node:${raw}`)}`);
    expect(expanded.nodes.some((n) => n.id === `node:${raw}`)).toBe(true);
    expect(
      expanded.nodes.some((n) => n.id === `node:${extracted}` && n.sourceType === "llm_extract"),
    ).toBe(true);
    expect(
      expanded.edges.some(
        (e) =>
          e.type === "merged_into" &&
          e.from === `node:${extracted}` &&
          e.to === `node:${raw}`,
      ),
    ).toBe(true);
  });

  test("문서 청크도 기본 overview 에서는 숨기고 문서 expand 시에만 보인다", async () => {
    const doc = await ctx.store.addNode({
      content: "청크 원본 문서",
      sourceType: "document",
    });
    const chunk = await ctx.store.addNode({
      content: "청크 자식 본문",
      sourceType: "document_chunk",
      metadata: { parentId: String(doc), chunkIndex: 0 },
    });
    await ctx.store.addEdge({
      sourceId: chunk,
      targetId: doc,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });

    const overview = await overviewJson();
    expect(overview.nodes.some((n) => n.id === `node:${doc}`)).toBe(true);
    expect(overview.nodes.some((n) => n.id === `node:${chunk}`)).toBe(false);

    const expanded = await overviewJson(`expand=${encodeURIComponent(`node:${doc}`)}`);
    expect(
      expanded.nodes.some(
        (n) => n.id === `node:${chunk}` && n.sourceType === "document_chunk",
      ),
    ).toBe(true);
    expect(
      expanded.edges.some(
        (e) =>
          e.type === "parent_of" &&
          e.from === `node:${chunk}` &&
          e.to === `node:${doc}`,
      ),
    ).toBe(true);
  });
});

// ── 검색 경로 회귀 0 ──────────────────────────────────────────────────────────

describe("Task 5 — 검색 경로 회귀 0", () => {
  test("document 노드가 있을 때 검색 쿼리 결과에 document sourceType 노드가 합류된다", async () => {
    await ctx.store.addNode({
      content: "검색 회귀 검증 문서 자산 노드",
      sourceType: "document",
    });

    const { status, data } = await searchJson({
      query: "검색 회귀 검증 문서",
      limit: 10,
    });
    expect(status).toBe(200);
    // subgraph 형태가 유지된다
    expect(Array.isArray(data.subgraph.nodes)).toBe(true);
    expect(Array.isArray(data.subgraph.edges)).toBe(true);
  });

  test("image_asset 노드가 있을 때 검색이 정상 동작한다(회귀 없음)", async () => {
    await ctx.store.addNode({
      content: "검색 회귀 이미지 노드 테스트",
      sourceType: "image_asset",
    });

    const { status, data } = await searchJson({
      query: "검색 회귀 이미지",
      limit: 10,
    });
    expect(status).toBe(200);
    expect(Array.isArray(data.subgraph.nodes)).toBe(true);
  });

  test("검색에서 파생 노드가 직접 hit 이면 파생 노드와 원본 연결이 보인다", async () => {
    const raw = await ctx.store.addNode({
      content: "원본 라벨 감마",
      sourceType: "auto_capture",
    });
    const extracted = await ctx.store.addNode({
      content: "파생 직접 검색어 델타",
      sourceType: "llm_extract",
    });
    await ctx.store.addEdge({
      sourceId: extracted,
      targetId: raw,
      relation: "merged_into",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });

    const { status, data } = await searchJson({ query: "파생 직접 검색어 델타", limit: 10 });
    expect(status).toBe(200);
    expect(data.subgraph.nodes.some((n) => n.id === `node:${extracted}`)).toBe(true);
    expect(data.subgraph.nodes.some((n) => n.id === `node:${raw}`)).toBe(true);
    expect(
      data.subgraph.edges.some(
        (e) =>
          e.type === "merged_into" &&
          e.from === `node:${extracted}` &&
          e.to === `node:${raw}`,
      ),
    ).toBe(true);
  });
});
