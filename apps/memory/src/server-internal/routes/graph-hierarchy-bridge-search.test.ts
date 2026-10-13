/**
 * graph-hierarchy-bridge-search.test.ts — /graph/search 위계 다리 복원 통합 재현
 * (branch plaintext-auto-inference-scope Task 5).
 *
 * graph-hierarchy-bridge-overview.test.ts(Task 4)와 같은 문제를 검색 라우트에
 * 적용한다. 검색은 이름으로 들어오므로(addMatchingEntitySearchSeeds), 독립
 * 엔티티/사람/프로젝트가 augmentWithEntities *뒤*에 시드로 늦게 합류해 위계
 * 상향 walk(walkHierarchyUpward)를 못 타고, 콜론 사슬 가운데 다리 개념 노드
 * (동물·고양이)가 검색 subgraph 에서 빠진다.
 *
 * 진짜 red 재현 — noise 볼륨으로는 안 된다(실측) — 처음엔 graph-relation-edges-
 * search-e2e.test.ts 22~26행의 선례(무관 noise 50줄로 정의 글을 retriever 상위
 * 밖으로 민다)를 그대로 따라 했다. 그런데 이 사슬 재현에서는 noise 를 80줄까지
 * 늘려도 정의 글이 retriever 결과 1위를 유지했다(실측: node:1 score 0.399 —
 * vector+fts+concept 세 채널 동시 hit라 noise(vector 단일 채널, score ~0.26)
 * 로는 RRF 순위를 절대 못 뒤집는다 — "얼룩이" 라는 글자를 담은 문서는 이 정의 글
 * 하나뿐이라 FTS·concept 채널은 noise 볼륨과 무관하게 항상 정의 글에게 고정
 * 순위 1위를 준다). 즉 exact-name 질의는 noise 양으로 hit 밖으로 못 민다 —
 * 정성적으로 다른 재현 통로가 필요하다.
 *
 * 그래서 production 실제 기능인 "entity_patch" 입력 갈래(save-input-entity-
 * branches.ts saveEntityProfilePatch)를 그대로 재현한다 — 본문 없이 `#타입:대상`
 * 만 있는 입력은 knowledge_node 를 아예 만들지 않고 wireHashtagEntities/
 * wireEntityPlacement 를 originNodeId=null 로 호출해 엔티티·위계만 심는다
 * (save-input-entity-branches.ts:186-211). knowledge_nodes 행이 0건이므로
 * "얼룩이" 정의는 retriever 가 절대 찾을 수 없다(retriever 는 knowledge_nodes 만
 * 검색) — hit/이웃 통로가 원천 차단된 완전히 결정적인 red 조건이다(noise 튜닝
 * 불필요). graph.ts:461 의 주석("entity_patch 는 knowledge_nodes 를 만들지
 * 않으므로")이 정확히 이 상황을 가리킨다 — addStandaloneEntitySeeds/
 * addMatchingEntitySearchSeeds 가 존재하는 이유 자체가 이 갈래다.
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
import type { GraphSearchResponse } from "./graph.ts";
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

/** 텍스트 글 입력(실제 통로): store.addNode → wireHashtagEntities → wireEntityPlacement. */
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

/**
 * entity_patch 입력(실제 통로): save-input-entity-branches.ts saveEntityProfilePatch
 * 와 동일하게 originNodeId=null 로 wireHashtagEntities/wireEntityPlacement 를 호출한다.
 * knowledge_node 를 전혀 만들지 않는다 — 본문 없이 콜론 해시태그만 있는 입력이
 * 실 운영에서 거치는 그대로다.
 */
async function processEntityPatch(content: string): Promise<void> {
  await wireHashtagEntities(ctx.store, null, content, { provenance: "user_input" });
  await wireEntityPlacement(ctx.store, null, content, {
    llm: null,
    provenance: "user_input",
  });
}

