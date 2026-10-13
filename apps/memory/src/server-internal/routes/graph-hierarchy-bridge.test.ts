/**
 * graph-hierarchy-bridge.test.ts — attachStandaloneHierarchyBridges 함수 단위 재현
 * (branch plaintext-auto-inference-scope Task 4).
 *
 * 배경 — Task 1 이 분류 값 개념의 평문 우연 등장에 대한 자동 mention 연결을 끊었다(진짜
 * 결함 수정). 그 부작용으로 `/graph/overview` 가 addStandaloneEntitySeeds 로 뒤늦게 넣는
 * 독립 엔티티/사람 잎에서 위계 상위(가운데 다리 개념)를 못 거슬러 올라가, 잎이 타입 묶음
 * 바로 아래 직결로 보이는 문제가 생겼다(저장은 정상 — hierarchy_edges 는 그대로 있다).
 *
 * 이 파일은 그 렌더 조립 문제의 *함수 단위* 재현이다 — addStandaloneEntitySeeds 가 만드는
 * 상태를 그대로 흉내 낸다: nodeById 에 leaf 노드(엔티티 행/사람 행) 딱 하나만 있고, 개념
 * mention 엣지·노드는 0. attachStandaloneHierarchyBridges 를 직접 불러 위계 다리가
 * 복원되는지 본다.
 *
 * mock 클래스 0 — 실제 SQLite(:memory:) + 실제 Bgem3Embedder + 실제 입력 통로
 * (wireHashtagEntities → wireEntityPlacement)를 그대로 태운다(CLAUDE.md "DB/임베딩 의존
 * 모듈은 실제 구현체와 통합 검증"). colon-chain-mid-bridge.test.ts 의 셋업 양식과
 * graph-person-hierarchy-augment.test.ts 의 "함수를 직접 불러 nodeById·edgeSet 을 단언"
 * 양식을 결합했다. 임시 :memory: DB 라 운영 DB(apps/memory/data/bara.sqlite) 무접촉.
 *
 * attachStandaloneHierarchyBridges 모듈이 구현 전엔 존재하지 않아 이 파일 자체가
 * import 시점에 컴파일 실패(모듈 not found)한다 — 이것이 "재현 A·B red(모듈 부재)"의
 * 증거다. 구현 후 아래 assertion 이 green 으로 통과해야 한다.
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
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { wireEntityPlacement } from "../../memory/entity-placement-wiring.ts";
import { wireHashtagEntities } from "../../memory/hashtag-entity-wiring.ts";
import { resetConceptTypeVocabularyCache } from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import {
  type GraphNode,
  type GraphEdge,
  type AugmentResult,
  entityToGraphNode,
  personToDetailedGraphNode,
  scheduleOccurrenceRowsForEntity,
  conceptKey,
  personKey,
  entityKey,
  conceptToGraphNode,
} from "./graph-nodes-shared.ts";
import { attachStandaloneHierarchyBridges } from "./graph-augment-hierarchy-bridge.ts";
import { buildGroupNodes } from "./graph-group-nodes.ts";

describe("attachStandaloneHierarchyBridges — standalone 잎에서 위계 다리 복원", () => {
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

  /** 실 입력 통로 순서 — 사람·프로젝트 통로(wireHashtagEntities) → 엔티티 배치(wireEntityPlacement). */
  async function run(content: string): Promise<number> {
    const origin = await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    await wireHashtagEntities(store, origin, content);
    await wireEntityPlacement(store, origin, content, { llm: null });
    return origin;
  }

  function hasEdge(
    edgeSet: Map<string, GraphEdge>,
    from: string,
    to: string,
    type = "parent_of",
  ): boolean {
    return [...edgeSet.values()].some(
      (e) => e.from === from && e.to === to && e.type === type,
    );
  }

  test("재현 A(생물 사슬) — 생물→동물→고양이→creature:얼룩이 다리가 복원된다", async () => {
    await run("#생물:동물 #동물:고양이 #고양이:얼룩이");

    const row = await store.entitiesRepo.findByName("creature", "얼룩이");
    expect(row).not.toBeNull();

    // addStandaloneEntitySeeds 가 만드는 상태 흉내 — leaf 엔티티 노드 하나만 seed.
    const leafKey = entityKey("creature", row!.id);
    const nodeById = new Map<string, GraphNode>();
    nodeById.set(
      leafKey,
      entityToGraphNode(
        row!,
        store.entitiesRepo.listAttributes(row!.id),
        scheduleOccurrenceRowsForEntity(store, row!),
      ),
    );
    const edgeSet = new Map<string, GraphEdge>();
    const refs: AugmentResult = {
      entityRefs: [{ type: "creature", id: row!.id }],
      personRefs: [],
      projectRefs: [],
    };

    await attachStandaloneHierarchyBridges(store, nodeById, edgeSet, refs);

    const bio = await store.findConceptByName("생물");
    const animal = await store.findConceptByName("동물");
    const cat = await store.findConceptByName("고양이");
    expect(bio).not.toBeNull();
    expect(animal).not.toBeNull();
    expect(cat).not.toBeNull();

    const bioKey = conceptKey(bio!.conceptId);
    const animalKey = conceptKey(animal!.conceptId);
    const catKey = conceptKey(cat!.conceptId);

    // 가운데 다리 개념 노드가 복원됐다.
    expect(nodeById.has(bioKey)).toBe(true);
    expect(nodeById.has(animalKey)).toBe(true);
    expect(nodeById.has(catKey)).toBe(true);

    // parent_of 사슬 전체(생물→동물→동물→고양이→고양이→leaf)가 이어진다.
    expect(hasEdge(edgeSet, bioKey, animalKey)).toBe(true);
    expect(hasEdge(edgeSet, animalKey, catKey)).toBe(true);
    expect(hasEdge(edgeSet, catKey, leafKey)).toBe(true);

    // 묶음 정합 — 위계 사슬이 살아 있으면 buildGroupNodes 가 잎으로 가는 직접 member_of
    // 를 추이 감축으로 생략한다(가운데 다리가 없던 옛 렌더는 이 member_of 가 직결로 남아
    // "묶음→엔티티 직결" 증상을 냈다).
    buildGroupNodes(nodeById, edgeSet, refs);
    const hasDirectMemberOf = [...edgeSet.values()].some(
      (e) => e.type === "member_of" && e.to === leafKey,
    );
    expect(hasDirectMemberOf).toBe(false);
  });

  test("결함 1 재현(겹치는 공용 분류어) — '동물' 개념이 이미 nodeById 에 있어도 생물→동물·동물→고양이 다리가 빠지지 않는다", async () => {
    await run("#생물:동물 #동물:고양이 #고양이:얼룩이");

    const row = await store.entitiesRepo.findByName("creature", "얼룩이");
    expect(row).not.toBeNull();

    const animal = await store.findConceptByName("동물");
    expect(animal).not.toBeNull();

    // addStandaloneEntitySeeds 가 만드는 leaf 시드 + "동물" 개념이 다른 경로(예: 다른
    // 최근 글이 "동물"을 직접 mention 해 첫 augment 패스가 이미 만든 노드)로 이미
    // nodeById 에 들어와 있는 상태를 손으로 흉내낸다 — 결함 1 재현의 핵심.
    const leafKey = entityKey("creature", row!.id);
    const nodeById = new Map<string, GraphNode>();
    nodeById.set(
      leafKey,
      entityToGraphNode(
        row!,
        store.entitiesRepo.listAttributes(row!.id),
        scheduleOccurrenceRowsForEntity(store, row!),
      ),
    );
    const animalKeyPre = conceptKey(animal!.conceptId);
    nodeById.set(animalKeyPre, conceptToGraphNode(animal!));

    const edgeSet = new Map<string, GraphEdge>();
    const refs: AugmentResult = {
      entityRefs: [{ type: "creature", id: row!.id }],
      personRefs: [],
      projectRefs: [],
    };

    await attachStandaloneHierarchyBridges(store, nodeById, edgeSet, refs);

    const bio = await store.findConceptByName("생물");
    const cat = await store.findConceptByName("고양이");
    expect(bio).not.toBeNull();
    expect(cat).not.toBeNull();

    const bioKey = conceptKey(bio!.conceptId);
    const animalKey = conceptKey(animal!.conceptId);
    const catKey = conceptKey(cat!.conceptId);

    // "동물" 노드는 애초에 이미 있었으니 당연히 true — 핵심 단언이 아니다.
    expect(nodeById.has(animalKey)).toBe(true);

    // 핵심 단언 — 사슬 전체(생물→동물→고양이→leaf) 엣지가 전부 이어져야 한다.
    // 결함 1 이 있으면 "동물"이 새 빈 conceptIds Set 에 안 들어가 생물→동물·동물→고양이
    // 두 엣지가 getHierarchyEdgesWithin 조회에서 걸러진다(고양이→leaf 만 살아남는다).
    expect(hasEdge(edgeSet, bioKey, animalKey)).toBe(true);
    expect(hasEdge(edgeSet, animalKey, catKey)).toBe(true);
    expect(hasEdge(edgeSet, catKey, leafKey)).toBe(true);
  });

  test("재현 B(사람 사슬) — 사람→가족→둘째→person 다리가 복원된다", async () => {
    await run("#사람:인영희 #관계:가족 #가족:둘째");

    const person = await store.findPersonByName("인영희");
    expect(person).not.toBeNull();

    // addStandaloneEntitySeeds 가 만드는 상태 흉내 — leaf 사람 노드 하나만 seed.
    const leafKey = personKey(person!.personId);
    const nodeById = new Map<string, GraphNode>();
    nodeById.set(leafKey, await personToDetailedGraphNode(store, person!));
    const edgeSet = new Map<string, GraphEdge>();
    const refs: AugmentResult = {
      entityRefs: [],
      personRefs: [person!.personId],
      projectRefs: [],
    };

    await attachStandaloneHierarchyBridges(store, nodeById, edgeSet, refs);

    // 그라운드 트루스 확인 — person-hierarchy-wiring.ts 의 "잎→사람 매달기"(S1-T1) 양식은
    // graph-person-hierarchy-augment.test.ts 의 seedPersonHierarchy/S1-LIVE 재현과 동형:
    // 사람(타입 루트) → 가족(subcategory) → 둘째(잎 개념) → person 행.
    const personRoot = await store.findConceptByName("사람");
    const family = await store.findConceptByName("가족");
    const leafConcept = await store.findConceptByName("둘째");
    expect(personRoot).not.toBeNull();
    expect(family).not.toBeNull();
    expect(leafConcept).not.toBeNull();

    const rootKey = conceptKey(personRoot!.conceptId);
    const familyKey = conceptKey(family!.conceptId);
    const leafConceptKey = conceptKey(leafConcept!.conceptId);

    expect(nodeById.has(rootKey)).toBe(true);
    expect(nodeById.has(familyKey)).toBe(true);
    expect(nodeById.has(leafConceptKey)).toBe(true);

    expect(hasEdge(edgeSet, rootKey, familyKey)).toBe(true);
    expect(hasEdge(edgeSet, familyKey, leafConceptKey)).toBe(true);
    expect(hasEdge(edgeSet, leafConceptKey, leafKey)).toBe(true);

    // 묶음 정합 — 사람 잎으로 가는 직접 member_of 없음(위계로 이미 닿음).
    buildGroupNodes(nodeById, edgeSet, refs);
    const hasDirectMemberOf = [...edgeSet.values()].some(
      (e) => e.type === "member_of" && e.to === leafKey,
    );
    expect(hasDirectMemberOf).toBe(false);
  });
});
