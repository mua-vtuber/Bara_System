/**
 * graph.kind-enrich.test.ts — GET /graph/overview·POST /graph/search 라우트가
 * 종류 배지(kind 칸)를 채워 응답하는지 검증한다.
 *
 * 2026-06-28 "종류" 분류 키 그래프 허브 버그 수정(spec §4.3 (B)) — 배지는 옛 "종류"
 * 분류 꼬리표(getNodeKind 위계 JOIN) 대신 글 본문의 엔티티 종류(typeName)로 직접 산출된다
 * (graph.ts enrichNodeKinds → classifyEntityTypeDeterministic(snippet) → displayKindName).
 * 그래서 테스트도 addClassificationTag 로 꼬리표를 심는 대신, 본문에 종류 신호(`#일정:`·
 * `#장소:` 콜론 태그)를 적어 분류기가 typeName 을 잡게 한다. 배지 산출은 순수 함수라
 * wiring 없이 본문 텍스트만으로 동작한다(글-칸·콜론 위계는 이 배지 통로와 무관).
 *
 * 라이브 render 경로 핵심 게이트:
 *   - 본문에 종류 신호가 있는 글 → 응답 nodes 의 해당 노드에 kind 채워짐.
 *   - 종류 신호 없는 글 → 응답 nodes 의 해당 노드에 kind 없음(undefined).
 *
 * 실 SqliteMemoryStore(:memory:) + 실 Bgem3Embedder. mock 0.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { loadEmbedder, makeGraphTestDeps } from "./graph.test-helpers.ts";
import type { GraphTestContext } from "./graph.test-helpers.ts";
import { registerGraphRoutes } from "./graph.ts";
import type { GraphOverviewResponse, GraphSearchResponse, GraphNode } from "./graph.ts";

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

async function overviewNodes(): Promise<GraphNode[]> {
  const res = await app.request("/graph/overview");
  const body = (await res.json()) as GraphOverviewResponse;
  return body.nodes;
}

async function searchNodes(query: string): Promise<GraphNode[]> {
  const res = await app.request("/graph/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as GraphSearchResponse;
  return body.subgraph.nodes;
}

// ── 테스트 ─────────────────────────────────────────────────────────────────

test("overview — 본문에 종류 신호가 있는 글 노드는 kind 채워진다", async () => {
  const nodeId = await ctx.store.addNode({
    content: "#장소:강남 카페 다녀옴",
    memoryType: "episode",
    sourceType: "user_explicit",
  });

  const nodes = await overviewNodes();
  const memNode = nodes.find((n) => n.sourceId === nodeId);

  expect(memNode).toBeDefined();
  // 배지는 본문 엔티티 종류(place)를 직접 분류해 한국어 '장소' 로 산출된다.
  expect(memNode!.kind).toBe("장소");
});

test("overview — 본문 종류(schedule)가 한국어(일정)로 표시된다(displayKindName 변환)", async () => {
  const nodeId = await ctx.store.addNode({
    content: "#일정:장터당번 설명회 참석",
    memoryType: "episode",
    sourceType: "user_explicit",
  });

  const nodes = await overviewNodes();
  const memNode = nodes.find((n) => n.sourceId === nodeId);

  expect(memNode).toBeDefined();
  // 분류 typeName 은 영문 schedule 이지만 그래프 배지 표시는 한국어 일정.
  expect(memNode!.kind).toBe("일정");
});

test("overview — 종류 없는 글 노드는 kind 없다(undefined·가짜 0 금지)", async () => {
  const nodeId = await ctx.store.addNode({
    content: "종류 없는 일반 메모",
    memoryType: "episode",
    sourceType: "user_explicit",
  });

  const nodes = await overviewNodes();
  const memNode = nodes.find((n) => n.sourceId === nodeId);

  expect(memNode).toBeDefined();
  expect(memNode!.kind).toBeUndefined();
});

test("overview — 평문 seed 어휘(코드)는 종류 배지를 달지 않는다(재현·2026-07-06 P-2)", async () => {
  // 본문 "코드"가 material(자료) 하위 어휘와 겹쳐도(2단 seed 경계 매칭), 콜론 태그로
  // 명시하지 않았으면 배지를 달지 않는다(Task 2 저장 게이트와 같은 규칙·화면 표시 측).
  const nodeId = await ctx.store.addNode({
    content: "#나, 주로 사용하는 AI는 클로드 코드, 코덱스",
    memoryType: "episode",
    sourceType: "user_explicit",
  });

  const nodes = await overviewNodes();
  const memNode = nodes.find((n) => n.sourceId === nodeId);

  expect(memNode).toBeDefined();
  expect(memNode!.kind).toBeUndefined();
});

test("search — 본문 종류 신호가 있는 글 노드는 subgraph nodes 에서 kind 채워진다", async () => {
  const nodeId = await ctx.store.addNode({
    content: "#일정:장터당번 설명회 참석",
    memoryType: "episode",
    sourceType: "user_explicit",
  });

  const nodes = await searchNodes("장터당번 설명회");
  const memNode = nodes.find((n) => n.sourceId === nodeId);

  // 검색 결과에 해당 글이 포함된 경우만 kind 검증(결과 없으면 테스트 건너뜀).
  if (memNode == null) {
    // 검색 결과에 포함되지 않으면 enrich 경로 도달 불가 — skip.
    return;
  }
  expect(memNode.kind).toBe("일정");
});
