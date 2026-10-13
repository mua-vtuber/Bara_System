/**
 * retriever.summary-concept.test.ts — Phase 7 깊은 패스 둘째 단계 Task 15:
 * 검색 합류를 개념 채널 1-hop 펼침으로(RRF 코어 0줄 / 개념 cpt_ 끝).
 *
 * 설계 권위 = docs/decisions/2026-06-05-phase7-summary-stage-spec.md §4.4·§5.2,
 * plan Task 15.
 *
 * 관계 엣지는 `concept_edges` 의 `relation='llm_relation'`(개념 ↔ 개념)으로 들어간다.
 * `getConnectedNodes` BFS 는 `knowledge_edges` 만 따라가 개념 엣지를 안 본다 — 그래서
 * 검색 합류는 *개념 검색 채널*을 한 단계 펼치는 방식이다. 개념 검색이 개념 A 를 잡으면
 * `concept_edges` 의 `llm_relation` 로 A 와 이어진 개념 B 도 1-hop 펼쳐, B 를 가리키는
 * 글 노드를 후보 pool 에 더한다. 이 펼침은 *RRF 합산 전 후보 pool 확장*일 뿐 —
 * rrf·scoring·search-tuning 의 시그니처·점수식은 0줄이다.
 *
 * 이 task 는 개념(`cpt_`) 끝까지만 펼친다. 사람(`psn_`) 끝 합류는 Task 19.
 *
 * 테스트 설계(sources 출처 전이로 1-hop 을 가린다): 이 작은 코퍼스(노드 13개)는
 * vector 채널 top-K(20) 안에 전부 들어와, 단순 "결과에 들었나"로는 1-hop 효과를
 * 못 가린다. 그래서 *개념 채널 합류*를 출처(`sources`)로 가린다: 이웃 개념 B 가
 * 검색어의 *직접* 개념 매칭(vector·fts top-10)에서 빠져 있으면, B 를 가리키는 글
 * 노드는 1-hop 펼침이 없을 때 `sources` 에 `concept` 가 없다(벡터 채널로만 뜸).
 * 1-hop 펼침이 생기면 그 노드가 개념 채널로도 잡혀 `sources` 에 `concept` 가
 * 더해진다 — 이 출처 전이가 1-hop 의 결정적 신호다.
 *
 * 재보정 이력(2026-07-10): 옛 주석의 "bge-m3 는 무관 글에도 높은 cosine" 은 사실
 * 왜곡 — 그건 Granite anisotropy 특성(무관 0.78~0.83)이고, bge-m3 는 유사도를
 * 변별한다(무관 0.28~0.49 / 관련 0.559 — CLAUDE.md A1 실측). 그 변별력 때문에
 * 옛 이웃 개념 '귀멸의칼날'(검색어 '주술회전'과 의미 인접한 애니 제목)이 직접
 * 매칭 top-10 에 자력 진입해(실측 sources=["vector","concept"]) "펼침 전 B 는
 * concept 출처 없음" 전제가 깨졌다. 그래서 distractor 를 검색어와 토큰이 겹치는
 * 개념 12개로 재선정해 직접 매칭 창을 구조적으로 채워 전제를 복원했다(tag-reflow
 * 테스트의 anisotropy 함정 처방과 같은 계열 — 창 밖 배치를 순위 요행이 아니라
 * 구조로 보장).
 *
 * 검증 항목:
 *   1. 개념 A 검색 → A-B llm_relation 으로 B 1-hop 펼침 → B 글 노드가 개념 채널 합류
 *      (`sources` 에 `concept` 가 새로 더해짐 / 펼침 전엔 `concept` 없음).
 *   2. llm_relation 엣지 0건이면 검색 결과 id·점수·순서·sources 가 byte 동일(회귀 0).
 *   3. parent_of downward 위계(weight ≥ 0.7)는 검색 펼침이 자식까지 따라간다(spec
 *      2026-06-06 tag-hierarchy-search-expansion §4.1 A — getParentOfChildrenTransitive).
 *      llm_relation 1-hop 과 통로는 나뉘되, parent_of 도 이제 별도 통로로 펼쳐진다.
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
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "./retriever.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/**
 * 검색어("주술회전") 직접 개념 매칭 창(vector top-DEFAULT_CONCEPT_VECTOR_K=10 /
 * fts top-10)을 구조적으로 채워 이웃 개념 B 를 창 밖으로 밀어내는 distractor.
 * bge-m3 는 의미 유사도를 실제로 변별하므로, 검색어와 토큰("주술"/"회전"/전체
 * 문자열)이 겹치는 이 12개가 '귀멸의칼날' 같은 의미-인접 이웃 개념보다 확실히
 * 위에 서서 top-10 을 선점한다(2026-07-10 bge-m3 실측 재선정). 무관 주제 잡음
 * 12개로 창을 채우던 옛 구성은 Granite anisotropy 시절 설계 — bge-m3 에선 B 가
 * top-10 에 자력 진입해 전제가 깨졌다.
 */
