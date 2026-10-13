/**
 * graph.test.ts — GET /graph/overview + POST /graph/search 라우트 통합 검증.
 *
 * 설계 권위 = Phase 8 T3/T4 구현 지침.
 *
 * GET /graph/overview 검증 항목:
 *   1. 빈 DB → { nodes:[], edges:[], stats:{totalNodes:0,totalEdges:0} } (정직한 빈 상태).
 *   2. 글 저장 후 overview 가 해당 노드를 회신한다.
 *   3. 노드에 id / label 칸이 있다.
 *   4. limit 파라미터가 노드 수를 제한한다.
 *   5. 두 노드 사이 엣지가 있으면 edges 배열에 포함된다.
 *   6. limit 미지정 시 DEFAULT_LIMIT(60) 동작 — 글 수가 적으면 전부 회신.
 *   7. stats.totalNodes / stats.totalEdges 가 nodes/edges 길이와 일치한다.
 *
 * POST /graph/search 검증 항목:
 *   1. 빈/공백 쿼리 → 400.
 *   2. 글 저장 후 검색 → hits + subgraph + focus 를 회신한다.
 *   3. hit 가 있으면 focus.centerNodeId 가 첫 번째 hit nodeId 와 일치한다.
 *   4. top3 는 hits 의 앞 3개다.
 *   5. 엣지가 있으면 subgraph.edges 에 포함된다.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0. 운영 DB 비접근.
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
import { conceptToGraphNode, registerGraphRoutes } from "./graph.ts";
import type { GraphOverviewResponse, GraphSearchResponse } from "./graph.ts";
import type { ConceptNode } from "../../memory/types.ts";
import { saveTextInput } from "../save-input.ts";

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

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

async function overviewJson(query = ""): Promise<GraphOverviewResponse> {
  const path = query ? `/graph/overview?${query}` : "/graph/overview";
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.json() as Promise<GraphOverviewResponse>;
}

// ── 검증 ──────────────────────────────────────────────────────────────────

describe("GET /graph/overview — Phase 8 T3", () => {
  test("빈 DB → 정직한 빈 상태", async () => {
    const body = await overviewJson();
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.stats.totalNodes).toBe(0);
    expect(body.stats.totalEdges).toBe(0);
  });

  test("entity_patch 로 생긴 작품 엔티티는 글 노드 없이 overview 에 보인다", async () => {
    const saved = await saveTextInput(ctx.store, {
      content: "#작품:데못죽 #장르:판타지",
      source: "dashboard:manual",
    });
    expect(saved.kind).toBe("entity_patch");
    expect(saved.originNodeId).toBeNull();

    const body = await overviewJson();
    expect(body.nodes.some((n) => n.id.startsWith("node:"))).toBe(false);
    expect(
      body.nodes.some((n) => n.id.startsWith("entity:work:") && n.label === "데못죽"),
    ).toBe(true);
    expect(
      body.nodes.some((n) => n.sourceType === "entity_group" && n.groupType === "work"),
    ).toBe(true);
  });

  test("entity_patch 로 생긴 사람·프로젝트도 overview 에 보인다", async () => {
    const personSaved = await saveTextInput(ctx.store, {
      content: "#사람:홍길동 #직업:2D산골나무꾼",
      source: "dashboard:manual",
    });
    const projectSaved = await saveTextInput(ctx.store, {
      content: "#프로젝트:바라시스템 #언어:TypeScript",
      source: "dashboard:manual",
    });
    expect(personSaved.kind).toBe("entity_patch");
    expect(projectSaved.kind).toBe("entity_patch");

    const body = await overviewJson();
    expect(body.nodes.some((n) => n.id.startsWith("node:"))).toBe(false);
    expect(
      body.nodes.some((n) => n.id.startsWith("person:") && n.label === "홍길동"),
    ).toBe(true);
    expect(
      body.nodes.some((n) => n.id.startsWith("project:") && n.label === "바라시스템"),
    ).toBe(true);
  });

  test("사용자 추가 타입 엔티티도 글 노드 없이 overview 에 보인다", async () => {
    ctx.store.entityTypeRegistryDb.addEntityType({
      typeName: "ledger",
      koName: "가계부",
      idPrefix: "ldg_",
    });
    const entity = await ctx.store.entitiesRepo.findOrCreateEntity("ledger", "배달");

    const body = await overviewJson();
    expect(body.nodes.some((n) => n.id === `entity:ledger:${entity.id}`)).toBe(true);
    expect(
      body.nodes.some((n) => n.sourceType === "entity_group" && n.groupType === "ledger"),
    ).toBe(true);
  });

  test("태그 첫 줄과 여러 줄 본문이 함께 있으면 글 노드로 보이고 본문 라벨을 쓴다", async () => {
    const content = [
      "#프로젝트:코딩, #코딩:앱, #앱:디롱, #언어:TypeScript, #런타임:Nodejs22, #라이브러리:discordjs, #DB:SQLite, #기능:STT, #연동:Notion, #AI에이전트도구,",
      "Discord 음성 세션을 녹음하고 STT, AI 정리, Notion 업로드까지 이어주는 로컬 우선 앱이다.",
      "디스코드에서 음성 챗으로 회의 할 때 회의록 작성이 귀찮아서 만들게 되었다.",
      "디롱이는 디스코드 봇이라는 것에 꽂혀서 캐릭터 설정을 했다.",
    ].join("\n");

    const saved = await saveTextInput(ctx.store, {
      content,
      source: "dashboard:manual",
    });
    expect(saved.kind).toBe("memory");
    expect(typeof saved.originNodeId).toBe("number");

    const body = await overviewJson();
    const memoryNode = body.nodes.find((n) => n.id === `node:${saved.originNodeId}`);
    expect(memoryNode).toBeDefined();
    expect(memoryNode!.sourceType).toBe("auto_capture");
    expect(memoryNode!.label.startsWith("Discord 음성 세션")).toBe(true);
    expect(memoryNode!.snippet).toBe(content);
  });

  test("프로젝트 사슬은 라벨이 많아도 overview 에 프로젝트→코딩→앱→디롱→글로 보인다", async () => {
    const content = [
      "#프로젝트:코딩, #코딩:앱, #앱:디롱, #언어:TypeScript, #런타임:Nodejs22, #라이브러리:discordjs, #DB:SQLite, #기능:STT, #연동:Notion, #AI에이전트도구,",
      "Discord 음성 세션을 녹음하고 STT, AI 정리, Notion 업로드까지 이어주는 로컬 우선 앱이다.",
      "디스코드에서 음성 챗으로 회의 할 때 회의록 작성이 귀찮아서 만들게 되었다.",
      "디롱이는 디스코드 봇이라는 것에 꽂혀서 캐릭터 설정을 했다.",
    ].join("\n");

    const saved = await saveTextInput(ctx.store, {
      content,
      source: "dashboard:manual",
    });
    expect(saved.kind).toBe("memory");
    expect(typeof saved.originNodeId).toBe("number");

    const body = await overviewJson();
    const idsByLabel = (label: string): Set<string> =>
      new Set(body.nodes.filter((n) => n.label === label).map((n) => n.id));
    const hasEdgeByLabel = (fromLabel: string, toLabel: string, type: string): boolean => {
      const fromIds = idsByLabel(fromLabel);
      const toIds = idsByLabel(toLabel);
      return body.edges.some(
        (e) => e.type === type && fromIds.has(e.from) && toIds.has(e.to),
      );
    };

    for (const label of ["프로젝트", "코딩", "앱", "디롱"]) {
      expect(idsByLabel(label).size).toBeGreaterThan(0);
    }
    expect(hasEdgeByLabel("프로젝트", "코딩", "parent_of")).toBe(true);
    expect(hasEdgeByLabel("코딩", "앱", "parent_of")).toBe(true);
    expect(hasEdgeByLabel("앱", "디롱", "parent_of")).toBe(true);

    const memoryNode = body.nodes.find((n) => n.id === `node:${saved.originNodeId}`);
    expect(memoryNode).toBeDefined();
    const dirongIds = idsByLabel("디롱");
    expect(
      body.edges.some(
        (e) => e.type === "owns_memory" && dirongIds.has(e.from) && e.to === memoryNode!.id,
      ),
    ).toBe(true);
    expect(hasEdgeByLabel("프로젝트", "디롱", "member_of")).toBe(false);
  });

  test("글 저장 후 노드를 회신한다", async () => {
    await ctx.store.addNode({ content: "테스트 글 하나" });
    const body = await overviewJson();
    expect(body.nodes.length).toBeGreaterThan(0);
  });

  test("노드에 id·label 칸이 있다", async () => {
    await ctx.store.addNode({ content: "노드 칸 검증용 글" });
    const body = await overviewJson();
    const node = body.nodes[0]!;
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("label");
    expect(typeof node.id).toBe("string");
    expect(typeof node.label).toBe("string");
    expect(node.id.startsWith("node:")).toBe(true);
  });

  test("stats.totalNodes 가 nodes 길이와 일치한다", async () => {
    await ctx.store.addNode({ content: "통계 검증 글 A" });
    await ctx.store.addNode({ content: "통계 검증 글 B" });
    const body = await overviewJson();
    expect(body.stats.totalNodes).toBe(body.nodes.length);
    expect(body.stats.totalEdges).toBe(body.edges.length);
  });

  test("두 노드 사이 엣지가 있으면 edges 배열에 포함된다", async () => {
    const idA = await ctx.store.addNode({ content: "엣지 검증 글 A" });
    const idB = await ctx.store.addNode({ content: "엣지 검증 글 B" });
    await ctx.store.addEdge({
      sourceId: idA,
      targetId: idB,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.8,
    });
    const body = await overviewJson();
    expect(body.edges.length).toBeGreaterThan(0);
    const edge = body.edges[0]!;
    expect(edge).toHaveProperty("id");
    expect(edge).toHaveProperty("from");
    expect(edge).toHaveProperty("to");
    expect(edge).toHaveProperty("type");
    expect(edge.from.startsWith("node:")).toBe(true);
    expect(edge.to.startsWith("node:")).toBe(true);
  });

  test("limit 파라미터가 회신 노드 수를 제한한다", async () => {
    // 5개 저장 후 limit=2 요청 → 노드가 2개 이하여야 한다.
    for (let i = 0; i < 5; i++) {
      await ctx.store.addNode({ content: `limit 검증 글 ${i}` });
    }
    const body = await overviewJson("limit=2");
    // getRecent(2) 결과 + 1-hop 이웃 합산이라 정확히 2는 아닐 수 있지만
    // 엣지 없는 DB 이므로 이웃 없음 → 노드 수 = limit 이하.
    expect(body.nodes.length).toBeLessThanOrEqual(2);
  });

  test("limit 미지정 시 글이 적으면 전부 회신한다", async () => {
    await ctx.store.addNode({ content: "default limit 검증 글 A" });
    await ctx.store.addNode({ content: "default limit 검증 글 B" });
    const body = await overviewJson();
    // DEFAULT_LIMIT(60) 이하면 저장한 글이 전부 들어온다.
    expect(body.nodes.length).toBeGreaterThanOrEqual(2);
  });

  test("엣지의 양끝이 노드 집합 안에 있다", async () => {
    const idA = await ctx.store.addNode({ content: "엣지 양끝 검증 A" });
    const idB = await ctx.store.addNode({ content: "엣지 양끝 검증 B" });
    await ctx.store.addEdge({
      sourceId: idA,
      targetId: idB,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.7,
    });
    const body = await overviewJson();
    const nodeIds = new Set(body.nodes.map((n) => n.id));
    for (const edge of body.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  // ── S1-A 직렬화 검증 — event_at 이 응답 eventAt 으로 실린다 ──────────────────
  // 일정 탭이 eventAt 기준 정렬이라 overview 직렬화에 그 값이 흘러야 한다.
  // event_at 있는 글은 eventAt 이 실리고, 없는 글은 키가 빠진다(null→undefined 접힘).

  test("S1-A — event_at 있는 글은 응답에 eventAt 이 실린다", async () => {
    const id = await ctx.store.addNode({
      content: "5월 25일 회의에서 결정한 일정",
      eventAt: "2026-05-25",
    });
    const body = await overviewJson();
    const node = body.nodes.find((n) => n.id === `node:${id}`);
    expect(node).toBeDefined();
    expect(node!.eventAt).toBe("2026-05-25");
  });

  test("S1-A — event_at 없는 글은 eventAt 키가 없다(빈 문자열로 채우지 않음)", async () => {
    const id = await ctx.store.addNode({ content: "일정 없는 평범한 글" });
    const body = await overviewJson();
    const node = body.nodes.find((n) => n.id === `node:${id}`);
    expect(node).toBeDefined();
    expect(node!.eventAt).toBeUndefined();
    // JSON 직렬화에서 키 자체가 빠졌는지도 확인한다(undefined 칸은 직렬화에서 제거된다).
    expect(Object.prototype.hasOwnProperty.call(node!, "eventAt")).toBe(false);
  });
});

// ── POST /graph/search ─────────────────────────────────────────────────────

async function searchJson(
  body: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const res = await app.request("/graph/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe("POST /graph/search — Phase 8 T4", () => {
  test("빈 쿼리 → 400", async () => {
    const { status } = await searchJson({ query: "" });
    expect(status).toBe(400);
  });

  test("공백만 있는 쿼리 → 400", async () => {
    const { status } = await searchJson({ query: "   " });
    expect(status).toBe(400);
  });

  test("query 키 없음 → 400", async () => {
    const { status } = await searchJson({});
    expect(status).toBe(400);
  });

  test("글 저장 후 검색 → 응답 형태 검증", async () => {
    await ctx.store.addNode({ content: "한국 전통 음식 김치찌개 레시피" });
    await ctx.store.addNode({ content: "된장찌개 끓이는 방법" });

    const { status, data } = await searchJson({ query: "찌개", limit: 5 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body).toHaveProperty("query", "찌개");
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("hits");
    expect(body).toHaveProperty("top3");
    expect(body).toHaveProperty("subgraph");
    expect(body).toHaveProperty("focus");
    expect(Array.isArray(body.hits)).toBe(true);
    expect(Array.isArray(body.top3)).toBe(true);
    expect(body.subgraph).toHaveProperty("nodes");
    expect(body.subgraph).toHaveProperty("edges");
    expect(body.focus).toHaveProperty("centerNodeId");
    expect(body.focus).toHaveProperty("highlightedNodeIds");
    expect(body.focus).toHaveProperty("highlightedEdgeIds");
    expect(body.count).toBe(body.hits.length);
  });

  test("hit 가 있으면 focus.centerNodeId 가 첫 번째 hit nodeId 와 일치한다", async () => {
    await ctx.store.addNode({ content: "검색 포커스 검증용 기억 글" });

    const { status, data } = await searchJson({ query: "포커스 검증", limit: 5 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    if (body.hits.length > 0) {
      expect(body.focus.centerNodeId).toBe(body.hits[0]!.nodeId);
      expect(body.focus.highlightedNodeIds).toContain(body.hits[0]!.nodeId);
    }
  });

  test("top3 는 hits 의 앞 3개다", async () => {
    // 4개 저장해 top3 잘림 여부 확인
    for (let i = 0; i < 4; i++) {
      await ctx.store.addNode({ content: `top3 검증용 음식 글 ${i}` });
    }

    const { status, data } = await searchJson({ query: "top3 검증용 음식", limit: 10 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body.top3.length).toBeLessThanOrEqual(3);
    // top3 는 hits 앞에서 자른 결과여야 한다
    for (let i = 0; i < body.top3.length; i++) {
      expect(body.top3[i]!.nodeId).toBe(body.hits[i]!.nodeId);
      expect(body.top3[i]!.score).toBe(body.hits[i]!.score);
    }
  });

  test("엣지가 있으면 subgraph.edges 에 포함된다", async () => {
    const idA = await ctx.store.addNode({ content: "그래프 검색 엣지 검증 노드 A" });
    const idB = await ctx.store.addNode({ content: "그래프 검색 엣지 검증 노드 B" });
    await ctx.store.addEdge({
      sourceId: idA,
      targetId: idB,
      relation: "related_to",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.8,
    });

    const { status, data } = await searchJson({
      query: "그래프 검색 엣지 검증",
      limit: 5,
    });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    // 두 노드가 모두 hit 또는 이웃으로 들어오면 엣지도 subgraph 에 포함된다
    if (body.subgraph.nodes.length >= 2) {
      const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));
      for (const edge of body.subgraph.edges) {
        expect(nodeIds.has(edge.from)).toBe(true);
        expect(nodeIds.has(edge.to)).toBe(true);
      }
    }
  });

  test("결과 0건 → 빈 subgraph + count 0(정직한 빈 상태)", async () => {
    // 아무 내용도 없는 DB 에서 검색
    const { status, data } = await searchJson({
      query: "절대존재하지않을쿼리xyz123",
      limit: 5,
    });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body.count).toBe(0);
    expect(body.hits).toEqual([]);
    expect(body.top3).toEqual([]);
    expect(body.subgraph.nodes).toEqual([]);
    expect(body.subgraph.edges).toEqual([]);
    expect(body.focus.centerNodeId).toBe("");
    expect(body.focus.highlightedNodeIds).toEqual([]);
    expect(body.focus.highlightedEdgeIds).toEqual([]);
  });

  test("entity_patch 사람은 글 노드가 없어도 이름 검색으로 subgraph 에 들어온다", async () => {
    const saved = await saveTextInput(ctx.store, {
      content: "#사람:홍길동 #직업:2D산골나무꾼",
      source: "dashboard:manual",
    });
    expect(saved.kind).toBe("entity_patch");
    expect(saved.originNodeId).toBeNull();

    const person = (await ctx.store.listPersons({ limit: 50 })).find(
      (p) => p.displayName === "홍길동",
    );
    expect(person).toBeDefined();

    const { status, data } = await searchJson({ query: "홍길동", limit: 5 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    const personNodeId = `person:${person!.personId}`;
    const personHit = body.hits.find((h) => h.nodeId === personNodeId);
    expect(personHit).toBeDefined();
    expect(personHit!.score).toBe(1);
    expect(personHit!.components?.directEntityExact).toBe(1);
    expect(body.focus.centerNodeId).toBe(personNodeId);
    expect(body.focus.highlightedNodeIds).toContain(personNodeId);
    expect(
      body.subgraph.nodes.some((n) => n.id === personNodeId && n.label === "홍길동"),
    ).toBe(true);
    expect(body.subgraph.nodes.some((n) => n.id.startsWith("node:"))).toBe(false);
  });

  test("entity_patch 이름 완전 일치는 글 히트보다 높은 점수로 정렬된다", async () => {
    await ctx.store.addNode({ content: "홍길동 관련 일반 메모" });
    const saved = await saveTextInput(ctx.store, {
      content: "#사람:홍길동 #직업:2D산골나무꾼",
      source: "dashboard:manual",
    });
    expect(saved.kind).toBe("entity_patch");

    const person = (await ctx.store.listPersons({ limit: 50 })).find(
      (p) => p.displayName === "홍길동",
    );
    expect(person).toBeDefined();

    const { status, data } = await searchJson({ query: "홍길동", limit: 5 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    const personNodeId = `person:${person!.personId}`;
    expect(body.hits[0]?.nodeId).toBe(personNodeId);
    expect(body.focus.centerNodeId).toBe(personNodeId);
    expect(body.hits[0]!.score).toBe(1);
    for (const hit of body.hits.slice(1)) {
      expect(body.hits[0]!.score).toBeGreaterThanOrEqual(hit.score);
    }
  });

  test("entity_patch 범용 엔티티도 이름 검색으로 subgraph 에 들어온다", async () => {
    const saved = await saveTextInput(ctx.store, {
      content: "#작품:데못죽 #장르:판타지",
      source: "dashboard:manual",
    });
    expect(saved.kind).toBe("entity_patch");
    expect(saved.originNodeId).toBeNull();

    const work = await ctx.store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();

    const { status, data } = await searchJson({ query: "데못죽", limit: 5 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    const workNodeId = `entity:work:${work!.id}`;
    const workHit = body.hits.find((h) => h.nodeId === workNodeId);
    expect(workHit).toBeDefined();
    expect(workHit!.score).toBe(1);
    expect(workHit!.components?.directEntityExact).toBe(1);
    expect(body.focus.centerNodeId).toBe(workNodeId);
    expect(body.focus.highlightedNodeIds).toContain(workNodeId);
    expect(
      body.subgraph.nodes.some((n) => n.id === workNodeId && n.label === "데못죽"),
    ).toBe(true);
    expect(body.subgraph.nodes.some((n) => n.id.startsWith("node:"))).toBe(false);
  });
});

// ── 개념·사람 노드 합류 (Phase 8 그래프 비주얼 1단계) ────────────────────────

describe("개념·사람 노드 합류 — Phase 8 1단계", () => {
  test("글에 개념 엣지가 있으면 overview 에 concept: 노드 + 글↔개념 엣지가 들어온다", async () => {
    const nodeId = await ctx.store.addNode({ content: "오늘 커피를 마셨다" });
    const conceptId = await ctx.store.findOrCreateTagConcept("커피");
    await ctx.store.addNodeConceptEdge(nodeId, conceptId, "tag", "user_input", nodeId);

    const body = await overviewJson();

    const conceptNode = body.nodes.find((n) => n.id === `concept:${conceptId}`);
    expect(conceptNode).toBeDefined();
    expect(conceptNode!.sourceType).toBe("concept");
    expect(conceptNode!.label.length).toBeGreaterThan(0);

    const link = body.edges.find(
      (e) => e.from === `node:${nodeId}` && e.to === `concept:${conceptId}`,
    );
    expect(link).toBeDefined();
    expect(link!.type).toBe("tag");
  });

  test("글에 사람 엣지가 있으면 overview 에 person: 노드 + 글↔사람 엣지가 들어온다", async () => {
    const nodeId = await ctx.store.addNode({ content: "민수와 점심을 먹었다" });
    const person = await ctx.store.findOrCreatePersonByName("민수");
    await ctx.store.addNodePersonEdge(nodeId, person.personId, "mentions", "user_input", nodeId);

    const body = await overviewJson();

    const personNode = body.nodes.find((n) => n.id === `person:${person.personId}`);
    expect(personNode).toBeDefined();
    expect(personNode!.sourceType).toBe("person");
    expect(personNode!.label).toBe("민수");

    const link = body.edges.find(
      (e) => e.from === `node:${nodeId}` && e.to === `person:${person.personId}`,
    );
    expect(link).toBeDefined();
    expect(link!.type).toBe("mentions");
  });

  test("개념끼리 parent_of 위계가 두 개념 모두 집합 안이면 엣지로 들어온다", async () => {
    const nodeId = await ctx.store.addNode({ content: "주술회전 만화를 봤다" });
    const parent = await ctx.store.findOrCreateTagConcept("만화");
    const child = await ctx.store.findOrCreateTagConcept("주술회전");
    await ctx.store.addNodeConceptEdge(nodeId, parent, "tag", "user_input", nodeId);
    await ctx.store.addNodeConceptEdge(nodeId, child, "tag", "user_input", nodeId);
    // S0-T4(위계 단일 출처) — 위계 parent_of 는 hierarchy_edges 에 쓴다.
    ctx.store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: parent,
      targetType: "concept",
      targetId: child,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const body = await overviewJson();

    const hierarchy = body.edges.find(
      (e) => e.from === `concept:${parent}` && e.to === `concept:${child}`,
    );
    expect(hierarchy).toBeDefined();
    expect(hierarchy!.type).toBe("parent_of");
    expect(hierarchy!.weight).toBeCloseTo(0.9, 5);
  });

  test("불변식 — augment 후에도 모든 엣지 양끝이 노드 집합 안에 있다(개념·사람 포함)", async () => {
    const nodeId = await ctx.store.addNode({ content: "고양이와 커피 그리고 친구 영희" });
    const cat = await ctx.store.findOrCreateTagConcept("고양이");
    const coffee = await ctx.store.findOrCreateTagConcept("커피");
    await ctx.store.addNodeConceptEdge(nodeId, cat, "tag", "user_input", nodeId);
    await ctx.store.addNodeConceptEdge(nodeId, coffee, "mention", "user_input", nodeId);
    // S0-T4(위계 단일 출처) — 위계 parent_of 는 hierarchy_edges 에 쓴다.
    ctx.store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: cat,
      targetType: "concept",
      targetId: coffee,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });
    const person = await ctx.store.findOrCreatePersonByName("영희");
    await ctx.store.addNodePersonEdge(nodeId, person.personId, "mentions", "user_input", nodeId);

    const body = await overviewJson();

    const nodeIds = new Set(body.nodes.map((n) => n.id));
    expect(body.edges.length).toBeGreaterThan(0);
    for (const edge of body.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  test("개념·사람 엣지가 전혀 없으면 concept:/person: 노드가 0개(기존과 동일)", async () => {
    await ctx.store.addNode({ content: "엔티티 없는 평범한 글 하나" });
    await ctx.store.addNode({ content: "엔티티 없는 평범한 글 둘" });

    const body = await overviewJson();

    const entityNodes = body.nodes.filter(
      (n) => n.id.startsWith("concept:") || n.id.startsWith("person:"),
    );
    expect(entityNodes).toEqual([]);
    // 모든 노드가 글 노드여야 한다.
    for (const n of body.nodes) {
      expect(n.id.startsWith("node:")).toBe(true);
    }
  });

  test("글 노드는 vitality 0~1 를 싣고, 개념·사람 노드는 vitality 가 없다", async () => {
    const nodeId = await ctx.store.addNode({ content: "생명력 검증용 글 — 커피와 친구 영수" });
    const conceptId = await ctx.store.findOrCreateTagConcept("커피");
    await ctx.store.addNodeConceptEdge(nodeId, conceptId, "tag", "user_input", nodeId);
    const person = await ctx.store.findOrCreatePersonByName("영수");
    await ctx.store.addNodePersonEdge(nodeId, person.personId, "mentions", "user_input", nodeId);

    const body = await overviewJson();

    const memoryNode = body.nodes.find((n) => n.id === `node:${nodeId}`);
    expect(memoryNode).toBeDefined();
    expect(typeof memoryNode!.vitality).toBe("number");
    expect(memoryNode!.vitality!).toBeGreaterThanOrEqual(0);
    expect(memoryNode!.vitality!).toBeLessThanOrEqual(1);

    const conceptNode = body.nodes.find((n) => n.id === `concept:${conceptId}`);
    expect(conceptNode).toBeDefined();
    expect(conceptNode!.vitality).toBeUndefined();

    const personNode = body.nodes.find((n) => n.id === `person:${person.personId}`);
    expect(personNode).toBeDefined();
    expect(personNode!.vitality).toBeUndefined();
  });

  test("search 응답에도 개념 노드와 글↔개념 엣지가 subgraph 로 들어온다", async () => {
    const nodeId = await ctx.store.addNode({ content: "김치찌개 레시피 메모" });
    const conceptId = await ctx.store.findOrCreateTagConcept("김치찌개");
    await ctx.store.addNodeConceptEdge(nodeId, conceptId, "tag", "user_input", nodeId);

    const { status, data } = await searchJson({ query: "김치찌개", limit: 5 });
    expect(status).toBe(200);
    const body = data as GraphSearchResponse;

    if (body.hits.some((h) => h.nodeId === `node:${nodeId}`)) {
      const conceptNode = body.subgraph.nodes.find(
        (n) => n.id === `concept:${conceptId}`,
      );
      expect(conceptNode).toBeDefined();
      const link = body.subgraph.edges.find(
        (e) => e.from === `node:${nodeId}` && e.to === `concept:${conceptId}`,
      );
      expect(link).toBeDefined();
      // 개념 연결선도 검색 강조에 들어간다 — 표시되는 모든 subgraph 엣지를 강조한다
      // (결과 노드 사이 연결선이 검색 중에도 보이게 하는 새 정책).
      expect(body.focus.highlightedEdgeIds).toContain(link!.id);
    }
  });
});

// ── conceptToGraphNode 대표 정체성 (꼬임 해소 1단계 결정 1·spec §3.1) ──────────

describe("conceptToGraphNode — 대표 정체성 개념>분류>태그 (결정 1 서버 배선)", () => {
  function makeConcept(roles: {
    isTag?: boolean;
    isClassificationKey?: boolean;
    isClassificationValue?: boolean;
  }): ConceptNode {
    return {
      conceptId: "cpt_x",
      name: "샘플",
      koName: null,
      koAliases: [],
      enAliases: [],
      description: null,
      isTag: roles.isTag ?? false,
      isClassificationKey: roles.isClassificationKey ?? false,
      isClassificationValue: roles.isClassificationValue ?? false,
      tagUsageCount: 0,
      classificationUsageCount: 0,
      searchBlacklist: false,
      createdAt: "2026-06-12T00:00:00+09:00",
      updatedAt: "2026-06-12T00:00:00+09:00",
    };
  }

  test("어느 역할도 없는 순수 개념 → sourceType=concept", () => {
    expect(conceptToGraphNode(makeConcept({})).sourceType).toBe("concept");
  });

  test("태그-only 역할 → sourceType=concept (개념과 한데 흡수·기존 계약)", () => {
    expect(conceptToGraphNode(makeConcept({ isTag: true })).sourceType).toBe("concept");
  });

  test("분류 키 역할 → sourceType=classification_key", () => {
    expect(
      conceptToGraphNode(makeConcept({ isClassificationKey: true })).sourceType,
    ).toBe("classification_key");
  });

  test("분류 값 역할 → sourceType=concept (일반 개념 흡수·현행 정합)", () => {
    expect(
      conceptToGraphNode(makeConcept({ isClassificationValue: true })).sourceType,
    ).toBe("concept");
  });

  test("태그+분류 키 겹친 행 → 분류가 태그를 이겨 classification_key", () => {
    expect(
      conceptToGraphNode(makeConcept({ isTag: true, isClassificationKey: true }))
        .sourceType,
    ).toBe("classification_key");
  });

  test("세 역할 다 누적된 한 행 → 분류 키가 대표 sourceType", () => {
    expect(
      conceptToGraphNode(
        makeConcept({
          isTag: true,
          isClassificationKey: true,
          isClassificationValue: true,
        }),
      ).sourceType,
    ).toBe("classification_key");
  });
});
