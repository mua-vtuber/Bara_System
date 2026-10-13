/**
 * classification-key-graph-hub.test.ts — "종류" 분류 키 그래프 허브 버그 수정 회귀 안전망
 * (2026-06-28 spec docs/decisions/2026-06-28-classification-key-graph-hub-fix-spec.md · S0).
 *
 * 이 수정의 핵심 세 동작을 라우트 레벨로 잠근다(spec §9 완료 기준·§7 함정 기계 증명):
 *
 *   1. 허브 제거(완료 기준 1) — 글에 잔존 "종류" 분류 꼬리표가 직접 심겨 있어도, 그래프
 *      응답 노드 집합에 "종류" 메타 키 개념 노드가 안 뜬다(폼 폴백·잔존 데이터 방어·§4.4).
 *   2. 콜론 위계 분류 키 보존(완료 기준 2·함정 1) — 사용자가 `#작품:데못죽` 으로 만든
 *      "작품" 유리조각(classification_key) 개념 노드는 그래프에 그대로 남는다(과삭제 0).
 *   3. 종류 배지 보존(완료 기준 3·함정 2) — place 글·일정 글의 종류 배지가 검색·그래프
 *      결과에 그대로 뜬다. 자동 "종류" 꼬리표 없이 글 본문 엔티티 종류(typeName)로 직접
 *      산출되므로 배지가 사라지지 않는다.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder + 실제 입력 통로(wireHashtagEntities →
 * wireEntityPlacement). Mock 0(CLAUDE.md "DB/임베딩 의존 모듈은 실 구현체와 통합 검증").
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
import { registerGraphRoutes, augmentWithEntities } from "./graph.ts";
import { registerSearchRoutes } from "./search.ts";
import type {
  GraphOverviewResponse,
  GraphNode,
  GraphEdge,
} from "./graph.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { KIND_CATEGORY } from "../../memory/glob-field-apply.ts";

beforeAll(async () => {
  await loadEmbedder();
});

afterAll(() => {});

let ctx: GraphTestContext;
let app: Hono;

beforeEach(async () => {
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
  ctx = await makeGraphTestDeps();
  app = new Hono();
  registerGraphRoutes(app, ctx.deps);
  registerSearchRoutes(app, ctx.deps);
});

afterEach(() => {
  ctx.close();
});

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

/** 입력 한 줄을 실제 통로로 처리한다(텍스트 ingest 의 wiring 묶음 재현). */
async function processInput(content: string): Promise<number> {
  const nodeId = await ctx.store.addNode({
    content,
    sourceType: "auto_capture",
    author: "owner",
    platform: "dashboard:manual",
  });
  await wireHashtagEntities(ctx.store, nodeId, content);
  await wireEntityPlacement(ctx.store, nodeId, content, { llm: null });
  return nodeId;
}

async function overviewNodes(): Promise<GraphNode[]> {
  const res = await app.request("/graph/overview");
  expect(res.status).toBe(200);
  const body = (await res.json()) as GraphOverviewResponse;
  return body.nodes;
}


interface SearchResult {
  id: number;
  kind: string | null;
}

async function searchResults(query: string): Promise<SearchResult[]> {
  const res = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: SearchResult[] };
  return body.results;
}

/** 노드 라벨이 주어진 텍스트인 그래프 노드를 찾는다(개념 노드는 sourceId 없음). */
function findByLabel(nodes: GraphNode[], label: string): GraphNode | undefined {
  return nodes.find((n) => n.label === label);
}

// ── 1. 허브 제거 — 잔존 "종류" 꼬리표가 있어도 메타 키 노드는 안 뜬다 (§4.4·완료 기준 1) ──

describe('허브 제거 — "종류" 메타 키 노드 그래프 필터', () => {
  test('잔존 "종류" 분류 꼬리표가 직접 심긴 글이 있어도 그래프 노드에 "종류" 메타 키 노드가 없다', async () => {
    // 빈 DB 가 아닌 환경·폼 드롭다운 폴백으로 들어온 잔존 "종류" 꼬리표를 직접 재현한다.
    const nodeId = await processInput("강남 카페에서 커피");
    await ctx.store.addClassificationTag(nodeId, KIND_CATEGORY, "장소", "user_input", nodeId);

    const nodes = await overviewNodes();
    // "종류" 라는 라벨의 노드가 그래프에 없어야 한다(허브 데이터가 화면에서 걸러짐).
    const kindMetaNode = findByLabel(nodes, KIND_CATEGORY);
    expect(kindMetaNode).toBeUndefined();
  });

  test('두 글이 서로 다른 종류로 잔존 꼬리표를 가져도 공유 "종류" 허브 노드가 안 생긴다', async () => {
    const placeNode = await processInput("강남 카페 방문");
    await ctx.store.addClassificationTag(placeNode, KIND_CATEGORY, "장소", "user_input", placeNode);
    const personNode = await processInput("철수랑 만남");
    await ctx.store.addClassificationTag(personNode, KIND_CATEGORY, "사람", "user_input", personNode);

    const nodes = await overviewNodes();
    expect(findByLabel(nodes, KIND_CATEGORY)).toBeUndefined();
    // "종류" 메타 키를 from/to 로 가진 엣지도 없어야 한다(허브 연결선 0).
    const res = await app.request("/graph/overview");
    const body = (await res.json()) as GraphOverviewResponse;
    const kindNodeIds = new Set(
      nodes.filter((n) => n.label === KIND_CATEGORY).map((n) => n.id),
    );
    const hubEdges = body.edges.filter(
      (e) => kindNodeIds.has(e.from) || kindNodeIds.has(e.to),
    );
    expect(hubEdges.length).toBe(0);
  });
});

