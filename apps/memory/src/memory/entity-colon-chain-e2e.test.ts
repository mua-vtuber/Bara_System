/**
 * entity-colon-chain-e2e.test.ts — 콜론 사슬 자동 배치 종합 e2e + 불변식 회귀
 * (2026-06-12 콜론 사슬 자동 배치 Task 5·spec §8 완료 기준).
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store + 실제 어휘 사전 + 실제
 * classifyEntityTypeDeterministic·wireEntityPlacement 를 진짜 호출한다(CLAUDE.md "DB/임베딩
 * 의존 모듈은 실제 구현체와 통합 검증"). LLM 단은 null(default OFF·결정적 1·2단만).
 *
 * spec §8 완료 기준을 끝에서 끝으로 실증한다:
 *   - 결과 동치: #작품:소설 #소설:데뷔못... #작가:백덕수 == #소설:데뷔못... #작가:백덕수.
 *   - 사슬 끝 고유명이 이름(분류 단어 '소설' 아님).
 *   - 위계 완결: 작품 > 소설 > 데뷔못... parent_of 사슬.
 *   - 관계 연쇄: #작가:백덕수 → work→person created_by.
 *   - (가) 별칭: #데뷔못...:데못죽 → work ko_aliases.
 *   - (나) 경고: #소설:A #소설:B → A 만 행·B 미반영 경고.
 *   - (다) 거짓 엔티티 0: 분류에서 끝남·순환·분류 단어 candidate → 행 미생성/경고.
 *   - 단일 태그 회귀 0.
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
import { wireEntityPlacement } from "./entity-placement-wiring.ts";
import { wireHashtagEntities } from "./hashtag-entity-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import {
  classifyEntityTypeDeterministic,
  resetClassifierCache,
} from "./entity-type-classifier.ts";

describe("콜론 사슬 자동 배치 e2e (§8 완료 기준)", () => {
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

  /** 범용 본체 entities 에서 한 종류(type_name)의 행 수를 센다(전용 테이블 흡수·T4). */
  function countEntities(typeName: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
        .get(typeName) as { n: number }
    ).n;
  }

  /** 별도 store 에 입력을 돌려 결과·db 를 함께 돌려준다(동치 비교용·격리). */
  async function runIn(content: string): Promise<{
    db: Database;
    store: SqliteMemoryStore;
    result: Awaited<ReturnType<typeof wireEntityPlacement>>;
  }> {
    const d = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const s = new SqliteMemoryStore(d, embedder);
    const origin = await s.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    const result = await wireEntityPlacement(s, origin, content, { llm: null });
    return { db: d, store: s, result };
  }

  test("결과 동치 — 사슬 prefix 입력이 단독 입력과 같은 배치(행·위계·관계)", async () => {
    const chained = "#작품:소설 #소설:데뷔못하면죽는병걸림 #작가:백덕수";
    const single = "#소설:데뷔못하면죽는병걸림 #작가:백덕수";

    const a = await runIn(chained);
    const b = await runIn(single);

    // typeName·subcategory·행 생성 동치.
    expect(a.result.typeName).toBe(b.result.typeName);
    expect(a.result.typeName).toBe("work");
    expect(a.result.subcategory).toBe(b.result.subcategory);
    expect(a.result.subcategory).toBe("소설");
    expect(a.result.entityRowCreated).toBe(b.result.entityRowCreated);
    expect(a.result.entityRowCreated).toBe(true);

    // 사슬 끝 고유명이 이름 — work 행 '데뷔못...'(분류 단어 '소설' 아님).
    const rowA = await a.store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    const rowB = await b.store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    expect(await a.store.entitiesRepo.findByName("work", "소설")).toBeNull(); // 분류 단어로 행 안 만듦.

    // 관계 엣지 동치 — 둘 다 work→person created_by 한 개(백덕수).
    expect(a.result.relationEdges.length).toBe(b.result.relationEdges.length);
    expect(a.result.relationEdges.length).toBe(1);
    expect(a.result.relationEdges[0]!.relation).toBe("created_by");
    expect(a.result.relationEdges[0]!.targetName).toBe("백덕수");

    a.db.close();
    b.db.close();
  });

  test("위계 완결 — 작품 > 소설 > works행(잎) parent_of 사슬이 데이터에 생긴다(S2-T1)", async () => {
    const content = "#작품:소설 #소설:데뷔못하면죽는병걸림 #작가:백덕수";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    const jakpum = await store.findConceptByName("작품");
    const soseol = await store.findConceptByName("소설");
    // E3 — work 잎 identity 개념은 매체·작가로 갈린다("데뷔못... (소설/백덕수)"). 위계 잎은
    // works 행 자체라 이 분리 개념은 위계 엣지를 받지 않는다(검색 mention·identity 키 전용).
    const leaf = await store.findConceptByName(
      "데뷔못하면죽는병걸림 (소설/백덕수)",
    );
    expect(jakpum).not.toBeNull();
    expect(soseol).not.toBeNull();
    expect(leaf).not.toBeNull();
    expect(result.entityId).not.toBeNull();

    const edges = store.getHierarchyEdgesWithin([
      jakpum!.conceptId,
      soseol!.conceptId,
      leaf!.conceptId,
      result.entityId!,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    expect(hasEdge(jakpum!.conceptId, soseol!.conceptId)).toBe(true); // 작품 → 소설
    // 위계 잎은 works 행 — 소설 → works행 직접(그림자 잎 개념 위계 0·S2-T1).
    expect(hasEdge(soseol!.conceptId, result.entityId!)).toBe(true); // 소설 → works행
    expect(hasEdge(soseol!.conceptId, leaf!.conceptId)).toBe(false); // 그림자 잎 위계 0
  });

  test("관계 연쇄 — #작가:백덕수 가 work→person created_by 로 걸린다", async () => {
    const content = "#작품:소설 #소설:데뷔못하면죽는병걸림 #작가:백덕수";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    const rel = store.getRelationsFromSource("work", result.entityId!);
    expect(rel.length).toBe(1);
    expect(rel[0]!.relation).toBe("created_by");

    // '백덕수' 는 라벨 개념이 아니라 사람 행으로 갔다(관계 target).
    const person = await store.findPersonByNameOrAlias("백덕수");
    expect(person.person).not.toBeNull();
  });

  test("(가) 별칭 — #별명:데못죽 추가 시 work 행 ko_aliases 에 데못죽", async () => {
    // 2026-06-13 §13·§15 — 별칭은 명시 예약 키 #별명:/#닉네임: 로 적는다. 옛 "본체 키
    // 콜론 태그 = 별칭" 표기(#데뷔못...:데못죽)는 위계로 재해석돼 폐기됐다(아래 케이스).
    const content =
      "#작품:소설 #소설:데뷔못하면죽는병걸림 #별명:데못죽";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    expect(row!.koAliases).toContain("데못죽");
  });

  test("§13 폐기 증언 — 옛 #데뷔못...:데못죽 표기는 이제 위계로 해석(별칭 아님)", async () => {
    // 옛 6/11 (가) 표기. §5.2 하이브리드가 "데못죽"을 "데뷔못..."의 다음 태그로 보고
    // 위계 한 단(데뷔못... → 데못죽)으로 만든다 — ko_aliases 엔 안 들어간다. 폐기가
    // silent 가 아니라 의도된 동작 변경임을 이 케이스가 증언한다(§15 추가 권장).
    const content =
      "#작품:소설 #소설:데뷔못하면죽는병걸림 #데뷔못하면죽는병걸림:데못죽";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    // 사슬이 "데못죽"까지 내려가 본체 이름이 "데못죽"이 된다(데뷔못...은 분류 단으로 통과).
    expect(result.entityRowCreated).toBe(true);
    const aliasRow = await store.entitiesRepo.findByName("work", "데못죽");
    expect(aliasRow).not.toBeNull();
    // "데못죽"은 별칭이 아니라 위계 잎 — 본체("데뷔못...")의 ko_aliases 에 안 들어간다.
    const oldName = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    if (oldName) expect(oldName.koAliases).not.toContain("데못죽");
    // 위계 — 데뷔못...(마지막 분류 단) → works행("데못죽" 잎) parent_of(S2-T1). 위계 잎은
    // works 행 자체라, 옛 양식의 데뷔못... → 데못죽(그림자 잎 개념)을 행 직접 위계로 대체한다.
    // E3 — work 잎 identity 개념은 매체로 갈린다("데못죽 (소설)"·작가 없음). 이 분리 개념은
    // 위계 엣지를 받지 않는다(검색 mention·identity 키 전용).
    const debut = await store.findConceptByName("데뷔못하면죽는병걸림");
    const demotLeaf = await store.findConceptByName("데못죽 (소설)");
    expect(debut).not.toBeNull();
    expect(demotLeaf).not.toBeNull();
    expect(result.entityId).toBe(aliasRow!.id);
    const edges = store.getHierarchyEdgesWithin([
      debut!.conceptId,
      demotLeaf!.conceptId,
      aliasRow!.id,
    ]);
    expect(
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === debut!.conceptId &&
          e.targetId === aliasRow!.id,
      ),
    ).toBe(true);
    // 그림자 잎 개념("데못죽 (소설)" 개념)이 위계 잎으로 쓰이는 엣지는 0.
    expect(
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === debut!.conceptId &&
          e.targetId === demotLeaf!.conceptId,
      ),
    ).toBe(false);
  });

  test("(나) 경고 — #소설:A #소설:B → A 만 행·B 미반영 경고", async () => {
    const content = "#소설:데뷔못하면죽는병걸림 #소설:전지적독자시점";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("work", "전지적독자시점")).toBeNull();
    expect(
      result.warnings.some(
        (w) => w.includes("같은 분류") && w.includes("전지적독자시점"),
      ),
    ).toBe(true);
  });

  test("(다) 거짓 엔티티 0 — 사슬이 분류에서 끝나면 행 미생성 + 경고", async () => {
    const content = "#작품:소설";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(false);
    expect(countEntities("work")).toBe(0);
    expect(result.warnings.some((w) => w.includes("이름 후보를 못 찾음"))).toBe(true);
  });

  test("(다) 거짓 엔티티 0 — 순환 사슬은 무한 루프 없이 경고를 남긴다", async () => {
    const content = "#작품:소설 #소설:작품";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(
      result.warnings.some((w) => w.includes("비정상으로 길거나 순환")),
    ).toBe(true);
  });

  test("단일 태그 회귀 0 — #소설:데뷔못... 단독이 사슬 도입 전과 같은 배치", async () => {
    const content = "#소설:데뷔못하면죽는병걸림 #작가:백덕수";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBe("소설");
    expect(result.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    // 관계도 그대로 — 작가 백덕수 created_by.
    expect(result.relationEdges.length).toBe(1);
    expect(result.relationEdges[0]!.relation).toBe("created_by");
    // 사슬 prefix 없는 단일 태그는 비정상/미반영 경고 0.
    expect(result.warnings.some((w) => w.includes("비정상"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("같은 분류"))).toBe(false);
  });

  // 2026-06-13 어휘 독립 다단계 위계 — 어휘에 없는 분류 단어(병원·피부과)도 사슬 구조로 통과.

  test("어휘 독립 다단계 — 장소>병원>피부과>무지개의원 parent_of 사슬 4쌍 + place 행", async () => {
    // 파서 통일(방식 ②·결정 4): 마지막 태그 #피부과:무지개의원 뒤에 본문을 바로 붙이면 값이
    // 본문까지 삼킨다. 사용자 실데이터 양식대로 쉼표로 본문을 가른다(spec §3.2) → 잎 값이
    // "무지개의원" 으로 잘려 사슬 4쌍이 산다. 앞 두 태그는 # 경계로 이미 각각 잡힌다.
    const content =
      "#장소:병원 #병원:피부과 #피부과:무지개의원, 5월 12일 무지개의원에서 보습 관리 받음";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    // 사슬 끝 고유명이 이름 — place 행 '무지개의원'(어휘 밖 분류 단어 병원·피부과 아님).
    expect(result.typeName).toBe("place");
    expect(result.subcategory).toBe("병원");
    expect(result.entityRowCreated).toBe(true);
    expect(await store.entitiesRepo.findByName("place", "무지개의원")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("place", "병원")).toBeNull(); // 분류 단어로 행 안 만듦.
    expect(await store.entitiesRepo.findByName("place", "피부과")).toBeNull();

    // 위계 — 장소 > 병원 > 피부과 > place행(잎) 네 인접 쌍이 데이터에 생긴다(S2-T1).
    // 마지막 단은 place 행 자체 — 옛 양식의 피부과 → 무지개의원(그림자 잎 개념)을 행 직접
    // 위계로 대체한다(그림자 잎 위계 0).
    const jangso = await store.findConceptByName("장소");
    const byeongwon = await store.findConceptByName("병원");
    const pibugwa = await store.findConceptByName("피부과");
    const rainbow = await store.findConceptByName("무지개의원");
    const rainbowRow = await store.entitiesRepo.findByName("place", "무지개의원");
    expect(jangso).not.toBeNull();
    expect(byeongwon).not.toBeNull();
    expect(pibugwa).not.toBeNull();
    expect(rainbow).not.toBeNull();
    expect(rainbowRow).not.toBeNull();

    const edges = store.getHierarchyEdgesWithin([
      jangso!.conceptId,
      byeongwon!.conceptId,
      pibugwa!.conceptId,
      rainbow!.conceptId,
      rainbowRow!.id,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    expect(hasEdge(jangso!.conceptId, byeongwon!.conceptId)).toBe(true); // 장소 → 병원
    expect(hasEdge(byeongwon!.conceptId, pibugwa!.conceptId)).toBe(true); // 병원 → 피부과
    expect(hasEdge(pibugwa!.conceptId, rainbowRow!.id)).toBe(true); // 피부과 → place행(잎)
    expect(hasEdge(pibugwa!.conceptId, rainbow!.conceptId)).toBe(false); // 그림자 잎 위계 0
  });

  test("깊은 사슬 — #작품:소설 #소설:만화 #만화:이름 → categoryChain=[소설,만화]·이름", () => {
    // 분류기 단위(순수 함수) — 어휘에 있는 분류 단어라도 다음 태그가 이어지면 더 내려간다
    // (2026-06-13 사용자 확정·§5.4). 'soseol' 어휘 hit + 다음 태그 둘 다 있으면 1순위(다음
    // 태그)가 이겨 분류로 통과한다.
    const c = classifyEntityTypeDeterministic("#작품:소설 #소설:만화 #만화:이름");
    expect(c.typeName).toBe("work");
    expect(c.categoryChain).toEqual(["소설", "만화"]);
    expect(c.subcategory).toBe("소설"); // categoryChain[0] = 첫 분류 단.
    expect(c.matched).toBe("만화:이름"); // candidateName = 사슬 끝 '이름'.
    expect(c.chainStop?.reason).toBe("leaf");
  });

  test("(나) 마지막 분류 기준 — 같은 마지막 분류 둘이면 둘째 미반영 경고", async () => {
    // categoryChain[last]=피부과 기준(2026-06-13 §7) — #피부과 둘이라 둘째 '서울의원' 미반영.
    const content =
      "#장소:병원 #병원:피부과 #피부과:무지개의원 #피부과:서울의원";
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.entityRowCreated).toBe(true);
    expect(await store.entitiesRepo.findByName("place", "무지개의원")).not.toBeNull();
    expect(await store.entitiesRepo.findByName("place", "서울의원")).toBeNull(); // 둘째는 행 미생성.
    expect(
      result.warnings.some(
        (w) =>
          w.includes("같은 분류") &&
          w.includes("피부과") &&
          w.includes("서울의원"),
      ),
    ).toBe(true);
  });

  test("§6.2 — wireGeneralClassification 이 #병원:피부과 인접 쌍을 콜론 태그에서 세운다", async () => {
    // 사슬은 타입 루트 진입(장소→병원)만, 인접 쌍(병원→피부과)·잎(피부과→무지개의원)은
    // 일반 분류가 콜론 태그에서 세운다(겹침 0·멱등). 타입 prefix 없이 분류 태그만 줘도
    // 인접 쌍이 그대로 세워지는지 고정한다(일반 분류 통로 단독 동작 증명).
    const content = "#병원:피부과 #피부과:무지개의원";
    const origin = await makeOrigin(content);
    await wireEntityPlacement(store, origin, content, { llm: null });

    const byeongwon = await store.findConceptByName("병원");
    const pibugwa = await store.findConceptByName("피부과");
    const rainbow = await store.findConceptByName("무지개의원");
    expect(byeongwon).not.toBeNull();
    expect(pibugwa).not.toBeNull();
    expect(rainbow).not.toBeNull();

    const edges = store.getHierarchyEdgesWithin([
      byeongwon!.conceptId,
      pibugwa!.conceptId,
      rainbow!.conceptId,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    expect(hasEdge(byeongwon!.conceptId, pibugwa!.conceptId)).toBe(true); // 병원 → 피부과
    expect(hasEdge(pibugwa!.conceptId, rainbow!.conceptId)).toBe(true); // 피부과 → 무지개의원
  });

  // §14 #별명: 귀속 경계 — 실제 입력 통로 순서(사람 통로 → 엔티티 통로)를 재현한다.

  test("§14.1 ① #사람:만 있는 글 — #닉네임: 은 사람 alias (엔티티 통로 미관여)", async () => {
    const content = "#사람:민수 #닉네임:민짱";
    const origin = await makeOrigin(content);
    const personResult = await wireHashtagEntities(store, origin, content);
    const entityResult = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    // 사람 통로가 민수의 alias 로 '민짱' 을 붙인다 — 엔티티 행은 안 생긴다(② 아님).
    expect(entityResult.entityRowCreated).toBe(false);
    const lookup = await store.findPersonByNameOrAlias("민짱");
    expect(lookup.person).not.toBeNull();
    expect(lookup.person!.displayName).toBe("민수");
    // 모호 경고 없음 — 사람 단독 글이라 귀속이 명확.
    expect(
      personResult.warnings.some((w) => w.includes("별칭 귀속 모호")),
    ).toBe(false);
  });

  test("§14.2 ② 엔티티 사슬만 있는 글 — #별명: 은 엔티티 ko_aliases", async () => {
    const content = "#작품:소설 #소설:데뷔못하면죽는병걸림 #별명:데못죽";
    const origin = await makeOrigin(content);
    // 사람 통로 먼저(실제 통로 순서) — 주 사람이 없어 별칭을 소비 안 한다.
    const personResult = await wireHashtagEntities(store, origin, content);
    const entityResult = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    expect(entityResult.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("work", "데뷔못하면죽는병걸림");
    expect(row).not.toBeNull();
    expect(row!.koAliases).toContain("데못죽"); // 엔티티 ko_aliases.
    // 사람 통로는 '데못죽' 을 사람 alias 로 안 끌어간다(주 사람 0).
    const personLookup = await store.findPersonByNameOrAlias("데못죽");
    expect(personLookup.person).toBeNull();
    expect(
      personResult.warnings.some((w) => w.includes("별칭 귀속 모호")),
    ).toBe(false);
  });

  test("§14.3 ③ 둘 다 있는 글 — #별명: 을 어디에도 안 붙이고 양쪽 경고", async () => {
    // 엔티티 행(비-work) + #사람:민수(주 사람·별칭 소비 대상) 둘 다 → 모호(방향 4).
    //
    // P4 재정의(2026-06-16 글 주체) 뒤로는, `#사람:` 선언이 있는 글의 `#작품:` 은 새 work
    // 행을 만들지 않고 기존 작품에 연결만 한다 — 그래서 옛 `#작품:`+`#사람:` 조합으로는 ③
    // (엔티티 행이 실제 생김)이 성립하지 않는다. ③ 은 work 한정 규칙 밖의 비-work 엔티티
    // (#섭취:특제딸기우유 — intake 행은 `#사람:` 선언과 무관하게 생성)로 재현한다. 그래야
    // "엔티티 행이 실제로 생기면서 주 사람도 있는" ③ 상황이 새 규칙에서도 그대로 검증된다.
    const content = "#섭취:특제딸기우유 #사람:민수 #별명:데못죽";
    const origin = await makeOrigin(content);
    const personResult = await wireHashtagEntities(store, origin, content);
    const entityResult = await wireEntityPlacement(store, origin, content, {
      llm: null,
    });

    // 엔티티 행(intake)은 생기지만 ko_aliases 엔 '데못죽' 이 안 들어간다(엔티티 통로가 막음).
    expect(entityResult.entityRowCreated).toBe(true);
    const row = await store.entitiesRepo.findByName("intake", "특제딸기우유");
    expect(row).not.toBeNull();
    expect(row!.koAliases ?? []).not.toContain("데못죽");
    // 사람 alias 에도 '데못죽' 이 안 들어간다(사람 통로가 막음).
    const personLookup = await store.findPersonByNameOrAlias("데못죽");
    expect(personLookup.person).toBeNull();
    // 양쪽 통로 모두 모호 경고를 남긴다(거짓 귀속 0·정직).
    expect(
      personResult.warnings.some((w) => w.includes("별칭 귀속 모호")),
    ).toBe(true);
    expect(
      entityResult.warnings.some((w) => w.includes("별칭 귀속 모호")),
    ).toBe(true);
  });
});

// ── L2: 분류 LLM 토글 "구조만 남김" 동결 회귀 ───────────────────────────────
// WireEntityPlacementOptions.llm 은 예약 칸이고 wireEntityPlacement 함수 안이 *안
// 읽는다*(결정적 1·2단만). 이 inert 성을 회귀로 고정한다 — throwing LLM 을 넘겨도
// 이 경로는 LLM 을 부르지 않으므로 throw 가 안 나고, 결정 결과(기타=none)가 선다.
// LLM 을 부른다면 chat() tripwire 가 호출돼 calls 가 1+ 가 되거나 throw 가 샌다.
describe("L2 — 분류 LLM 토글 구조만 남김 동결(llm 칸 inert)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    resetConceptTypeVocabularyCache();
    resetClassifierCache();
  });

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("throwing LLM 을 넘겨도 wireEntityPlacement 가 LLM 을 안 부른다(기타 글)", async () => {
    // 결정 1·2단이 절대 안 잡는 순수 기타 글 — 콜론 태그·어휘 씨앗 0. LLM 단이
    // 배선됐다면 여기서 chat() 으로 갔을 입력이다.
    const content = "오늘 점심에 그냥 산책을 했다";
    const origin = await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });

    let chatCalls = 0;
    // tripwire LlmClient — 인터페이스를 가짜 데이터로 채우는 mock 이 아니라, 호출되면
    // 안 되는 경로가 호출됐는지 잡는 감지선이다(*.test.ts 한정). chat 은 호출 즉시
    // 기록 후 throw — 배선됐다면 이 throw 가 새거나 calls 가 오른다.
    const tripwire = {
      name: "tripwire:should-not-be-called",
      chat: async () => {
        chatCalls += 1;
        throw new Error("LLM 이 배선됐다 — L2 동결 위반(이 경로는 결정적만이어야 함)");
      },
    };

    // throwing LLM 을 넘긴다. inert 면 throw 가 안 새고 정상 반환.
    const result = await wireEntityPlacement(store, origin, content, {
      llm: tripwire,
    });

    expect(chatCalls).toBe(0); // LLM 을 단 한 번도 안 불렀다.
    expect(result.typeName).toBeNull(); // 결정 결과 = 기타(none).
    expect(result.entityRowCreated).toBe(false);
  });

  test("llm:null 과 throwing LLM 의 결과가 동일(칸이 동작에 영향 0)", async () => {
    const content = "그냥 일기 한 줄";
    const o1 = await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    const withNull = await wireEntityPlacement(store, o1, content, {
      llm: null,
    });
    const o2 = await store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
    const withTripwire = await wireEntityPlacement(store, o2, content, {
      llm: {
        name: "tripwire",
        chat: async () => {
          throw new Error("불려선 안 됨");
        },
      },
    });
    // 칸 값과 무관하게 같은 결정 결과(typeName·행 생성 여부).
    expect(withTripwire.typeName).toBe(withNull.typeName);
    expect(withTripwire.entityRowCreated).toBe(withNull.entityRowCreated);
  });
});