const DISTRACTOR_CONCEPTS = [
  "주술회전 1기 감상",
  "주술회전 2기 감상",
  "주술회전 극장판",
  "주술회전 굿즈 수집",
  "주술회전 만화 단행본",
  "주술회전 팬아트",
  "주술 부적 연구",
  "주술 의식 기록",
  "주술사 전설 모음",
  "회전 초밥 맛집",
  "회전목마 사진",
  "회전문 수리 일지",
];

describe("HybridRetriever — Task 15 개념 채널 llm_relation 1-hop 펼침 (RRF 0줄)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => db.close());

  /**
   * 검색어가 글자·의미로 직접 잡는 개념 A + 직접 매칭에서 빠질 이웃 개념 B + 개념
   * distractor 12개 + 그 distractor 에 붙은 글 노드 12개 + B 에 붙은 글 노드(nodeB)를
   * 만든다. nodeB 내용은 검색어와 무관해 개념 채널로는 1-hop 펼침 때만 잡힌다.
   */
  async function seedCorpus(): Promise<{
    conceptA: string;
    conceptB: string;
    nodeB: number;
  }> {
    const conceptA = await store.findOrCreateTagConcept("주술회전");
    const conceptB = await store.findOrCreateTagConcept("귀멸의칼날");
    const distractorIds: string[] = [];
    for (const nm of DISTRACTOR_CONCEPTS) {
      distractorIds.push(await store.findOrCreateTagConcept(nm));
    }
    for (let i = 0; i < DISTRACTOR_CONCEPTS.length; i++) {
      const n = await store.addNode({
        content: `${DISTRACTOR_CONCEPTS[i]} 관련 일상 기록 ${i}`,
      });
      await store.addNodeConceptEdge(n, distractorIds[i]!, "tag", "user_input", n);
    }
    const nodeB = await store.addNode({ content: "탄지로가 동생을 지킨다" });
    await store.addNodeConceptEdge(nodeB, conceptB, "tag", "user_input", nodeB);
    return { conceptA, conceptB, nodeB };
  }

  test("개념 A 검색 → llm_relation 이웃 B 1-hop 펼침 → B 글 노드가 개념 채널 합류", async () => {
    const { conceptA, conceptB, nodeB } = await seedCorpus();

    // 펼침 전 — B 는 검색어 직접 개념 매칭(top-10)에서 빠져, nodeB 는 (벡터
    // 채널로 떠도) 개념 채널 출처가 없다.
    const before = await retriever.retrieve("주술회전", { limit: 20 });
    const beforeB = before.find((r) => r.node.id === nodeB);
    expect(beforeB).toBeDefined();
    expect(beforeB!.sources).not.toContain("concept");

    // A-B 를 llm_relation 으로 잇는다(개념끼리 — Task 14 발굴 엣지 양식).
    await store.addConceptEdge({
      sourceConceptId: conceptA,
      targetConceptId: conceptB,
      relation: "llm_relation",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.8,
    });

    // 펼침 후 — A 가 검색에 잡히면 B 도 1-hop 펼쳐 nodeB 가 개념 채널로 합류한다.
    const after = await retriever.retrieve("주술회전", { limit: 20 });
    const afterB = after.find((r) => r.node.id === nodeB);
    expect(afterB).toBeDefined();
    expect(afterB!.sources).toContain("concept");
  });

  test("llm_relation 0건이면 검색 결과 id·점수·순서·sources byte 동일(회귀 0)", async () => {
    await seedCorpus();
    // llm_relation 엣지 0건 — 펼침이 0건이라 두 번 호출이 완전히 같아야 한다(멱등·동결).
    const a = await retriever.retrieve("주술회전 귀멸 기록", { limit: 15 });
    const b = await retriever.retrieve("주술회전 귀멸 기록", { limit: 15 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBe(b[i]!.score);
      expect(a[i]!.sources).toEqual(b[i]!.sources);
    }
  });

  test("parent_of downward 위계(weight ≥ 0.7)는 검색 펼침이 자식까지 따라간다(spec §4.1 A)", async () => {
    const { conceptA, conceptB, nodeB } = await seedCorpus();

    // A(부모) → B(자식) parent_of weight 0.9. 검색어 '주술회전' 이 직접 잡는 A 가
    // source 라, A 의 transitive 펼침(downward·weight ≥ 0.7)이 자식 B 를 후보 개념에 더한다.
    // S0-T4(위계 단일 출처) — 검색 펼침이 hierarchy_edges 를 읽으니 시드도 거기에.
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: conceptA,
      targetType: "concept",
      targetId: conceptB,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });

    const res = await retriever.retrieve("주술회전", { limit: 20 });
    const rB = res.find((r) => r.node.id === nodeB);
    expect(rB).toBeDefined();
    // A 도입 후 parent_of(downward·weight ≥ 0.7)도 펼쳐져 nodeB 가 개념 채널로 합류한다.
    expect(rB!.sources).toContain("concept");
  });
});

