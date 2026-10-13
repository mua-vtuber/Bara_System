/**
 * inherited-type-lookup.test.ts — 분류 키 → 등록 타입 역조회 헬퍼 검증
 * (entity-classify-display-rootfix Task C1·P1).
 *
 * mock 클래스 0 — 실제 SQLite + 실제 임베딩 store 로 검증한다(CLAUDE.md "DB/임베딩 의존
 * 모듈은 실제 구현체와 통합 검증"). 위계는 wireEntityPlacement 로 실제로 세운 뒤 역조회한다.
 *
 * 검증 대상(P1 — 얼룩이 사례의 판정 두뇌):
 *   - `생물 → 동물 → 고양이` 를 세운 뒤 "고양이" 역조회 → creature(잎이 타입 루트까지 거슬러 올라감).
 *   - 미등록 이름 → type null·모호 아님(상속 대상 아님).
 *   - 타입 루트 자체("생물") 역조회 → 부모 사슬에 타입 루트가 없으니 type null.
 *   - 중간 분류 단("동물") 역조회 → creature(부모에 생물 타입 루트).
 *   - 모호("나비"가 생물·작품 두 타입 루트 아래) → type null·ambiguous(거짓 타입 0·Q1-1).
 *   - 순환 위계(`가가 ↔ 나나`) → 무한 루프 없이 결과(깊이 상한·방문 Set 회귀 방어선).
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
import { ensureTypeRootConcept } from "./entity-hierarchy-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import { resolveInheritedType } from "./inherited-type-lookup.ts";

describe("inherited-type-lookup — 분류 키 → 등록 타입 역조회 (P1·C1)", () => {
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
   * `생물 → 동물 → 고양이` 위계를 실제로 세운다 — 입력 통로 양식 그대로
   * (wireHashtagEntities 가 동물 → 고양이 잎 단을, wireEntityPlacement 가 생물 → 동물 단을).
   */
  async function setupCreatureHierarchy(): Promise<void> {
    const content = "#생물:동물 #동물:고양이 #고양이:까망이";
    const origin = await makeOrigin(content);
    await wireHashtagEntities(store, origin, content);
    await wireEntityPlacement(store, origin, content, { llm: null });
  }

  test("생물 → 동물 → 고양이 등록 후 '고양이' → creature", async () => {
    await setupCreatureHierarchy();
    const r = await resolveInheritedType(store, "고양이");
    expect(r.type).toBe("creature");
    expect(r.ambiguous).toBe(false);
  });

  test("미등록 이름 — type null·모호 아님(상속 대상 아님)", async () => {
    const r = await resolveInheritedType(store, "처음보는단어");
    expect(r.type).toBeNull();
    expect(r.ambiguous).toBe(false);
  });

  test("중간 분류 단 '동물' → creature(부모에 생물 타입 루트)", async () => {
    await setupCreatureHierarchy();
    const r = await resolveInheritedType(store, "동물");
    expect(r.type).toBe("creature");
    expect(r.ambiguous).toBe(false);
  });

  test("타입 루트 자체 '생물' → type null(부모 사슬에 타입 루트 없음 — 상속 대상 아님)", async () => {
    await setupCreatureHierarchy();
    const r = await resolveInheritedType(store, "생물");
    expect(r.type).toBeNull();
    expect(r.ambiguous).toBe(false);
  });

  test("모호 — '나비'가 생물·작품 두 타입 루트 아래 → type null·ambiguous(거짓 타입 0·Q1-1)", async () => {
    // 두 타입 루트(생물·작품)를 보장하고 같은 자식 개념("나비")을 둘 다의 직접 자식으로 단다.
    // 실 store·Mock 0 — 같은 중간 개념 이름이 서로 다른 두 타입 위계 아래 매달린 우연 동명을
    // 재현한다. resolveInheritedType 가 거짓 타입 하나를 고르지 않고 모호로 정직히 멈추는지 확인.
    const creatureRoot = await ensureTypeRootConcept(store, "creature");
    const workRoot = await ensureTypeRootConcept(store, "work");
    const butterfly = await store.findOrCreateConcept("나비", {
      isClassificationValue: true,
    });
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: creatureRoot,
      targetType: "concept",
      targetId: butterfly,

      provenance: "user_input",
      sourceNodeId: null,
});
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: workRoot,
      targetType: "concept",
      targetId: butterfly,

      provenance: "user_input",
      sourceNodeId: null,
});

    const r = await resolveInheritedType(store, "나비");
    expect(r.type).toBeNull();
    expect(r.ambiguous).toBe(true);
    // reason 에 두 타입이 다 담겨야 한다(어느 둘이 충돌했는지 디버깅 가능).
    expect(r.reason).toContain("creature");
    expect(r.reason).toContain("work");
  });

  test("순환 위계(가가 ↔ 나나) — 무한 루프 없이 결과 반환(깊이 상한·방문 Set 회귀)", async () => {
    // `가가 → 나나` 와 `나나 → 가가` 양방향 parent_of 로 순환을 만든다. 어느 쪽도 타입 루트가
    // 아니라 type null 이 맞되, 핵심은 방문 Set·깊이 상한이 무한 루프를 막아 결과가 돌아오는 것.
    // 누가 PARENT_CHAIN_MAX_DEPTH 를 0 으로 바꾸거나 방문 Set 을 지워도 이 케이스가 매달려 잡는다.
    const gaga = await store.findOrCreateConcept("가가");
    const nana = await store.findOrCreateConcept("나나");
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: gaga,
      targetType: "concept",
      targetId: nana,

      provenance: "user_input",
      sourceNodeId: null,
});
    store.addHierarchyEdge({
      sourceType: "concept",
      sourceId: nana,
      targetType: "concept",
      targetId: gaga,

      provenance: "user_input",
      sourceNodeId: null,
});

    const started = Date.now();
    const r = await resolveInheritedType(store, "나나");
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(3000);
    expect(r.type).toBeNull();
    expect(r.ambiguous).toBe(false);
  });
});
