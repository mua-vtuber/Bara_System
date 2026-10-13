/**
 * tag-reflow.test.ts — spec §4.2.3 B3. reflowFlatParentTags 헬퍼 단위 + 실패 격리.
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 클래스 0.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { reflowFlatParentTags, REFLOW_TRIGGER_LABEL, type ReflowStore } from "./tag-reflow.ts";
import { DEFAULT_CONCEPT_VECTOR_K, HybridRetriever } from "./retriever.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("reflowFlatParentTags — 자동 재정리 헬퍼(B3)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  /** 작품(부모)+주술회전(자식) 둘 다 붙은 과거 글 + 위계 선언. */
  async function seedFlatAndDeclare(): Promise<{ category: string; value: string; node: number }> {
    const category = await store.findOrCreateTagConcept("작품");
    const value = await store.findOrCreateTagConcept("주술회전");
    const node = await store.addNode({ content: "주술회전 8권 샀다" });
    await store.addNodeConceptEdge(node, category, "tag", "user_input", node);
    await store.addNodeConceptEdge(node, value, "tag", "user_input", node);
    // 콜론 위계 선언(category → value parent_of 0.9).
    await store.addConceptEdge({ sourceConceptId: category, targetConceptId: value, relation: "parent_of", weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    return { category, value, node };
  }

  test("평평하게 붙은 과거 글의 부모 연결을 떼고 자식은 남긴다", async () => {
    const { category, value, node } = await seedFlatAndDeclare();
    await reflowFlatParentTags(store, category, value, "category→value");
    const tags = await store.listNodeConceptEdges({ nodeId: node, role: "tag" });
    const ids = tags.map((e) => e.conceptId);
    expect(ids).not.toContain(category);
    expect(ids).toContain(value);
  });

  test("평평하게 붙은 글 0건이면 no-op(throw 0)", async () => {
    const category = await store.findOrCreateTagConcept("작품");
    const value = await store.findOrCreateTagConcept("주술회전");
    await store.addConceptEdge({ sourceConceptId: category, targetConceptId: value, relation: "parent_of", weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});
    const result = await reflowFlatParentTags(store, category, value, "category→value");
    expect(result).toBeUndefined();
  });

  test("한 글에서 detach 가 throw 하면 warn 후 다음 글로 진행한다(글 단위 격리)", async () => {
    // 평평하게 붙은 글 두 개를 만든다. 첫 글에서 일부러 detach 를 실패시켜
    // 둘째 글이 그대로 떼이는지(격리) 확인한다 — 실 store 위에 한 노드만 throw 시키는
    // 얇은 위임 객체(실 데이터는 모두 실 SqliteMemoryStore 가 처리).
    const category = await store.findOrCreateTagConcept("작품");
    const value = await store.findOrCreateTagConcept("주술회전");
    const failNode = await store.addNode({ content: "주술회전 1권" });
    const okNode = await store.addNode({ content: "주술회전 2권" });
    for (const n of [failNode, okNode]) {
      await store.addNodeConceptEdge(n, category, "tag", "user_input", n);
      await store.addNodeConceptEdge(n, value, "tag", "user_input", n);
    }
    await store.addConceptEdge({ sourceConceptId: category, targetConceptId: value, relation: "parent_of", weight: 0.9 ,
    provenance: "user_input",
    sourceNodeId: null,
});

    // 실 store 를 감싸 failNode 에서만 throw — 나머지 호출은 실 store 에 위임.
    const detachCalls: number[] = [];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    const failingStore: ReflowStore = {
      findFlatParentTagNodes: (parentConceptId, childConceptIds) =>
        store.findFlatParentTagNodes(parentConceptId, childConceptIds),
      detachParentTagEdge: async (nodeId, parentConceptId, triggerHierarchy) => {
        detachCalls.push(nodeId);
        if (nodeId === failNode) {
          throw new Error("detach 강제 실패(테스트)");
        }
        return store.detachParentTagEdge(nodeId, parentConceptId, triggerHierarchy);
      },
    };

    try {
      await reflowFlatParentTags(failingStore, category, value, "category→value");
    } finally {
      console.warn = originalWarn;
    }

    // 두 글 모두 detach 시도 — failNode 실패가 okNode 진행을 막지 않았다.
    expect(detachCalls).toContain(failNode);
    expect(detachCalls).toContain(okNode);
    // 실패 글은 warn 으로 정직하게 남겼다(silent 아님). 메시지에 node_id·categoryId 포함.
    expect(warnings.length).toBe(1);
    const warnMsg = String(warnings[0]?.[0] ?? "");
    expect(warnMsg).toContain(String(failNode));
    expect(warnMsg).toContain(category);
    // 격리 결과 — okNode 는 실제로 부모 연결이 떼였고, failNode 는 부모가 남아 있다.
    const okTags = (await store.listNodeConceptEdges({ nodeId: okNode, role: "tag" })).map((e) => e.conceptId);
    expect(okTags).not.toContain(category);
    expect(okTags).toContain(value);
    const failTags = (await store.listNodeConceptEdges({ nodeId: failNode, role: "tag" })).map((e) => e.conceptId);
    expect(failTags).toContain(category);
  });
});

