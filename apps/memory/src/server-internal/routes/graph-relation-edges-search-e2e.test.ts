/**
 * graph-relation-edges-search-e2e.test.ts — /graph/search 관계선(entity_relation_edges)
 * 펼침(pull-in) 기능 검증·회귀 안전망.
 *
 * 배경(overview 와 다른 문제) — overview 는 addStandaloneEntitySeeds 로 사람·작품이 이미
 * 다 모여, 양끝이 모두 있을 때 관계선을 마저 긋는 것으로 고쳐졌다. 하지만 검색 뷰는 사용자가
 * *이름으로 검색*하므로(예 작가 이름), addMatchingEntitySearchSeeds 가 이름 맞는 사람 노드를
 * augmentWithEntities *뒤에* 시드로 넣는다. augmentWithEntities 안의 이른 관계선 패스는 그
 * 시점에 사람 노드가 아직 nodeById 에 없어 work→person 관계선을 건너뛴다. 사람 노드가 나중에
 * 들어와도 다시 긋는 패스가 없어, 양끝이 최종 노드 집합에 다 있는데도 관계선이 0개로 남는다.
 * 또 사용자가 작가 이름으로 검색하면 그 작가의 작품이 retriever 결과에 안 들어올 수 있어(작품
 * 메모가 상위 순위 밖으로 밀리면) 관계 상대가 아예 없다.
 *
 * 수정(사용자 결정) — 모든 시드가 모인 *뒤*, 검색한 엔티티에 걸린 관계 상대를 그래프로 끌어와
 * (상한 안에서) 함께 점선으로 보여준다. 작가는 created_by 관계의 *도착점*(work→person)이므로
 * 양방향 조회가 필수다(앵커에서 나가는 source 관계 + 들어오는 target 관계 둘 다).
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder + 실 입력 통로(store.addNode →
 * wireHashtagEntities → wireEntityPlacement). Mock 클래스 0(CLAUDE.md "DB/임베딩 의존 모듈은
 * 실 구현체와 통합 검증"). overview e2e 테스트와 같은 wiring 묶음을 재사용한다.
 *
 * red 재현 주의 — 작은 코퍼스(7줄)만 넣으면 trigram/vector retriever 가 코퍼스 거의 전체를
 * 돌려줘, 작품 메모가 다 딸려 오고 이른 관계선 패스가 우연히 관계선을 이미 그린다(수정 전에도
 * 관계선이 뜬다). 그래서 진짜 red 는 "무관 noise 메모를 섞어 작품 메모가 상위 순위 밖으로
 * 밀리고, 사람 노드는 검색 시드로만 들어오는" production-like 상황에서 재현된다 — 아래 시나리오
 * A 가 그 형태다(수정 전 created_by 관계선 0개, 양끝 노드는 최종 집합 안).
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
import type { GraphSearchResponse, GraphNode, GraphEdge } from "./graph.ts";
import { SEARCH_RELATION_PULL_LIMIT } from "./graph-search-relation-reveal.ts";
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

async function search(query: string): Promise<GraphSearchResponse> {
  const res = await app.request("/graph/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GraphSearchResponse;
}

/** entity_relation_edges 출처 관계선만 추린다(meta.edgeKind==="entity_relation"). */
function relationEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => e.meta?.edgeKind === "entity_relation");
}

