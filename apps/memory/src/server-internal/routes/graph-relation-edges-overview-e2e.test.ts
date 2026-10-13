/**
 * graph-relation-edges-overview-e2e.test.ts — /graph/overview 관계선(entity_relation_edges)
 * 실종 버그 재현·회귀 안전망.
 *
 * 증상(라이브) — 사용자가 그래프 입력창에 소설·작가·별칭 사슬 7줄을 넣었을 때, "관계로
 * 설정된 연결"(예: 소설→작가 created_by)은 다른 색·점선으로 보여야 하는데 선이 전혀 안
 * 보였다.
 *
 * 확정된 근본 원인 — wiring 은 정상(entity_relation_edges 에 created_by 행이 정상 생성)이고
 * 어댑터·뷰모델·렌더도 무죄다. 진짜 원인은 /graph/overview 조립 *순서*다:
 *   1. augmentWithEntities 가 최근 글 기반으로 엔티티를 합류시키며 그 안에서
 *      drawEntityRelationEdges 를 *이른 시점에* 돌린다.
 *   2. addStandaloneEntitySeeds 가 *그 뒤*에야 모든 사람·정적 8종·user 종류 엔티티 노드를
 *      nodeById 에 합류시킨다.
 *   → 관계 대상 작가(문찐·리벨 등) 노드가 이른 관계선 패스 시점엔 아직 nodeById 에 없어
 *     관계선이 0개로 확정된다. render 는 양끝 노드가 다 있어야만 그리므로 화면에 안 보인다.
 *
 * 수정 — standalone 시드로 모든 노드가 모인 *뒤*, overview 에서 관계선을 한 번 더 그리는
 * 멱등 패스를 추가한다(augment 안의 이른 패스는 검색 뷰용으로 그대로 둔다).
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder + 실제 입력 통로(store.addNode →
 * wireHashtagEntities → wireEntityPlacement). Mock 클래스 0(CLAUDE.md "DB/임베딩 의존
 * 모듈은 실 구현체와 통합 검증"). 대시보드 그래프 입력창의 진짜 저장 경로는 POST /ingest
 * (→ handleTextIngest → saveTextInput)이지만, 그 경로는 assetStore·extractor 등 무거운
 * 의존성을 요구하고(미주입 시 503), 관계선 생성 자체는 wireHashtagEntities+wireEntityPlacement
 * 가 담당한다 — classification-key-graph-hub.test.ts 의 processInput 이 쓰는 검증된
 * 동일 조합을 여기서도 재사용한다.
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
import type { GraphOverviewResponse, GraphNode, GraphEdge } from "./graph.ts";
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

/** entity_relation_edges 출처 관계선만 추린다(meta.edgeKind==="entity_relation"). */
function relationEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => e.meta?.edgeKind === "entity_relation");
}

// 사용자가 그래프 입력창에 실제로 넣은 7줄.
const INPUT_LINES: readonly string[] = [
  "#사람:백덕수, #직업:소설작가, #작품:데뷔 못 하면 죽는 병 걸림, #작품:괴담에 떨어져도 출근을 해야 하는구나",
  "#소설:데뷔 못 하면 죽는 병 걸림, #작가:백덕수, #별칭:데못죽, 소설을 3번 이상 정주행 했다.",
  "#소설:망나니 PD 아이돌로 살아남기, #작가:문찐, #별칭:망아살, 소설을 2번이상 정주행 했다.",
  "#소설:초심 잃은 아이돌을 위한 회귀 백서, #작가:리벨, #별칭:초심돌, 주인공이 멘탈이 좋아서 내용진행이 시원시원하다.",
  "#소설:괴담에 떨어져도 출근을 해야 하는구나, #작가:백덕수, #별칭:괴담출근, #별칭:괴출",
  "#사람:쓩늉, #직업:웹툰작가, #작품:괴담에 떨어져도 출근을 해야 하는구나(웹툰), #작품:흑막을 버리는 데 실패했다(웹툰)",
  "#작품:웹툰, #웹툰:괴담에 떨어져도 출근을 해야 하는구나(웹툰), #작가:쓩늉, #별칭:웹툰괴담출근, #별칭:웹툰괴출, 그림체가 찰떡 취향이다!",
];