async function search(query: string): Promise<GraphSearchResponse> {
  const res = await app.request("/graph/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GraphSearchResponse;
}

function labelSet(body: GraphSearchResponse): Set<string> {
  return new Set(body.subgraph.nodes.map((n) => n.label));
}

/** 응답 노드 라벨 이름으로 parent_of 엣지가 있는지 확인한다(id 는 매 실행 랜덤이라 라벨로 매칭). */
function hasParentOfBetween(
  body: GraphSearchResponse,
  fromLabel: string,
  toLabel: string,
): boolean {
  const labelById = new Map<string, string>(
    body.subgraph.nodes.map((n) => [n.id, n.label]),
  );
  return body.subgraph.edges.some(
    (e) =>
      e.type === "parent_of" &&
      labelById.get(e.from) === fromLabel &&
      labelById.get(e.to) === toLabel,
  );
}

/** 묶음(group:<type> 또는 재사용 위계 루트) → toLabel 로 직결되는 member_of 엣지가 있는지 확인한다. */
function hasGroupMemberOfDirectlyTo(
  body: GraphSearchResponse,
  toLabel: string,
): boolean {
  const labelById = new Map<string, string>(
    body.subgraph.nodes.map((n) => [n.id, n.label]),
  );
  const kindById = new Map<string, string | undefined>(
    body.subgraph.nodes.map((n) => [n.id, n.sourceType]),
  );
  return body.subgraph.edges.some((e) => {
    if (e.type !== "member_of") return false;
    if (labelById.get(e.to) !== toLabel) return false;
    return kindById.get(e.from) === "entity_group";
  });
}

describe("/graph/search — 콜론 사슬 가운데 다리 노드 복원(늦은 검색 시드 위계 합류)", () => {
  test("생물 사슬(정의 글이 hit 로 남는 단순 경우) — 동물·고양이 다리 노드 + 사슬이 응답에 뜬다", async () => {
    await processInput("#생물:동물 #동물:고양이 #고양이:얼룩이");

    const body = await search("얼룩이");
    const labels = labelSet(body);

    expect(labels.has("동물")).toBe(true);
    expect(labels.has("고양이")).toBe(true);

    expect(hasParentOfBetween(body, "생물", "동물")).toBe(true);
    expect(hasParentOfBetween(body, "동물", "고양이")).toBe(true);
    expect(hasParentOfBetween(body, "고양이", "얼룩이")).toBe(true);
  });

  test("배선 게이트(Task 5) — entity_patch 로만 들어온 엔티티(정의 글 자체가 없어 hit 통로 원천 차단)도 늦은 검색 시드로 다리가 복원된다", async () => {
    await processEntityPatch("#생물:동물 #동물:고양이 #고양이:얼룩이");

    // 전제 확인 — knowledge_node 가 0건(entity_patch 는 글을 안 만든다). retriever 는
    // knowledge_nodes 만 검색하므로 "얼룩이" 정의는 hit/이웃 어느 통로로도 절대 못 들어온다
    // (noise 볼륨과 무관한 결정적 red 조건 — 위 파일 docstring 실측 근거 참고).
    const nodeCount = ctx.store
      .getRawDb()
      .query("SELECT COUNT(*) AS n FROM knowledge_nodes")
      .get() as { n: number };
    expect(nodeCount.n).toBe(0);

    const body = await search("얼룩이");

    // "얼룩이" 는 오직 addMatchingEntitySearchSeeds 늦은 검색 시드로만 들어온다(hit 1건 ·
    // creature 출처) — retriever.retrieve() 결과가 전혀 없다는 뜻(hit 목록이 전부
    // 검색 시드 출처인지 확인).
    expect(body.hits.length).toBeGreaterThan(0);
    for (const h of body.hits) {
      expect(h.sources?.includes("creature")).toBe(true);
    }

    const labels = labelSet(body);
    expect(labels.has("얼룩이")).toBe(true);
    expect(labels.has("동물")).toBe(true);
    expect(labels.has("고양이")).toBe(true);

    expect(hasParentOfBetween(body, "생물", "동물")).toBe(true);
    expect(hasParentOfBetween(body, "동물", "고양이")).toBe(true);
    expect(hasParentOfBetween(body, "고양이", "얼룩이")).toBe(true);

    // 묶음 정합 — 가운데 다리가 살아있으므로 묶음→얼룩이 직결 member_of 는 생기지 않는다
    // (buildGroupNodes 의 ⑤ member_of 추이 감축이 parent_of 사슬을 타고 자연히 생략).
    expect(hasGroupMemberOfDirectlyTo(body, "얼룩이")).toBe(false);
  });
});