/** overview e2e 와 동일한 7줄 입력(소설·작가·별칭 사슬). 시나리오 B·C 가 재사용한다. */
const INPUT_LINES: readonly string[] = [
  "#사람:백덕수, #직업:소설작가, #작품:데뷔 못 하면 죽는 병 걸림, #작품:괴담에 떨어져도 출근을 해야 하는구나",
  "#소설:데뷔 못 하면 죽는 병 걸림, #작가:백덕수, #별칭:데못죽, 소설을 3번 이상 정주행 했다.",
  "#소설:망나니 PD 아이돌로 살아남기, #작가:문찐, #별칭:망아살, 소설을 2번이상 정주행 했다.",
  "#소설:초심 잃은 아이돌을 위한 회귀 백서, #작가:리벨, #별칭:초심돌, 주인공이 멘탈이 좋아서 내용진행이 시원시원하다.",
  "#소설:괴담에 떨어져도 출근을 해야 하는구나, #작가:백덕수, #별칭:괴담출근, #별칭:괴출",
  "#사람:쓩늉, #직업:웹툰작가, #작품:괴담에 떨어져도 출근을 해야 하는구나(웹툰), #작품:흑막을 버리는 데 실패했다(웹툰)",
  "#작품:웹툰, #웹툰:괴담에 떨어져도 출근을 해야 하는구나(웹툰), #작가:쓩늉, #별칭:웹툰괴담출근, #별칭:웹툰괴출, 그림체가 찰떡 취향이다!",
];

async function ingestSevenLines(): Promise<void> {
  for (const line of INPUT_LINES) {
    await processInput(line);
  }
}

