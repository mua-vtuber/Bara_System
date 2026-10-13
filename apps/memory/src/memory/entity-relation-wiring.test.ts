/**
 * entity-relation-wiring.test.ts — 관계 wiring 모듈 검증 (4단계 Task 4 부분 A).
 *
 * 실제 SQLite(:memory:) + 실제 임베딩 store 로 검증한다 — Mock 클래스 0(CLAUDE.md
 * "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). stage4 T4 가 8 타입을 범용 본체로 흡수해,
 * source 행은 store.entitiesRepo.findOrCreateEntity(typeName, name) 로 만들고, 관계 엣지는
 * store.getRelationsFromSource 로 읽어 확인한다.
 *
 * 검증 대상:
 *   - `#창작자:아쿠타미` (work source) → 작품 행 → 사람 행 created_by 엣지 1.
 *   - source 타입 불일치(작품에 located_at·관련장소) → 엣지 0 + warn(식별자 포함).
 *   - 빈 값(`#창작자:` trim) → 엣지 0(파싱 단계에서 제외).
 *   - 관계 태그 0개 → 빈 결과(정직·실패 아님).
 *   - 멱등 — 같은 글 두 번 → 두 번째는 created 0·already 1(중복 엣지 0).
 *   - person/project source → loud throw(이 통로 밖).
 *   - participated_by(project source)는 이 통로에서 안 만든다(person/project source 차단).
 *   - 출처 제거 회귀 — #출처 는 더 이상 관계 태그가 아니라 엣지를 만들지 않는다.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { wireEntityRelations } from "./entity-relation-wiring.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";

const TEST_ORIGIN_NODE_ID = 1;

describe("entity-relation-wiring — 관계 wiring (§7.2·§7.3)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    resetConceptTypeVocabularyCache();
  });
  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("작품 source #창작자:아쿠타미 → created_by 엣지(작품→사람) 1", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "#작품:데못죽 #창작자:아쿠타미",
    });

    expect(result.warnings).toEqual([]);
    expect(result.created.length).toBe(1);
    const edge = result.created[0]!;
    expect(edge.relation).toBe("created_by");
    expect(edge.rawKey).toBe("창작자");
    expect(edge.sourceType).toBe("work");
    expect(edge.sourceId).toBe(work.id);
    expect(edge.targetType).toBe("person");
    expect(edge.targetName).toBe("아쿠타미");

    // entity_relation_edges 에 진짜 적혔는지 — source 에서 나가는 엣지로 확인.
    const stored = store.getRelationsFromSource("work", work.id);
    expect(stored.length).toBe(1);
    expect(stored[0]!.relation).toBe("created_by");
    expect(stored[0]!.targetType).toBe("person");
    const provenance = db
      .query<{ provenance: string; source_node_id: number | null }, [string]>(
        `SELECT provenance, source_node_id
           FROM entity_relation_edges
          WHERE source_type='work' AND source_id=? AND relation='created_by'`,
      )
      .get(work.id);
    expect(provenance).toEqual({
      provenance: "hashtag",
      source_node_id: TEST_ORIGIN_NODE_ID,
    });

    // target 사람 행이 실제로 생겼다.
    const person = await store.findPersonByNameOrAlias("아쿠타미");
    expect(person.person).not.toBeNull();
    expect(edge.targetId).toBe(person.person!.personId);
  });

  test("생물 source #주인:엄마 → owned_by 엣지(생물→사람) 1", async () => {
    const creature = await store.entitiesRepo.findOrCreateEntity("creature", "보리");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "creature",
      sourceId: creature.id,
      content: "#생물:보리 #주인:엄마",
    });

    expect(result.warnings).toEqual([]);
    expect(result.created.length).toBe(1);
    expect(result.created[0]!.relation).toBe("owned_by");
    expect(result.created[0]!.targetName).toBe("엄마");

    const stored = store.getRelationsFromSource("creature", creature.id);
    expect(stored.length).toBe(1);
    expect(stored[0]!.relation).toBe("owned_by");
  });

  test("일정 source #관련장소:서울 → located_at 엣지(일정→장소) 1", async () => {
    const schedule = await store.entitiesRepo.findOrCreateEntity("schedule", "미팅");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "schedule",
      sourceId: schedule.id,
      content: "#일정:미팅 #관련장소:서울",
    });

    expect(result.warnings).toEqual([]);
    expect(result.created.length).toBe(1);
    expect(result.created[0]!.relation).toBe("located_at");
    expect(result.created[0]!.targetType).toBe("place");
    expect(result.created[0]!.targetName).toBe("서울");

    // target 장소 행이 실제로 생겼다.
    expect(await store.entitiesRepo.findByName("place", "서울")).not.toBeNull();
  });

  test("source 타입 불일치(작품에 관련장소=located_at) → 엣지 0 + warn(식별자 포함)", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "#작품:데못죽 #관련장소:서울",
    });

    // located_at 의 source 는 일정만 — 작품에는 못 건다. 엣지 0 + warn.
    expect(result.created).toEqual([]);
    expect(result.already).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("관련장소");
    expect(result.warnings[0]).toContain("work");

    expect(store.getRelationsFromSource("work", work.id).length).toBe(0);
  });

  test("관계 태그 0개(속성 태그만) → 빈 결과(정직·실패 아님)", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "#작품:데못죽 #장르:판타지", // 장르 = 라벨 키·관계 키 아님.
    });

    expect(result.created).toEqual([]);
    expect(result.already).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(store.getRelationsFromSource("work", work.id).length).toBe(0);
  });

  test("빈 값 관계 태그(#창작자: 만) → 엣지 0(파싱 단계에서 제외·거짓 엣지 0)", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "#작품:데못죽 #창작자:",
    });

    // 빈 값은 parseRelationTags 가 제외 — 관계 태그가 0개로 떨어져 빈 결과.
    expect(result.created).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(store.getRelationsFromSource("work", work.id).length).toBe(0);
  });

  test("멱등 — 같은 글 두 번 호출해도 엣지 1(두 번째는 created 0·already 1)", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
    const content = "#작품:데못죽 #창작자:아쿠타미";

    const first = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content,
    });
    expect(first.created.length).toBe(1);
    expect(first.already.length).toBe(0);

    const second = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content,
    });
    expect(second.created.length).toBe(0); // 새로 만든 것 없음.
    expect(second.already.length).toBe(1); // 이미 있던 것 1(정직 분리).

    // 엣지는 한 행만(중복 0).
    expect(store.getRelationsFromSource("work", work.id).length).toBe(1);
  });

  test("자료 source #출처:데못죽 → 출처는 더 이상 관계 태그가 아니라 엣지 0", async () => {
    const material = await store.entitiesRepo.findOrCreateEntity("material", "리뷰글");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "material",
      sourceId: material.id,
      content: "#자료:리뷰글 #출처:데못죽 #작품:데못죽",
      sameDocTypeHints: [{ value: "데못죽", type: "work" }],
    });

    expect(result.warnings).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.already).toEqual([]);
    expect(store.getRelationsFromSource("material", material.id)).toEqual([]);
    expect(await store.entitiesRepo.findByName("work", "데못죽")).toBeNull();
  });

  test("person/project source → loud throw(이 통로 밖·참여자=project_person_edges·가족/친구=5단계)", async () => {
    await expect(
      wireEntityRelations(store, {
        originNodeId: TEST_ORIGIN_NODE_ID,
        sourceType: "person" as never,
        sourceId: "psn_x",
        content: "#가족:엄마",
      }),
    ).rejects.toThrow(/person/);

    await expect(
      wireEntityRelations(store, {
        originNodeId: TEST_ORIGIN_NODE_ID,
        sourceType: "project" as never,
        sourceId: "prj_x",
        content: "#참여자:민수",
      }),
    ).rejects.toThrow(/project/);
  });

  test("여러 관계 태그 한 글 — 사용물 #관련사람:엄마 (related_person) 만 걸리고 무관 키는 무시", async () => {
    const usable = await store.entitiesRepo.findOrCreateEntity("usable", "타이레놀");
    const result = await wireEntityRelations(store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "usable",
      sourceId: usable.id,
      content: "#사용물:타이레놀 #관련사람:엄마 #주의사항:간독성",
    });

    // 관련사람 = usable 관계 키 → related_person 엣지. 주의사항 = 라벨 키(관계 키 아님) → 무시.
    expect(result.warnings).toEqual([]);
    expect(result.created.length).toBe(1);
    expect(result.created[0]!.relation).toBe("related_person");
    expect(result.created[0]!.targetName).toBe("엄마");
  });
});