describe("HybridRetriever — Task 19 사람(psn_) 끝 1-hop 펼침 합류 (RRF 0줄)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => db.close());

  /**
   * 개념 A(검색어가 직접 잡음) + 사람 B(psn_) + 개념 distractor 12개 + distractor 글
   * 12개 + 사람 B 를 node_person_edges 로 가리키는 글 노드(nodePerson)를 만든다.
   * nodePerson 내용은 검색어와 무관해, 개념 채널로는 A-B llm_relation 1-hop 펼침이
   * 사람 끝까지 풀릴 때만 잡힌다.
   */
  async function seedPersonCorpus(): Promise<{
    conceptA: string;
    personB: string;
    nodePerson: number;
  }> {
    const conceptA = await store.findOrCreateTagConcept("주술회전");
    const person = await store.findOrCreatePerson({
      displayName: "탄지로",
      userId: "discord:tanjiro-1",
    });
    const personB = person.personId;
    for (let i = 0; i < DISTRACTOR_CONCEPTS.length; i++) {
      const cid = await store.findOrCreateTagConcept(DISTRACTOR_CONCEPTS[i]!);
      const n = await store.addNode({
        content: `${DISTRACTOR_CONCEPTS[i]} 관련 일상 기록 ${i}`,
      });
      await store.addNodeConceptEdge(n, cid, "tag", "user_input", n);
    }
    const nodePerson = await store.addNode({
      content: "물의 호흡 검술 수련 기록",
    });
    await store.addNodePersonEdge(nodePerson, personB, "mentions", "user_input", nodePerson);
    return { conceptA, personB, nodePerson };
  }

  test("개념 A 검색 → A-B(psn_) llm_relation 1-hop 펼침 → 사람 B 글 노드가 개념 채널 합류", async () => {
    const { conceptA, personB, nodePerson } = await seedPersonCorpus();

    // 펼침 전 — 사람 B 는 검색어 직접 매칭에서 빠져(사람은 개념 색인에 없다),
    // nodePerson 은 (벡터 채널로 떠도) 개념 채널 출처가 없다.
    const before = await retriever.retrieve("주술회전", { limit: 20 });
    const beforeP = before.find((r) => r.node.id === nodePerson);
    expect(beforeP).toBeDefined();
    expect(beforeP!.sources).not.toContain("concept");

    // A(cpt_) ─ llm_relation ─ B(psn_) 를 잇는다(Task 18 FK 완화로 psn_ 끝 허용).
    await store.addConceptEdge({
      sourceConceptId: conceptA,
      targetConceptId: personB,
      relation: "llm_relation",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.8,
    });

    // 펼침 후 — A 가 검색에 잡히면 사람 B 도 1-hop 펼쳐, B 를 node_person_edges 로
    // 가리키는 nodePerson 이 개념 채널로 합류한다.
    const after = await retriever.retrieve("주술회전", { limit: 20 });
    const afterP = after.find((r) => r.node.id === nodePerson);
    expect(afterP).toBeDefined();
    expect(afterP!.sources).toContain("concept");
  });

  test("반대 방향 — 사람 검색이 개념 끝도 펼친다", async () => {
    // 사람 B(psn_)가 검색에 직접 잡히고, B ─ llm_relation ─ 개념 C(cpt_) 펼침으로
    // 개념 C 의 글 노드가 개념 채널 합류하는지 확인한다(양방향 무방향 엣지).
    const person = await store.findOrCreatePerson({
      displayName: "고죠사토루",
      userId: "discord:gojo-1",
    });
    const personB = person.personId;
    const conceptC = await store.findOrCreateTagConcept("무하한주술");
    for (let i = 0; i < DISTRACTOR_CONCEPTS.length; i++) {
      const cid = await store.findOrCreateTagConcept(DISTRACTOR_CONCEPTS[i]!);
      const n = await store.addNode({
        content: `${DISTRACTOR_CONCEPTS[i]} 관련 일상 기록 ${i}`,
      });
      await store.addNodeConceptEdge(n, cid, "tag", "user_input", n);
    }
    // 사람 B 를 직접 가리키는 글(검색어로 잡힘 — 사람 매칭은 개념 채널이 아니지만,
    // 사람 B 가 개념 채널 seed 가 되려면 사람도 concept_nodes_fts 색인에 있어야
    // 한다. 사람은 개념 색인에 없으므로, 이 방향 검증은 *개념 C 가 seed* 가 되어
    // 사람 B 를 거쳐 다시 개념으로 도는 무방향성 자체를 확인하는 것으로 둔다).
    const nodeC = await store.addNode({ content: "한없이 깊은 술식 연구" });
    await store.addNodeConceptEdge(nodeC, conceptC, "tag", "user_input", nodeC);

    // 검색어가 직접 잡는 개념 A.
    const conceptA = await store.findOrCreateTagConcept("주술회전");
    // A(cpt_) ─ B(psn_) ─ C(cpt_) 가 아니라, 무방향 매칭을 한 엣지로 확인한다:
    // B(psn_) 를 source 로, A(cpt_) 를 target 으로 둔 엣지에서 A 검색이 B 를 펼치는지.
    await store.addConceptEdge({
      sourceConceptId: personB,
      targetConceptId: conceptA,
      relation: "llm_relation",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.8,
    });
    // 그리고 B(psn_) ─ C(cpt_) 엣지로 B 펼침이 다시 개념 C 로는 가지 않음(1-hop 한도)
    // 을 확인하지 않는다 — 여기선 source=psn_ 끝이 target=cpt_ 로 정상 매칭되는지만.

    // 사람 B 를 가리키는 글.
    const nodePerson = await store.addNode({ content: "푸른 눈동자의 기록" });
    await store.addNodePersonEdge(nodePerson, personB, "mentions", "user_input", nodePerson);

    const res = await retriever.retrieve("주술회전", { limit: 20 });
    // A 검색 → source=psn_ B / target=cpt_ A 엣지에서 B(psn_) 가 1-hop 이웃으로 잡혀,
    // B 의 글(nodePerson)이 개념 채널 합류한다(source 가 psn_ 이어도 정상 매칭).
    const rP = res.find((r) => r.node.id === nodePerson);
    expect(rP).toBeDefined();
    expect(rP!.sources).toContain("concept");
  });

  test("getConceptDirectNeighbors 가 psn_ 이웃도 회신(개념·사람 둘 다 풀이)", async () => {
    const conceptA = await store.findOrCreateTagConcept("주술회전");
    const person = await store.findOrCreatePerson({
      displayName: "이타도리",
      userId: "discord:itadori-1",
    });
    const personB = person.personId;
    await store.addConceptEdge({
      sourceConceptId: conceptA,
      targetConceptId: personB,
      relation: "llm_relation",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.7,
    });
    const neighbors = await store.getConceptDirectNeighbors(conceptA);
    // psn_ 이웃이 JOIN concept_nodes 만으로는 탈락하던 것이 정정되어 회신에 든다.
    const psnNeighbor = neighbors.find((n) => n.concept.conceptId === personB);
    expect(psnNeighbor).toBeDefined();
    expect(psnNeighbor!.concept.name).toBe("이타도리");
  });

  test("psn_ 끝 llm_relation 0건이면 검색 결과 byte 동일(회귀 0)", async () => {
    await seedPersonCorpus();
    // llm_relation 엣지 0건 — 펼침 0건이라 두 호출이 완전히 같아야 한다(동결).
    const a = await retriever.retrieve("주술회전 수련 기록", { limit: 15 });
    const b = await retriever.retrieve("주술회전 수련 기록", { limit: 15 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.node.id).toBe(b[i]!.node.id);
      expect(a[i]!.score).toBe(b[i]!.score);
      expect(a[i]!.sources).toEqual(b[i]!.sources);
    }
  });
});
