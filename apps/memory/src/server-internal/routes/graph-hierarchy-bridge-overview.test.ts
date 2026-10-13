/**
 * graph-hierarchy-bridge-overview.test.ts — /graph/overview 위계 다리 복원 통합 재현
 * (branch plaintext-auto-inference-scope Task 4).
 *
 * graph-relation-edges-overview-e2e.test.ts 와 같은 실 라우트 통합 양식(실 Hono app +
 * registerGraphRoutes + makeGraphTestDeps + 실제 wireHashtagEntities/wireEntityPlacement
 * 입력 통로)으로, `/graph/overview` 응답에 콜론 사슬 가운데 다리 개념 노드(동물·고양이 /
 * 가족·둘째)와 그 사이 parent_of 위계선이 실제로 뜨는지 확인한다.
 *
 * 이 파일의 assertion 은 실 HTTP 라우트를 통과하므로 graph.ts 배선(이번 Task 4 변경)
 * 전엔 일부 red 일 수 있으나, 그 red/green 전환은 부수 확인일 뿐이다 — 함수 단위 테스트
 * (graph-hierarchy-bridge.test.ts)가 이 태스크의 결정적 게이트다(TDD red→green 은 그쪽에서
 * "모듈 부재" 컴파일 실패로 이미 확정된다).
 *
 * mock 클래스 0 — 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. 운영 DB 무접촉.
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
import type { GraphOverviewResponse } from "./graph.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

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
});

afterEach(() => {
  ctx.close();
});

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

async function overview(): Promise<GraphOverviewResponse> {
  const res = await app.request("/graph/overview");
  expect(res.status).toBe(200);
  return (await res.json()) as GraphOverviewResponse;
}

function labelSet(body: GraphOverviewResponse): Set<string> {
  return new Set(body.nodes.map((n) => n.label));
}

/** 응답 노드 라벨 이름으로 parent_of 엣지가 있는지 확인한다(id 는 매 실행 랜덤이라 라벨로 매칭). */
function hasParentOfBetween(
  body: GraphOverviewResponse,
  fromLabel: string,
  toLabel: string,
): boolean {
  const labelById = new Map<string, string>(body.nodes.map((n) => [n.id, n.label]));
  return body.edges.some(
    (e) =>
      e.type === "parent_of" &&
      labelById.get(e.from) === fromLabel &&
      labelById.get(e.to) === toLabel,
  );
}

describe("/graph/overview — 콜론 사슬 가운데 다리 노드 복원(standalone 위계 합류)", () => {
  test("생물 사슬 — 동물·고양이 다리 노드 + 생물→동물→고양이→얼룩이 사슬이 응답에 뜬다", async () => {
    await processInput("#생물:동물 #동물:고양이 #고양이:얼룩이");

    const body = await overview();
    const labels = labelSet(body);

    expect(labels.has("동물")).toBe(true);
    expect(labels.has("고양이")).toBe(true);

    expect(hasParentOfBetween(body, "생물", "동물")).toBe(true);
    expect(hasParentOfBetween(body, "동물", "고양이")).toBe(true);
    expect(hasParentOfBetween(body, "고양이", "얼룩이")).toBe(true);
  });

  test("배선 게이트(M1) — 정의 글이 최근 60개 창 밖으로 밀려도 standalone 시드로 다리가 복원된다", async () => {
    // 위 "생물 사슬" 테스트는 정의 글 자체가 항상 getRecent(DEFAULT_LIMIT=60) 안에 들어
    // 있어, 첫 augment 패스(콜론 사슬 mention edge)가 이미 다리를 다 그려 놓는다 — 그래서
    // graph.ts:489 의 attachStandaloneHierarchyBridges 배선을 지워도 green 으로 남아
    // 진짜 배선 회귀를 못 잡는다. 정의 글 뒤에 무관한 noise 글을 DEFAULT_LIMIT 개보다
    // 많이 넣어 정의 글을 "최근 60개" 창 밖으로 밀어내면(id DESC 정렬 — getRecent 는
    // created_at DESC, id DESC), 첫 augment 패스는 정의 글을 못 보고 creature 엔티티
    // "얼룩이"는 addStandaloneEntitySeeds 를 통한 standalone 시드로만 오버뷰에 들어온다
    // (production-like 상황). hierarchy_edges 는 이미 DB 에 저장돼 있으니(정의 글 처리
    // 시점에 실제로 저장됨) 노이즈만 추가하면 된다 — 정의 글을 다시 넣을 필요는 없다.
    await processInput("#생물:동물 #동물:고양이 #고양이:얼룩이");
    for (let i = 0; i < 65; i++) {
      await processInput(`잡담 ${i}`);
    }

    const body = await overview();
    const labels = labelSet(body);

    expect(labels.has("동물")).toBe(true);
    expect(labels.has("고양이")).toBe(true);

    expect(hasParentOfBetween(body, "생물", "동물")).toBe(true);
    expect(hasParentOfBetween(body, "동물", "고양이")).toBe(true);
    expect(hasParentOfBetween(body, "고양이", "얼룩이")).toBe(true);
  });

  test("사람 사슬 — 가족·둘째 다리 노드 + 사람→가족→둘째→인영희 사슬이 응답에 뜬다", async () => {
    await processInput("#사람:인영희 #관계:가족 #가족:둘째");

    const body = await overview();
    const labels = labelSet(body);

    expect(labels.has("가족")).toBe(true);
    expect(labels.has("둘째")).toBe(true);

    expect(hasParentOfBetween(body, "사람", "가족")).toBe(true);
    expect(hasParentOfBetween(body, "가족", "둘째")).toBe(true);
    expect(hasParentOfBetween(body, "둘째", "인영희")).toBe(true);
  });
});
