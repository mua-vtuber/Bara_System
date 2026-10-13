/**
 * graph.integration.test.ts — Phase 8 T12 통합 + 불변식 가드
 *
 * 검증 항목:
 *   1. happy path: 글 저장 → GET /graph/overview 노드 수 > 0
 *      → POST /graph/search 응답 형태 + focus 정합 검증.
 *   2. 기존 화면 회귀 0: 같은 app 에 registerStatsRoutes·registerArchiveRoutes
 *      도 등록했을 때 /stats · /archive 가 200 을 반환한다.
 *   3. focus.centerNodeId 가 hits[0].nodeId 와 일치하는지 (hit 있을 때만).
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
import { registerGraphRoutes, OWNS_MEMORY_EDGE_TYPE } from "./graph.ts";
import type { GraphOverviewResponse, GraphSearchResponse } from "./graph.ts";
import { registerStatsRoutes } from "./stats.ts";
import { registerArchiveRoutes } from "./archive.ts";

// ── embedder 한 번 로드해 테스트 전체 공유 ────────────────────────────────────
beforeAll(async () => {
  await loadEmbedder();
});

afterAll(() => {});

let ctx: GraphTestContext;
let app: Hono;

beforeEach(async () => {
  ctx = await makeGraphTestDeps();
  app = new Hono();
  // 그래프 라우트
  registerGraphRoutes(app, ctx.deps);
  // 기존 라우트 — 회귀 가드용 (staticDir 미주입 = 정적 서빙 비활성, /stats 은 가동)
  registerStatsRoutes(app, ctx.deps);
  registerArchiveRoutes(app, ctx.deps);
});

afterEach(() => {
  ctx.close();
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

async function overviewJson(): Promise<GraphOverviewResponse> {
  const res = await app.request("/graph/overview");
  expect(res.status).toBe(200);
  return res.json() as Promise<GraphOverviewResponse>;
}

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

// ── happy-path 통합 ───────────────────────────────────────────────────────────

describe("Phase 8 T12 — 통합 happy path", () => {
  test("글 저장 후 overview 에 노드가 있다", async () => {
    await ctx.store.addNode({ content: "통합 검증용 글 하나" });
    await ctx.store.addNode({ content: "통합 검증용 글 둘" });

    const ov = await overviewJson();
    expect(ov.nodes.length).toBeGreaterThan(0);
    expect(ov.stats.totalNodes).toBe(ov.nodes.length);
  });

  test("overview + search 형태 정합 — hits>0 이면 focus.centerNodeId=hits[0].nodeId", async () => {
    await ctx.store.addNode({ content: "검색 통합 검증 기억 A" });
    await ctx.store.addNode({ content: "검색 통합 검증 기억 B" });
    await ctx.store.addNode({ content: "검색 통합 검증 기억 C" });

    const ov = await overviewJson();
    expect(ov.nodes.length).toBeGreaterThan(0);

    const { status, data } = await searchJson({ query: "검색 통합 검증", limit: 10 });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body).toHaveProperty("subgraph");
    expect(body).toHaveProperty("hits");
    expect(body).toHaveProperty("focus");
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.subgraph).toHaveProperty("nodes");
    expect(body.subgraph).toHaveProperty("edges");
    expect(body.focus).toHaveProperty("centerNodeId");
    expect(body.focus).toHaveProperty("highlightedNodeIds");
    expect(body.count).toBe(body.hits.length);

    // hit 가 있으면 focus.centerNodeId 가 첫 번째 hit nodeId 와 일치한다
    if (body.hits.length > 0) {
      expect(body.focus.centerNodeId).toBe(body.hits[0]!.nodeId);
      expect(body.focus.highlightedNodeIds).toContain(body.hits[0]!.nodeId);
    }
  });

  test("결과 없는 쿼리 → 빈 subgraph + focus 비어 있음", async () => {
    const { status, data } = await searchJson({
      query: "절대존재하지않을쿼리xyz999통합",
      limit: 5,
    });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body.count).toBe(0);
    expect(body.hits).toEqual([]);
    expect(body.subgraph.nodes).toEqual([]);
    expect(body.focus.centerNodeId).toBe("");
  });
});

// ── 기존 화면 회귀 0 ──────────────────────────────────────────────────────────

describe("Phase 8 T12 — 기존 화면 회귀 0", () => {
  test("GET /stats — 200 (그래프 라우트 추가 후에도 200)", async () => {
    const res = await app.request("/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    // 빈 DB 이지만 stats 형태는 있어야 한다 (getStats → totalMemories)
    expect(body).toHaveProperty("totalMemories");
  });

  test("GET /archive — 200 (그래프 라우트 추가 후에도 200)", async () => {
    const res = await app.request("/archive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 빈 DB 이므로 archive 배열은 비어 있지만 키는 있어야 한다
    expect(body).toHaveProperty("archive");
    expect(Array.isArray(body.archive)).toBe(true);
  });

  test("GET /graph/overview 와 GET /stats 를 같은 app 에서 연속 호출해도 충돌 없음", async () => {
    await ctx.store.addNode({ content: "회귀 가드 검증용 글" });

    const ovRes = await app.request("/graph/overview");
    const statsRes = await app.request("/stats");

    expect(ovRes.status).toBe(200);
    expect(statsRes.status).toBe(200);
  });
});

// ── D6 — idle/search 두 라우트 owns_memory 회신 가드 (Task 5) ──────────────────
//
// 단계 1.7(프로젝트 → 글 owns_memory 허브)은 augmentWithEntities 안에 들어 있고,
// overview·search 두 라우트가 그 함수를 같이 호출한다. 그래서 두 경로 모두
// 자동으로 owns_memory 엣지를 회신한다. 이 묶음은 그 사실을 라우트 레벨에서
// 확정한다 — 프로덕션 코드는 한 줄도 안 바꾸고, 실제 store 에 실제 글·프로젝트
// 행을 넣은 뒤 app.request 로 라우트를 진짜 호출해 응답 엣지를 들여다본다.

/**
 * 범용 entities(type_name='project')에 프로젝트 본체 행 하나를 직접 넣는다. 단계4
 * T7'b 가 프로젝트 본체를 전용 projects 에서 entities 로 옮겼고 T9'(v30)이 옛 projects
 * 를 DROP 했으므로, getProject·owns_memory 통로가 읽는 entities 에 넣어야 한다.
 * findOrCreateProject 는 임베딩 로드를 요구해 테스트 셋업에서 raw SQL 을 쓴다.
 */