/**
 * TB4 — B 통합 검증. 평평하게 붙은 과거 글(부모+자식 둘 다 role='tag')을 만든 뒤
 * 실제 선언 *통로* `addClassificationTag(declNode, category, value)` 로 콜론 위계를
 * 선언하면, B3 자동 트리거(addClassificationTag 안의 reflowFlatParentTags 호출)가 가동해
 *   (1) 과거 글에서 부모 연결이 떼이고 자식 연결은 남으며,
 *   (2) tag_reflow_log 에 그 글 기록이 1건 남고(parent_concept_id·trigger_hierarchy),
 *   (3) 떼인 글이 '부모' 검색에 A 펼침(parent_of transitive)으로 도달하며,
 *   (4) 같은 위계를 2회 선언해도 두 번 떼지 않고 기록도 1건뿐(idempotent)
 * 임을 실 임베딩으로 증명한다. A(TA1~TA3)+B(TB1~TB3) 가 합쳐져 작동하는 최종 증거다.
 *
 * anisotropy 함정(TA3 검토 Critical 교훈 정합): bge-m3 는 무관 어휘에도 높은 cosine 을
 * 줘, 짧은 개념 풀에서는 자식 개념이 부모 검색의 *직접* vector 매칭 창
 * (top-DEFAULT_CONCEPT_VECTOR_K=10)에 끼어들 수 있다. 그러면 떼인 글이 concept 출처를
 * 얻어도 그건 펼침 도달이 아니라 직접 매칭이라 (3) 가드가 무효가 된다(옛 작품/주술회전
 * fixture 의 함정). 그래서 부모(검색어)·자식 이름을 임베딩 거리가 충분히 먼 무관 어휘
 * (TA3 와 같은 '심해어류관측소'/'수학정리증명')로 두고, 자식을 부모 검색 top-10 밖으로
 * 밀어낼 distractor 16개를 채운다. 그 전제를 (3) 케이스가 스스로 단언해
 * (assertChildOutsideDirectMatch) 고정하고, 위계 펼침 엣지가 없을 때 vs 있을 때를 음성
 * 대조해 검색 도달이 *오직 펼침*에서 옴을 가린다.
 */
