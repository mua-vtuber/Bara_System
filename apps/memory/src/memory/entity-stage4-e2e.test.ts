/**
 * entity-stage4-e2e.test.ts — 개념 엔티티 타입 체계 4단계 끝에서 끝 실증
 * (Task 6, spec 2026-06-09 §7.2·§7.3·§3 3분법).
 *
 * 사용자 요구 "작품에 창작자를 적으면 그 작가의 다른 작품이 검색에 딸려 온다"를 실제
 * 입력 흐름(saveTextInput → wireEntityPlacement → wireEntityRelations → retrieve)으로
 * 끝에서 끝까지 증명한다. 관계 엣지가 entity_relation_edges 에 typed relation 으로
 * 들어가고, 그 관계를 따라 검색 1-hop 펼침이 같은 작가의 다른 작품 글을 후보로 끌어오는
 * 것을 RRF 코어 0줄로 실증한다.
 *
 * ── "데못죽 검색이 주술회전을 끌어온다" 의 데이터 흐름 ────────────────────────────
 *   1. 작품 행이 검색 seed 가 되려면 그 행에 identity 엣지(행 ↔ 위계 잎 개념)가 있어야
 *      한다. `#작품:데못죽` 만으로는 잎 개념(데못죽)이 안 생겨 identity 가 안 걸린다
 *      (3단계 — 라벨만 개념화). 그래서 콜론 분류(addClassificationTag)로 잎 개념
 *      '데못죽'·'주술회전'을 먼저 등록해 두면, 그 뒤 `#작품:...` 글 입력이 같은 이름의
 *      잎 개념을 찾아 identity 를 세운다(stage3 identity 테스트와 같은 양식).
 *   2. `#작품:데못죽 #창작자:아쿠타미` 입력 → 작품 행 + identity(데못죽 개념) +
 *      created_by 관계 엣지(작품 → 아쿠타미 person). 같은 글의 origin 노드가 '데못죽'
 *      개념에 node_concept_edges 로 이어진다(addClassificationTag).
 *   3. `#작품:주술회전 #창작자:아쿠타미` 도 같은 아쿠타미 person 행을 target 으로.
 *   4. "데못죽" 검색 → 데못죽 개념 직접 매칭 → 그 개념 identity 작품 행 seed →
 *      created_by 아쿠타미(target) → 같은 아쿠타미 가진 주술회전(다른 source) →
 *      주술회전 identity 개념 → node_concept_edges → 주술회전 글 노드가 후보 합류.
 *
 * mock 클래스 0 — 실제 SQLite(:memory:) + 실제 Bgem3Embedder 로만 검증한다
 * (CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). 데이터 fixture 만 쓴다.
 * LLM 단은 saveTextInput 안에서 null(default OFF) — 결정적 1·2단 어휘로만 판정한다.
 * 4단계는 태그만(DCL-2) — LLM 관계 발굴 0(5단계로 남김).
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
import { HybridRetriever } from "./retriever.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import { saveTextInput } from "../server-internal/save-input.ts";
import type { SaveTextInputArgs } from "../server-internal/save-input.ts";

describe("entity-stage4-e2e — 창작자 적으면 그 작가의 다른 작품이 검색에 딸려 온다 (§7.2)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

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
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 글 입력 통로 그대로 — extractor·regex 미주입 plain 경로(LLM 단 null). */
  async function ingest(content: string): Promise<number> {
    const args: SaveTextInputArgs = {
      content,
      source: "dashboard:manual",
      author: "owner",
      userId: "owner",
    };
    const result = await saveTextInput(store, args);
    return result.originNodeId!;
  }

  function countRows(table: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  /**
   * 단계4 T4 — 8종(work·schedule·creature 등)이 전용 테이블을 잃고 범용 본체 entities 로
   * 합쳐졌다. 옛 countRows("works") 같은 전용 테이블 행 수 단정을 같은 사실
   * (entities 안 그 종류 행 수)로 옮긴 헬퍼다. person·project 는 그대로라 여기 안 쓴다.
   */
  function entityCount(typeName: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
        .get(typeName) as { n: number }
    ).n;
  }

  /** 작품 행 한 점이 가진 created_by 관계 엣지(작품 → 사람) 목록을 직접 읽는다. */
  function createdByEdgesOf(workId: string): Array<{
    target_type: string;
    target_id: string;
    relation: string;
  }> {
    return db
      .prepare(
        `SELECT target_type, target_id, relation FROM entity_relation_edges
         WHERE source_type = 'work' AND source_id = ?`,
      )
      .all(workId) as Array<{
      target_type: string;
      target_id: string;
      relation: string;
    }>;
  }

  test("창작자 두 작품이 같은 아쿠타미 person 을 target 으로 + 데못죽 검색이 둘째 작품 끌어옴 (끝에서 끝)", async () => {
    // ── 0) 잎 개념을 콜론 분류로 먼저 등록 — 그래야 작품 행에 identity 가 걸린다 ───
    //    (위 헤더 1번 — `#작품:X` 단독으론 잎 개념이 안 생긴다는 3단계 사실을 우회).
    //    둘째 작품 이름은 어휘 씨앗·하위분류에 없는 고유명을 쓴다 — '주술회전' 같은
    //    어휘 씨앗 이름은 3단계 결정 B 가 1급 행 생성을 막아(분류 단어로 봄) 작품 행이
    //    안 생긴다. '마법물고기' 는 어느 씨앗에도 없는 고유명이라 행이 생긴다.
    const seedDemo = await store.addNode({
      content: "데못죽 분류 등록",
      sourceType: "auto_capture",
    });
    await store.addClassificationTag(seedDemo, "작품", "데못죽", "user_input", seedDemo);
    const seedOther = await store.addNode({
      content: "마법물고기 분류 등록",
      sourceType: "auto_capture",
    });
    await store.addClassificationTag(seedOther, "작품", "마법물고기", "user_input", seedOther);
    expect(await store.findConceptByName("데못죽")).not.toBeNull();
    expect(await store.findConceptByName("마법물고기")).not.toBeNull();

    // ── 1) 입력 통로로 두 작품 + 창작자 태그를 넣는다 ────────────────────────────
    const demoNode = await ingest("#작품:데못죽 #창작자:아쿠타미, 데못죽 감상 기록");
    const otherNode = await ingest(
      "#작품:마법물고기 #창작자:아쿠타미, 마법물고기 감상 기록",
    );

    // ── 2) 작품 행 둘 + 아쿠타미 person 행 하나가 생긴다 ─────────────────────────
    const demo = await store.entitiesRepo.findByName("work", "데못죽");
    const other = await store.entitiesRepo.findByName("work", "마법물고기");
    expect(demo).not.toBeNull();
    expect(other).not.toBeNull();
    expect(entityCount("work")).toBe(2);

    // 같은 이름이라 아쿠타미 person 행이 한 번만 만들어진다(findOrCreatePersonByName
    // 재사용). persons 테이블에는 작성자 'owner'(attribution 축)도 한 행 있어 총 2 다 —
    // 창작자 아쿠타미는 그 중 정확히 하나여야 한다(중복 person 0).
    const akutami = await store.findPersonByName("아쿠타미");
    expect(akutami).not.toBeNull();
    const akutamiCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM persons WHERE display_name = '아쿠타미'",
        )
        .get() as { n: number }
    ).n;
    expect(akutamiCount).toBe(1);

    // ── 3) created_by 엣지 둘 — 둘 다 *같은* 아쿠타미 person 을 target 으로 ───────
    //    falsify: 관계명이 created_by 가 아니거나, target 이 서로 다른 person id 면
    //    "같은 작가" 펼침이 성립 안 한다 — 그 어긋남을 잡는다.
    const demoEdges = createdByEdgesOf(demo!.id);
    const otherEdges = createdByEdgesOf(other!.id);
    expect(demoEdges.length).toBe(1);
    expect(otherEdges.length).toBe(1);
    expect(demoEdges[0]!.relation).toBe("created_by");
    expect(otherEdges[0]!.relation).toBe("created_by");
    expect(demoEdges[0]!.target_type).toBe("person");
    expect(otherEdges[0]!.target_type).toBe("person");
    expect(demoEdges[0]!.target_id).toBe(akutami!.personId);
    // 핵심 — 두 작품이 동일 person 행을 가리킨다(같은 아쿠타미). 이게 펼침의 다리.
    expect(otherEdges[0]!.target_id).toBe(demoEdges[0]!.target_id);
    // 관계 엣지 전체가 정확히 둘(거짓 엣지 없음).
    expect(countRows("entity_relation_edges")).toBe(2);

    // ── 4) "데못죽" 검색이 둘째 작품 글을 후보로 끌어온다(검색 1-hop·RRF 코어 0줄) ──
    //    falsify: 1-hop 펼침이 안 돌면 마법물고기 글은 '데못죽' 검색에 안 잡힌다
    //    (두 글은 텍스트가 안 겹친다 — 펼침이 아니면 도달 불가).
    const res = await retriever.retrieve("데못죽", { limit: 20 });
    const otherHit = res.find((x) => x.node.id === otherNode);
    expect(otherHit).toBeDefined();
    // 관계 펼침은 concept 채널 합류 지점으로 들어온다(retrieve-channels Task 5).
    expect(otherHit!.sources).toContain("concept");

    // 데못죽 글 자신도 당연히 잡힌다(직접 매칭). 펼침이 seed 글을 빼는 건 후보 풀
    // 차원이지 검색 결과에서 빼는 게 아니다 — 직접 매칭으로 잡혀 결과에 있다.
    expect(res.find((x) => x.node.id === demoNode)).toBeDefined();
  });

  test("typed relation — located_at(일정→장소) · owned_by(생물→사람) 가 제 관계명으로 들어간다", async () => {
    // 잎 개념을 먼저 등록(행 identity 용 — 이 테스트는 검색 펼침이 아니라 엣지 타입만 본다).
    // 일정·생물 값은 어휘 씨앗에 없는 고유명을 쓴다('미팅'·'보리' 같은 일반명사·씨앗은
    // 3단계 결정 B 가 1급 행 생성을 막아 source 행이 안 생기고, 그러면 관계 wiring 이
    // 돌 source 가 없어진다). '졸업식'·'나비' 는 1급 행이 생기는 이름이다.
    const s1 = await store.addNode({ content: "졸업식 등록", sourceType: "auto_capture" });
    await store.addClassificationTag(s1, "일정", "졸업식", "user_input", s1);
    const s2 = await store.addNode({ content: "나비 등록", sourceType: "auto_capture" });
    await store.addClassificationTag(s2, "생물", "나비", "user_input", s2);

    await ingest("#일정:졸업식 #관련장소:서울");
    await ingest("#생물:나비 #주인:엄마");

    const schedule = await store.entitiesRepo.findByName("schedule", "졸업식");
    const creature = await store.entitiesRepo.findByName("creature", "나비");
    expect(schedule).not.toBeNull();
    expect(creature).not.toBeNull();

    // located_at — 일정 → 장소. target 타입이 place 여야 한다(사람으로 새지 않음).
    const locEdges = db
      .prepare(
        `SELECT target_type, relation FROM entity_relation_edges
         WHERE source_type = 'schedule' AND source_id = ?`,
      )
      .all(schedule!.id) as Array<{ target_type: string; relation: string }>;
    expect(locEdges.length).toBe(1);
    expect(locEdges[0]!.relation).toBe("located_at");
    expect(locEdges[0]!.target_type).toBe("place");
    const seoul = await store.entitiesRepo.findByName("place", "서울");
    expect(seoul).not.toBeNull(); // target 장소 행이 생겼다.

    // owned_by — 생물 → 사람.
    const ownEdges = db
      .prepare(
        `SELECT target_type, relation FROM entity_relation_edges
         WHERE source_type = 'creature' AND source_id = ?`,
      )
      .all(creature!.id) as Array<{ target_type: string; relation: string }>;
    expect(ownEdges.length).toBe(1);
    expect(ownEdges[0]!.relation).toBe("owned_by");
    expect(ownEdges[0]!.target_type).toBe("person");
    const eomma = await store.findPersonByName("엄마");
    expect(eomma).not.toBeNull();
  });

  test("거짓 엣지 0 — 빈 target 값(#창작자:)은 관계 엣지를 안 만든다", async () => {
    const s = await store.addNode({ content: "데못죽 등록2", sourceType: "auto_capture" });
    await store.addClassificationTag(s, "작품", "데못죽", "user_input", s);

    await ingest("#작품:데못죽 #창작자:");

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull(); // 작품 행은 생긴다.
    // 빈 값이라 관계 엣지 0 — 빈 person 행으로 위장하지 않는다(거짓 엣지 0).
    expect(countRows("entity_relation_edges")).toBe(0);
    // 빈 값이 창작자 person 으로 새지 않는다 — persons 에는 작성자 'owner'(attribution
    // 축) 한 행만 있고, 빈 값에서 만들어진 창작자 person 은 0 이어야 한다.
    const nonOwner = (
      db
        .prepare("SELECT COUNT(*) AS n FROM persons WHERE display_name <> 'owner'")
        .get() as { n: number }
    ).n;
    expect(nonOwner).toBe(0);
  });

  test("거짓 엣지 0 — source 타입 불일치(작품에 #관련장소:)는 관계 엣지를 안 만든다", async () => {
    // 관련장소(located_at)는 일정 전용 source 다 — 작품에 적으면 엣지를 만들면 안 된다.
    const s = await store.addNode({ content: "데못죽 등록3", sourceType: "auto_capture" });
    await store.addClassificationTag(s, "작품", "데못죽", "user_input", s);

    await ingest("#작품:데못죽 #관련장소:서울");

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    // located_at 은 작품 source 에 못 걸린다(sourceTypes=schedule) — 엣지 0.
    const edges = createdByEdgesOf(work!.id);
    expect(edges.length).toBe(0);
    expect(countRows("entity_relation_edges")).toBe(0);
  });

  test("3분법 — #창작자:아쿠타미 는 관계 엣지 1, 라벨(has_attribute) 엣지 0 으로만 간다", async () => {
    // 창작자는 관계 키다 — 작품 → "아쿠타미" 를 라벨(공유 특성·has_attribute)로 잘못
    // 적으면 안 된다. 관계 1·라벨 0 이어야 칸/라벨/관계 3분법이 안 무너진다.
    const s = await store.addNode({ content: "데못죽 등록4", sourceType: "auto_capture" });
    await store.addClassificationTag(s, "작품", "데못죽", "user_input", s);

    await ingest("#작품:데못죽 #창작자:아쿠타미");

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();

    // 관계 엣지 1(created_by).
    expect(createdByEdgesOf(work!.id).length).toBe(1);

    // 라벨 엣지(has_attribute)에 '아쿠타미' 가 없어야 한다 — 관계 키가 라벨로 새지 않음.
    const labelEdges = store.getEntityConceptEdges("work", work!.id, "has_attribute");
    const akutamiConcept = await store.findConceptByName("아쿠타미");
    if (akutamiConcept) {
      expect(
        labelEdges.some((e) => e.conceptId === akutamiConcept.conceptId),
      ).toBe(false);
    }
    // 더 강하게 — 작품의 has_attribute 라벨 자체가 0(이 글엔 장르 등 다른 라벨도 없다).
    expect(labelEdges.length).toBe(0);
  });

  test("단계4 T4 — 8타입 placement 전 흐름이 범용 entity_concept_edges 에 identity·has_attribute 를 크래시 0 으로 쓴다", async () => {
    // 이 테스트는 T4 의 concept-edge 통합 재배선을 끝에서 끝으로 확인해 둔다. 옛날엔 작품 행이
    // 죽은 works 테이블에 살아 work_concept_edges FK(→works)가 맞았지만, T4 가 행을 범용
    // entities 로 옮겨 그 FK 가 깨졌다(글 입력마다 FOREIGN KEY 크래시). 통합 테이블
    // entity_concept_edges(entity_id→entities)로 재배선해 크래시 0 + 두 엣지 종류가 한 곳에
    // 들어가는지 실 :memory: DB + 실 임베딩으로 검증한다(mock 0).
    //
    // 흐름: saveTextInput → wireEntityPlacement → placeOneEntityType →
    //   (a) applyEntityAttributes 라벨(#장르:판타지 → has_attribute 엣지)
    //   (b) linkEntityIdentity(행 ↔ 잎 개념 → identity 엣지)
    // 잎 개념을 콜론 분류로 먼저 등록해 identity 가 걸리게 한다(stage3 양식).
    const seed = await store.addNode({ content: "데못죽 등록3", sourceType: "auto_capture" });
    await store.addClassificationTag(seed, "작품", "데못죽", "user_input", seed);

    // 크래시 0 — 던지면 여기서 테스트가 실패한다(옛 FK 크래시 회귀 가드).
    const originNode = await ingest("#작품:데못죽 #장르:판타지, 감상 기록");
    expect(originNode).toBeGreaterThan(0);

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();

    // (a) has_attribute 라벨 엣지 — 장르(판타지)가 통합 테이블에 들어갔다.
    const labels = store.getEntityConceptEdges("work", work!.id, "has_attribute");
    const fantasy = await store.findConceptByName("판타지");
    expect(fantasy).not.toBeNull();
    expect(labels.some((e) => e.conceptId === fantasy!.conceptId)).toBe(true);

    // (b) identity 엣지 — 작품 행 ↔ 잎 개념(데못죽)이 통합 테이블에 들어갔다.
    const identities = store.getEntityConceptEdges("work", work!.id, "identity");
    expect(identities.length).toBeGreaterThanOrEqual(1);

    // 두 엣지 종류 모두 *범용* entity_concept_edges 한 테이블에 산다(옛 per-type 0 — T9 가 정의 삭제).
    const unifiedCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM entity_concept_edges WHERE entity_id = ?")
        .get(work!.id) as { n: number }
    ).n;
    expect(unifiedCount).toBeGreaterThanOrEqual(2); // has_attribute(판타지) + identity(데못죽 잎)
  });
});