describe("/graph/overview — 엔티티 관계선(entity_relation_edges) 실종 버그 재현·회귀", () => {
  test("소설·작가 사슬 7줄 입력 후 overview 에 관계선이 최소 5개 이상 뜬다(양끝 노드 존재)", async () => {
    for (const line of INPUT_LINES) {
      await processInput(line);
    }

    // 전제 확인 — wiring 은 무죄여야 한다. entity_relation_edges 에 created_by 행이 실제로
    // 심겼는지 DB 를 직접 읽어 근본 원인이 "조립 순서"이지 "wiring 미생성"이 아님을 못 박는다.
    const createdByRows = ctx.store
      .getRawDb()
      .query(
        "SELECT COUNT(*) AS n FROM entity_relation_edges WHERE relation = 'created_by'",
      )
      .get() as { n: number };
    expect(createdByRows.n).toBeGreaterThanOrEqual(5);

    const body = await overview();
    const rels = relationEdges(body.edges);

    // 1) 관계선(entity_relation) 이 DB 의 created_by 행 수만큼(최소 5) 그려져야 한다.
    //    수정 전 red: augment 이른 패스 시점엔 작가 노드가 nodeById 에 없어 0개(또는 <5).
    expect(rels.length).toBeGreaterThanOrEqual(5);

    // 2) 관계 엣지의 from/to 는 실제로 응답 노드 집합 안에 존재해야 한다(렌더 스킵 방지).
    const nodeIds = new Set(body.nodes.map((n) => n.id));
    for (const e of rels) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });

  test("특정 관계(작품 '데뷔 못 하면 죽는 병 걸림' → 사람 '백덕수' created_by)가 관계선 목록에 있다", async () => {
    for (const line of INPUT_LINES) {
      await processInput(line);
    }

    const body = await overview();
    const rels = relationEdges(body.edges);

    // 노드 라벨로 from/to 를 사람이 읽는 이름으로 매핑해, '데뷔 못 하면 죽는 병 걸림'
    // work 행 → '백덕수' person 관계가 그려졌는지 확인한다. 라벨은 LABEL_MAX_CHARS(31)로
    // 잘리지 않는 짧은 이름이라 그대로 매칭된다.
    const labelById = new Map<string, string>(
      body.nodes.map((n: GraphNode) => [n.id, n.label]),
    );

    const hasDemotjukToBaekdeoksu = rels.some((e) => {
      const from = labelById.get(e.from) ?? "";
      const to = labelById.get(e.to) ?? "";
      return (
        e.type === "created_by" &&
        from.includes("데뷔 못 하면 죽는 병 걸림") &&
        to.includes("백덕수")
      );
    });
    expect(hasDemotjukToBaekdeoksu).toBe(true);
  });
});

describe("/graph/overview — project 끝점 관계선(participated_by) 노드 키 정합 회귀", () => {
  // 결함(2026-07-10 리뷰 High) — refNodeKey 가 project 를 entityKey("project", id)
  // (=entity:project:<id>)로 매핑했지만 프로젝트 노드는 어디서나 projectKey(=project:<id>)로
  // 저장된다. overview 관계선 패스의 nodeById.has 가드가 항상 false 라 project 가 낀
  // 관계선이 전부 누락됐고, 소스 목록에 projectRefs 도 없어 participated_by(source=project)
  // 는 어느 소스에서도 나오지 않았다. participated_by 실데이터 경로는 store facade
  // addProjectPersonEdge(project-entity-mixin — 대시보드 참여자 추가 라우트가 쓰는 통로).
  test("project→person participated_by 관계선이 project:<id>/person:<id> 끝점으로 뜨고, 기존 created_by(work→person) 케이스는 그대로다", async () => {
    // 기존 타입 케이스(작품→사람 created_by)가 변하지 않음을 같은 화면에서 함께 확인한다.
    await processInput("#소설:활빈당 이야기, #작가:홍길동, 신나는 의적물이다.");

    const project = await ctx.store.findOrCreateProject({ name: "바라시스템" });
    const person = await ctx.store.findOrCreatePersonByName("김참여자");
    await ctx.store.addProjectPersonEdge(
      project.projectId,
      person.personId,
      "participant",
      "user_input",
      null,
    );

    const body = await overview();
    const nodeIds = new Set(body.nodes.map((n) => n.id));

    // (a) project↔person 관계선이 존재하고 from/to 키가 응답 노드 집합의 실제 노드를
    //     가리킨다. 수정 전 red: 소스 누락 + 키 불일치로 participated_by 0개.
    const participated = body.edges.filter((e) => e.type === "participated_by");
    expect(participated.length).toBe(1);
    const edge = participated[0]!;
    expect(edge.from).toBe(`project:${project.projectId}`);
    expect(edge.to).toBe(`person:${person.personId}`);
    expect(nodeIds.has(edge.from)).toBe(true);
    expect(nodeIds.has(edge.to)).toBe(true);

    // (c) 기존 person/엔티티 타입 케이스 무변 — created_by(work→person) 관계선이 그대로
    //     그려지고, 모든 관계선 양끝이 응답 노드 집합 안이다.
    const rels = relationEdges(body.edges);
    expect(rels.filter((e) => e.type === "created_by").length).toBeGreaterThanOrEqual(1);
    for (const e of rels) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(nodeIds.has(e.to)).toBe(true);
    }
  });
});