// ── 2. 콜론 위계 분류 키 보존 — 과삭제 0 (§3·함정 1·완료 기준 2) ──────────────

describe("콜론 위계 분류 키(작품) 유리조각 노드 보존", () => {
  test('augmentWithEntities 가 "작품" 분류 키(classification_key) 개념 노드를 그래프에 합류시킨다(과삭제 0·함정 1)', async () => {
    // graph-augment 를 직접 호출해 묶음 노드(buildGroupNodes) 변환 *전* 단계를 본다 —
    // 이게 "종류" 메타 키 필터가 콜론 분류 키를 안 지웠음을 정확히 증명하는 지점이다.
    // 라우트 overview 는 "작품" 을 entity_group 묶음 노드로 한 번 더 변환하므로 augment
    // 단계가 분류 키 보존의 진짜 게이트다(is_classification_key 전체 제외였다면 여기서 사라짐).
    const nodeId = await processInput("#작품:데못죽 재밌게 봤다");
    const nodeById = new Map<string, GraphNode>();
    nodeById.set(`node:${nodeId}`, {
      id: `node:${nodeId}`,
      sourceId: nodeId,
      sourceType: "auto_capture",
      label: "#작품:데못죽 재밌게 봤다",
      snippet: "#작품:데못죽 재밌게 봤다",
    });
    const edgeSet = new Map<string, GraphEdge>();
    await augmentWithEntities(ctx.store, nodeById, edgeSet);

    // "작품" 분류 키 개념 노드가 살아남아야 한다(classification_key = 유리조각 시각).
    const workKeyNode = [...nodeById.values()].find(
      (n) => n.label === "작품" && n.sourceType === "classification_key",
    );
    expect(workKeyNode).toBeDefined();
  });

  test('라우트 overview 응답에도 "작품" 노드가 그대로 보인다(허브 필터에 안 걸림)', async () => {
    await processInput("#작품:데못죽 재밌게 봤다");

    const nodes = await overviewNodes();
    // 라우트는 "작품" 을 묶음(entity_group) 으로 표현하지만, 어떤 형태로든 "작품" 라벨
    // 노드가 그래프에 남아 있어야 한다("종류" 처럼 통째로 사라지면 안 됨).
    const workNode = findByLabel(nodes, "작품");
    expect(workNode).toBeDefined();
  });
});

// ── 3. 종류 배지 보존 — 자동 꼬리표 없이도 배지가 뜬다 (§4.3·함정 2·완료 기준 3) ──

describe("종류 배지 보존 — 본문 typeName 직접 산출", () => {
  test("일정 글은 검색 결과에 종류 배지 '일정' 이 뜬다(꼬리표 없이)", async () => {
    const nodeId = await processInput("#일정:장터당번 설명회 참석");

    // 자동 "종류" 꼬리표가 안 심겼는지 먼저 확인한다(S1 — 허브 데이터 출처 제거).
    expect(ctx.store.getNodeKind(nodeId)).toBeNull();

    const results = await searchResults("장터당번 설명회");
    const hit = results.find((r) => r.id === nodeId);
    expect(hit).toBeDefined();
    // 배지는 본문 엔티티 종류(schedule)로 직접 산출돼 한국어 '일정' 으로 뜬다.
    expect(hit!.kind).toBe("일정");
  });

  test("장소 글은 그래프 overview 노드에 종류 배지 '장소' 가 뜬다(꼬리표 없이)", async () => {
    const nodeId = await processInput("#장소:한빛의원 다녀옴");
    expect(ctx.store.getNodeKind(nodeId)).toBeNull();

    // overview 는 getRecent 로 방금 저장한 글을 결정적으로 시드에 넣어, 검색 점수에 의존하던
    // soft skip 없이 배지를 단언한다(같은 enrichNodeKinds 경로·일정 테스트와 동형).
    const nodes = await overviewNodes();
    const memNode = nodes.find((n) => n.sourceId === nodeId);
    expect(memNode).toBeDefined();
    // 배지는 본문 엔티티 종류(place)로 직접 산출돼 한국어 '장소' 로 뜬다.
    expect(memNode!.kind).toBe("장소");
  });

  test("일정 글은 그래프 overview 노드에 종류 배지 '일정' 이 뜬다(꼬리표 없이)", async () => {
    const nodeId = await processInput("#일정:장터당번 설명회 참석");
    expect(ctx.store.getNodeKind(nodeId)).toBeNull();

    const nodes = await overviewNodes();
    const memNode = nodes.find((n) => n.sourceId === nodeId);
    expect(memNode).toBeDefined();
    expect(memNode!.kind).toBe("일정");
  });

  test("종류 신호 없는 일반 글은 배지가 없다(정직한 빈 상태·가짜 0 금지)", async () => {
    const nodeId = await processInput("그냥 평범한 메모 한 줄");

    const nodes = await overviewNodes();
    const memNode = nodes.find((n) => n.sourceId === nodeId);
    expect(memNode).toBeDefined();
    expect(memNode!.kind).toBeUndefined();
  });
});
