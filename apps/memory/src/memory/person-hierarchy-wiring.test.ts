/**
 * person-hierarchy-wiring.test.ts — 사람 분류 위계 편입 검증 (spec 2026-06-14 D5).
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store 로 통합 검증한다(CLAUDE.md "DB/임베딩
 * 의존 모듈은 실제 구현체와 통합 검증"). 데이터 fixture(글 입력 → parent_of 조회 검증)만 쓴다.
 *
 * 검증 대상:
 *   - `#가족:엄마` → 사람 → 가족 → 엄마 parent_of 사슬(사람→가족 + 가족→엄마 둘 다).
 *   - `#관계:가족 #가족:엄마` → 같은 사슬("관계"는 타입 지붕이라 노드 안 생김).
 *   - 단일 `#사람:민수`(분류 없음) → 위계 0(행은 wireHashtagEntities 책임).
 *   - person 아닌 글(`#작품:데못죽`) → 위계 0(정직).
 *   - 사람 행(persons 테이블)은 이 모듈이 만들지 않음.
 *   - 멱등 — 같은 글 두 번이면 엣지 중복 0.
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
import { wirePersonHierarchy } from "./person-hierarchy-wiring.ts";
import { wireEntityPlacement } from "./entity-placement-wiring.ts";
import {
  ensureTypeRootConcept,
  linkLeafToTypeRoot,
} from "./entity-hierarchy-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

describe("person-hierarchy-wiring — 사람 분류 위계 편입 (D5)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    // 운영 yaml 단일 출처를 읽는다(다른 테스트가 fixture path 로 캐시를 오염했을 수 있어 초기화).
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

  /** origin 노드 한 개를 실제로 만들어 id 를 돌려준다. */
  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  function countRows(table: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  /**
   * 사람 루트·분류·잎 세 개념 사이에 양끝 매칭 parent_of 가 있는지 본다.
   * S0-T4(위계 단일 출처) — getHierarchyEdgesWithin 은 source·target 둘 다 입력 집합
   * 안인 parent_of 엣지만 돌려주므로 세 conceptId 를 한꺼번에 넘긴 뒤 (source,target)
   * 쌍 존재를 직접 확인한다(끝점 칸 sourceId/targetId).
   */
  function hasParentOf(
    parentConceptId: string,
    childConceptId: string,
  ): boolean {
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

  test("#가족:엄마 → 사람 → 가족 → 엄마 parent_of 사슬", async () => {
    const content = "#가족:엄마";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);
    expect(result.hierarchyEdges).toBeGreaterThan(0);

    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });

    // 사람 → 가족(이 모듈), 가족 → 엄마(이 모듈 보강 + 1.5단계).
    expect(hasParentOf(personRoot, family)).toBe(true);
    expect(hasParentOf(family, mom)).toBe(true);

    // 사람 행은 이 모듈이 만들지 않는다(wireHashtagEntities 위임).
    expect(countRows("persons")).toBe(0);
  });

  test("#관계:가족 #가족:엄마 → 같은 사슬('관계' 노드 안 생김)", async () => {
    const content = "#관계:가족 #가족:엄마";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);
    expect(result.hierarchyEdges).toBeGreaterThan(0);

    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });

    expect(hasParentOf(personRoot, family)).toBe(true);
    expect(hasParentOf(family, mom)).toBe(true);

    // "관계"는 타입 지붕(synonym) — 개념 노드를 안 만든다.
    const relationConcept = db
      .prepare(`SELECT COUNT(*) AS n FROM concept_nodes WHERE name = '관계'`)
      .get() as { n: number };
    expect(relationConcept.n).toBe(0);
  });

  test("단일 #사람:민수(분류 없음) → 위계 0(행은 wireHashtagEntities 책임)", async () => {
    const content = "#사람:민수";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);
    expect(result.hierarchyEdges).toBe(0);
    expect(countRows("persons")).toBe(0);
  });

  test("person 아닌 글(#작품:데못죽) → 위계 0(정직)", async () => {
    const content = "#작품:데못죽";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);
    expect(result.hierarchyEdges).toBe(0);
  });

  test("멱등 — 같은 글 두 번이면 parent_of 엣지 중복 0", async () => {
    const content = "#가족:엄마";
    const origin = await makeOrigin(content);

    await wirePersonHierarchy(store, origin, content);
    await wirePersonHierarchy(store, origin, content);

    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });

    const edges = store.getHierarchyEdgesWithin([personRoot, family, mom]);
    const personToFamily = edges.filter(
      (e) => e.sourceId === personRoot && e.targetId === family,
    );
    const familyToMom = edges.filter(
      (e) => e.sourceId === family && e.targetId === mom,
    );
    expect(personToFamily.length).toBe(1);
    expect(familyToMom.length).toBe(1);
  });

  test("입력 통로 합류 — wireEntityPlacement 가 person 갈래에서 위계를 세운다", async () => {
    // 입력 통로(wireEntityPlacement)는 person 을 신규 8 타입 배치에서 제외하되, 위계는
    // person-hierarchy-wiring 으로 편입한다. typeName 은 person 으로 정직히 돌려준다.
    const content = "#가족:엄마";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });
    expect(result.typeName).toBe("person");
    expect(result.hierarchyEdges).toBeGreaterThan(0);

    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    expect(hasParentOf(personRoot, family)).toBe(true);
    expect(hasParentOf(family, mom)).toBe(true);
    expect(countRows("persons")).toBe(0);
  });

  // ── 소유자 관계 엣지 폐기 (family_of/friend_of) — 사용자 결정 ───────────────
  //
  // 옛 양식은 분류가 관계 키(가족·친구)이면 소유자(나) ↔ 매달린 대상 사람 사이에 family_of/
  // friend_of 관계 엣지를 세웠다. 사용자 결정으로 이 소유자 관계 엣지 생성을 폐기한다 — 위계
  // (사람>가족>막내>이놀부)가 가족·친구 관계를 이미 표현해 중복이고 검색 seed 도 아니라 위계가
  // 시각·검색을 대체한다. 아래 테스트는 *관계 엣지가 안 서는지*(entity_relation_edges family_of 0)
  // 와 위계·잎 매달기는 그대로 보존되는지를 함께 본다.

  /** 소유자(나) person 을 등록한다 — 본명 + 별칭 "나"(옛 소유자 관계 경로 재현용). */
  async function registerOwner(): Promise<string> {
    const owner = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(owner.personId, "나");
    return owner.personId;
  }

  /** person 출처(소유자 등)에서 나가는 관계 엣지 수 — family_of/friend_of 폐기 검증용. */
  function relationEdgeCountFrom(personId: string): number {
    return store.getRelationsFromSource("person", personId).length;
  }

  test("#사람:이놀부 #가족:막내 + 소유자 등록 → family_of 0(폐기)·위계만 보존", async () => {
    const ownerId = await registerOwner();
    // 대상 사람 행(이놀부) 먼저 생성 — 입력 통로의 행→위계 순서 재현.
    const target = await store.findOrCreatePersonByName("이놀부");

    const content = "#사람:이놀부 #관계:가족 #가족:막내";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    // 소유자 관계 엣지(family_of) 0 — 위계가 가족 관계를 대체해 중복을 안 만든다(사용자 결정).
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(store.getRelationsToTarget("person", target.personId).length).toBe(0);
    expect(result.warnings.length).toBe(0);

    // 위계는 보존 — 사람 → 가족 → 막내 사슬은 그대로 선다.
    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const youngest = await store.findOrCreateConcept("막내", {
      isClassificationValue: true,
    });
    expect(hasParentOf(personRoot, family)).toBe(true);
    expect(hasParentOf(family, youngest)).toBe(true);
  });

  test("#사람:박대웅 #친구:박대웅 + 소유자 등록 → friend_of 0(폐기)·위계만 보존", async () => {
    const ownerId = await registerOwner();
    await store.findOrCreatePersonByName("박대웅");

    const content = "#사람:박대웅 #관계:친구 #친구:박대웅";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    // 소유자 관계 엣지(friend_of) 0 — 위계가 친구 관계를 대체한다(사용자 결정).
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(result.warnings.length).toBe(0);

    // 위계는 보존 — 사람 → 친구 → 박대웅 사슬.
    const personRoot = await ensureTypeRootConcept(store, "person");
    const friendClass = await store.findOrCreateConcept("친구", {
      isClassificationValue: true,
    });
    const daewoong = await store.findOrCreateConcept("박대웅", {
      isClassificationValue: true,
    });
    expect(hasParentOf(personRoot, friendClass)).toBe(true);
    expect(hasParentOf(friendClass, daewoong)).toBe(true);
  });

  test("자유 분류 #대웅님가족:어머니 → 관계 엣지 0(위계만·예나 지금이나)", async () => {
    const ownerId = await registerOwner();
    await store.findOrCreatePersonByName("어머니");

    const content = "#대웅님가족:어머니";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);

    // 소유자 source 에 관계 엣지 0 — 자유 분류든 관계 어휘든 소유자 관계 엣지는 안 선다(폐기).
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  test("D9 — 자유 분류(관계 지붕)는 친족 동의어 미적용·원본 잎(엄마로 안 모임)", async () => {
    // `#관계:대웅님가족 #대웅님가족:어머니` — "관계" 지붕으로 person 분류되지만, "대웅님가족"
    // 은 알려진 관계 어휘(가족·친구)가 아니라 친족 동의어 표준형 통일을 적용하지 않는다(D9).
    // candidate 가 원본 "어머니"로 유지돼 대웅님가족 → 어머니 잎만 서고, 대웅님가족 → 엄마는
    // 안 선다(표준형으로 모으면 내 엄마와 타인 어머니가 "엄마" 한 노드로 섞이는 과잉 연결 차단).
    const content = "#관계:대웅님가족 #대웅님가족:어머니";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);

    const daewoongFamily = await store.findOrCreateConcept("대웅님가족", {
      isClassificationValue: true,
    });
    const mother = await store.findOrCreateConcept("어머니", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    // 대웅님가족 → 어머니(원본) 존재, 대웅님가족 → 엄마(표준형) 없음.
    expect(hasParentOf(daewoongFamily, mother)).toBe(true);
    expect(hasParentOf(daewoongFamily, mom)).toBe(false);
  });

  test("관계 어휘 분류 #가족:어머니 → 표준형 엄마 잎(자유 분류와 대비)", async () => {
    // 대비 — 관계 어휘(가족) 분류는 친족 동의어를 적용한다. candidate 가 "엄마"로 통일돼
    // 가족 → 엄마 잎이 선다(내 엄마 한 사람으로 모임). 위 자유 분류 케이스와 갈래가 갈린다.
    const content = "#가족:어머니";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);

    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    expect(hasParentOf(family, mom)).toBe(true);
  });

  test("멱등 — 같은 글 두 번이어도 소유자 관계 엣지 0(폐기·중복도 0)", async () => {
    const ownerId = await registerOwner();
    await store.findOrCreatePersonByName("이놀부");

    const content = "#사람:이놀부 #관계:가족 #가족:막내";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);
    await wirePersonHierarchy(store, origin, content);

    // 소유자 관계 엣지는 애초에 안 선다(폐기) — 두 번 처리해도 0.
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
  });

  test("대상 사람 행 미생성이면 소유자 관계 엣지 0(폐기) + 잎 매달기 경고(거짓 연결 0)", async () => {
    // 소유자만 있고 대상(이놀부) person 행이 없다 — 잎 매달기가 이놀부 행을 못 찾아 경고한다.
    // 소유자 관계 엣지는 폐기라 애초에 안 서지만, 잎→사람 매달기 정직 가드는 그대로 보존된다.
    const ownerId = await registerOwner();

    const content = "#사람:이놀부 #관계:가족 #가족:막내";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(result.warnings.some((w) => w.includes("이놀부"))).toBe(true);
  });

  // ── 소급 이동 + 친족 동의어 — Task 6 / D3 ─────────────────────────────────
  //
  // `#엄마` 로 사람 루트 직속에 먼저 생긴 사람을, 나중 `#가족:엄마`(또는 `#가족:어머니`)
  // 입력 시 가족 아래로 완전 이동한다. 사람 루트 → 엄마 직속 parent_of 를 떼고 사람 → 가족
  // → 엄마 사슬만 남긴다. 친족 동의어(어머니→엄마)는 표준형으로 통일해 같은 한 사람으로 모인다.

  /**
   * `#엄마` 단독 입력이 만드는 "사람 루트 → 엄마" 직속 parent_of 를 재현한다.
   * linkLeafToTypeRoot(person, 엄마)가 단일 배치 잎 경로와 같은 직속을 세운다 — 소급
   * 제거가 실제로 무언가를 떼어내는지 검증하려고 직속을 명시적으로 만든다.
   */
  async function makePersonRootDirectChild(
    nameLeaf: string,
  ): Promise<{ personRoot: string; nameConcept: string }> {
    const origin = await makeOrigin(`#${nameLeaf}`);
    await linkLeafToTypeRoot(store, origin, "person", nameLeaf);
    const personRoot = await ensureTypeRootConcept(store, "person");
    const nameConcept = await store.findOrCreateConcept(nameLeaf, {
      isClassificationValue: true,
    });
    return { personRoot, nameConcept };
  }

  test("#엄마 직속 → 나중 #가족:엄마 → 직속 제거 + 사람→가족→엄마 사슬만", async () => {
    // 1) `#엄마` 직속 — 사람 루트 → 엄마 parent_of 를 먼저 세운다.
    const { personRoot, nameConcept } = await makePersonRootDirectChild("엄마");
    expect(hasParentOf(personRoot, nameConcept)).toBe(true); // 직속 존재 전제.

    // 소급 대상 사람 행도 있어야 reparent 가 작동한다(실재 확인 게이트).
    await store.findOrCreatePersonByName("엄마");

    // 2) `#가족:엄마` — 소급 이동.
    const content = "#가족:엄마";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);

    // 사람 루트 → 엄마 직속 제거됨.
    expect(hasParentOf(personRoot, nameConcept)).toBe(false);
    // 사람 → 가족 → 엄마 사슬 존재.
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    expect(hasParentOf(personRoot, family)).toBe(true);
    expect(hasParentOf(family, nameConcept)).toBe(true);
  });

  test("#엄마 → 나중 #가족:어머니 → 친족 동의어로 기존 '엄마' 한 사람으로 이동", async () => {
    // `#엄마` 직속 + 기존 "엄마" 사람.
    const { personRoot, nameConcept } = await makePersonRootDirectChild("엄마");
    await store.findOrCreatePersonByName("엄마");

    // `#가족:어머니` — canonicalKinship("어머니")==="엄마" 라 기존 "엄마"로 모인다.
    const content = "#가족:어머니";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);

    // "엄마" 직속 제거 + 가족 아래로 이동(표준형 통일).
    expect(hasParentOf(personRoot, nameConcept)).toBe(false);
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    expect(hasParentOf(family, nameConcept)).toBe(true);

    // 새 "어머니" 개념 노드는 안 생긴다 — 표준형 "엄마"로 통일됐다.
    const motherConcept = db
      .prepare(`SELECT COUNT(*) AS n FROM concept_nodes WHERE name = '어머니'`)
      .get() as { n: number };
    expect(motherConcept.n).toBe(0);
  });

  test("동명이인 2명+ 모호면 명시 소급 건너뜀 + 경고(거짓 이동 0)", async () => {
    // `#엄마` 직속 + 같은 이름 "엄마" 2명(별칭 충돌로 ambiguous).
    await makePersonRootDirectChild("엄마");
    const a = await store.findOrCreatePersonByName("홍길동");
    const b = await store.findOrCreatePersonByName("박대웅");
    await store.addPersonAlias(a.personId, "엄마");
    await store.addPersonAlias(b.personId, "엄마");

    const content = "#가족:엄마";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    // 모호 경고가 남는다 — 어느 사람 행을 가족 아래로 옮길지 못 정해 명시 소급(removeParentOfEdge)
    // 을 건너뛴다(거짓 이동 0). 위계 직속 정리는 reflow(pruneShortcutParentsOf)가 사슬 구조로
    // 따로 처리하므로(사람→가족→엄마 길이 2 경로 실재 시 직속 제거), 여기 검증 핵심은 *경고* 다.
    expect(
      result.warnings.some((w) => w.includes("동명이인") || w.includes("모호")),
    ).toBe(true);
  });

  // ── 잎 → 사람 행 직접 매달기 — S1-T1 / E1~E4 (위계 단일 출처) ──────────────────
  //
  // 사용자가 속성을 *따로* 적으면(`#사람:인영희 #관계:가족 #가족:엄마`) `#사람:인영희` 가 첫
  // 콜론 매치라 classification.subcategory 가 null 이 돼 위 분류 통로가 일찍 끝났다. person-
  // relation-chain 의 순수 함수(extractRelationChains·extractPersonDeclarations·
  // decidePersonAttachment)를 합류해, 사람 1명 + 역할 잎 1개일 때 엄마(개념) → 인영희(person 행)
  // 위계 엣지를 hierarchy_edges 에 직접 쓴다(target_type='person'). 옛 양식이 만들던 *그림자
  // 인영희 개념*(isClassificationValue)은 만들지 않는다 — 그게 라벨 흡수 과흡수 회귀의 뿌리라
  // 폐기했다(spec §2·§5.3·§11). 모호하면(사람 둘 이상·역할 둘 이상) 매달지 않고 경고만 남긴다.

  /**
   * 잎 개념(엄마) → person 행(psn_…) parent_of 위계 엣지가 hierarchy_edges 에 있는지 본다.
   * getHierarchyEdgesWithin 은 양 끝 id 가 입력 집합 안인 parent_of 엣지를 종류 무관하게
   * 돌려주므로, 잎 개념 id 와 person 행 id 를 함께 넘긴 뒤 (source=잎·target=person 행) 쌍을
   * 직접 확인한다. 끝점 종류(targetType==='person')까지 검증해 그림자 개념 매달기와 구분한다.
   */
  function hasPersonLeafEdge(
    leafConceptId: string,
    personId: string,
  ): boolean {
    const edges = store.getHierarchyEdgesWithin([leafConceptId, personId]);
    return edges.some(
      (e) =>
        e.sourceType === "concept" &&
        e.sourceId === leafConceptId &&
        e.targetType === "person" &&
        e.targetId === personId,
    );
  }

  /** 주어진 이름의 그림자 개념(isClassificationValue) 행 수 — 새 모델에선 0 이어야 한다. */
  function countShadowConcept(name: string): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM concept_nodes
           WHERE name = ? AND is_classification_value = 1`,
        )
        .get(name) as { n: number }
    ).n;
  }

  test("E1 — #사람:인영희 #관계:가족 #가족:엄마 → 엄마(개념)→인영희(person 행) 직접 매달기", async () => {
    // 사람 행은 wireHashtagEntities 책임 — 매달기가 기존 행을 찾으므로 먼저 만든다(입력 통로 순서 재현).
    const person = await store.findOrCreatePersonByName("인영희");

    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);
    expect(result.hierarchyEdges).toBeGreaterThan(0);

    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });

    // 가족 → 엄마(사슬 분류 단·개념↔개념) + 엄마(개념) → 인영희(person 행 직접).
    expect(hasParentOf(family, mom)).toBe(true);
    expect(hasPersonLeafEdge(mom, person.personId)).toBe(true);
    // "인영희" 그림자 개념(isClassificationValue)은 생성되지 않는다 — person 행이 직접 위계 잎이다.
    expect(countShadowConcept("인영희")).toBe(0);
  });

  test("E2 — 순서 바뀐 #가족:엄마 … #사람:인영희 → 같은 결과(순서 무관)", async () => {
    const person = await store.findOrCreatePersonByName("인영희");

    const content = "#가족:엄마 #관계:가족 #사람:인영희";
    const origin = await makeOrigin(content);

    await wirePersonHierarchy(store, origin, content);

    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });

    expect(hasParentOf(family, mom)).toBe(true);
    expect(hasPersonLeafEdge(mom, person.personId)).toBe(true);
    expect(countShadowConcept("인영희")).toBe(0);
  });

  test("E3 — #사람:인영희 #관계:엄마(중간 단 없음) → 사람→엄마 + 엄마→인영희(person 행)", async () => {
    const person = await store.findOrCreatePersonByName("인영희");

    const content = "#사람:인영희 #관계:엄마";
    const origin = await makeOrigin(content);

    await wirePersonHierarchy(store, origin, content);

    const personRoot = await ensureTypeRootConcept(store, "person");
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });

    // 중간 분류 단이 없어 잎(엄마)이 사람 루트 직속에 붙고, 그 아래로 person 행(인영희)이 매달린다.
    expect(hasParentOf(personRoot, mom)).toBe(true);
    expect(hasPersonLeafEdge(mom, person.personId)).toBe(true);
    expect(countShadowConcept("인영희")).toBe(0);
  });

  test("E4 — 사람 둘 이상이면 잎→사람 매달기 0 + 경고(거짓 연결 0)", async () => {
    await store.findOrCreatePersonByName("인영희");
    await store.findOrCreatePersonByName("권영현");

    const content = "#사람:인영희 #사람:권영현 #가족:엄마 #가족:아빠";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);

    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    const inyounghee = await store.findPersonByNameOrAlias("인영희");
    // 엄마 → 인영희 매달기는 안 선다(누구를 매달지 모호).
    expect(inyounghee.person).not.toBeNull();
    expect(hasPersonLeafEdge(mom, inyounghee.person!.personId)).toBe(false);
    // 모호 경고가 남는다.
    expect(
      result.warnings.some((w) => w.includes("사람") || w.includes("모호")),
    ).toBe(true);
  });

  test("같은 이름 두 번(#사람:인영희 #사람:인영희)은 1명으로 보고 매달기 진행", async () => {
    // 같은 사람을 두 번 적은 것 — 정규화 이름 기준 dedupe 해 1명으로 본다(거짓 거부 0).
    const person = await store.findOrCreatePersonByName("인영희");

    const content = "#사람:인영희 #사람:인영희 #가족:엄마";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);

    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    // 같은 이름 1명으로 보고 엄마(개념) → 인영희(person 행) 매달기가 선다.
    expect(hasPersonLeafEdge(mom, person.personId)).toBe(true);
    // 매달았으니 사람-모호 경고는 없다.
    expect(result.warnings.some((w) => w.includes("사람이 둘 이상"))).toBe(false);
  });

  test("사람 행 미생성이면 잎→사람 매달기 0 + 경고(거짓 연결 0)", async () => {
    // 사람 선언은 있지만 person 행이 아직 없다(wireHashtagEntities 가 안 만든 입력).
    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const origin = await makeOrigin(content);

    const result = await wirePersonHierarchy(store, origin, content);

    // 사람 행이 없어 매달 끝점이 없다 — 위계는 가족→엄마까지 서지만 잎→사람은 건너뛰고 경고.
    expect(
      result.warnings.some((w) => w.includes("인영희") && w.includes("미생성")),
    ).toBe(true);
    // 그림자 인영희 개념을 만들어 매달지 *않는다*(silent fallback 0).
    expect(countShadowConcept("인영희")).toBe(0);
  });

  test("멱등 — 잎→사람(person 행) 매달기도 두 번이면 엣지 중복 0", async () => {
    const person = await store.findOrCreatePersonByName("인영희");

    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const origin = await makeOrigin(content);

    await wirePersonHierarchy(store, origin, content);
    await wirePersonHierarchy(store, origin, content);

    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    const edges = store
      .getHierarchyEdgesWithin([mom, person.personId])
      .filter(
        (e) =>
          e.sourceId === mom &&
          e.targetType === "person" &&
          e.targetId === person.personId,
      );
    expect(edges.length).toBe(1);
  });

  // ── 사람 선언 우선 양식도 소유자 관계 엣지 폐기 (위계·잎 매달기는 보존) ──────────
  //
  // 옛 양식은 사람 선언 우선 글(#사람:이놀부 #관계:가족 #가족:막내)에서 소유자(나=홍길동) ↔
  // 매달린 대상 사람(이놀부) family_of/friend_of 를 세웠다. 사용자 결정으로 이 소유자 관계 엣지
  // 생성을 폐기한다 — 위계(사람>가족>막내>이놀부)가 가족·친구 관계를 이미 표현하기 때문이다. 잎→사람
  // 매달기(엄마/막내 개념 → 이놀부 person 행)는 위계 축이라 그대로 보존한다.

  test("사람 선언 우선 #사람:이놀부 #가족:막내 → 소유자 관계 엣지 0(폐기)·잎 매달기 보존", async () => {
    const ownerId = await registerOwner();
    // 대상 사람 행(이놀부)을 먼저 만든다 — 입력 통로의 행→위계 순서 재현.
    const target = await store.findOrCreatePersonByName("이놀부");

    const content = "#사람:이놀부 #관계:가족 #가족:막내";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    // 소유자 관계 엣지(family_of) 0 — 위계가 가족 관계를 대체한다(폐기).
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(result.warnings.length).toBe(0);

    // 잎→사람 매달기는 보존 — 막내(개념) → 이놀부(person 행) 위계 엣지가 선다.
    const youngest = await store.findOrCreateConcept("막내", {
      isClassificationValue: true,
    });
    expect(hasPersonLeafEdge(youngest, target.personId)).toBe(true);
  });

  test("사람 선언 우선 #사람:인영희 #관계:가족 #가족:엄마 → 관계 엣지 0(폐기)·엄마→인영희 매달기 보존", async () => {
    const ownerId = await registerOwner();
    const person = await store.findOrCreatePersonByName("인영희");

    const content = "#사람:인영희 #관계:가족 #가족:엄마";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(result.warnings.length).toBe(0);

    // 잎→사람 매달기 보존 — 엄마(개념) → 인영희(person 행).
    const mom = await store.findOrCreateConcept("엄마", {
      isClassificationValue: true,
    });
    expect(hasPersonLeafEdge(mom, person.personId)).toBe(true);
  });

  test("사람 선언 우선 #사람:박대웅 #친구:박대웅 → friend_of 0(폐기)·위계 보존", async () => {
    const ownerId = await registerOwner();
    await store.findOrCreatePersonByName("박대웅");

    const content = "#사람:박대웅 #관계:친구 #친구:박대웅";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(result.warnings.length).toBe(0);

    // 위계 보존 — 사람 → 친구 → 박대웅.
    const personRoot = await ensureTypeRootConcept(store, "person");
    const friendClass = await store.findOrCreateConcept("친구", {
      isClassificationValue: true,
    });
    expect(hasParentOf(personRoot, friendClass)).toBe(true);
  });

  test("사람 선언 없는 #가족:엄마 단독 → 관계 엣지 0(폐기)·위계 보존", async () => {
    const ownerId = await registerOwner();
    const content = "#가족:엄마";
    const origin = await makeOrigin(content);
    await wirePersonHierarchy(store, origin, content);

    // 소유자 source 에 관계 엣지 0.
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    // 위계는 유지.
    const personRoot = await ensureTypeRootConcept(store, "person");
    const family = await store.findOrCreateConcept("가족", {
      isClassificationValue: true,
    });
    expect(hasParentOf(personRoot, family)).toBe(true);
  });

  test("모호(사람 둘) → 관계 엣지 0(폐기) + 위계 잎 매달기도 0(거짓 연결 0)", async () => {
    const ownerId = await registerOwner();
    await store.findOrCreatePersonByName("인영희");
    await store.findOrCreatePersonByName("권영현");

    const content = "#사람:인영희 #사람:권영현 #관계:가족 #가족:엄마";
    const origin = await makeOrigin(content);
    const result = await wirePersonHierarchy(store, origin, content);

    // 관계 엣지는 폐기라 0, 잎 매달기는 사람 둘이라 모호로 건너뛰고 경고.
    expect(relationEdgeCountFrom(ownerId)).toBe(0);
    expect(
      result.warnings.some((w) => w.includes("사람") || w.includes("모호")),
    ).toBe(true);
  });
});
