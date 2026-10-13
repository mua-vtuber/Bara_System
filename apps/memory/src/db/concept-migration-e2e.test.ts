/**
 * 1.0b E2E — 개념·사람·관계 분리 후 입력 → 그래프 정합 한 흐름 검증.
 *
 * 실 SqliteMemoryStore + Bgem3Embedder. mock 금지(CLAUDE.md 정책).
 * 각 테스트는 독립 in-memory DB 사용 — beforeEach/afterEach 격리.
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
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "./migrations.ts";
import { SqliteMemoryStore } from "./store.ts";
import { applyHashtagWiring } from "../memory/extractor.ts";
import { autoLinkMentions } from "../memory/auto-mention.ts";
import { linkAuthorPerson } from "../memory/person-link.ts";
import { representativeConceptType } from "../../web/dashboard/graph/graph-view-model.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

describe("1.0b E2E — 개념·사람·관계 분리", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });

  afterEach(() => {
    db.close();
  });

  // ── 케이스 1: #태그 입력 → concept_nodes + node_concept_edges + concept_edges ──

  test("#태그 입력 → concept_nodes 2개 + node_concept_edges(tag) 2개 + parent_of 0(순수 나열)", async () => {
    const r = await applyHashtagWiring(
      store,
      "#만화 #주술회전 고죠가 죽었어",
      { embedder },
    );

    // 반환값 검증
    expect(r.tagConceptIds.length).toBe(2);
    expect(r.bodyNodeId).not.toBeNull();

    // concept_nodes 2개 생성 확인
    const concepts = await store.listConcepts();
    expect(concepts.length).toBe(2);

    // node_concept_edges role='tag' 2개 — 본문 노드 → 두 태그 개념
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: r.bodyNodeId!,
      role: "tag",
    });
    expect(tagEdges.length).toBe(2);
    expect(tagEdges.map((e) => e.conceptId)).toContain(r.tagConceptIds[0]!);
    expect(tagEdges.map((e) => e.conceptId)).toContain(r.tagConceptIds[1]!);

    // 콜론 없는 순수 나열은 위계(parent_of)를 만들지 않는다(spec §4.1 I1) —
    // 두 태그 다 글에 붙되 둘 사이 위계 엣지는 0개.
    const hierarchy = await store.listConceptEdges({ relation: "parent_of" });
    expect(hierarchy.length).toBe(0);
  });

  // ── 케이스 2: 같은 이름 태그·분류·개념 한 행 합류 (꼬임 해소 1단계 결정 1·spec §3.1) ──

  test("같은 이름 태그+분류 키+분류 값이 한 concept 행으로 합류·역할 플래그 누적", async () => {
    // 태그로 먼저 등록(is_tag).
    const tagId = await store.findOrCreateTagConcept("직업");
    // 같은 이름을 분류 키로 다시 등록 — 같은 행에 is_classification_key 누적.
    const keyId = await store.findOrCreateConcept("직업", {
      isClassificationKey: true,
    });
    // 같은 이름을 분류 값으로 또 등록 — 같은 행에 is_classification_value 누적.
    const valId = await store.findOrCreateConcept("직업", {
      isClassificationValue: true,
    });

    // 세 호출이 같은 conceptId 한 행으로 합류한다(name UNIQUE).
    expect(keyId).toBe(tagId);
    expect(valId).toBe(tagId);

    // concept_nodes 행도 1개만 — 중복 행 0.
    const concepts = await store.listConcepts();
    expect(concepts.length).toBe(1);

    // 역할 플래그 셋이 한 행에 다 누적됐다.
    const merged = await store.findConceptByName("직업");
    expect(merged).not.toBeNull();
    expect(merged!.isTag).toBe(true);
    expect(merged!.isClassificationKey).toBe(true);
    expect(merged!.isClassificationValue).toBe(true);
  });

  test("합류 행의 대표 type 은 개념>분류>태그 우선순위로 분류 키가 이긴다", async () => {
    // 태그·분류 값·분류 키가 다 겹친 한 행.
    await store.findOrCreateTagConcept("프로바이더");
    await store.findOrCreateConcept("프로바이더", { isClassificationValue: true });
    await store.findOrCreateConcept("프로바이더", { isClassificationKey: true });

    const merged = await store.findConceptByName("프로바이더");
    expect(merged).not.toBeNull();

    // 그래프 렌더 표시 규칙(view-model)에 합류된 실제 플래그를 그대로 넣으면
    // 분류 키가 대표가 된다(분류 > 태그·spec §3.1).
    const repType = representativeConceptType({
      isTag: merged!.isTag,
      isClassificationKey: merged!.isClassificationKey,
      isClassificationValue: merged!.isClassificationValue,
    });
    expect(repType).toBe("classification_key");
  });

  test("태그로만 등록한 행은 대표 type 이 일반 concept (개념과 한데·기존 계약)", async () => {
    await store.findOrCreateTagConcept("커피");
    const merged = await store.findConceptByName("커피");
    expect(merged).not.toBeNull();
    expect(merged!.isTag).toBe(true);
    expect(merged!.isClassificationKey).toBe(false);
    expect(merged!.isClassificationValue).toBe(false);

    const repType = representativeConceptType({
      isTag: merged!.isTag,
      isClassificationKey: merged!.isClassificationKey,
      isClassificationValue: merged!.isClassificationValue,
    });
    expect(repType).toBe("concept");
  });

  // ── 케이스 3: autoLinkMentions + linkAuthorPerson ────────────────────────────

  test("autoLinkMentions → role='mention' / linkAuthorPerson → persons + authored_by", async () => {
    // "커피" 개념이 먼저 등록돼 있어야 findMentionedConcepts 가 매칭할 수 있다
    await store.findOrCreateTagConcept("커피");

    const nid = await store.addNode({ content: "오늘 커피 마셨다", author: "나" });

    // autoLinkMentions — 본문 부분 매칭으로 mention 엣지 1개
    const mentions = await autoLinkMentions(store, {
      id: nid,
      content: "오늘 커피 마셨다",
    });
    expect(mentions).toBe(1);

    const mentionEdges = await store.listNodeConceptEdges({
      nodeId: nid,
      role: "mention",
    });
    expect(mentionEdges.length).toBe(1);

    // linkAuthorPerson — author + user_id 둘 다 있을 때 persons + authored_by 생성
    const link = await linkAuthorPerson(store, {
      nodeId: nid,
      author: "나",
      metadata: { user_id: "u1", source: "slack" },
    });
    expect(link.personId).not.toBeNull();
    expect(link.personId!.startsWith("psn_")).toBe(true);
    expect(link.edgeAdded).toBe(true);

    const personEdges = await store.listNodePersonEdges({
      nodeId: nid,
      relation: "authored_by",
    });
    expect(personEdges.length).toBe(1);
  });

  // ── 케이스 4: getConceptDirectNeighbors — 1단계만, 2단계 생략 ───────────────

  test("개념 직접 이웃 1단계만 반환 (2단계 형제 개념 제외)", async () => {
    const jjk = await store.findOrCreateTagConcept("주술회전");
    const manga = await store.findOrCreateTagConcept("만화");
    const onepiece = await store.findOrCreateTagConcept("원피스");

    // 주술회전 → 만화 (직접 이웃)
    await store.addConceptEdge({
      sourceConceptId: jjk,
      targetConceptId: manga,
      relation: "parent_of",

      provenance: "user_input",
      sourceNodeId: null,
});
    // 원피스 → 만화 (주술회전 입장에서는 2단계 — 직접 이웃 아님)
    await store.addConceptEdge({
      sourceConceptId: onepiece,
      targetConceptId: manga,
      relation: "parent_of",

      provenance: "user_input",
      sourceNodeId: null,
});

    // 반환 구조: Array<{ concept: ConceptNode; weight: number }>
    const neighbors = await store.getConceptDirectNeighbors(jjk);
    const names = neighbors.map((n) => n.concept.name);

    // 만화는 직접 연결 — 포함
    expect(names).toContain("만화");
    // 원피스는 만화를 거쳐야 닿는 2단계 — 제외
    expect(names).not.toContain("원피스");
  });
});
