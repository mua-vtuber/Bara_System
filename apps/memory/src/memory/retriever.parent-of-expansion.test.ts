/**
 * retriever.parent-of-expansion.test.ts — spec §4.1 A2·A3 TA2.
 * parent_of 검색 펼침 합류의 회귀 가드(byte 동일) + 상수 export 확인.
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import {
  DEFAULT_CONCEPT_VECTOR_K,
  HybridRetriever,
  PARENT_OF_EXPANSION_MIN_WEIGHT,
  PARENT_OF_EXPANSION_LIMIT,
} from "./retriever.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("HybridRetriever — parent_of 검색 펼침(TA2 회귀 가드)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => db.close());

  test("상수 export — 임계 0.7 / 상한 40 (단일 출처)", () => {
    expect(PARENT_OF_EXPANSION_MIN_WEIGHT).toBe(0.7);
    expect(PARENT_OF_EXPANSION_LIMIT).toBe(40);
  });

  test("parent_of 0건이면 검색 결과 id·점수·순서·sources byte 동일(회귀 0)", async () => {
    const jjk = await store.findOrCreateTagConcept("주술회전");
    const n = await store.addNode({ content: "탄지로가 동생을 지킨다" });
    await store.addNodeConceptEdge(n, jjk, "tag", "user_input", n);
    const a = await retriever.retrieve("주술회전 기록", { limit: 15 });
    const b = await retriever.retrieve("주술회전 기록", { limit: 15 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBe(b[i]!.score);
      expect(a[i]!.sources).toEqual(b[i]!.sources);
    }
  });
});

/**
 * TA3 — A 통합 검증. 콜론 위계(루트→심해어류관측소→수학정리증명)를 깔고 부모
 * ('심해어류관측소')로 검색하면 잎(수학정리증명) 태그만 붙은 글이 개념 채널로 합류함을
 * (sources 에 concept 전이) 실 임베딩으로 증명한다. 글에는 잎 자식 태그만 붙이고 부모는
 * 안 붙인 상태라, 부모로 그 글이 개념 채널에 잡히면 = transitive 펼침이 자식 글까지
 * 도달한 증거다.
 *
 * anisotropy 함정(검토 Critical 정합): bge-m3 는 무관 어휘에도 높은 cosine 을 줘, 짧은
 * 개념 풀에서는 자식 개념이 부모 검색의 *직접* vector 매칭 창(top-DEFAULT_CONCEPT_VECTOR_K
 * =10)에 끼어들 수 있다. 그러면 자식 글이 concept 출처를 얻어도 그건 펼침 도달이 아니라
 * 직접 매칭이라 가드가 무효가 된다(옛 만화/주술회전 fixture 실패 사례 — 주술회전이 '만화'
 * top-10 rank-4 로 직접 매칭됨). 그래서 자식 이름을 부모 검색어와 임베딩 거리가 가장 먼
 * 무관 어휘("수학정리증명", 부모 대비 코사인 0.70)로 두고 distractor 를 부모와 더 가까운
 * 어휘 16개로 채워, 자식이 top-10 밖으로 밀려나게 한다. 그 전제를 테스트가 스스로 단언해
 * (assertChildOutsideDirectMatch) 고정하고, 위계 없을 때 vs 있을 때를 음성 대조해 차이가
 * 오직 펼침에서 옴을 증명한다.
 */