describe("자동 재정리 통합 — 콜론 선언 통로 → 떼임·기록·검색 도달(TB4)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => db.close());

  // 검색어(PARENT)와 비교적 가까워 직접 매칭 top-10 을 점유하는 distractor.
  // 이들이 자리를 채워 무관한 자식(LEAF)을 top-10 밖으로 밀어낸다(TA3 검증 설계 정합).
  const DISTRACTORS = [
    "열대우림탐사", "빙하지질조사", "항공역학계산", "미생물배양실", "발레무용단",
    "천문관측일지", "향수조향법", "건축설계도면", "교향곡악보", "법전조항해설",
    "화산암석표본", "도자기가마터", "전자회로기판", "해양생물도감", "극지방탐험대",
    "사막기후연구",
  ];

  // 부모(category) = 검색어. 자식(value) = 무관 어휘(부모 검색 top-10 밖).
  // 떼임·기록 케이스는 검색을 안 거치므로 어휘 선택과 무관하나, 한 fixture 양식을 통일해
  // 두면 셋째 케이스가 같은 통로로 쌓인 글에 그대로 적용된다.
  const PARENT = "심해어류관측소"; // category = 검색어(top-1 직접 매칭 → 펼침 seed)
  const LEAF = "수학정리증명";     // value = 무관 어휘(부모 검색 top-10 밖)

  /**
   * 부모(category)+자식(value) 둘 다 role='tag' 로 붙은 과거 평평 글을 만든다. 개념 노드는
   * addClassificationTag 가 같은 이름으로 다시 찾을 때 같은 cpt_ id 로 합류하므로(이름
   * UNIQUE + 역할 OR 합류), 미리 tag 로 붙여 둔 부모·자식이 선언 통로의 부모·자식과 같은
   * 개념이다 — 그래서 선언이 과거 글을 재정리 대상으로 인식한다.
   */
  async function seedFlatNode(content: string): Promise<{
    category: string; value: string; node: number;
  }> {
    const category = await store.findOrCreateTagConcept(PARENT);
    const value = await store.findOrCreateTagConcept(LEAF);
    const node = await store.addNode({ content });
    await store.addNodeConceptEdge(node, category, "tag", "user_input", node);
    await store.addNodeConceptEdge(node, value, "tag", "user_input", node);
    return { category, value, node };
  }

  /** distractor 16개를 개념 + 글로 채워 직접 매칭 top-10 을 점유하게 한다. */
  async function seedDistractors(): Promise<void> {
    for (let i = 0; i < DISTRACTORS.length; i++) {
      const cid = await store.findOrCreateTagConcept(DISTRACTORS[i]!);
      const n = await store.addNode({ content: `${DISTRACTORS[i]} 관련 일상 기록 ${i}` });
      await store.addNodeConceptEdge(n, cid, "tag", "user_input", n);
    }
  }

  /**
   * 전제 고정 — 자식 개념(valueId)이 부모 검색어의 *직접* vector 매칭 창
   * (top-DEFAULT_CONCEPT_VECTOR_K)에 *안 든다*. 들면 펼침과 직접 매칭이 안 갈려 셋째
   * 케이스의 가드가 무효이므로 여기서 loud fail 한다(anisotropy 재침입 자가 차단).
   */
  async function assertChildOutsideDirectMatch(valueId: string): Promise<void> {
    const qv = await embedder.embed(PARENT);
    const directHits = await store.searchConceptsByVector(qv, DEFAULT_CONCEPT_VECTOR_K);
    const directIds = directHits.map((h) => h.conceptId);
    expect(directIds).not.toContain(valueId);
  }

  test("addClassificationTag 선언 → 과거 평평 글 부모 떼임·자식 남음·기록 1건", async () => {
    const { category, value, node } = await seedFlatNode("그날 산책길 노을이 길었다");

    // 콜론 위계 선언 — addClassificationTag 통로가 B3 자동 트리거를 가동한다.
    // (직접 detach 호출이 아니라 통로가 reflow 를 부르는 경로를 검증.)
    const declNode = await store.addNode({ content: "분류 선언용 글" });
    await store.addClassificationTag(declNode, PARENT, LEAF, "user_input", declNode);

    // 과거 평평 글에서 부모(category) tag 는 떼이고 자식(value) tag 는 남는다.
    const tags = await store.listNodeConceptEdges({ nodeId: node, role: "tag" });
    const ids = tags.map((e) => e.conceptId);
    expect(ids).not.toContain(category);
    expect(ids).toContain(value);

    // tag_reflow_log 에 그 글 기록 1건 — parent_concept_id·trigger_hierarchy 확인.
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c, MAX(parent_concept_id) AS pid, MAX(trigger_hierarchy) AS trig FROM tag_reflow_log WHERE node_id=?",
      )
      .get(node) as { c: number; pid: string; trig: string };
    expect(row.c).toBe(1);
    expect(row.pid).toBe(category);
    expect(row.trig).toBe(REFLOW_TRIGGER_LABEL);
  });

  test("상위 reflow 실패(findFlatParentTagNodes throw) 격리 — 선언 보존·warn 1건", async () => {
    // 자동 재정리의 *상위* 단계(findFlatParentTagNodes 자체)가 DB 오류로 throw 하는 경우.
    // 헬퍼 안 글 단위 격리(detach 실패)보다 한 층 위라 헬퍼가 아니라 호출자(addClassificationTag)
    // 가 잡아야 한다. 격리되면 (1) parent_of 위계 선언은 그대로 남고 (2) warn 1건이 정직하게
    // 남는다(silent fallback 아님). 실 store 한 메서드만 throw 시키는 얇은 위임(실 데이터는
    // 모두 실 SqliteMemoryStore 처리, mock 클래스 0).
    const { category, value } = await seedFlatNode("바닷가 모래가 따뜻했다");

    // findFlatParentTagNodes 만 throw 로 갈아끼운다 — 나머지 동작은 실 store 그대로.
    const originalFind = store.findFlatParentTagNodes.bind(store);
    store.findFlatParentTagNodes = async () => {
      throw new Error("findFlatParentTagNodes 강제 실패(테스트)");
    };
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const declNode = await store.addNode({ content: "분류 선언용 글" });
    try {
      // 상위 실패가 격리되면 addClassificationTag 는 throw 없이 끝난다.
      await store.addClassificationTag(declNode, PARENT, LEAF, "user_input", declNode);
    } finally {
      console.warn = originalWarn;
      store.findFlatParentTagNodes = originalFind;
    }

    // (1) 위계 선언(parent_of) 은 자동 정리 실패와 무관하게 보존된다.
    //     S0-T4 — addClassificationTagFlow 의 위계 쓰기가 hierarchy_edges 로 옮겨졌으니
    //     보존도 그 테이블에서 확인한다(concept_edges 아님).
    const hasDecl =
      db
        .prepare(
          `SELECT 1 FROM hierarchy_edges
           WHERE relation = 'parent_of'
             AND source_type = 'concept' AND source_id = ?
             AND target_type = 'concept' AND target_id = ?`,
        )
        .get(category, value) != null;
    expect(hasDecl).toBe(true);

    // (2) 실패는 warn 으로 정직하게 남았다(silent 아님). 메시지에 라벨 식별 포함.
    expect(warnings.length).toBe(1);
    const warnMsg = String(warnings[0]?.[0] ?? "");
    expect(warnMsg).toContain(category);
    expect(warnMsg).toContain(`${PARENT}:${LEAF}`);
  });

  test("idempotent — 같은 위계 2회 선언해도 두 번 안 떼고 기록 1건", async () => {
    const { category, node } = await seedFlatNode("창밖 비가 오래 내렸다");

    // 두 번 선언(서로 다른 선언 글)해도 두 번째엔 떼어낼 평평 글이 없어 no-op.
    const d1 = await store.addNode({ content: "선언1" });
    await store.addClassificationTag(d1, PARENT, LEAF, "user_input", d1);
    const d2 = await store.addNode({ content: "선언2" });
    await store.addClassificationTag(d2, PARENT, LEAF, "user_input", d2);

    // 부모는 첫 선언에서 한 번만 떼였다 — 자식은 여전히 남아 있다.
    const ids = (await store.listNodeConceptEdges({ nodeId: node, role: "tag" })).map((e) => e.conceptId);
    expect(ids).not.toContain(category);

    // 두 번째 선언이 기록을 중복 INSERT 하지 않는다 — 기록 1건뿐.
    const logCnt = (
      db.prepare("SELECT COUNT(*) AS c FROM tag_reflow_log WHERE node_id=?").get(node) as { c: number }
    ).c;
    expect(logCnt).toBe(1);
  });

  test("떼인 글이 '부모' 검색에 A 펼침으로 도달 + 음성 대조(펼침 없으면 안 도달)", async () => {
    // 음성 대조 — 위계 펼침 엣지가 *없는* 상태. 부모(category) tag 를 직접 떼서, 떼인 뒤
    // 펼침 seed(parent_of 엣지)가 없을 때 자식 글이 부모 검색의 개념 채널에 *안* 잡힘을
    // 보인다. 자식은 직접 매칭 top-10 밖이라(전제 단언) 도달할 길이 펼침뿐인데 그 펼침이
    // 없으므로 concept 출처 0 이어야 한다. 이것이 "검색 도달은 오직 펼침에서 온다"의 대조.
    {
      const { category, value, node } = await seedFlatNode("그날 빵집 크림빵이 달았다");
      await seedDistractors();
      await assertChildOutsideDirectMatch(value);
      // 부모 tag 만 직접 떼고 위계 엣지는 안 깐다(펼침 seed 부재 상태 재현).
      await store.detachParentTagEdge(node, category, "테스트-음성대조");
      const neg = await retriever.retrieve(PARENT, { limit: 20 });
      const rNeg = neg.find((x) => x.node.id === node);
      if (rNeg) expect(rNeg.sources).not.toContain("concept");
    }

    // 양성 — 실제 통로(addClassificationTag)로 선언하면 부모→자식 parent_of 펼침이 깔리고
    // 부모 tag 가 떼인 같은 양식 글이 부모 검색에 개념 채널로 합류(펼침 도달).
    {
      db.close();
      db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
      store = new SqliteMemoryStore(db, embedder);
      retriever = new HybridRetriever(store, embedder);

      const { value, node } = await seedFlatNode("그날 빵집 크림빵이 달았다");
      await seedDistractors();
      await assertChildOutsideDirectMatch(value);

      const declNode = await store.addNode({ content: "분류 선언용 글" });
      await store.addClassificationTag(declNode, PARENT, LEAF, "user_input", declNode);

      // 부모 연결은 떼였지만 부모→자식 위계가 있어 '부모' 검색이 자식 통해 도달한다.
      const res = await retriever.retrieve(PARENT, { limit: 20 });
      const r = res.find((x) => x.node.id === node);
      expect(r).toBeDefined();
      expect(r!.sources).toContain("concept");
    }
  });
});
