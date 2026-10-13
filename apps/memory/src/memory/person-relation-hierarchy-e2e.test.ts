/**
 * person-relation-hierarchy-e2e.test.ts — 사람 관계 하위 분류 통합 E2E (spec 2026-06-14).
 *
 * spec 동작 시나리오 표 7행을 실제 입력 통로로 검증한다(mock 0 — 실 SQLite + bge-m3).
 * 통로는 routes/memories.ts 순서 그대로 재현한다:
 *   saveTextInput(origin 노드 + 태그 개념 + 타입 배치)
 *     → wireHashtagEntitiesSafe(사람·프로젝트 행 생성)
 *     → wireEntityPlacementSafe(위계·관계, 내부에서 wirePersonHierarchy 호출).
 * 행 생성이 위계·관계보다 먼저라 관계 엣지가 대상 사람 행을 찾는다(순서 의존·T5 확인).
 *
 * 가장 중요한 회귀(D4) — 콜론 없는 나열(`#친구 #박대웅`)은 위계를 새로 안 만든다.
 * 입력 전후 친구→박대웅 parent_of 개수가 같은지(신규 0)를 직접 센다.
 *
 * 시나리오 표:
 * 소유자 관계 엣지 폐기(사용자 결정) — 옛 시나리오 표는 가족·친구 분류에서 소유자 ↔ 대상 사람
 * family_of/friend_of 관계 엣지를 세웠으나, 위계(사람>가족>막내>이놀부)가 가족·친구 관계를 이미
 * 표현해 중복이라 그 소유자 관계 엣지 생성을 폐기한다. 위계·잎 매달기는 그대로 보존하고, 소유자
 * 관계 엣지(getRelationsFromSource)는 어느 시나리오에서도 0 인지 함께 본다.
 *
 *   1. `#엄마 …`            → 사람 루트 직속 위계는 person-hierarchy 가 안 만듦(person explicit 아님).
 *   2. `#사람:이놀부 #가족:막내` → 사람 > 가족 > 막내 + 소유자 관계 엣지 0(폐기).
 *   3. `#관계:가족 #가족:엄마` → 시나리오 2 와 같은 사슬("관계"는 지붕·노드 0) + 관계 엣지 0.
 *   4. `#엄마`(직속) → `#사람:엄마 #가족:엄마` → 가족 아래로 완전 이동 + 관계 엣지 0(폐기).
 *   5-1. `#관계:대웅님가족 #대웅님가족:어머니`(관계 지붕·사용자 실제 양식) → 사람 >
 *        대웅님가족 > 어머니 + 관계 0("관계" 지붕이 person 으로 잡아 자유 분류를 사람 아래로).
 *   5-2. `#대웅님가족:어머니`(지붕 없음) → person 미합류·"대웅님가족 > 어머니" 일반 분류만
 *        (자유 분류는 #관계: 지붕을 붙여야 사람 아래 들어간다 — 케이스 1 과 대비).
 *   6. `#사람:박대웅 #친구:박대웅` → 사람 > 친구 > 박대웅 + 소유자 관계 엣지 0(폐기).
 *   7. `#친구 #박대웅`(콜론 없음) → "친구" 아래로 안 들어감(위계 신규 0). 기존 참조 유지.
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
import { saveTextInput } from "../server-internal/save-input.ts";
import { wireHashtagEntitiesSafe } from "./hashtag-entity-wiring.ts";
import { wireEntityPlacementSafe } from "./entity-placement-wiring.ts";
import {
  ensureTypeRootConcept,
  linkLeafToTypeRoot,
} from "./entity-hierarchy-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

describe("person-relation-hierarchy E2E — 동작 시나리오 표 7행", () => {
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

  /**
   * 실제 입력 통로를 routes/memories.ts 순서 그대로 거친다 — 글 한 줄을 저장하고
   * 사람·프로젝트 행 생성 → 위계·관계 wiring 까지 돌린다. origin 노드 id 를 돌려준다.
   */
  async function ingestThroughPipeline(content: string): Promise<number> {
    const saved = await saveTextInput(store, {
      content,
      source: "dashboard:manual",
    });
    await wireHashtagEntitiesSafe(
      store,
      saved.originNodeId!,
      content,
      undefined,
      "e2e",
    );
    await wireEntityPlacementSafe(
      store,
      saved.originNodeId!,
      content,
      undefined,
      "e2e",
      null,
    );
    return saved.originNodeId!;
  }

  /** 소유자(나) person 을 등록한다 — 본명 + 별칭 "나". */
  async function registerOwner(): Promise<string> {
    const owner = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(owner.personId, "나");
    return owner.personId;
  }

  /** 두 개념 사이 parent_of 직속이 있는지 — 양끝을 집합에 넣어 조회(S0-T4 hierarchy_edges). */
  async function hasParentOf(
    parentConceptId: string,
    childConceptId: string,
  ): Promise<boolean> {
    const edges = store.getHierarchyEdgesWithin([
      parentConceptId,
      childConceptId,
    ]);
    return edges.some(
      (e) =>
        e.sourceId === parentConceptId &&
        e.targetId === childConceptId,
    );
  }

  /** 분류 키·잎 이름 개념의 conceptId 를 보장해 돌려준다(조회용·없으면 생성). */
  async function classConcept(name: string): Promise<string> {
    return store.findOrCreateConcept(name, { isClassificationValue: true });
  }

  /** person 출처(소유자 등)에서 나가는 관계 엣지 수 — family_of/friend_of 폐기 검증용. */
  function relationEdgeCountFrom(personId: string): number {
    return store.getRelationsFromSource("person", personId).length;
  }

  function countRows(table: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  // ── 시나리오 1 — #엄마 단독(분류 없음) ────────────────────────────────────
  test("[1] #엄마 단독 → person-hierarchy 가 사람 루트 직속 위계를 안 만든다", async () => {
    // `#엄마` 는 person explicit 신호(콜론 사슬·#사람:)가 아니라 wirePersonHierarchy 가
    // early return(위계 0). 사람 루트 → 엄마 직속은 이 통로로 생기지 않는다(T6 확인 동작).
    await ingestThroughPipeline("#엄마 엄마가 앵두청 해줬다");

    const personRoot = await ensureTypeRootConcept(store, "person");
    const mom = await classConcept("엄마");
    expect(await hasParentOf(personRoot, mom)).toBe(false);
  });

  // ── 시나리오 2 — #사람:이놀부 #가족:막내 (소유자 관계 엣지 폐기·위계만) ────────────
  //
  // 사용자 결정: 소유자 ↔ 대상 사람 family_of/friend_of 관계 엣지 생성을 폐기한다 — 위계
  // (사람>가족>막내>이놀부)가 가족 관계를 이미 표현하기 때문이다. #사람:이놀부 선언으로 이놀부
  // person 행이 막내(역할 잎) 아래 매달리는 위계는 그대로 보존하고, 소유자 관계 엣지만 안 만든다.
  test("[2] #사람:이놀부 #가족:막내 → 사람>가족>막내 + 소유자 관계 엣지 0(폐기)", async () => {
    const ownerId = await registerOwner();
    // 대상 이놀부 person 행은 통로의 wireHashtagEntities 가 #사람:이놀부 선언에서 만든다.

    await ingestThroughPipeline("#사람:이놀부 #관계:가족 #가족:막내");

    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await classConcept("가족");
    const youngest = await classConcept("막내");
    expect(await hasParentOf(personRoot, family)).toBe(true);
    expect(await hasParentOf(family, youngest)).toBe(true);

    // 이놀부 person 행은 만들어진다 — 소유자 관계 엣지만 안 선다(위계가 관계 대체).
    const target = await store.findPersonByNameOrAlias("이놀부");
    expect(target.person).not.toBeNull();
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  // ── 시나리오 3 — #사람:인영희 #관계:가족 #가족:엄마 ────────────────────────────
  test("[3] #사람:인영희 #관계:가족 #가족:엄마 → 사슬 + 소유자 관계 엣지 0(폐기·'관계' 지붕 노드 0)", async () => {
    const ownerId = await registerOwner();
    // 대상 인영희 person 행은 통로의 wireHashtagEntities 가 #사람:인영희 선언에서 만든다.

    await ingestThroughPipeline("#사람:인영희 #관계:가족 #가족:엄마");

    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await classConcept("가족");
    const momConcept = await classConcept("엄마");
    expect(await hasParentOf(personRoot, family)).toBe(true);
    expect(await hasParentOf(family, momConcept)).toBe(true);

    // 인영희 person 행은 만들어진다 — 소유자 관계 엣지만 안 선다(위계가 관계 대체).
    const target = await store.findPersonByNameOrAlias("인영희");
    expect(target.person).not.toBeNull();
    expect(relationEdgeCountFrom(ownerId)).toBe(0);

    // "관계"는 타입 지붕(synonym) — 개념 노드를 안 만든다.
    const relationCount = db
      .prepare(`SELECT COUNT(*) AS n FROM concept_nodes WHERE name = '관계'`)
      .get() as { n: number };
    expect(relationCount.n).toBe(0);
  });

  // ── 시나리오 4 — 먼저 #엄마 직속 → 나중 #사람:엄마 #가족:엄마 완전 이동 ──────────
  //
  // 여기서는 "엄마"가 잎(역할)이자 사람 선언이다 — 사용자가 친족 호칭 자체를 사람 이름처럼
  // 쓰는 케이스. #사람:엄마 선언으로 엄마 person 행이 가족 아래로 완전 이동(소급)한다. 소유자
  // 관계 엣지(family_of)는 폐기라 안 선다 — 위계가 가족 관계를 표현한다(사용자 결정).
  test("[4] #엄마 직속 → #사람:엄마 #가족:엄마 → 가족 아래로 완전 이동 + 소유자 관계 엣지 0(폐기)", async () => {
    const ownerId = await registerOwner();

    // 1) #엄마 직속 — 사람 루트 → 엄마 parent_of 를 명시적으로 세운다(T6 단일 배치 잎 경로).
    const directOrigin = await ingestThroughPipeline("#엄마");
    await linkLeafToTypeRoot(store, directOrigin, "person", "엄마");
    const personRoot = await ensureTypeRootConcept(store, "person");
    const momConcept = await classConcept("엄마");
    expect(await hasParentOf(personRoot, momConcept)).toBe(true); // 직속 전제.

    // 2) #사람:엄마 #가족:엄마 — 사람 선언 + 소급 완전 이동. 행 생성은 통로의 wireHashtagEntities.
    await ingestThroughPipeline("#사람:엄마 #관계:가족 #가족:엄마");

    // 직속 제거 + 가족 사슬(소급 완전 이동).
    expect(await hasParentOf(personRoot, momConcept)).toBe(false);
    const family = await classConcept("가족");
    expect(await hasParentOf(personRoot, family)).toBe(true);
    expect(await hasParentOf(family, momConcept)).toBe(true);

    // 엄마 person 행은 만들어진다 — 소유자 관계 엣지(family_of)는 폐기라 안 선다.
    const mom = await store.findPersonByNameOrAlias("엄마");
    expect(mom.person).not.toBeNull();
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  // ── 시나리오 5 — 자유 분류 (관계 지붕 유무 두 케이스) ──────────────────────
  //
  // spec 표는 `#대웅님가족:어머니` 로 축약 표기했으나 사용자 실제 양식은 "관계" 지붕을
  // 붙인 `#관계:대웅님가족 #대웅님가족:어머니` 다. "관계"가 person 타입 지시어(T1 synonym)
  // 라, 관계 지붕을 붙이면 classifier 가 person 으로 잡아 사람 루트 아래로 자유 분류를
  // 매단다. 지붕이 없으면 person 으로 안 잡혀 사람 루트 미합류 — 두 케이스를 함께 고정한다.

  test("[5-1] #관계:대웅님가족 #대웅님가족:어머니(관계 지붕) → 사람>대웅님가족>어머니 + 관계 0", async () => {
    const ownerId = await registerOwner();

    await ingestThroughPipeline("#관계:대웅님가족 #대웅님가족:어머니");

    // "관계" 지붕 덕에 person 으로 분류(typeName=person·subcategory=대웅님가족·candidate=어머니).
    // 사람 루트 → 대웅님가족 → 어머니 사슬이 선다(spec 시나리오 5 의 "사람 > 자유분류 > 사람" 의도 충족).
    const personRoot = await ensureTypeRootConcept(store, "person");
    const daewoongFamily = await classConcept("대웅님가족");
    const mother = await classConcept("어머니");
    expect(await hasParentOf(personRoot, daewoongFamily)).toBe(true);
    expect(await hasParentOf(daewoongFamily, mother)).toBe(true);

    // D9 — 자유 분류(대웅님가족)는 친족 동의어를 적용하지 않는다. 표준형으로 모으면 내 엄마
    // (가족 → 엄마)와 타인 어머니(대웅님가족 → 엄마)가 이름 UNIQUE "엄마" 한 노드로 섞인다.
    // 자유 분류 경계가 그 섞임을 막으므로 대웅님가족 → 엄마 잎은 *안 생긴다*("어머니" 원본만).
    const mom = await classConcept("엄마");
    expect(await hasParentOf(daewoongFamily, mom)).toBe(false);

    // 관계 엣지 0 — 자유 분류든 관계 어휘든 소유자 관계 엣지는 폐기라 안 선다.
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  test("[5-2] #대웅님가족:어머니(관계 지붕 없음) → person 미합류·일반 분류 위계만(케이스 1 과 대비)", async () => {
    const ownerId = await registerOwner();

    await ingestThroughPipeline("#대웅님가족:어머니");

    // 관계 지붕 없는 자유 분류 "대웅님가족" 은 person 어휘(가족·친구)도 타입 지시 키
    // (사람·인물·관계)도 아니라 classifier 가 person 으로 분류하지 않는다(typeName=none).
    // 그래서 person 루트 아래로 안 들어가고, 1.5단계 일반 분류 위계가 "대웅님가족 → 어머니"
    // 한 단만 세운다. "자유 분류는 #관계: 지붕을 붙여야 사람 아래 들어간다"는 한계를 고정한다.
    const daewoongFamilyKey = await store.findOrCreateConcept("대웅님가족", {
      isClassificationKey: true,
    });
    const mother = await classConcept("어머니");
    expect(await hasParentOf(daewoongFamilyKey, mother)).toBe(true);

    // 사람 루트 → 대웅님가족 직속은 안 선다(케이스 1 과 대비 — 지붕 없으면 person 미합류).
    const personRoot = await ensureTypeRootConcept(store, "person");
    const daewoongFamilyVal = await classConcept("대웅님가족");
    expect(await hasParentOf(personRoot, daewoongFamilyVal)).toBe(false);

    // 관계 엣지 0(person 미합류라 person-hierarchy 자체가 안 돈다).
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  // ── 시나리오 6 — #사람:박대웅 #친구:박대웅 ────────────────────────────────────
  //
  // "박대웅"이 잎이자 사람 선언이다(사용자가 사람 이름을 친구 분류 잎으로도 씀). #사람:박대웅
  // 선언으로 박대웅 person 행이 친구 아래 매달린다(위계). 소유자 관계 엣지(friend_of)는 폐기라
  // 안 선다 — 위계(사람>친구>박대웅)가 친구 관계를 이미 표현한다(사용자 결정).
  test("[6] #사람:박대웅 #친구:박대웅 → 사람>친구>박대웅 + 소유자 관계 엣지 0(폐기)", async () => {
    const ownerId = await registerOwner();

    await ingestThroughPipeline("#사람:박대웅 #관계:친구 #친구:박대웅");

    const personRoot = await ensureTypeRootConcept(store, "person");
    const friendClass = await classConcept("친구");
    const daewoong = await classConcept("박대웅");
    expect(await hasParentOf(personRoot, friendClass)).toBe(true);
    expect(await hasParentOf(friendClass, daewoong)).toBe(true);

    const friend = await store.findPersonByNameOrAlias("박대웅");
    expect(friend.person).not.toBeNull();
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  // ── 시나리오 7 — #친구 #박대웅(콜론 없음) — D4 회귀 가드 (AC1·AC2) ──────────
  test("[7-AC1] #친구 #박대웅(콜론 없음) → 친구→박대웅 위계 신규 0", async () => {
    const friendClass = await classConcept("친구");
    const daewoong = await classConcept("박대웅");
    const before = await hasParentOf(friendClass, daewoong);
    expect(before).toBe(false); // 사전 위계 없음(전제).

    await ingestThroughPipeline("#친구 #박대웅");

    // 콜론 없는 나열은 위계를 새로 안 만든다(D4) — 친구→박대웅 parent_of 신규 0.
    const after = await hasParentOf(friendClass, daewoong);
    expect(after).toBe(false);
  });

  test("[7-AC2] 박대웅이 먼저 친구 아래면 #친구 #박대웅 후에도 유지 + 글 연결", async () => {
    const ownerId = await registerOwner();

    // 1) #사람:박대웅 #친구:박대웅 으로 박대웅을 친구 아래 등록(위계). 행 생성은 통로.
    await ingestThroughPipeline("#사람:박대웅 #관계:친구 #친구:박대웅");
    const friend = await store.findPersonByNameOrAlias("박대웅");
    expect(friend.person).not.toBeNull();
    const personRoot = await ensureTypeRootConcept(store, "person");
    const friendClass = await classConcept("친구");
    const daewoong = await classConcept("박대웅");
    expect(await hasParentOf(friendClass, daewoong)).toBe(true); // 등록 전제.
    // 소유자 관계 엣지(friend_of)는 폐기라 안 선다 — 위계가 친구 관계를 표현한다.
    expect(relationEdgeCountFrom(ownerId)).toBe(0);

    const beforeChildren = (
      store.getHierarchyEdgesWithin([friendClass, daewoong])
    ).length;

    // 2) #친구 #박대웅(콜론 없음) — 위계는 그대로, 글이 박대웅에 연결되는지 본다.
    const origin = await ingestThroughPipeline("#친구 #박대웅");

    // 박대웅이 여전히 친구 아래(유지) — 위계 엣지 수 변동 0.
    expect(await hasParentOf(friendClass, daewoong)).toBe(true);
    const afterChildren = (
      store.getHierarchyEdgesWithin([friendClass, daewoong])
    ).length;
    expect(afterChildren).toBe(beforeChildren);

    // 글이 박대웅 사람에 연결됐는지 — 콜론 없는 `#박대웅` 이 등록된 사람으로 잡히는
    // 경로(wireHashtagConcepts mentions). 연결이 붙으면 listNodePersonEdges 가 잡는다.
    const personEdges = await store.listNodePersonEdges({
      nodeId: origin,
      personId: friend.person!.personId,
    });
    expect(personEdges.length).toBeGreaterThan(0);

    // 사람 루트 → 친구 위계도 유지(회귀 0).
    expect(await hasParentOf(personRoot, friendClass)).toBe(true);
  });

  // ── 통합 — 사람 행은 위계 모듈이 만들지 않는다(이중 처리 0) ────────────────
  test("위계 통로는 사람 행을 만들지 않는다 — #가족:엄마 단독은 persons 0", async () => {
    // 소유자·대상 사전 등록 없이 #가족:엄마 만 통로에 넣으면 persons 행이 안 생긴다.
    await ingestThroughPipeline("#가족:엄마");
    expect(countRows("persons")).toBe(0);
  });
});