function insertProjectRow(
  ctx: GraphTestContext,
  projectId: string,
  name: string,
): void {
  ctx.db
    .prepare(
      `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
       VALUES (?, 'project', ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    )
    .run(projectId, name);
}

describe("D6 — idle/search owns_memory 라우트 회신 가드 (Task 5)", () => {
  test("GET /graph/overview 응답 edges 에 프로젝트→글 owns_memory 엣지가 있다", async () => {
    insertProjectRow(ctx, "prj_zombie", "좀비 로그라이크");
    // 같은 프로젝트 소속 글 셋. addNode 가 임베딩까지 채워 실제 글로 들어간다.
    await ctx.store.addNode({
      content: "좀비 로그라이크 스토리 첫 단락",
      project_id: "prj_zombie",
    });
    await ctx.store.addNode({
      content: "좀비 로그라이크 스토리 둘째 단락",
      project_id: "prj_zombie",
    });
    await ctx.store.addNode({
      content: "좀비 로그라이크 스토리 셋째 단락",
      project_id: "prj_zombie",
    });

    const ov = await overviewJson();

    const ownsEdges = ov.edges.filter(
      (e) => e.type === OWNS_MEMORY_EDGE_TYPE,
    );
    expect(ownsEdges.length).toBeGreaterThan(0);
    // 방향 = 프로젝트 → 글. from 은 project: prefix, to 는 글 노드.
    const projectKey = "project:prj_zombie";
    for (const e of ownsEdges) {
      expect(e.from).toBe(projectKey);
      expect(e.to.startsWith("node:")).toBe(true);
    }
    // 양끝 노드가 둘 다 응답 nodes 안에 있어야 한다(엣지 불변식).
    const nodeIds = new Set(ov.nodes.map((n) => n.id));
    for (const e of ownsEdges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
    // 프로젝트 노드 자체도 응답에 있다(허브).
    expect(nodeIds.has(projectKey)).toBe(true);
  });

  test("POST /graph/search 응답 subgraph.edges 에도 같은 owns_memory 엣지가 있다", async () => {
    insertProjectRow(ctx, "prj_search", "검색 프로젝트");
    await ctx.store.addNode({
      content: "검색 가드 프로젝트 글 알파 내용",
      project_id: "prj_search",
    });
    await ctx.store.addNode({
      content: "검색 가드 프로젝트 글 베타 내용",
      project_id: "prj_search",
    });
    await ctx.store.addNode({
      content: "검색 가드 프로젝트 글 감마 내용",
      project_id: "prj_search",
    });

    const { status, data } = await searchJson({
      query: "검색 가드 프로젝트 글",
      limit: 10,
    });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body.hits.length).toBeGreaterThan(0);

    const ownsEdges = body.subgraph.edges.filter(
      (e) => e.type === OWNS_MEMORY_EDGE_TYPE,
    );
    expect(ownsEdges.length).toBeGreaterThan(0);

    const projectKey = "project:prj_search";
    for (const e of ownsEdges) {
      expect(e.from).toBe(projectKey);
      expect(e.to.startsWith("node:")).toBe(true);
    }
    // 양끝이 subgraph.nodes 안.
    const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));
    for (const e of ownsEdges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
    expect(nodeIds.has(projectKey)).toBe(true);
  });

  test("search focus 강조는 글 hit(+묶음)만 — owns_memory 엣지·프로젝트 노드는 강조 별도 미포함", async () => {
    insertProjectRow(ctx, "prj_focus", "포커스 프로젝트");
    await ctx.store.addNode({
      content: "포커스 가드 프로젝트 글 하나 내용",
      project_id: "prj_focus",
    });
    await ctx.store.addNode({
      content: "포커스 가드 프로젝트 글 둘 내용",
      project_id: "prj_focus",
    });
    await ctx.store.addNode({
      content: "포커스 가드 프로젝트 글 셋 내용",
      project_id: "prj_focus",
    });

    const { status, data } = await searchJson({
      query: "포커스 가드 프로젝트 글",
      limit: 10,
    });
    expect(status).toBe(200);

    const body = data as GraphSearchResponse;
    expect(body.hits.length).toBeGreaterThan(0);

    const projectKey = "project:prj_focus";
    const hitNodeIds = new Set(body.hits.map((h) => h.nodeId));

    // (1) 프로젝트 노드는 subgraph 에는 있되 focus 강조 노드엔 안 들어간다.
    const subNodeIds = new Set(body.subgraph.nodes.map((n) => n.id));
    expect(subNodeIds.has(projectKey)).toBe(true);
    expect(body.focus.highlightedNodeIds).not.toContain(projectKey);

    // (2) focus 강조 노드는 글 hit + 묶음(group:) 노드만 — 그 외 노드는 없다.
    for (const id of body.focus.highlightedNodeIds) {
      const isHit = hitNodeIds.has(id);
      const isGroup = id.startsWith("group:");
      expect(isHit || isGroup).toBe(true);
    }

    // (3) 최종 subgraph 에 살아남은 엣지는 모두 focus 강조에 들어간다(owns_memory 포함) —
    //     결과 노드 사이 연결선이 검색 중에도 보이게 하는 새 정책.
    const ownsEdges = body.subgraph.edges.filter(
      (e) => e.type === OWNS_MEMORY_EDGE_TYPE,
    );
    expect(ownsEdges.length).toBeGreaterThan(0);
    for (const e of ownsEdges) {
      expect(body.focus.highlightedEdgeIds).toContain(e.id);
    }
  });
});