describe("/graph/search — 관계선(entity_relation_edges) 펼침(pull-in)", () => {
  test("시나리오 A(진짜 red): 작가 검색 + noise 다수 → 작품 메모가 상위 밖·사람은 검색 시드로만 → created_by 관계선 2개 이상 뜬다", async () => {
    // 작품 두 개 + 작가(홍길동). 두 소설 메모가 created_by(work→person) 관계를 만든다.
    await processInput("#소설:활빈당 이야기, #작가:홍길동, 신나는 의적물이다.");
    await processInput("#소설:도술 대모험, #작가:홍길동, 도술이 화려하다.");
    // 무관 noise 50줄 — 작품 메모를 retriever 상위 밖으로 밀어 production-like gap 을 만든다.
    for (let i = 0; i < 50; i++) {
      await processInput(`오늘 점심으로 김치찌개 ${i}번째 먹었다 맛있었다 날씨도 좋다.`);
    }

    // 전제 — created_by 행이 실제로 심겼는지 DB 를 직접 읽어 근본이 "wiring 미생성"이 아님을
    // 못 박는다(작품 두 개 → 홍길동).
    const createdByRows = ctx.store
      .getRawDb()
      .query(
        "SELECT COUNT(*) AS n FROM entity_relation_edges WHERE relation = 'created_by'",
      )
      .get() as { n: number };
    expect(createdByRows.n).toBe(2);

    const body = await search("홍길동");
    const rels = relationEdges(body.subgraph.edges);
    const createdByRels = rels.filter((e) => e.type === "created_by");

    // 수정 전 red: 이른 관계선 패스 시점엔 사람 노드가 nodeById 에 없어 0개.
    // (양끝 노드는 최종 집합 안에 다 있는데도 관계선이 안 그려지는 검색 뷰 순서 버그.)
    expect(createdByRels.length).toBeGreaterThanOrEqual(2);

    // 관계선 양끝이 실제로 응답 노드 집합 안에 있어야 한다(렌더 스킵 방지).
    const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));
    for (const e of createdByRels) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }

    // 작품·작가 노드가 subgraph 에 존재(양끝 노드 존재 확인).
    const labels = body.subgraph.nodes.map((n: GraphNode) => n.label);
    expect(labels.some((l) => l.includes("활빈당 이야기"))).toBe(true);
    expect(labels.some((l) => l.includes("도술 대모험"))).toBe(true);
    expect(labels.some((l) => l.includes("홍길동"))).toBe(true);
  });

  test("시나리오 A-2(pull-in): 작가만 시드로 잡히고 작품이 retriever 결과에 아예 없어도 관계 상대(작품)를 끌어와 잇는다", async () => {
    // 작품 소개 메모는 만들지 않는다 — 사람 선언 한 줄이 created_by 를 만든다면 그 상대 작품을
    // 노드로 끌어와야(pull-in) 한다. 단, #소설:X, #작가:Y 형태만 created_by 를 만들므로
    // 작품 메모 자체는 존재하되 검색 결과에는 안 들어오게 noise 로 밀어낸 뒤, 사람 검색으로만
    // 도달한 작가에서 작품을 끌어오는지 본다.
    await processInput("#소설:은밀한 밤의 기록, #작가:유령작가아무개, 분위기가 스산하다.");
    for (let i = 0; i < 40; i++) {
      await processInput(`전혀 무관한 잡담 ${i} 커피가 맛있다 산책을 했다.`);
    }

    const body = await search("유령작가아무개");
    const rels = relationEdges(body.subgraph.edges).filter(
      (e) => e.type === "created_by",
    );
    expect(rels.length).toBeGreaterThanOrEqual(1);

    // 끌려온 작품 노드가 존재해야 한다(pull-in 증거).
    const labels = body.subgraph.nodes.map((n: GraphNode) => n.label);
    expect(labels.some((l) => l.includes("은밀한 밤의 기록"))).toBe(true);
  });

  test("시나리오 B: 작가 이름 '백덕수' 검색 시 그 작가의 작품과 created_by 관계선이 함께 뜬다(7줄·양끝 존재)", async () => {
    await ingestSevenLines();

    const body = await search("백덕수");
    const rels = relationEdges(body.subgraph.edges);
    const createdByRels = rels.filter((e) => e.type === "created_by");

    // 백덕수는 두 소설('데뷔…'·'괴담…')의 작가 → created_by 관계선이 함께 보인다.
    expect(createdByRels.length).toBeGreaterThanOrEqual(2);

    const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));
    for (const e of createdByRels) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }

    // 상대 작품 노드가 subgraph 에 함께 떠 있다(작가 검색이 작품을 데려온다).
    const labels = body.subgraph.nodes.map((n: GraphNode) => n.label);
    expect(labels.some((l) => l.includes("데뷔 못 하면 죽는 병 걸림"))).toBe(true);
    expect(labels.some((l) => l.includes("괴담에 떨어져도 출근을 해야 하는구나"))).toBe(true);

    // '데뷔…' work → '백덕수' person created_by 관계선이 실제로 있다(라벨 매핑 확인).
    const labelById = new Map<string, string>(
      body.subgraph.nodes.map((n: GraphNode) => [n.id, n.label]),
    );
    const hasDemotjukToBaek = createdByRels.some((e) => {
      const from = labelById.get(e.from) ?? "";
      const to = labelById.get(e.to) ?? "";
      return from.includes("데뷔 못 하면 죽는 병 걸림") && to.includes("백덕수");
    });
    expect(hasDemotjukToBaek).toBe(true);
  });

  test("시나리오 B-2: 작품 이름 '망나니 PD 아이돌로 살아남기' 검색 시 작가 '문찐'과 created_by 관계선이 뜬다", async () => {
    await ingestSevenLines();

    const body = await search("망나니 PD 아이돌로 살아남기");
    const rels = relationEdges(body.subgraph.edges);
    const createdByRels = rels.filter((e) => e.type === "created_by");

    expect(createdByRels.length).toBeGreaterThanOrEqual(1);

    const labels = body.subgraph.nodes.map((n: GraphNode) => n.label);
    expect(labels.some((l) => l.includes("문찐"))).toBe(true);

    const labelById = new Map<string, string>(
      body.subgraph.nodes.map((n: GraphNode) => [n.id, n.label]),
    );
    const hasMangnaniToMoonjjin = createdByRels.some((e) => {
      const from = labelById.get(e.from) ?? "";
      const to = labelById.get(e.to) ?? "";
      return from.includes("망나니") && to.includes("문찐");
    });
    expect(hasMangnaniToMoonjjin).toBe(true);
  });

  test("시나리오 C: pull 상한이 존중된다(상수 합리적·관계선 양끝은 최종 노드 집합 안)", async () => {
    await ingestSevenLines();

    const body = await search("백덕수");
    const rels = relationEdges(body.subgraph.edges);

    // 상한 상수가 폭발 방지 값(0<x≤200)임을 못 박는다 — 하드코딩 분산 없이 한 상수가 게이트.
    expect(SEARCH_RELATION_PULL_LIMIT).toBeGreaterThan(0);
    expect(SEARCH_RELATION_PULL_LIMIT).toBeLessThanOrEqual(200);

    // 관계선 양끝은 모두 최종 노드 집합 안(상한으로 못 끌어온 상대의 반쪽 엣지는 없어야 한다).
    const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));
    for (const e of rels) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
    expect(rels.length).toBeGreaterThan(0);
  });
});

