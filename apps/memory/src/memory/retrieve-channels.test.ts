/**
 * retrieve-channels.test.ts — 위계 펼침 → 엔티티 행 → 글 도달 통합 검증 (S1-T2).
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store 로 통합 검증한다(CLAUDE.md "DB/임베딩
 * 의존 모듈은 실제 구현체와 통합 검증"). 데이터 fixture(입력 글)만 쓴다.
 *
 * 배경(위계 단일 출처 Stage 1):
 *   S1-T1 에서 person 행이 위계 잎이 됐다 — `#사람:인영희 #관계:가족 #가족:엄마` 입력 시
 *   hierarchy_edges 에 사람루트→가족·가족→엄마·엄마(개념)→psn_인영희(target_type='person')
 *   사슬이 선다(그림자 "인영희" 개념 0). 검색 위계 펼침이 person 행 id 를 자식으로 회신할 때
 *   그 행을 언급한 글에 닿아야 한다.
 *
 * 검증 통로(코드 변경 0 — 이미 존재하는 통로가 끊기지 않음을 실증):
 *   1. wireHashtagEntities 가 `#사람:인영희` 에서 person 행 생성 + node_person_edges(글→사람
 *      mentions) 언급 엣지를 세운다.
 *   2. wirePersonHierarchy 가 hierarchy_edges 에 엄마(개념)→psn_인영희 위계 엣지를 세운다.
 *   3. getHierarchyChildrenTransitive("가족" 개념 seed) 가 psn_인영희 를 자식으로 회신한다
 *      (위계 펼침·종류 혼합 id·weight ≥ 0.7).
 *   4. getNodesByConcepts(psn_ 분기·search-repository.ts:707) 가 그 person 행 id 를
 *      node_person_edges 로 풀어 인영희 언급 글 node_id 를 후보에 더한다.
 *
 * 시나리오 1 — person 위계 잎 검색 도달(핵심). 펼침이 끊겼으면 글이 결과에서 빠져 회귀 잡힘.
 * 시나리오 2 — RRF 0 diff 가드. 위계 펼침 자식 0 건 검색어는 person 위계 글 추가 전/후 결과
 *             byte 동일(spec §7.2 "펼친 자식 0건이면 후보 목록 불변").
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
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";
import { wirePersonHierarchy } from "./person-hierarchy-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import {
  PARENT_OF_EXPANSION_MIN_WEIGHT,
  PARENT_OF_EXPANSION_LIMIT,
  DEFAULT_CONCEPT_NODE_LIMIT,
} from "./retrieve-constants.ts";
import { collectConceptChannel } from "./retrieve-channels.ts";
import { resolveRetrieveConfig } from "./retrieve-config.ts";

describe("retrieve-channels — 위계 펼침 → person 행 → 글 도달 (S1-T2)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    resetConceptTypeVocabularyCache();
    resetClassifierCache();
  });
  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** origin 글 노드 하나를 실제로 만들어 id 를 돌려준다. */
  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /**
   * `#사람:인영희 #관계:가족 #가족:엄마` 글을 입력 통로로 넣는다 — 행 생성·언급·위계가
   * 실제 통로(wireHashtagEntities → wirePersonHierarchy)로 같이 돈다. 입력 통로 순서
   * 재현(memories.ts:155→167·ingest.ts:288→295 — 행 생성이 위계보다 먼저).
   */
  async function ingestPersonHierarchy(
    content: string,
  ): Promise<{ origin: number; personId: string }> {
    const origin = await makeOrigin(content);
    // 1) 행 생성 + 글→사람 mention(node_person_edges).
    await wireHashtagEntities(store, origin, content);
    // 2) 위계(엄마 개념 → psn_인영희) 세우기.
    await wirePersonHierarchy(store, origin, content);
    const found = await store.findPersonByNameOrAlias("인영희");
    if (found.person === null) {
      throw new Error("테스트 전제 실패 — 인영희 person 행이 입력 통로로 안 생겼다");
    }
    return { origin, personId: found.person.personId };
  }

  // ── 시나리오 1 — person 위계 잎 검색 도달 (핵심) ────────────────────────────

  test("위계 펼침이 person 행 id 를 자식으로 회신한다(가족 → psn_인영희)", async () => {
    const { personId } = await ingestPersonHierarchy(
      "#사람:인영희 #관계:가족 #가족:엄마",
    );

    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });

    // 가족 개념을 seed 로 한 위계 펼침이 사슬 끝 person 행까지 BFS 로 회신한다.
    const children = store.getHierarchyChildrenTransitive(
      [family],
      PARENT_OF_EXPANSION_MIN_WEIGHT,
      PARENT_OF_EXPANSION_LIMIT,
    );

    // 가족 → 엄마(개념) → 인영희(person 행). person 행 id 가 자식 집합에 섞여 있다.
    expect(children).toContain(personId);
    expect(personId.startsWith("psn_")).toBe(true);
  });

  test("getNodesByConcepts 가 person 행 id 를 node_person_edges 로 글에 푼다", async () => {
    const { origin, personId } = await ingestPersonHierarchy(
      "#사람:인영희 #관계:가족 #가족:엄마",
    );

    // 위계 펼침이 회신한 person 행 id 를 그대로 글 풀이에 넘긴다.
    const nodeIds = await store.getNodesByConcepts(
      [personId],
      DEFAULT_CONCEPT_NODE_LIMIT,
    );

    // 인영희 언급 글(node_person_edges)이 후보에 들어온다.
    expect(nodeIds).toContain(origin);
  });

  test("위계 펼침 → person 행 → 글 도달이 두 단계로 이어진다(끊김 0)", async () => {
    const { origin, personId } = await ingestPersonHierarchy(
      "#사람:인영희 #관계:가족 #가족:엄마",
    );

    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });

    // 펼침(위계) → 글 풀이(getNodesByConcepts) 두 단계를 retrieve-channels 가 잇는 그대로 잇는다.
    const expandedChildren = store.getHierarchyChildrenTransitive(
      [family],
      PARENT_OF_EXPANSION_MIN_WEIGHT,
      PARENT_OF_EXPANSION_LIMIT,
    );
    expect(expandedChildren).toContain(personId);

    const reachedNodes = await store.getNodesByConcepts(
      expandedChildren,
      DEFAULT_CONCEPT_NODE_LIMIT,
    );

    // 펼친 자식(psn_인영희 포함)을 글로 푸니 인영희 언급 글에 닿는다.
    // 펼침이 끊겼으면(person 행 미회신·psn_ 분기 미작동) 이 글이 빠져 회귀가 잡힌다.
    expect(reachedNodes).toContain(origin);
  });

  test("collectConceptChannel 전 경로 — 가족 검색이 인영희 언급 글을 위계 펼침으로 끌어온다", async () => {
    const { origin } = await ingestPersonHierarchy(
      "#사람:인영희 #관계:가족 #가족:엄마",
    );

    // 임베딩 포함 실제 검색 채널을 통째로 돌린다(collectConceptChannel 가 위계 펼침을 부른다).
    const queryText = "가족";
    const queryVec = await embedder.embed(queryText);
    const config = resolveRetrieveConfig(queryText, {}, {});

    const conceptNodeIds = await collectConceptChannel(
      store,
      queryText,
      queryVec,
      config,
    );

    // "가족" 이 직접 잡은 개념을 seed 로 위계 펼침이 사슬 끝 인영희 행까지 따라가
    // 인영희 언급 글을 후보 pool 에 더한다(위계 펼침이 끊기면 이 글이 빠진다).
    expect(conceptNodeIds).toContain(origin);
  });

  // ── 시나리오 2 — RRF 0 diff 가드 (위계 펼침 자식 0 건이면 후보 불변) ──────────
  //
  // spec §7.2 의 RRF 0 diff 불변식은 정확히 *위계 펼침 단계* 의 것이다 —
  // "getParentOfChildrenTransitive·getNodesByConcepts 가 후보 글 id 목록을 키우기만
  // 한다. 펼친 자식 0건이면 목록 불변". collectConceptChannel 전 경로는 의미 임베딩
  // top-K 가 글 추가에 따라 *직접 매칭 개념 집합 자체* 를 바꿔(가족·엄마 개념이 top-K
  // 진입) 위계 펼침과 무관한 변동을 끌어들인다(정상 동작이지 위계 회귀 아님). 그래서
  // 가드는 의미 검색 비결정성을 변수에서 빼고 *위계 펼침 단계 입력/출력* 을 고정 개념
  // 집합으로 직접 단언한다 — 이게 spec 이 말하는 "byte 동일" 의 실제 좌표다.

  test("위계 펼침 자식 0건이면 getNodesByConcepts 후보가 byte 동일(고정 개념 집합)", async () => {
    // 위계가 전혀 없는 일반 글 두 개 + 같은 태그 개념(검색 직접 매칭 모사).
    const plainA = await makeOrigin("주술회전 고죠가 죽었다");
    const plainB = await makeOrigin("주술회전 스토리가 좋다");
    const jjk = await store.findOrCreateTagConcept("주술회전");
    await store.addNodeConceptEdge(plainA, jjk, "tag", "user_input", plainA);
    await store.addNodeConceptEdge(plainB, jjk, "tag", "user_input", plainB);

    // 직접 매칭 개념을 고정([jjk]) — 의미 임베딩 top-K 비결정성을 변수에서 제거한다.
    const directMatched = [jjk];

    // (1) person 위계 글 추가 전 — 펼침 입력 = 직접 개념 + 위계 자식(0건).
    const childrenBefore = store.getHierarchyChildrenTransitive(
      directMatched,
      PARENT_OF_EXPANSION_MIN_WEIGHT,
      PARENT_OF_EXPANSION_LIMIT,
    );
    expect(childrenBefore).toEqual([]); // jjk 는 위계 부모가 아니라 자식 0건.
    const before = await store.getNodesByConcepts(
      [...directMatched, ...childrenBefore],
      DEFAULT_CONCEPT_NODE_LIMIT,
    );

    // (2) person 위계 글을 추가한다 — 가족>엄마>인영희 사슬이 DB 에 생긴다.
    await ingestPersonHierarchy("#사람:인영희 #관계:가족 #가족:엄마");

    // (3) 같은 고정 개념([jjk])으로 펼침 — jjk 는 person 위계와 무관하니 자식 여전히 0건.
    const childrenAfter = store.getHierarchyChildrenTransitive(
      directMatched,
      PARENT_OF_EXPANSION_MIN_WEIGHT,
      PARENT_OF_EXPANSION_LIMIT,
    );
    expect(childrenAfter).toEqual([]); // 펼친 자식 0건 — 후보 목록 입력 불변.
    const after = await store.getNodesByConcepts(
      [...directMatched, ...childrenAfter],
      DEFAULT_CONCEPT_NODE_LIMIT,
    );

    // 펼친 자식 0건이라 getNodesByConcepts 입력이 안 변함 → 후보 node_id 순서까지 byte 동일.
    expect(after).toEqual(before);
    expect(after).toEqual([plainA, plainB]);
  });

  test("가드 반대쪽 대조 — 위계 펼침이 psn_ 자식을 진짜 회신한다(거짓 통과 차단)", async () => {
    // 가드가 "펼침 0건이면 불변" 을 단언하므로, 펼침이 *작동할 때는* 비어 있지 않음을 대조로
    // 확인한다 — 가드가 "검색이 깨져서 늘 불변" 인 거짓 통과가 아님을 증명한다. "가족" 개념엔
    // 글-개념 classification mention 엣지(spec §5.1 보존)가 따로 붙어 직접 매칭만으로도 글에
    // 닿으므로, 펼침의 고유 기여는 *psn_ person 행 자식 회신* 으로 본다(직접 개념엔 psn_ 통로 없음).
    const { personId } = await ingestPersonHierarchy(
      "#사람:인영희 #관계:가족 #가족:엄마",
    );
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });

    // 가족 개념을 직접 매칭 seed 로 고정 — 위계 펼침이 사슬 끝 person 행을 회신해야 한다.
    const children = store.getHierarchyChildrenTransitive(
      [family],
      PARENT_OF_EXPANSION_MIN_WEIGHT,
      PARENT_OF_EXPANSION_LIMIT,
    );

    // 펼침이 비어 있지 않고, 그 안에 person 행 id 가 들어 있다(시나리오 2 가드의 0건과 대비).
    expect(children.length).toBeGreaterThan(0);
    expect(children).toContain(personId);
  });
});