describe("HybridRetriever — parent_of 사슬 펼침 통합(TA3)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => db.close());

  // 검색어 '심해어류관측소'와 비교적 가까워 직접 매칭 top-10 을 점유하는 distractor.
  // 이들이 자리를 채워 무관한 자식 '수학정리증명'을 top-10 밖으로 밀어낸다.
  const DISTRACTORS = [
    "열대우림탐사", "빙하지질조사", "항공역학계산", "미생물배양실", "발레무용단",
    "천문관측일지", "향수조향법", "건축설계도면", "교향곡악보", "법전조항해설",
    "화산암석표본", "도자기가마터", "전자회로기판", "해양생물도감", "극지방탐험대",
    "사막기후연구",
  ];

  const ROOT = "작품루트동결";       // 최상위 부모(검색에 직접 안 잡혀도 됨)
  const PARENT = "심해어류관측소";   // 중간 부모 = 검색어(top-1 직접 매칭 → 펼침 seed)
  const LEAF = "수학정리증명";       // 잎 자식 = 무관 어휘(부모 검색 top-10 밖)

  /**
   * distractor + 세 위계 개념을 만들고 잎 태그만 붙은 글(leafNode)을 만든다. parent_of
   * 위계 엣지는 withHierarchy=true 일 때만 깐다 — 음성 대조용.
   */
  async function seedChain(withHierarchy: boolean): Promise<{
    rootId: string; parentId: string; leafId: string; leafNode: number;
  }> {
    const rootId = await store.findOrCreateTagConcept(ROOT);
    const parentId = await store.findOrCreateTagConcept(PARENT);
    const leafId = await store.findOrCreateTagConcept(LEAF);
    if (withHierarchy) {
      // S0-T4(위계 단일 출처) — 검색 펼침이 hierarchy_edges 를 읽으니 시드도 거기에.
      store.addHierarchyEdge({ sourceType: "concept", sourceId: rootId, targetType: "concept", targetId: parentId, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
      store.addHierarchyEdge({ sourceType: "concept", sourceId: parentId, targetType: "concept", targetId: leafId, weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    }
    for (let i = 0; i < DISTRACTORS.length; i++) {
      const cid = await store.findOrCreateTagConcept(DISTRACTORS[i]!);
      const n = await store.addNode({ content: `${DISTRACTORS[i]} 관련 일상 기록 ${i}` });
      await store.addNodeConceptEdge(n, cid, "tag", "user_input", n);
    }
    // 잎 태그만 붙은 글 — 본문은 부모·잎 검색어와 무관해, 부모 검색으로 개념 채널에
    // 잡힐 길은 오직 위계 펼침뿐이다(직접 매칭 아님).
    const leafNode = await store.addNode({ content: "그날 빵집에서 산 크림빵이 맛있었다" });
    await store.addNodeConceptEdge(leafNode, leafId, "tag", "user_input", leafNode);
    return { rootId, parentId, leafId, leafNode };
  }

  /**
   * 전제 고정 — 자식 개념(leafId)이 부모 검색어의 *직접* vector 매칭 창
   * (top-DEFAULT_CONCEPT_VECTOR_K)에 *안 든다*. 들면 펼침과 직접 매칭이 안 갈려 가드가
   * 무효이므로 여기서 loud fail 한다(anisotropy 재침입 방지 — 테스트가 스스로 보장).
   */
  async function assertChildOutsideDirectMatch(leafId: string): Promise<void> {
    const qv = await embedder.embed(PARENT);
    const directHits = await store.searchConceptsByVector(qv, DEFAULT_CONCEPT_VECTOR_K);
    const directIds = directHits.map((h) => h.conceptId);
    expect(directIds).not.toContain(leafId);
  }

  test("'부모' 검색 → 루트→부모→잎 펼침으로 잎 글이 개념 채널 합류 + 음성 대조(위계 없으면 안 합류)", async () => {
    // 1) 음성 대조 — 위계 엣지 없으면 잎 글은 부모 검색의 개념 채널에 안 잡힌다
    //    (자식이 직접 매칭 밖 + 펼칠 위계 없음 → concept 출처 0).
    {
      const { leafId, leafNode } = await seedChain(false);
      await assertChildOutsideDirectMatch(leafId);
      const res = await retriever.retrieve(PARENT, { limit: 20 });
      const r = res.find((x) => x.node.id === leafNode);
      // 결과에 안 들거나, 들어도 벡터 잡음뿐 — concept 출처는 없다.
      if (r) expect(r.sources).not.toContain("concept");
    }
    // 2) 양성 — 위계 엣지를 깔면 같은 잎 글이 부모 검색으로 개념 채널 합류(펼침 도달).
    {
      db.close();
      db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
      store = new SqliteMemoryStore(db, embedder);
      retriever = new HybridRetriever(store, embedder);
      const { leafId, leafNode } = await seedChain(true);
      await assertChildOutsideDirectMatch(leafId);
      const res = await retriever.retrieve(PARENT, { limit: 20 });
      const r = res.find((x) => x.node.id === leafNode);
      expect(r).toBeDefined();
      expect(r!.sources).toContain("concept");
    }
  });

  test("'잎' 검색 → 펼칠 자식 없어 후보 안 넓어짐", async () => {
    const { leafId, leafNode } = await seedChain(true);
    // 잎으로 검색해도 그 글은 직접 매칭으로 잡힌다(개념 채널). 단 그 아래 자식이 없어
    // parent_of 펼침이 새 후보를 0건 더한다 — leaf=좁게 통찰. 검색 펼침은
    // hierarchy_edges 를 읽으므로(getHierarchyChildrenTransitive) 시드와 같은 통로로 조회.
    const children = store.getHierarchyChildrenTransitive([leafId], 0.7, 40);
    expect(children).toEqual([]);
    const res = await retriever.retrieve(LEAF, { limit: 20 });
    expect(res.find((x) => x.node.id === leafNode)).toBeDefined();
  });

  test("옛 순서 위계 weight 0.3 자식은 '부모' 펼침에 안 걸림(0.7 미만 거름)", async () => {
    const { parentId } = await seedChain(true);
    // 자식 이름·글 본문은 검색어와 어휘·의미 거리를 둔다 — anisotropy 로 자식 개념이
    // 검색어의 *직접* vector 매칭에 끼어들면 펼침과 직접 매칭이 안 갈린다(검토 Critical).
    const weakChild = await store.findOrCreateTagConcept("고대문자해독집");
    // S0-T4(위계 단일 출처) — 검색 펼침이 hierarchy_edges 를 읽으니 시드도 거기에.
    store.addHierarchyEdge({ sourceType: "concept", sourceId: parentId, targetType: "concept", targetId: weakChild, weight: 0.3 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    const weakNode = await store.addNode({ content: "전혀 무관한 고대 점토판 판독 일지" });
    await store.addNodeConceptEdge(weakNode, weakChild, "tag", "user_input", weakNode);

    // 펼침 함수 단독 — 부모의 0.7 이상 자식만 회신하고 0.3 자식(weakChild)은 빠진다.
    // 이것이 "0.3 위계를 retriever 가 펼침으로 안 따라간다"의 결정적 증거다. 펼침은
    // hierarchy_edges 를 읽으므로(getHierarchyChildrenTransitive) 시드와 같은 통로로 조회.
    const expanded = store.getHierarchyChildrenTransitive([parentId], 0.7, 40);
    expect(expanded).not.toContain(weakChild);

    // 펼침으로 안 따라가므로 weakNode 는 개념 채널 출처가 없다(벡터 잡음으로만 뜸).
    const res = await retriever.retrieve(PARENT, { limit: 20 });
    const r = res.find((x) => x.node.id === weakNode);
    if (r) expect(r.sources).not.toContain("concept");
  });
});
