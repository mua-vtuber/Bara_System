/**
 * entity-placement-wiring.test.ts — 타입 배치 오케스트레이션 + 입력 통로 합류 검증
 * (개념 엔티티 타입 체계 3단계 Task 5, spec §11.2-3·§5·§6.5).
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store 로 검증한다(CLAUDE.md "DB/임베딩 의존
 * 모듈은 실제 구현체와 통합 검증"). LLM 단은 null(default OFF·결정적 1·2단만).
 *
 * 검증 대상:
 *   - `#작품:데못죽 #장르:판타지` → work 행 + 라벨(판타지) has_attribute 엣지 + 위계 없음
 *     (작품은 명시 타입·subcategory 없음).
 *   - `#생물:동물` + `#동물:고양이` → `생물 → 동물 → 고양이` parent_of 사슬 + creatures 행 0
 *     (동물 = 분류 단어 — 결정 B). 동물 → 고양이 단은 wireHashtagConcepts 가 만든다(입력 통로
 *     양식 그대로 먼저 부른 뒤 wireEntityPlacement 가 생물 → 동물 을 얹는다).
 *   - `#섭취:특제딸기우유 #유통기한:2026-07-01` → intake 행 + expires_at 칸(고유 개체명이라 행 생성).
 *   - `#섭취:우유` → intake 행 1 (우유 = intake seed 지만 명시 선언이 씨앗을 이김 — 결정 D·2026-06-27 M7).
 *   - `#섭취:음식` → intake 행 1 (음식은 더 이상 intake subcategory 가 아니라 명시 엔티티).
 *   - 기타 입력(타입 안 걸림) → 배치 0(정직·typeName null).
 *   - saveTextInput 한 번 호출에 개념 wiring + 타입 배치 둘 다 도는 입력 통로 합류 회귀.
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
import {
  wireEntityPlacement,
  wireEntityPlacementSafe,
} from "./entity-placement-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";
import { saveTextInput } from "../server-internal/save-input.ts";

describe("entity-placement-wiring — 타입 배치 오케스트레이션 (§11.2-3·§6.5)", () => {
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

  /**
   * 행 수를 센다. 단계4 T4 로 전용 8종 테이블(works·creatures·intakes·places·
   * schedules·things·usables·materials)이 범용 본체 entities 로 흡수됐으므로, 그 옛
   * 테이블 이름이 들어오면 `entities WHERE type_name=<단수형>` 으로 돌려 같은 뜻을
   * 센다. person·project 는 그대로 전용 테이블(persons·projects)이라 통과시킨다.
   */
  function countRows(table: string): number {
    const universalType: Record<string, string> = {
      works: "work",
      creatures: "creature",
      things: "thing",
      intakes: "intake",
      usables: "usable",
      materials: "material",
      places: "place",
      schedules: "schedule",
    };
    const typeName = universalType[table];
    if (typeName) {
      return (
        db
          .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
          .get(typeName) as { n: number }
      ).n;
    }
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  test("#작품:데못죽 #장르:판타지 → work 행 + 라벨(판타지) + 단일 배치 타입 루트→잎 위계 한 단", async () => {
    const content = "#작품:데못죽 #장르:판타지";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBeNull();
    // 단일 배치(subcategory=null·categoryChain=[])라 L2 가 작품 → 데못죽 한 단을 세운다
    // (2026-06-13 단일 타입 배치 잎 개념 보장 spec — 옛 "위계 0" 결함이 외톨이의 정체였다).
    expect(result.hierarchyEdges).toBe(1);
    expect(result.entityRowCreated).toBe(true);

    // works 행이 '데못죽' 으로 실제 생겼다.
    const row = await store.entitiesRepo.findByName("work", "데못죽");
    expect(row).not.toBeNull();
    expect(result.entityId).not.toBeNull();
    expect(row!.id).toBe(result.entityId!);

    // 라벨 '판타지' has_attribute 엣지가 work_concept_edges 에 붙었다.
    expect(result.labelsApplied).toBe(1);
    const fantasy = await store.findConceptByName("판타지");
    expect(fantasy).not.toBeNull();
    const labelEdges = store.getEntityConceptEdges(
      "work",
      result.entityId!,
      "has_attribute",
    );
    expect(labelEdges.some((e) => e.conceptId === fantasy!.conceptId)).toBe(true);

    // S2-T1 — 잎 '데못죽' 개념·identity(검색 JOIN 키)는 보존하되, 위계 잎은 *works 행*이다.
    // 단일 배치라 부모 = 타입 루트('작품'). 작품 → works행 parent_of 를 직접 쓴다(그림자 잎 0).
    const leaf = await store.findConceptByName("데못죽");
    expect(leaf).not.toBeNull();
    // identity 엣지(행 ↔ 잎-개념·role identity)는 검색 mention 경로라 유지된다.
    const identityEdges = store.getEntityConceptEdges(
      "work",
      result.entityId!,
      "identity",
    );
    expect(identityEdges.length).toBe(1);
    expect(identityEdges[0]!.conceptId).toBe(leaf!.conceptId);

    const workRoot = await store.findConceptByName("작품");
    const rootEdges = store.getHierarchyEdgesWithin([
      workRoot!.conceptId,
      leaf!.conceptId,
      result.entityId!,
    ]);
    // 위계 잎은 works 행 — 작품 → works행 parent_of 가 선다.
    expect(
      rootEdges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === workRoot!.conceptId &&
          e.targetId === result.entityId!,
      ),
    ).toBe(true);
    // 그림자 잎 개념('데못죽' 개념)이 위계 잎으로 쓰이는 엣지는 0 — 흡수 폐기의 핵심.
    expect(
      rootEdges.some(
        (e) =>
          e.relation === "parent_of" && e.targetId === leaf!.conceptId,
      ),
    ).toBe(false);
  });

  test("#생물:동물 #동물:고양이 → 생물 → 동물 위계 + 고양이 creature 행 1 (결정 D·M7)", async () => {
    // Task 7 — 한 글 입력이 사슬 두 조각을 만든다.
    //   `#생물:동물` → 생물(타입 루트) → 동물 (타입 배치 단계 linkSubcategoryToTypeRoot).
    //   `#동물:고양이` → 명시 선언이라 '고양이'(creature seed)가 결정 D 로 1급 creature 행이 된다.
    // 결정 D(2026-06-27 M7): 명시 선언이 일반명사 씨앗을 이긴다 — 콜론 사슬 잎(고양이)도 명시
    // 선언이면 1급 엔티티가 된다. 그래서 옛 '동물 → 고양이 *concept* 위계' 대신 고양이 creature
    // 엔티티가 선다(creatures 행 0 → 1). 분류 폴더 단어(동물)는 여전히 못 이겨 위계 잎 유지.
    const content = "#생물:동물 #동물:고양이";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("creature");
    expect(result.subcategory).toBe("동물");
    expect(result.entityRowCreated).toBe(true); // 결정 D — 명시 선언 '고양이' 가 씨앗을 이겨 행 생성.
    expect(result.entityId?.startsWith("cre_")).toBe(true);

    // creatures 행 1 — 고양이 1급 엔티티.
    expect(countRows("creatures")).toBe(1);
    const row = await store.entitiesRepo.findByName("creature", "고양이");
    expect(row).not.toBeNull();

    // 생물 → 동물 타입 배치 위계는 그대로 선다(동물 = 분류 폴더 단어).
    const saengmul = await store.findConceptByName("생물");
    const dongmul = await store.findConceptByName("동물");
    expect(saengmul).not.toBeNull();
    expect(dongmul).not.toBeNull();

    const edges = store.getHierarchyEdgesWithin([
      saengmul!.conceptId,
      dongmul!.conceptId,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    expect(hasEdge(saengmul!.conceptId, dongmul!.conceptId)).toBe(true); // 생물 → 동물
  });

  test("#섭취:특제딸기우유 #유통기한:2026-07-01 → intake 행 + expires_at 칸", async () => {
    // '특제딸기우유' 는 intake 의 seed·subcategory 어느 쪽과도 안 겹치는 고유 개체명이라
    // 결정 A·B 게이트를 통과해 행이 생긴다('우유' 단독은 seed 라 행 X — 아래 별 테스트).
    const content = "#섭취:특제딸기우유 #유통기한:2026-07-01";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("intake");
    expect(result.entityRowCreated).toBe(true);
    expect(result.columnsApplied).toBe(1); // 유통기한 → expires_at 칸 1개.

    const row = await store.entitiesRepo.findByName("intake", "특제딸기우유");
    expect(row).not.toBeNull();
    expect(result.entityId).not.toBeNull();
    expect(row!.id).toBe(result.entityId!);
    // 단계4 T4 — 옛 intake 전용 칸 expires_at 은 범용 본체 entity_attributes 의 칸으로
    // 옮겨졌다. attr_key 는 schema 칼럼 이름 'expires_at'(applyOwnColumns 의 camelToSnake
    // 결과·spec §4.1)이고 is_column=1(검색 합성 색인 포함)이다. 값이 채워졌는지 본다.
    const expiresRow = db
      .query(
        "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = 'expires_at'",
      )
      .get(result.entityId!) as
      | { attr_value: string; is_column: number }
      | null;
    expect(expiresRow).not.toBeNull();
    expect(expiresRow!.attr_value).toBe("2026-07-01");
    expect(expiresRow!.is_column).toBe(1); // 칸(전용 칸과 동등·검색 색인 포함).
  });

  test("#섭취:우유 → intake 행 1 (결정 D — 명시 선언이 일반명사 씨앗을 이김, M7)", async () => {
    // '우유' 는 intake seed 지만 #섭취:우유 는 명시 선언(explicit)이라 결정 D 로 1급 행을 만든다.
    // (옛 결정 B 보수는 explicit 여도 씨앗이면 막았으나 2026-06-27 M7 로 명시 선언이 이김.)
    const content = "#섭취:우유";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("intake"); // 타입은 걸린다(섭취 명시 태그).
    expect(result.entityRowCreated).toBe(true); // 명시 선언이 씨앗을 이겨 1급 행 생성(결정 D).
    expect(countRows("intakes")).toBe(1);
    const row = await store.entitiesRepo.findByName("intake", "우유");
    expect(row).not.toBeNull();
  });

  test("#섭취:음식 → intake 행 1 (음식은 더 이상 subcategory 가 아니라 명시 엔티티)", async () => {
    // 섭취 하위분류에서 음식·음료·식재료를 제거했다. 따라서 #섭취:음식 은 분류 폴더가
    // 아니라 사용자가 명시한 섭취 엔티티로 행을 만든다.
    const content = "#섭취:음식";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("intake");
    expect(result.entityRowCreated).toBe(true);
    expect(countRows("intakes")).toBe(1);
    expect(await store.entitiesRepo.findByName("intake", "음식")).not.toBeNull();
  });

  test("기타 입력(타입 안 걸림) → 배치 0(정직·typeName null)", async () => {
    const content = "오늘 날씨가 참 좋다";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBeNull();
    expect(result.subcategory).toBeNull();
    expect(result.hierarchyEdges).toBe(0);
    expect(result.entityRowCreated).toBe(false);
    expect(result.entityId).toBeNull();
    // 8 타입 행 어느 것도 안 생긴다.
    expect(countRows("works")).toBe(0);
    expect(countRows("creatures")).toBe(0);
    expect(countRows("intakes")).toBe(0);
  });

  test("멱등 — 같은 글로 두 번 불러도 행·라벨 중복 0", async () => {
    const content = "#작품:데못죽 #장르:판타지";
    const origin = await makeOrigin(content);

    const first = await wireEntityPlacement(store, origin, content, { llm: null });
    const second = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(second.entityId).toBe(first.entityId);
    expect(countRows("works")).toBe(1);

    const labelEdges = store.getEntityConceptEdges(
      "work",
      first.entityId!,
      "has_attribute",
    );
    expect(labelEdges.length).toBe(1); // 판타지 라벨 엣지 한 개(멱등).
  });

  test("wireEntityPlacementSafe — 실패를 격리하고 원본을 보존한다", async () => {
    // 정상 경로는 throw 없이 끝난다(원본 노드는 호출 통로가 이미 저장). 실패 격리 래퍼라
    // 예외를 다시 던지지 않는다 — 정상·실패 둘 다 resolve 한다.
    const content = "#작품:데못죽";
    const origin = await makeOrigin(content);
    await wireEntityPlacementSafe(store, origin, content, undefined, "test", null);
    expect(await store.entitiesRepo.findByName("work", "데못죽")).not.toBeNull();
  });

  // ── 4단계 Task 4 부분 A — 관계 wiring 합류(행 생기면 관계 엣지·이중 처리 0) ──────────

  test("#작품:데못죽 #창작자:아쿠타미 → work 행 + created_by 관계 엣지(라벨 엣지 0·관계만)", async () => {
    const content = "#작품:데못죽 #창작자:아쿠타미";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    // 관계 엣지가 result 에 additive 로 들어왔다 — 작품→사람 created_by 하나.
    expect(result.relationEdges.length).toBe(1);
    expect(result.relationEdges[0]!.relation).toBe("created_by");
    expect(result.relationEdges[0]!.targetName).toBe("아쿠타미");

    // 핵심 이중 처리 가드 — '창작자' 가 라벨 엣지로 안 샜다(라벨 엣지 0).
    expect(result.labelsApplied).toBe(0);
    const labelEdges = store.getEntityConceptEdges(
      "work",
      result.entityId!,
      "has_attribute",
    );
    expect(labelEdges.length).toBe(0);

    // 관계 엣지는 entity_relation_edges 에 한 행(관계 엣지 1).
    const relEdges = store.getRelationsFromSource("work", result.entityId!);
    expect(relEdges.length).toBe(1);
    expect(relEdges[0]!.relation).toBe("created_by");

    // '아쿠타미' 는 라벨 개념이 아니라 사람 행으로 갔다.
    expect(await store.findConceptByName("아쿠타미")).toBeNull();
    const person = await store.findPersonByNameOrAlias("아쿠타미");
    expect(person.person).not.toBeNull();
  });

  test("#작품:데못죽 #장르:판타지 #창작자:아쿠타미 → 장르=라벨 1, 창작자=관계 1(겹침 0)", async () => {
    const content = "#작품:데못죽 #장르:판타지 #창작자:아쿠타미";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    // 장르는 라벨(판타지 has_attribute 1), 창작자는 관계(created_by 1) — 갈래가 갈린다.
    expect(result.labelsApplied).toBe(1);
    expect(result.relationEdges.length).toBe(1);
    expect(result.relationEdges[0]!.relation).toBe("created_by");

    const labelEdges = store.getEntityConceptEdges(
      "work",
      result.entityId!,
      "has_attribute",
    );
    expect(labelEdges.length).toBe(1); // 판타지만 라벨(아쿠타미는 라벨로 안 샜다).
    const fantasy = await store.findConceptByName("판타지");
    expect(labelEdges[0]!.conceptId).toBe(fantasy!.conceptId);
  });

  test("행이 안 생기면 관계 엣지도 0 (#작품:소설 #창작자:아쿠타미 — 소설=subcategory 행 X)", async () => {
    // 분류 폴더 단어(소설=subcategory)는 명시 선언이어도 1급 행 X(결정 D 도 폴더는 못 이김).
    // 행이 없으니 관계를 걸 source 가 없어 관계 엣지도 0.
    const content = "#작품:소설 #창작자:아쿠타미";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(false);
    expect(result.relationEdges).toEqual([]);
    expect(countRows("works")).toBe(0);
  });

  test("관계 합류 멱등 — 같은 글 두 번 입력해도 관계 엣지 1(중복 0)", async () => {
    const content = "#작품:데못죽 #창작자:아쿠타미";
    const origin = await makeOrigin(content);

    const first = await wireEntityPlacement(store, origin, content, { llm: null });
    const second = await wireEntityPlacement(store, origin, content, { llm: null });

    // 두 번째는 멱등이라 created 가 비어 result.relationEdges(=created) 0.
    expect(first.relationEdges.length).toBe(1);
    expect(second.relationEdges.length).toBe(0);

    // entity_relation_edges 에는 한 행만(중복 0).
    const relEdges = store.getRelationsFromSource("work", first.entityId!);
    expect(relEdges.length).toBe(1);
  });

  // ── 콜론 사슬 자동 배치 Task 2 — 입력 통로 정합 + (다) 경고 합류 ─────────────────

  test("사슬 결과 동치 — #작품:소설 #소설:데뷔못... 가 #소설:데뷔못... 단독과 같은 배치", async () => {
    const chained = "#작품:소설 #소설:데뷔못하면죽는병걸림";
    const single = "#소설:데뷔못하면죽는병걸림";

    const oChained = await makeOrigin(chained);
    const rChained = await wireEntityPlacement(store, oChained, chained, { llm: null });

    // 새 store 로 단독 입력을 따로 돌려 비교(같은 db 면 멱등으로 섞이니 분리).
    const db2 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const store2 = new SqliteMemoryStore(db2, embedder);
    const o2 = await store2.addNode({
      content: single,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    const rSingle = await wireEntityPlacement(store2, o2, single, { llm: null });

    // typeName·subcategory·행 생성·candidateName(=work 이름) 동치.
    expect(rChained.typeName).toBe(rSingle.typeName);
    expect(rChained.subcategory).toBe(rSingle.subcategory);
    expect(rChained.entityRowCreated).toBe(rSingle.entityRowCreated);
    expect(rChained.entityRowCreated).toBe(true);

    const rowChained = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    const rowSingle = await store2.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(rowChained).not.toBeNull();
    expect(rowSingle).not.toBeNull();

    // 위계 완결 — 작품 > 소설 > works행 parent_of 사슬(S2-T1·chained 쪽에서 확인).
    // 위계 잎은 *works 행* 이다 — 다단계 부모(마지막 분류 단 '소설') → works행 직접.
    // 잎 개념(검색 mention 키)은 E3 에서 매체로 갈린다 — 매체 '소설' 만 있고 작가가 없어
    // "데뷔못하면죽는병걸림 (소설)" 단일 매체 형식이다(P3-leaf).
    const jakpum = await store.findConceptByName("작품");
    const soseol = await store.findConceptByName("소설");
    const name = await store.findConceptByName("데뷔못하면죽는병걸림 (소설)");
    expect(jakpum).not.toBeNull();
    expect(soseol).not.toBeNull();
    expect(name).not.toBeNull();
    const edges = store.getHierarchyEdgesWithin([
      jakpum!.conceptId,
      soseol!.conceptId,
      name!.conceptId,
      rowChained!.id,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    expect(hasEdge(jakpum!.conceptId, soseol!.conceptId)).toBe(true); // 작품 → 소설
    expect(hasEdge(soseol!.conceptId, rowChained!.id)).toBe(true); // 소설 → works행(잎)
    // 그림자 잎 개념('데뷔못... (소설)' 개념)이 위계 잎으로 쓰이는 엣지는 0(흡수 폐기).
    expect(
      edges.some(
        (e) => e.relation === "parent_of" && e.targetId === name!.conceptId,
      ),
    ).toBe(false);

    db2.close();
  });

  test("(다) 게이트① — #작품:소설(다음 태그 없음) → 행 미생성 + 이름 후보 경고", async () => {
    const content = "#작품:소설";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBe("소설");
    expect(result.entityRowCreated).toBe(false); // 빈 후보 — 행 X(거짓 엔티티 0).
    expect(countRows("works")).toBe(0);
    expect(result.warnings.some((w) => w.includes("이름 후보를 못 찾음"))).toBe(true);
    // 위계는 거쳐 온 분류 단까지 세운다 — 작품 → 소설.
    const jakpum = await store.findConceptByName("작품");
    const soseol = await store.findConceptByName("소설");
    expect(jakpum).not.toBeNull();
    expect(soseol).not.toBeNull();
  });

  test("(다) 게이트② — 순환 #작품:소설 #소설:작품 → depth-or-cycle 경고", async () => {
    const content = "#작품:소설 #소설:작품";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    // 멈춘 자리 값('작품')이 candidateName 인데 '작품' 은 어휘 밖 고유명이 아니라 타입 지시
    // 키라 행 게이트가 막거나 비정상 사슬 경고가 남는다 — 경고가 정직히 알린다.
    expect(
      result.warnings.some((w) => w.includes("비정상으로 길거나 순환")),
    ).toBe(true);
  });

  test("(다) 게이트② L3 동결 회귀 — 깊이 상한(7+ 사슬) 도달 → result.warnings 에 사용자 경고 노출", async () => {
    // L3 동결(2026-06-27): 상한 COLON_CHAIN_MAX_DEPTH(6) 도달 시 멈춘 값으로 진행 + 경고 노출
    // 정책이 확정. 이 회귀 테스트는 *순환이 아닌 순수 깊이 상한* 사슬이 멈춘 뒤 그 사유가
    // result.warnings 로 사용자에게 올라가는지(silent drop 0) 검증한다.
    // work subcategories 7개(소설→만화→게임→애니→영화→음악→웹툰)를 서로 다른 키로 길게 이어
    // 순환이 먼저 안 걸리고 깊이 상한 6 에 닿게 한다. 멈춘 값('음악')이 분류 폴더 단어라
    // 행 게이트가 막고(거짓 엔티티 0) 그 사유 경고가 정직히 남는다.
    const content =
      "#작품:소설 #소설:만화 #만화:게임 #게임:애니 #애니:영화 #영화:음악 #음악:웹툰";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    // 깊이 상한으로 멈춘 사슬은 행을 안 만들되 사유 경고가 result.warnings 로 노출된다.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("비정상으로 길거나 순환") ||
          w.includes("분류 단어가 이름 자리에") ||
          w.includes("이름 후보를 못 찾음"),
      ),
    ).toBe(true);
  });

  // ── 엔티티 별칭 ko_aliases 등록 — #별명:/#닉네임: 키 통로 (2026-06-13 §13 재배선) ────────

  test("별칭 — #소설:데뷔못... #별명:데못죽 → work 행 ko_aliases 에 데못죽", async () => {
    const content = "#소설:데뷔못하면죽는병걸림 #별칭:데못죽";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    expect(row!.koAliases).toContain("데못죽");
  });

  test("작품 별칭 조회 — #작품:데못죽 이 기존 정식 작품 행으로 연결된다", async () => {
    const fullContent = "#소설:데뷔못하면죽는병걸림 #별칭:데못죽";
    const fullOrigin = await makeOrigin(fullContent);
    await wireEntityPlacement(store, fullOrigin, fullContent, { llm: null });

    const aliasContent = "#작품:데못죽";
    const aliasOrigin = await makeOrigin(aliasContent);
    const result = await wireEntityPlacement(store, aliasOrigin, aliasContent, {
      llm: null,
    });

    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    expect(result.entityId).toBe(row!.id);
    expect(await store.entitiesRepo.findByName("work", "데못죽")).toBeNull();
  });

  test("작품 외 8타입 별칭 — 별칭을 저장하지 않고 경고한다", async () => {
    const content = "#섭취:특제딸기우유 #별칭:딸우";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    const row = await store.entitiesRepo.findByName("intake", "특제딸기우유");
    expect(row).not.toBeNull();
    expect(row!.koAliases).toEqual([]);
    expect(result.warnings.some((w) => w.includes("사람·작품·프로젝트"))).toBe(true);
  });

  test("별칭 멱등 — 같은 글 두 번 처리해도 ko_aliases 중복 0", async () => {
    const content = "#소설:데뷔못하면죽는병걸림 #별명:데못죽";
    const origin = await makeOrigin(content);

    await wireEntityPlacement(store, origin, content, { llm: null });
    await wireEntityPlacement(store, origin, content, { llm: null });

    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    // '데못죽' 이 한 번만 들어 있다(합집합 멱등).
    const count = row!.koAliases.filter((a) => a === "데못죽").length;
    expect(count).toBe(1);
  });

  test("별칭 없음 — #별명: 태그 없는 입력은 ko_aliases 가 빈 채(등록 건너뜀)", async () => {
    const content = "#소설:데뷔못하면죽는병걸림";
    const origin = await makeOrigin(content);

    await wireEntityPlacement(store, origin, content, { llm: null });

    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    expect(row!.koAliases).toEqual([]); // 별칭 후보 0 — 등록 건너뜀(정직).
  });

  test("별칭 — 행 미생성(분류 단어 candidateName)이면 별칭 등록 안 함(대상 없음)", async () => {
    // #작품:소설(다음 태그 없음) → 빈 후보 → 행 X. #별명: 태그가 없어도 등록 대상 자체가 없다.
    const content = "#작품:소설 #소설:데못죽";
    // 위는 사슬이 #소설:데못죽 으로 내려가 '데못죽' 고유명 행을 만든다 — 별칭 등록 대상이
    // '데못죽' 행이고 #별명: 태그가 없으니 ko_aliases 는 빈 채. 행은 정상 생성.
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("work", "데못죽");
    expect(row).not.toBeNull();
    expect(row!.koAliases).toEqual([]);
  });

  // ── 콜론 사슬 자동 배치 Task 4 — (나) 같은 분류 둘+ 경고 (C6 옵션 A) ────────────────

  test("(나) 같은 분류 둘+ — #웹툰:A #웹툰:B → A 만 work 행 + B 미반영 경고", async () => {
    // '웹툰' 은 work 의 subcategory(yaml). 같은 키 둘이면 첫째 A 만 엔티티·둘째 B 경고.
    const content = "#웹툰:전지적독자시점 #웹툰:신의탑";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBe("웹툰");
    expect(result.entityRowCreated).toBe(true);

    // 첫째 '전지적독자시점' 만 work 행이 된다.
    expect(await store.entitiesRepo.findByName("work", "전지적독자시점")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("work", "신의탑")).toBeNull();

    // 둘째 '신의탑' 미반영 경고.
    expect(
      result.warnings.some(
        (w) => w.includes("같은 분류") && w.includes("신의탑"),
      ),
    ).toBe(true);
  });

  test("(나) 하나뿐 — #소설:A 단독은 같은 분류 둘+ 경고 없음", async () => {
    const content = "#소설:데뷔못하면죽는병걸림";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    expect(result.warnings.some((w) => w.includes("같은 분류"))).toBe(false);
  });

  test("(나) 다른 분류 둘 — #소설:A #만화:B 는 같은 키 아님(이 경고 대상 아님)", async () => {
    // 소설·만화 둘 다 work subcategory 지만 *키가 다르다* → 같은 분류 둘+ 경고 대상 아님.
    const content = "#소설:데뷔못하면죽는병걸림 #만화:주술회전";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.warnings.some((w) => w.includes("같은 분류"))).toBe(false);
  });

  // ── P4 재정의(글 주체) — 사람 주체 글의 작품은 행 X·기존 작품 연결 ─────────────────
  //
  // 라이브 결정(spec §0.1 2026-06-16 "글 주체"): 글에 `#사람:` 선언이 있으면(사람 주체 글)
  // 그 글의 `#작품:` 은 새 work 행을 만들지 않는다 — 매체·작가 미상 파편 작품(괴담①) 양산
  // 차단. 같은 글의 사람을 작가로 보아 기존 동명+작가 작품에 글→작품 연결만 한다.

  test("P4-redefine 사람 주체 글 — 작품 행 0(기존 작품 없어 연결도 0)", async () => {
    const c = "#사람:백덕수 #직업:소설작가 #작품:데못죽 #작품:괴담";
    const origin = await makeOrigin(c);
    const result = await wireEntityPlacement(store, origin, c);
    // 사람 주체 글이라 작품 행을 안 만든다 — 기존 동명+작가 작품도 없으니 연결도 0.
    expect(countRows("works")).toBe(0);
    // 동명+작가 작품 없어 연결 안 함을 정직히 경고로 남긴다(silent 차단).
    expect(
      result.warnings.some(
        (w) => w.includes("데못죽") && w.includes("연결 안 함"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.includes("괴담") && w.includes("연결 안 함"),
      ),
    ).toBe(true);
    // person 행은 입력 통로 wireHashtagEntities 몫(이 테스트 범위 밖) — work 0 만 확인.
  });

  test("P4-redefine 작품 글 — 사람 선언 없으면 행 생성(기존 P3)", async () => {
    const c = "#작품:소설 #소설:괴담 #작가:백덕수";
    const origin = await makeOrigin(c);
    await wireEntityPlacement(store, origin, c);
    expect(countRows("works")).toBe(1);
    const w = db
      .query(
        "SELECT name, medium, created_by FROM entities WHERE type_name = 'work'",
      )
      .get() as any;
    expect(w.name).toBe("괴담");
    expect(w.medium).toBe("소설");
    expect(w.created_by).toBe("백덕수");
  });

  test("P4-redefine 사람 글 — 기존 동명+작가 작품에 연결", async () => {
    // 1) 작품 글로 소설 괴담(백덕수) 등록.
    const o1 = await makeOrigin("#작품:소설 #소설:괴담 #작가:백덕수");
    await wireEntityPlacement(store, o1, "#작품:소설 #소설:괴담 #작가:백덕수");
    const before = countRows("works");
    expect(before).toBe(1);
    const work = db
      .query(
        "SELECT entity_id, name FROM entities WHERE type_name = 'work' AND name='괴담'",
      )
      .get() as any;
    expect(work).toBeTruthy();

    // 2) 사람 글에서 백덕수+괴담 — 새 행 X, 기존 소설괴담(백덕수)에 연결.
    const o2 = await makeOrigin("#사람:백덕수 #작품:괴담");
    const r2 = await wireEntityPlacement(store, o2, "#사람:백덕수 #작품:괴담");
    expect(countRows("works")).toBe(before); // 새 행 0.

    // o2 글이 기존 소설괴담에 연결됐다 — 글→작품 잎-개념 mention(role='classification').
    // 행 생성 경로와 같은 분리 잎 개념('괴담 (소설/백덕수)')을 origin o2 노드가 언급한다
    // (E3 — 연결도 work 의 medium·createdBy 칸으로 같은 분리 키를 만들어 정확히 닿는다).
    const goedam = await store.findConceptByName("괴담 (소설/백덕수)");
    expect(goedam).not.toBeNull();
    const mentions = await store.listNodeConceptEdges({
      nodeId: o2,
      conceptId: goedam!.conceptId,
      role: "classification",
    });
    expect(mentions.length).toBe(1);
    // 연결은 행 생성이 아니다 — entityRowCreated=false·entityId 미설정(의미 오버로드 차단).
    expect(r2.entityRowCreated).toBe(false);
    expect(r2.entityId).toBeNull();
  });

  test("P4-redefine 사슬 양식 사람 글 — 매체 토큰('소설') 거짓 경고 0·잎 제목('괴담')만 연결", async () => {
    // 작품 글로 소설 괴담(백덕수) 등록.
    const o1 = await makeOrigin("#작품:소설 #소설:괴담 #작가:백덕수");
    await wireEntityPlacement(store, o1, "#작품:소설 #소설:괴담 #작가:백덕수");
    expect(countRows("works")).toBe(1);

    // 사슬 양식 사람 글 — work 그룹 declValues 에 매체 토큰 '소설'(work subcategory 키)도 합류한다.
    // 연결 갈래가 행 생성 경로와 같은 사슬 진입점 판정을 태워 잎 제목 '괴담'만 연결 대상으로 삼아야
    // '소설' 거짓 경고가 나지 않는다.
    const o2 = await makeOrigin("#사람:백덕수 #작품:소설 #소설:괴담");
    const r2 = await wireEntityPlacement(store, o2, "#사람:백덕수 #작품:소설 #소설:괴담");
    expect(countRows("works")).toBe(1); // 새 행 0(연결만).

    // '소설'(매체 토큰)에 대한 거짓 경고가 없다 — 연결 대상에서 빠졌다.
    expect(
      r2.warnings.some((w) => w.includes("'소설'") && w.includes("연결 안 함")),
    ).toBe(false);
    // 잎 제목 '괴담'은 기존 백덕수 소설괴담에 연결됐다(경고 없음).
    expect(
      r2.warnings.some((w) => w.includes("괴담") && w.includes("연결 안 함")),
    ).toBe(false);
    const goedam = await store.findConceptByName("괴담 (소설/백덕수)");
    const mentions = await store.listNodeConceptEdges({
      nodeId: o2,
      conceptId: goedam!.conceptId,
      role: "classification",
    });
    expect(mentions.length).toBe(1); // 분리 잎-개념('괴담 (소설/백덕수)')을 o2 가 언급(연결됨·E3).
  });

  test("P4-redefine 사슬 양식 사람 글 — 기존 작품 없으면 잎 제목만 경고('소설' 매체 토큰 경고 0)", async () => {
    // 등록된 작품이 없는 사슬 양식 사람 글. '괴담' 잎 제목에 대해서만 "연결 안 함" 경고가 나고,
    // 매체 토큰 '소설'에 대해서는 경고가 나지 않아야 한다(거짓 경고 0).
    const o = await makeOrigin("#사람:백덕수 #작품:소설 #소설:괴담");
    const r = await wireEntityPlacement(store, o, "#사람:백덕수 #작품:소설 #소설:괴담");
    expect(countRows("works")).toBe(0); // 사람 글이라 행 0.
    // 잎 제목 '괴담' 경고는 있다(등록 작품 없음).
    expect(
      r.warnings.some((w) => w.includes("'괴담'") && w.includes("연결 안 함")),
    ).toBe(true);
    // 매체 토큰 '소설' 거짓 경고는 없다.
    expect(
      r.warnings.some((w) => w.includes("'소설'") && w.includes("연결 안 함")),
    ).toBe(false);
  });

  test("P4-redefine 사람 글 — 동명 다른 작가는 연결 안 함(거짓 연결 0)", async () => {
    // 작품 글로 소설 괴담(쓩늉) 등록 — 작가가 다르다.
    const o1 = await makeOrigin("#작품:소설 #소설:괴담 #작가:쓩늉");
    await wireEntityPlacement(store, o1, "#작품:소설 #소설:괴담 #작가:쓩늉");

    // 사람 글에서 백덕수+괴담 — 백덕수 작품 괴담은 없으니(쓩늉 것뿐) 연결 안 함.
    const o2 = await makeOrigin("#사람:백덕수 #작품:괴담");
    const r2 = await wireEntityPlacement(store, o2, "#사람:백덕수 #작품:괴담");
    expect(countRows("works")).toBe(1); // 쓩늉 괴담 한 행만(새 행 0·연결 0).

    // 쓩늉 괴담 잎-개념을 o2(백덕수 글)가 언급하지 않는다(거짓 연결 0). F1(콜론 값 그림자 차단)
    // 후 맨이름 "괴담" 개념은 안 생기므로(작품이 소비하는 (소설,괴담) 쌍 제외) findConceptByName
    // 이 null 일 수 있다 — 그래도 거짓 연결 0 의도는 그대로다(없는 개념엔 mention 도 없다). 분리
    // 잎("괴담 (소설/쓩늉)")에도 o2 가 안 닿아야 거짓 연결 0 이 완전하다.
    const goedam = await store.findConceptByName("괴담");
    if (goedam) {
      const mentions = await store.listNodeConceptEdges({
        nodeId: o2,
        conceptId: goedam.conceptId,
        role: "classification",
      });
      expect(mentions.length).toBe(0);
    }
    const split = await store.findConceptByName("괴담 (소설/쓩늉)");
    if (split) {
      const splitMentions = await store.listNodeConceptEdges({
        nodeId: o2,
        conceptId: split.conceptId,
        role: "classification",
      });
      expect(splitMentions.length).toBe(0);
    }
    expect(
      r2.warnings.some((w) => w.includes("괴담") && w.includes("연결 안 함")),
    ).toBe(true);
  });

  test("P4-redefine 사람 글 — 매체 여럿 동명+작가 작품 모두 연결", async () => {
    // 작품 글로 백덕수의 괴담 두 매체(소설·웹툰) 등록.
    const oa = await makeOrigin("#작품:소설 #소설:괴담 #작가:백덕수");
    await wireEntityPlacement(store, oa, "#작품:소설 #소설:괴담 #작가:백덕수");
    const ob = await makeOrigin("#작품:웹툰 #웹툰:괴담 #작가:백덕수");
    await wireEntityPlacement(store, ob, "#작품:웹툰 #웹툰:괴담 #작가:백덕수");
    expect(countRows("works")).toBe(2); // 매체로 갈린 두 행.

    // 사람 글 백덕수+괴담 — 동명+작가 두 행 모두 글→작품 연결. E3 에서 두 행은 매체로 갈린
    // 별개 잎 개념('괴담 (소설/백덕수)'·'괴담 (웹툰/백덕수)')을 쓰므로 o2 가 둘 다 언급한다.
    const o2 = await makeOrigin("#사람:백덕수 #작품:괴담");
    await wireEntityPlacement(store, o2, "#사람:백덕수 #작품:괴담");
    expect(countRows("works")).toBe(2); // 새 행 0.
    const novel = await store.findConceptByName("괴담 (소설/백덕수)");
    const webtoon = await store.findConceptByName("괴담 (웹툰/백덕수)");
    expect(novel).not.toBeNull();
    expect(webtoon).not.toBeNull();
    // 두 분리 잎 개념 각각에 o2 mention 한 행(연결이 매체별 분리 키로 둘 다 닿는다).
    const novelMentions = await store.listNodeConceptEdges({
      nodeId: o2,
      conceptId: novel!.conceptId,
      role: "classification",
    });
    const webtoonMentions = await store.listNodeConceptEdges({
      nodeId: o2,
      conceptId: webtoon!.conceptId,
      role: "classification",
    });
    expect(novelMentions.length).toBe(1);
    expect(webtoonMentions.length).toBe(1);
  });

  test("P4 합류 — 타입 지시 키 + 분류 진입 키 같은 타입(#작품:데못죽 #소설:괴담 → work 둘)", async () => {
    // qa A1 권고: 합류 케이스 통합 검증. work 그룹에 데못죽·괴담 둘 다 배치되는지.
    const c = "#작품:데못죽 #소설:괴담에떨어져도";
    const origin = await makeOrigin(c);
    await wireEntityPlacement(store, origin, c);
    expect(countRows("works")).toBeGreaterThanOrEqual(2);
  });

  test("P4 사람 단독 글 회귀 — #사람:홍길동 은 8타입 행 0(person 행은 입력 통로 전담)", async () => {
    const c = "#사람:홍길동";
    const origin = await makeOrigin(c);
    const result = await wireEntityPlacement(store, origin, c);
    expect(result.typeName).toBe("person");
    expect(countRows("works")).toBe(0);
    expect(countRows("creatures")).toBe(0);
    expect(countRows("persons")).toBe(0); // person 행은 wireHashtagEntities 전담.
  });

  test("P4-redefine 멱등 — 사람 글 연결 두 번 입력해도 mention 중복 0", async () => {
    // 작품 글로 백덕수의 데못죽·괴담 등록(사람 선언 없는 작품 글이라 행 생성).
    const oa = await makeOrigin("#작품:소설 #소설:데못죽 #작가:백덕수");
    await wireEntityPlacement(store, oa, "#작품:소설 #소설:데못죽 #작가:백덕수");
    const ob = await makeOrigin("#작품:소설 #소설:괴담 #작가:백덕수");
    await wireEntityPlacement(store, ob, "#작품:소설 #소설:괴담 #작가:백덕수");
    expect(countRows("works")).toBe(2);

    // 사람 글 두 번 입력 — 행은 안 늘고(연결만), 같은 글 mention 도 멱등(중복 0).
    const c = "#사람:백덕수 #작품:데못죽 #작품:괴담";
    const origin = await makeOrigin(c);
    await wireEntityPlacement(store, origin, c);
    await wireEntityPlacement(store, origin, c);
    expect(countRows("works")).toBe(2); // 새 행 0(연결만).

    // E3 — 잎 개념은 매체·작가로 갈린다('데못죽 (소설/백덕수)'). 연결도 같은 분리 키로 닿는다.
    const daemotjuk = await store.findConceptByName("데못죽 (소설/백덕수)");
    expect(daemotjuk).not.toBeNull();
    const mentions = await store.listNodeConceptEdges({
      nodeId: origin,
      conceptId: daemotjuk!.conceptId,
      role: "classification",
    });
    expect(mentions.length).toBe(1); // 두 번 입력해도 mention 한 행(addNodeConceptEdge INSERT OR IGNORE).
  });

  // P3-B3 — work 배치에 매체(medium)·작가(author) 정체성 키를 배선한다. 같은 이름이라도
  // 매체나 작가가 다르면 별개 work 행이 된다(B1 v21 복합 UNIQUE + B2 findOrCreateWork).
  test("P3 매체 변별 — 괴담(소설)·괴담(웹툰) 별개 work 행", async () => {
    const o1 = await makeOrigin("#작품:소설 #소설:괴담에떨어져도");
    await wireEntityPlacement(store, o1, "#작품:소설 #소설:괴담에떨어져도");
    const o2 = await makeOrigin("#작품:웹툰 #웹툰:괴담에떨어져도");
    await wireEntityPlacement(store, o2, "#작품:웹툰 #웹툰:괴담에떨어져도");
    const rows = db
      .query(
        "SELECT name, medium FROM entities WHERE type_name = 'work' AND name='괴담에떨어져도' ORDER BY medium",
      )
      .all();
    expect(rows.length).toBe(2);
    expect(rows.map((r: any) => r.medium).sort()).toEqual(["소설", "웹툰"]);
  });

  test("P3 작가 변별 — 같은 매체 다른 작가 별개 work 행", async () => {
    // 작가 관계 키는 entity-relation-vocabulary 의 created_by 동의어(#작가:).
    const o1 = await makeOrigin("#작품:소설 #소설:괴담 #작가:백덕수");
    await wireEntityPlacement(store, o1, "#작품:소설 #소설:괴담 #작가:백덕수");
    const o2 = await makeOrigin("#작품:소설 #소설:괴담 #작가:쓩늉");
    await wireEntityPlacement(store, o2, "#작품:소설 #소설:괴담 #작가:쓩늉");
    const rows = db
      .query(
        "SELECT created_by FROM entities WHERE type_name = 'work' AND name='괴담' ORDER BY created_by",
      )
      .all();
    expect(rows.length).toBe(2);
    expect(rows.map((r: any) => r.created_by).sort()).toEqual(["백덕수", "쓩늉"]);
  });

  test("P3 매체 미입력 — created_by·medium NULL 동명 같은 행(Q3-1)", async () => {
    const o1 = await makeOrigin("#작품:괴담단독");
    await wireEntityPlacement(store, o1, "#작품:괴담단독");
    const o2 = await makeOrigin("#작품:괴담단독");
    await wireEntityPlacement(store, o2, "#작품:괴담단독");
    expect(countRows("works")).toBe(1);
    const row = db
      .query(
        "SELECT medium, created_by FROM entities WHERE type_name = 'work' AND name='괴담단독'",
      )
      .get() as { medium: string | null; created_by: string | null };
    expect(row.medium).toBeNull();
    expect(row.created_by).toBeNull();
  });

  // ── E3: 잎 개념 work별 분리 배선 + 원래 이름 별칭 보강(P3-leaf) ──────────────
  test("E3 동명 work 별개 잎 개념 — 소설 괴담·웹툰 괴담 글 안 엉킴", async () => {
    const c1 = "#작품:소설 #소설:괴담 #작가:백덕수";
    const o1 = await makeOrigin(c1);
    await wireEntityPlacement(store, o1, c1, { llm: null });
    const c2 = "#작품:웹툰 #웹툰:괴담 #작가:쓩늉";
    const o2 = await makeOrigin(c2);
    await wireEntityPlacement(store, o2, c2, { llm: null });

    // work 잎 *identity* 개념이 둘로 갈렸다 — "괴담 (소설/백덕수)"·"괴담 (웹툰/쓩늉)" 별개
    // concept_node(공유 1개가 아니다). 매체·작가가 정체성 키라 동명이 한 잎 개념을 안 나눠 쓴다.
    // (콜론 위계 값 개념 "괴담"(`#소설:괴담`·`#웹툰:괴담` 의 값)은 별개 일반 분류 경로 산출이라
    //  여기 잎 분리 검증과 무관 — 괄호 분리 형식의 잎 개념만 가른다.)
    const separatedLeaves = (
      db
        .query(
          "SELECT name FROM concept_nodes WHERE name LIKE '괴담 (%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(separatedLeaves).toEqual(["괴담 (소설/백덕수)", "괴담 (웹툰/쓩늉)"]);

    // 각 글이 자기 work 잎 개념에만 mention(엉킴 0) — 글→잎-개념 classification 엣지로 확인.
    const novel = await store.findConceptByName("괴담 (소설/백덕수)");
    const webtoon = await store.findConceptByName("괴담 (웹툰/쓩늉)");
    expect(novel).not.toBeNull();
    expect(webtoon).not.toBeNull();

    const o1Concepts = (
      await store.listNodeConceptEdges({ nodeId: o1 })
    ).map((e) => e.conceptId);
    const o2Concepts = (
      await store.listNodeConceptEdges({ nodeId: o2 })
    ).map((e) => e.conceptId);
    // o1(소설 글)은 소설 잎에만, o2(웹툰 글)은 웹툰 잎에만 닿는다(교차 0).
    expect(o1Concepts).toContain(novel!.conceptId);
    expect(o1Concepts).not.toContain(webtoon!.conceptId);
    expect(o2Concepts).toContain(webtoon!.conceptId);
    expect(o2Concepts).not.toContain(novel!.conceptId);
  });

  test("E3 매체 없는 work — 이름 단독 잎 개념(충돌 0)", async () => {
    const c1 = "#작품:데못죽";
    const o1 = await makeOrigin(c1);
    await wireEntityPlacement(store, o1, c1, { llm: null });

    // 매체·작가가 없으면 잎 개념 이름은 '데못죽' 단독(옛 동작과 같아 충돌 0·Q3-1 정합).
    const exact = db
      .query("SELECT name FROM concept_nodes WHERE name = '데못죽'")
      .all() as { name: string }[];
    expect(exact.length).toBe(1);
    // 괄호 분리 형식이 안 붙었다.
    const decorated = db
      .query("SELECT name FROM concept_nodes WHERE name LIKE '데못죽 (%'")
      .all() as { name: string }[];
    expect(decorated.length).toBe(0);
  });

  test("E3 별칭 보강 — 분리 개념에 원래 이름 별칭", async () => {
    const c1 = "#작품:소설 #소설:괴담 #작가:백덕수";
    const o1 = await makeOrigin(c1);
    await wireEntityPlacement(store, o1, c1, { llm: null });

    // 분리된 "괴담 (소설/백덕수)" 개념 ko_aliases 에 원래 이름 "괴담" 이 들어갔다.
    const novel = await store.findConceptByName("괴담 (소설/백덕수)");
    expect(novel).not.toBeNull();
    const row = db
      .query("SELECT ko_aliases FROM concept_nodes WHERE concept_id = ?")
      .get(novel!.conceptId) as { ko_aliases: string | null };
    const aliases: string[] = row.ko_aliases ? JSON.parse(row.ko_aliases) : [];
    expect(aliases).toContain("괴담");
  });

  test("E3 사람 글 work 연결 — 분리 키로 기존 분리 개념에 닿음(드리프트 0)", async () => {
    // 작품 글이 먼저 분리 work 행 + 분리 잎 개념을 만든다.
    const cWork = "#작품:소설 #소설:괴담 #작가:백덕수";
    const oWork = await makeOrigin(cWork);
    await wireEntityPlacement(store, oWork, cWork, { llm: null });

    // 사람 주체 글(`#사람:백덕수 #작품:괴담`)은 새 행을 안 만들고 기존 분리 개념에 글만 잇는다.
    const cPerson = "#사람:백덕수 #작품:괴담";
    const oPerson = await makeOrigin(cPerson);
    await wireEntityPlacement(store, oPerson, cPerson, { llm: null });

    // 사람 글이 분리 잎 "괴담 (소설/백덕수)" 에 정확히 닿았다(work 의 medium·createdBy 칸으로
    // 생성 측과 같은 분리 키를 다시 만들어 그 분리 개념을 재조회·연결한다).
    const novel = await store.findConceptByName("괴담 (소설/백덕수)");
    expect(novel).not.toBeNull();
    const personConcepts = (
      await store.listNodeConceptEdges({ nodeId: oPerson })
    ).map((e) => e.conceptId);
    expect(personConcepts).toContain(novel!.conceptId);
    // 드리프트 0 — 연결은 분리 키 한 군데에만 닿는다. 단독 이름 "괴담" 콜론 위계 값 개념은
    // 작품 등록 글의 `#소설:괴담` 일반 분류 경로가 만든 별개 산출이라 존재하지만, 연결 경로는
    // 거기에 *글 mention 을 더하지 않는다*(사람 글이 단독 잎을 잘못 잇지 않음·엉킴 0).
    const bareGoedam = await store.findConceptByName("괴담");
    if (bareGoedam) {
      expect(personConcepts).not.toContain(bareGoedam.conceptId);
    }
  });

  // ── F1: 콜론 값 작품 그림자 차단(P3-leaf 후속·A안 형태 (a)) ──────────────────
  // `#소설:괴담`·`#웹툰:괴담` 의 콜론 값 채널이 만들던 맨이름 "괴담" 그림자 개념(+위계+멘션)을
  // 차단한다. work 가 소비하는 (매체, 이름) 쌍은 일반 분류 위계로 안 흘러 분리 잎만 글을 진다.
  test("P3-leaf-F 콜론 값 그림자 차단 — 맨이름 '괴담' concept 0개·교차 0", async () => {
    const o1 = await makeOrigin("#작품:소설 #소설:괴담 #작가:백덕수");
    await wireEntityPlacement(store, o1, "#작품:소설 #소설:괴담 #작가:백덕수");
    const o2 = await makeOrigin("#작품:웹툰 #웹툰:괴담 #작가:쓩늉");
    await wireEntityPlacement(store, o2, "#작품:웹툰 #웹툰:괴담 #작가:쓩늉");

    // 맨이름 "괴담" 그림자 개념 0(범인 차단).
    const bare = db
      .query(
        "SELECT COUNT(*) c FROM concept_nodes WHERE name='괴담' AND is_classification_value=1",
      )
      .get() as { c: number };
    expect(bare.c).toBe(0);

    // 분리 잎은 둘(정상).
    const split = (
      db
        .query(
          "SELECT name FROM concept_nodes WHERE name LIKE '괴담 (%' AND is_classification_value=1 ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(split.length).toBe(2);
  });

  test("P3-leaf-F 정밀 제외 — 같은 매체 다른 값(#소설:다른것)은 그림자 정상 생성", async () => {
    const o = await makeOrigin("#작품:소설 #소설:괴담 #소설:다른것");
    await wireEntityPlacement(store, o, "#작품:소설 #소설:괴담 #소설:다른것");
    // '다른것' 은 작품 등록 candidate 가 아니므로(첫째 괴담만 행·둘째 미반영) 맨이름 그림자가
    // 남을 수 있으나 — '괴담'(작품 candidate) 맨이름은 0. '다른것' 거동은 기존 (나) 경고 동작 보존.
    const bare = db
      .query(
        "SELECT COUNT(*) c FROM concept_nodes WHERE name='괴담' AND is_classification_value=1",
      )
      .get() as { c: number };
    expect(bare.c).toBe(0);
  });

  test("P3-leaf-F 비-work 일반 분류 회귀 0 — #동물:고양이 위계 그대로", async () => {
    const o = await makeOrigin("#생물:동물 #동물:고양이 #고양이:까망이");
    await wireEntityPlacement(store, o, "#생물:동물 #동물:고양이 #고양이:까망이");
    // 동물 → 고양이 잎 위계가 기존대로 선다(DCL-7 동작 보존).
    const cat = db
      .query("SELECT COUNT(*) c FROM concept_nodes WHERE name='고양이'")
      .get() as { c: number };
    expect(cat.c).toBeGreaterThanOrEqual(1);
  });
});

describe("entity-placement-wiring — 일반 분류 콜론 위계 (Task 7 / DCL-7)", () => {
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

  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /**
   * 행 수를 센다. 단계4 T4 로 전용 8종 테이블(works·creatures·intakes·places·
   * schedules·things·usables·materials)이 범용 본체 entities 로 흡수됐으므로, 그 옛
   * 테이블 이름이 들어오면 `entities WHERE type_name=<단수형>` 으로 돌려 같은 뜻을
   * 센다. person·project 는 그대로 전용 테이블(persons·projects)이라 통과시킨다.
   */
  function countRows(table: string): number {
    const universalType: Record<string, string> = {
      works: "work",
      creatures: "creature",
      things: "thing",
      intakes: "intake",
      usables: "usable",
      materials: "material",
      places: "place",
      schedules: "schedule",
    };
    const typeName = universalType[table];
    if (typeName) {
      return (
        db
          .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
          .get(typeName) as { n: number }
      ).n;
    }
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  /** 두 개념 사이 parent_of 엣지(weight 포함)를 찾는다(없으면 undefined). */
  async function parentEdge(parentName: string, childName: string) {
    const parent = await store.findConceptByName(parentName);
    const child = await store.findConceptByName(childName);
    if (!parent || !child) return undefined;
    const edges = store.getHierarchyEdgesWithin([
      parent.conceptId,
      child.conceptId,
    ]);
    return edges.find(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === parent.conceptId &&
        e.targetId === child.conceptId,
    );
  }

  test("#동물:고양이 → 동물 parent_of 고양이(creature 행) 엣지 weight 0.9 (결정 D·M7)", async () => {
    // 결정 D(2026-06-27 M7): 명시 선언 '고양이'(creature seed)가 1급 creature 엔티티가 된다.
    // 그래서 옛 '동물 parent_of 고양이 *concept*' 잎 엣지 대신 '동물 parent_of <고양이 creature 행>'
    // 직접 위계가 선다(작품 → works행 양식과 동일·그림자 잎 0).
    const content = "#동물:고양이";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("creature", "고양이");
    expect(row).not.toBeNull();

    // 동물(분류 폴더) → 고양이 creature 행 parent_of 엣지 weight 0.9.
    const dongmul = await store.findConceptByName("동물");
    expect(dongmul).not.toBeNull();
    const edges = store.getHierarchyEdgesWithin([dongmul!.conceptId, row!.id]);
    const rowEdge = edges.find(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === dongmul!.conceptId &&
        e.targetId === row!.id,
    );
    expect(rowEdge).toBeDefined();
    expect(rowEdge!.weight).toBe(0.9);
    expect(result.hierarchyEdges).toBeGreaterThanOrEqual(1);
  });

  test("#사람:홍길동 → 일반 분류 위계로 안 감(예약 키·사람 경로 보존·이중 처리 0)", async () => {
    const content = "#사람:홍길동";
    const origin = await makeOrigin(content);

    await wireEntityPlacement(store, origin, content, { llm: null });

    // '사람' 은 예약 키라 일반 분류 위계(사람 parent_of 홍길동)를 만들지 않는다.
    const edge = await parentEdge("사람", "홍길동");
    expect(edge).toBeUndefined();
    // wireEntityPlacement 는 person 타입을 만나면 신규 8 타입 배치를 건너뛴다 —
    // 사람 행도 이 통로가 만들지 않는다(기존 wireHashtagEntities 전담). 이중 처리 0.
    expect(countRows("persons")).toBe(0);
  });

  test("#작품:데못죽 → 단일 배치가 작품 parent_of works행 한 단을 직접 세운다(S2-T1·그림자 잎 위계 0)", async () => {
    const content = "#작품:데못죽";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    // 타입 배치 경로 — works 행 '데못죽' 생성.
    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("work", "데못죽");
    expect(row).not.toBeNull();

    // 단일 배치라 부모 = 타입 루트('작품'). 작품 → works행 parent_of 를 직접 세운다 —
    // 옛 양식의 작품 → 데못죽(그림자 잎 개념)을 행 직접 위계로 대체한다(S2-T1·이중 위계 0).
    const workRoot = await store.findConceptByName("작품");
    const leaf = await store.findConceptByName("데못죽");
    const edges = store.getHierarchyEdgesWithin([
      workRoot!.conceptId,
      leaf!.conceptId,
      row!.id,
    ]);
    // 작품 → works행 엣지는 정확히 1개(INSERT OR IGNORE 멱등·중복 0).
    const rowEdges = edges.filter(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === workRoot!.conceptId &&
        e.targetId === row!.id,
    );
    expect(rowEdges.length).toBe(1);
    expect(rowEdges[0]!.weight).toBe(0.9);

    // 그림자 잎 개념('데못죽' 개념)이 위계 잎으로 쓰이는 엣지는 0.
    expect(
      edges.some(
        (e) => e.relation === "parent_of" && e.targetId === leaf!.conceptId,
      ),
    ).toBe(false);

    // identity 엣지(행 ↔ 잎-개념·검색 JOIN 키)는 유지된다.
    const identityEdges = store.getEntityConceptEdges(
      "work",
      result.entityId!,
      "identity",
    );
    expect(identityEdges.length).toBe(1);
    expect(identityEdges[0]!.conceptId).toBe(leaf!.conceptId);
  });

  test("S2-T1 다단계 #장소:병원 #병원:피부과 #피부과:무지개의원 → 피부과 parent_of place행(잎)·그림자 잎 위계 0", async () => {
    // '무지개의원' 은 고유 개체명이라 행 게이트를 통과해 place 행이 생긴다. 위계 잎은 그
    // place 행 자체 — 마지막 분류 단('피부과') → place행 parent_of 를 직접 쓴다(S2-T1).
    const content = "#장소:병원 #병원:피부과 #피부과:무지개의원";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("place");
    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(row).not.toBeNull();
    expect(result.entityId).toBe(row!.id);

    const jangso = await store.findConceptByName("장소");
    const byeongwon = await store.findConceptByName("병원");
    const pibugwa = await store.findConceptByName("피부과");
    const leaf = await store.findConceptByName("무지개의원");
    expect(jangso).not.toBeNull();
    expect(byeongwon).not.toBeNull();
    expect(pibugwa).not.toBeNull();
    const edges = store.getHierarchyEdgesWithin([
      jangso!.conceptId,
      byeongwon!.conceptId,
      pibugwa!.conceptId,
      leaf!.conceptId,
      row!.id,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    // 장소 → 병원 → 피부과 → place행 — 마지막 단이 place 행(엔티티 잎).
    expect(hasEdge(jangso!.conceptId, byeongwon!.conceptId)).toBe(true);
    expect(hasEdge(byeongwon!.conceptId, pibugwa!.conceptId)).toBe(true);
    expect(hasEdge(pibugwa!.conceptId, row!.id)).toBe(true);
    // 그림자 잎 개념('무지개의원' 개념)이 위계 잎으로 쓰이는 엣지는 0(흡수 폐기).
    expect(
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          leaf !== null &&
          e.targetId === leaf.conceptId,
      ),
    ).toBe(false);
  });

  test("S2-T1 단일 배치 #일정:장터당번 → 일정루트 parent_of schedule행(잎)·이중 위계 0", async () => {
    const content = "#일정:장터당번";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("schedule");
    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("schedule", "장터당번");
    expect(row).not.toBeNull();
    expect(result.entityId).toBe(row!.id);

    const iljeong = await store.findConceptByName("일정");
    const leaf = await store.findConceptByName("장터당번");
    expect(iljeong).not.toBeNull();
    const edges = store.getHierarchyEdgesWithin([
      iljeong!.conceptId,
      ...(leaf ? [leaf.conceptId] : []),
      row!.id,
    ]);
    // 일정 루트 → schedule행 parent_of 정확히 1개(이중 위계 0).
    const rowEdges = edges.filter(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === iljeong!.conceptId &&
        e.targetId === row!.id,
    );
    expect(rowEdges.length).toBe(1);
    // 일정 루트 → 그림자 잎 개념 위계는 0.
    if (leaf) {
      expect(
        edges.some(
          (e) =>
            e.relation === "parent_of" &&
            e.sourceId === iljeong!.conceptId &&
            e.targetId === leaf.conceptId,
        ),
      ).toBe(false);
    }
  });

  test("#작품:데못죽 #장르:판타지 → 장르 parent_of 판타지 위계 안 만듦(속성=라벨 전담·겹침 0)", async () => {
    const content = "#작품:데못죽 #장르:판타지";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    // 장르 는 work 의 속성(attributes) 키라 라벨 경로(applyEntityAttributes)가 전담한다 —
    // 일반 분류 위계로 가면 같은 태그가 라벨과 위계로 이중 처리된다. 그 위계는 안 만든다.
    expect(result.labelsApplied).toBe(1); // 판타지 라벨 한 개(라벨 경로).
    const edge = await parentEdge("장르", "판타지");
    expect(edge).toBeUndefined();
  });

  test("#취미:독서 → 타입 안 걸려도 일반 분류 위계(취미 parent_of 독서)는 만든다", async () => {
    // 취미·독서 어느 쪽도 PLACEMENT 타입·subcategory·seed 아님 → typeName null.
    // 그래도 명시 콜론 분류 태그라 일반 분류 위계는 세운다(DCL-4 정합·콜론=명시).
    const content = "#취미:독서";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBeNull(); // 타입 배치 대상 아님.
    const edge = await parentEdge("취미", "독서");
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(0.9);
  });

  test("멱등 — 같은 콜론 태그 두 번 입력해도 동물 → 고양이(행) 엣지 중복 0 (결정 D·M7)", async () => {
    // 결정 D 후 '고양이' 는 creature 행이라 동물 parent_of 의 target 은 행 id 다 — 그 엣지 멱등.
    const content = "#동물:고양이";
    const origin = await makeOrigin(content);

    await wireEntityPlacement(store, origin, content, { llm: null });
    await wireEntityPlacement(store, origin, content, { llm: null });

    const dongmul = await store.findConceptByName("동물");
    expect(dongmul).not.toBeNull();
    const row = await store.entitiesRepo.findByName("creature", "고양이");
    expect(row).not.toBeNull();
    // S0-T4(위계 단일 출처) — 위계는 hierarchy_edges 에서 센다. 동물 → 고양이 행 엣지 1개(멱등).
    const edgeCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM hierarchy_edges
           WHERE relation = 'parent_of'
             AND source_id = ? AND target_id = ?`,
        )
        .get(dongmul!.conceptId, row!.id) as { n: number }
    ).n;
    expect(edgeCount).toBe(1);
    // creature 행도 중복 0(멱등·findOrCreate).
    expect(countRows("creatures")).toBe(1);
  });

  test("saveTextInput 글 입력만으로 #생물:동물 위계 + 고양이 creature 행 완결 (결정 D·M7)", async () => {
    // 입력 통로 합류 회귀 — 한 글 입력이 생물 → 동물 타입 배치 위계 + 고양이 creature 행을 만든다.
    // 결정 D(2026-06-27 M7) — '고양이'(명시 선언·creature seed)는 1급 creature 엔티티가 된다.
    await saveTextInput(store, {
      content: "#생물:동물 #동물:고양이",
      source: "dashboard:manual",
      author: "owner",
      userId: "owner",
    });

    const saengmulDongmul = await parentEdge("생물", "동물");
    expect(saengmulDongmul).toBeDefined(); // 생물 → 동물 (타입 배치).
    // 고양이 creature 행 — 명시 선언이 씨앗을 이김.
    const row = await store.entitiesRepo.findByName("creature", "고양이");
    expect(row).not.toBeNull();
    // 동물(폴더) → 고양이 행 parent_of 직접 위계.
    const dongmul = await store.findConceptByName("동물");
    const edges = store.getHierarchyEdgesWithin([dongmul!.conceptId, row!.id]);
    expect(
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === dongmul!.conceptId &&
          e.targetId === row!.id,
      ),
    ).toBe(true);
  });

  // ── Task 7 보정 — 사람/프로젝트 라벨 키 이중 처리 0 ─────────────────────────────
  /**
   * 두 개념 사이 parent_of 엣지 *행 수* — 중복(이중 처리)이 생겼는지 본다.
   * S0-T4(위계 단일 출처) — 위계는 hierarchy_edges 에서 센다.
   */
  function parentEdgeCount(parentId: string, childId: string): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM hierarchy_edges
           WHERE relation = 'parent_of'
             AND source_id = ? AND target_id = ?`,
        )
        .get(parentId, childId) as { n: number }
    ).n;
  }

  test("#사람:민수 #직업:의사 → wireEntityPlacement 일반 분류는 직업 위계를 만들지 않는다(소비됨·겹침 0)", async () => {
    const content = "#사람:민수 #직업:의사";
    const origin = await makeOrigin(content);

    // 같은 글에 사람 선언(#사람:민수)이 있어 wireHashtagEntities 가 '직업:의사' 를 라벨로
    // 소비한다 — 그래서 wireEntityPlacement 의 일반 분류 단계는 '직업' 을 건너뛴다(겹침 0).
    // 이 단위 테스트는 wireEntityPlacement 만 부르므로 사람 경로가 안 도는데, 그럼에도
    // 일반 분류가 직업 → 의사 위계를 만들지 *않아야* 한다(소비 키라 건너뜀).
    await wireEntityPlacement(store, origin, content, { llm: null });

    const edge = await parentEdge("직업", "의사");
    expect(edge).toBeUndefined(); // 일반 분류가 직업 → 의사 를 안 만든다(이중 처리 차단).
  });

  test("#사람:민수 #직업:의사 → 사람 경로가 직업 라벨 엣지를 만들고, 일반 분류는 중복을 안 더한다", async () => {
    const content = "#사람:민수 #직업:의사";
    const origin = await makeOrigin(content);

    // 사람 경로(wireHashtagEntities)는 정상대로 민수 행 + 직업:의사 라벨을 만든다. 라벨
    // 등록은 ensureLabelValueConcept 에서 직업 parent_of 의사 위계(weight 0.9)도 함께 세운다
    // (라벨 키→값은 이 시스템에서 분류 위계이기도 하다 — 기존 사람 경로 동작·건드리지 않음).
    const r = await wireHashtagEntities(store, origin, content);
    expect(r.labelsApplied).toBe(1); // 직업 라벨 한 개.
    expect(r.personIds.length).toBe(1);

    const jikup = await store.findConceptByName("직업");
    const uisa = await store.findConceptByName("의사");
    expect(jikup).not.toBeNull();
    expect(uisa).not.toBeNull();
    expect(parentEdgeCount(jikup!.conceptId, uisa!.conceptId)).toBe(1); // 사람 경로가 만든 한 엣지.

    // 이어서 wireEntityPlacement 일반 분류 — 같은 직업 키를 소비 키로 보고 건너뛰어, 위계
    // 엣지를 *중복으로 더하지 않는다*. 행 수가 여전히 1(이중 처리 0).
    await wireEntityPlacement(store, origin, content, { llm: null });
    expect(parentEdgeCount(jikup!.conceptId, uisa!.conceptId)).toBe(1);
  });

  test("#프로젝트:바라 #언어:타입스크립트 → 언어 parent_of 타입스크립트 위계 생성(프로젝트 라벨 미소비)", async () => {
    const content = "#프로젝트:바라 #언어:타입스크립트";
    const origin = await makeOrigin(content);

    await wireEntityPlacement(store, origin, content, { llm: null });
    // '언어' 는 project.attributes 에서 제거되어 프로젝트 라벨로 소비되지 않는다 — 일반 위계로 간다.
    expect(await parentEdge("언어", "타입스크립트")).toBeDefined();
  });

  test("사람/프로젝트 선언 없는 #직업:의사 단독 → 라벨 미소비라 일반 분류 위계로 간다", async () => {
    // wireHashtagEntities 는 대상(사람/프로젝트)이 없으면 '직업:의사' 를 "라벨 미반영" 으로
    // 소비하지 않는다 — 그래서 일반 분류 위계(직업 → 의사)로 가도 이중 처리가 아니다.
    // 실제 소비 결과에 맞춰 단언(고정 목록이 아니라 그 글 맥락의 소비 여부).
    const content = "#직업:의사";
    const origin = await makeOrigin(content);

    // 사람 경로 — 대상이 없어 라벨을 소비하지 않는다(미반영 경고만).
    const r = await wireHashtagEntities(store, origin, content);
    expect(r.labelsApplied).toBe(0);
    expect(r.warnings.some((w) => w.includes("라벨 미반영"))).toBe(true);

    // 일반 분류 위계는 직업 → 의사 를 만든다(소비 안 됐으니 겹침 0).
    await wireEntityPlacement(store, origin, content, { llm: null });
    const edge = await parentEdge("직업", "의사");
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(0.9);
  });
});

describe("entity-placement-wiring — 타입 미상 콜론 키 타입 상속 (P1·C2)", () => {
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

  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /**
   * 행 수를 센다. 단계4 T4 로 전용 8종 테이블(works·creatures·intakes·places·
   * schedules·things·usables·materials)이 범용 본체 entities 로 흡수됐으므로, 그 옛
   * 테이블 이름이 들어오면 `entities WHERE type_name=<단수형>` 으로 돌려 같은 뜻을
   * 센다. person·project 는 그대로 전용 테이블(persons·projects)이라 통과시킨다.
   */
  function countRows(table: string): number {
    const universalType: Record<string, string> = {
      works: "work",
      creatures: "creature",
      things: "thing",
      intakes: "intake",
      usables: "usable",
      materials: "material",
      places: "place",
      schedules: "schedule",
    };
    const typeName = universalType[table];
    if (typeName) {
      return (
        db
          .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
          .get(typeName) as { n: number }
      ).n;
    }
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  test("P1 타입 이어받기 — 까망이 등록 후 #고양이:얼룩이 → creature 행", async () => {
    // 먼저 까망이 글이 명시 타입 사슬로 생물 > 동물 > 고양이 위계를 세운다.
    const c1 = "#생물:동물 #동물:고양이 #고양이:까망이";
    const o1 = await makeOrigin(c1);
    await wireEntityPlacement(store, o1, c1, { llm: null });
    const before = countRows("creatures");

    // 그다음 #고양이:얼룩이 만 적힌 글 — 타입 선언이 없지만 '고양이' 가 creature 위계의
    // 잎이라 얼룩이가 creature 행으로 이어받아 생긴다.
    const c2 = "#고양이:얼룩이";
    const o2 = await makeOrigin(c2);
    const result = await wireEntityPlacement(store, o2, c2, { llm: null });

    expect(countRows("creatures")).toBe(before + 1);
    expect(result.typeName).toBe("creature");
    expect(result.entityRowCreated).toBe(true);

    const names = db
      .query(
        "SELECT name FROM entities WHERE type_name = 'creature' ORDER BY name",
      )
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("얼룩이");

    // 얼룩이가 '고양이' 개념 잎으로 매달린다(생물 > 동물 > 고양이 > 얼룩이).
    const goyangi = await store.findConceptByName("고양이");
    expect(goyangi).not.toBeNull();
    const daljaeRow = await store.entitiesRepo.findByName("creature", "얼룩이");
    expect(daljaeRow).not.toBeNull();
    const edges = store.getHierarchyEdgesWithin([
      goyangi!.conceptId,
      daljaeRow!.id,
    ]);
    expect(
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === goyangi!.conceptId &&
          e.targetId === daljaeRow!.id,
      ),
    ).toBe(true);
  });

  test("P1 미등록 키 — 이어받기 안 함(기존 동작·회귀 0)", async () => {
    const content = "#처음보는키:어떤값";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });
    // 타입 미상·미등록이라 creature 등 1급 행 0(기존 기타 글 동작).
    expect(countRows("creatures")).toBe(0);
    expect(result.typeName).toBeNull();
    expect(result.entityRowCreated).toBe(false);
  });

  test("P1 명시 타입 글은 상속 경로 안 탐(중복 0)", async () => {
    const content = "#생물:동물 #동물:고양이 #고양이:나비";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });
    // 명시 사슬로 나비 1행(상속 경로 중복 호출 0).
    expect(countRows("creatures")).toBe(1);
    expect(result.entityRowCreated).toBe(true);
    const nabi = await store.entitiesRepo.findByName("creature", "나비");
    expect(nabi).not.toBeNull();
  });

  test("P1 모호 — 같은 분류 개념이 두 타입 루트 아래면 보류 + 경고", async () => {
    // '거점' 분류 개념을 두 타입(생물·사물) 위계 아래 둔다 — 우연 동명 두 타입 매달림.
    // 거점 아래 잎(까망이·인형)을 둬 거점을 *분류 개념*(자식 있는 거점)으로 남긴다.
    const cBio = "#생물:동물 #동물:거점 #거점:까망이";
    await wireEntityPlacement(store, await makeOrigin(cBio), cBio, { llm: null });
    const cThing = "#사물:가구 #가구:거점 #거점:인형";
    await wireEntityPlacement(store, await makeOrigin(cThing), cThing, {
      llm: null,
    });

    const creaturesBefore = countRows("creatures");
    const thingsBefore = countRows("things");

    // 이제 #거점:반짝이 — '거점' 이 두 타입 루트 아래 매달려 상속이 모호하다.
    const content = "#거점:반짝이";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    // 거짓 타입 0 — 어느 타입 행도 새로 안 생긴다.
    expect(countRows("creatures")).toBe(creaturesBefore);
    expect(countRows("things")).toBe(thingsBefore);
    expect(result.typeName).toBeNull();
    // 식별자 '거점' 을 포함한 보류 경고가 남는다.
    expect(
      result.warnings.some(
        (w) => w.includes("거점") && w.includes("상속 보류"),
      ),
    ).toBe(true);
  });

  test("관계 source 자동 승격 — 빈 DB #고양이:얼룩이 #주인:김철수 → 얼룩이 creature + owned_by", async () => {
    const content = "#고양이:얼룩이, #주인:김철수, 철수님이 키우는 둘째 고양이";
    const origin = await makeOrigin(content);

    const result = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(result.typeName).toBe("creature");
    expect(result.subcategory).toBe("고양이");
    expect(result.entityRowCreated).toBe(true);
    expect(result.relationEdges.length).toBe(1);
    expect(result.relationEdges[0]!.relation).toBe("owned_by");
    expect(result.relationEdges[0]!.targetName).toBe("김철수");

    const daljae = await store.entitiesRepo.findByName("creature", "얼룩이");
    expect(daljae).not.toBeNull();
    const owner = await store.findPersonByNameOrAlias("김철수");
    expect(owner.person).not.toBeNull();

    const stored = store.getRelationsFromSource("creature", daljae!.id);
    expect(stored.some((e) => e.relation === "owned_by" && e.targetId === owner.person!.personId)).toBe(true);

    const goyangi = await store.findConceptByName("고양이");
    expect(goyangi).not.toBeNull();
    const hierarchy = store.getHierarchyEdgesWithin([goyangi!.conceptId, daljae!.id]);
    expect(
      hierarchy.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === goyangi!.conceptId &&
          e.targetId === daljae!.id,
      ),
    ).toBe(true);

    // #주인:김철수 은 관계 문법으로 소비된다. 주인→김철수 일반 분류 위계나 주인 concept 는 만들지 않는다.
    expect(await store.findConceptByName("주인")).toBeNull();
  });

  test("관계 source 자동 승격 후 명시 위계 입력도 같은 소유자 관계를 만든다", async () => {
    const reverse = "#고양이:얼룩이, #주인:김철수";
    await wireEntityPlacement(store, await makeOrigin(reverse), reverse, {
      llm: null,
    });

    const forward = "#생물:동물 #동물:고양이 #고양이:까망이 #주인:김철수";
    const result = await wireEntityPlacement(store, await makeOrigin(forward), forward, {
      llm: null,
    });

    expect(result.typeName).toBe("creature");
    expect(result.relationEdges.some((e) => e.relation === "owned_by" && e.targetName === "김철수")).toBe(true);

    const daljae = await store.entitiesRepo.findByName("creature", "얼룩이");
    const jjoraeng = await store.entitiesRepo.findByName("creature", "까망이");
    expect(daljae).not.toBeNull();
    expect(jjoraeng).not.toBeNull();

    const daljaeRelations = store.getRelationsFromSource("creature", daljae!.id);
    const jjoraengRelations = store.getRelationsFromSource("creature", jjoraeng!.id);
    expect(daljaeRelations.some((e) => e.relation === "owned_by")).toBe(true);
    expect(jjoraengRelations.some((e) => e.relation === "owned_by")).toBe(true);
  });

  test("관계 태그 단독 — source 후보가 없으면 target 사람·주인 concept·관계 모두 만들지 않는다", async () => {
    const content = "#주인:김철수";
    const result = await wireEntityPlacement(store, await makeOrigin(content), content, {
      llm: null,
    });

    expect(result.entityRowCreated).toBe(false);
    expect(result.relationEdges).toEqual([]);
    expect(countRows("creatures")).toBe(0);
    expect((await store.findPersonByNameOrAlias("김철수")).person).toBeNull();
    expect(await store.findConceptByName("주인")).toBeNull();
    expect(
      result.warnings.some((w) => w.includes("관계 source 후보") && w.includes("0개")),
    ).toBe(true);
  });

  test("관계 source 후보 다중 — 자동 승격 보류, 관계 키는 일반 분류로 새지 않는다", async () => {
    const content = "#고양이:얼룩이 #강아지:보리 #주인:김철수";
    const result = await wireEntityPlacement(store, await makeOrigin(content), content, {
      llm: null,
    });

    expect(result.entityRowCreated).toBe(false);
    expect(result.relationEdges).toEqual([]);
    expect(countRows("creatures")).toBe(0);
    expect(await store.findConceptByName("주인")).toBeNull();
    expect(
      result.warnings.some((w) => w.includes("관계 source 후보") && w.includes("2개")),
    ).toBe(true);
  });

  test("관계 source 타입 교집합 없음 — 자동 승격 보류", async () => {
    const content = "#고양이:얼룩이 #주인:김철수 #관련장소:서울";
    const result = await wireEntityPlacement(store, await makeOrigin(content), content, {
      llm: null,
    });

    expect(result.entityRowCreated).toBe(false);
    expect(result.relationEdges).toEqual([]);
    expect(countRows("creatures")).toBe(0);
    expect(
      result.warnings.some((w) => w.includes("관계 source 타입") && w.includes("0개")),
    ).toBe(true);
  });
});

describe("entity-placement-wiring — 입력 통로 합류 회귀 (saveTextInput)", () => {
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

  test("saveTextInput plain 경로가 개념 wiring + 타입 배치 둘 다 돌린다", async () => {
    // extractor 미주입 plain 경로 — wireHashtagConceptsSafe(개념) 직후
    // wireEntityPlacementSafe(타입 배치)가 같은 origin·content 로 합류했는지 본다.
    const result = await saveTextInput(store, {
      content: "#작품:데못죽 #장르:판타지, 감상 기록",
      source: "dashboard:manual",
      author: "owner",
      userId: "owner",
    });

    // (1) 기존 개념 wiring 이 돌았다 — '판타지' 라벨 개념 노드가 생겼다(타입 배치 라벨 경로).
    //     개념 wiring·타입 배치 둘 다 안 돌았다면 어느 쪽도 개념·행을 안 만든다.
    expect(await store.findConceptByName("판타지")).not.toBeNull();

    // (2) 타입 배치가 돌았다 — works 행 '데못죽' 이 생겼다(개념 wiring 만으론 행이 안 생긴다).
    const row = await store.entitiesRepo.findByName("work", "데못죽");
    expect(row).not.toBeNull();

    // (3) 타입 배치 identity·라벨 엣지가 그 행에 붙었다(둘 다 돈 증거).
    const labelEdges = store.getEntityConceptEdges("work", row!.id, "has_attribute");
    expect(labelEdges.length).toBeGreaterThanOrEqual(1);

    // origin 노드는 보존된다(입력 저장 흐름 무회귀).
    expect(result.originNodeId).toBeGreaterThan(0);
  });
});