describe("/graph/search — project 끝점 관계선(participated_by) 노드 키 정합 회귀", () => {
  // 결함(2026-07-10 리뷰 High) — refNodeKey 가 project 를 entity:project:<id> 로
  // 매핑했지만 프로젝트 노드는 projectKey(=project:<id>)로 저장·시드된다. 검색 뷰에서는
  //   · 사람 앵커에서 들어오는 project→person 관계를 펼칠 때 fromKey 가
  //     entity:project:<id> 로 그어지는 반면 buildEndpointNode 가 끌어온 프로젝트 노드는
  //     project:<id> 로 저장돼 — 응답에 없는 노드를 가리키는 끊긴 엣지 + 고립 노드가 됐고,
  //   · 프로젝트 이름 검색은 앵커 키(entity:project:<id>)가 시드 키(project:<id>)와 어긋나
  //     관계 펼침 자체가 돌지 않았다.
  // participated_by 실데이터 경로는 store facade addProjectPersonEdge(project-entity-mixin).
  async function seedProjectPersonRelation(): Promise<{
    projectId: string;
    personId: string;
  }> {
    const project = await ctx.store.findOrCreateProject({ name: "바라시스템" });
    const person = await ctx.store.findOrCreatePersonByName("박협업자");
    await ctx.store.addProjectPersonEdge(
      project.projectId,
      person.personId,
      "participant",
      "user_input",
      null,
    );
    // 검색 결과·앵커가 생기도록 최소 코퍼스 — 사람 언급 글 한 줄.
    await processInput("#사람:박협업자, 협업 일정을 정리했다.");
    return { projectId: project.projectId, personId: person.personId };
  }

  test("사람 이름 검색: project→person participated_by 가 끊긴 엣지 없이 뜨고 프로젝트 노드가 project:<id> 키로 존재한다", async () => {
    const { projectId, personId } = await seedProjectPersonRelation();

    const body = await search("박협업자");
    const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));

    const participated = body.subgraph.edges.filter(
      (e) => e.type === "participated_by",
    );
    expect(participated.length).toBeGreaterThanOrEqual(1);
    for (const e of participated) {
      expect(e.from).toBe(`project:${projectId}`);
      expect(e.to).toBe(`person:${personId}`);
    }

    // 끌려온 프로젝트 노드가 projectKey(project:<id>)로 존재한다 — 수정 전 red:
    // 엣지는 entity:project:<id> 를 가리키고 노드는 project:<id> 로 저장돼 끊긴 엣지.
    expect(nodeIds.has(`project:${projectId}`)).toBe(true);

    // (b) 응답의 어떤 엣지도 응답에 없는 노드를 가리키지 않는다(끊긴 엣지 0).
    for (const e of body.subgraph.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });

  test("프로젝트 이름 검색: 앵커 키 정합으로 관계 펼침이 돌아 상대 사람 노드가 끌려온다", async () => {
    const { projectId, personId } = await seedProjectPersonRelation();

    const body = await search("바라시스템");
    const nodeIds = new Set(body.subgraph.nodes.map((n) => n.id));

    // 프로젝트 시드(project:<id>)가 앵커로 잡혀 관계 펼침이 돌고, 상대 사람 노드가
    // person:<id> 로 끌려온다. 수정 전 red: 앵커 키 불일치로 펼침 자체가 스킵.
    const participated = body.subgraph.edges.filter(
      (e) => e.type === "participated_by",
    );
    expect(participated.length).toBeGreaterThanOrEqual(1);
    expect(nodeIds.has(`project:${projectId}`)).toBe(true);
    expect(nodeIds.has(`person:${personId}`)).toBe(true);

    for (const e of body.subgraph.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });
});
