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
  loadConceptTypeVocabulary,
  clearConceptVocabularyOverrides,
  setConceptVocabOverride,
  setEntityTypeOverride,
  type ConceptTypeVocabulary,
  type PlacementTypeName,
} from "../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../memory/entity-type-classifier.ts";
import { scheduleOccurrenceRowsForEntity } from "./routes/graph-nodes-shared.ts";
import { saveTextInput } from "./save-input.ts";
import { DuplicateMemoryError } from "./write-guard/duplicate-check.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("saveTextInput — entity-only 입력은 글 노드 없이 엔티티만 갱신", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    setEntityTypeOverride([]);
    clearConceptVocabularyOverrides();
    resetClassifierCache();
  });

  afterEach(() => {
    setEntityTypeOverride([]);
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    db.close();
  });

  function knowledgeNodeCount(): number {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM knowledge_nodes").get() as { n: number }
    ).n;
  }

  function entityAttr(
    entityId: string,
    attrKey: string,
  ): { attr_value: string; is_column: number } | null {
    return db
      .prepare(
        `SELECT attr_value, is_column
         FROM entity_attributes
         WHERE entity_id = ? AND attr_key = ?`,
      )
      .get(entityId, attrKey) as { attr_value: string; is_column: number } | null;
  }

  function registerUserLedgerType(): void {
    store.entityTypeRegistryDb.addEntityType({
      typeName: "household_ledger",
      koName: "가계부",
      idPrefix: "led_",
    });
    setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();

    const merged: ConceptTypeVocabulary = new Map(loadConceptTypeVocabulary());
    merged.set("household_ledger" as PlacementTypeName, {
      synonyms: [],
      subcategories: [],
      attributes: [],
      columns: ["금액"],
    });
    setConceptVocabOverride(merged);
    resetClassifierCache();
  }

  test("사람 프로필 입력 — knowledge_nodes 0개, 사람 사실/별명만 갱신", async () => {
    const result = await saveTextInput(store, {
      content:
        "#사람:홍길동, #직업:2D산골나무꾼, #별명:동글이, #별명:Banjjagi, #생일:0000년 0월 0일",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("entity_patch");
    expect(result.originNodeId).toBeNull();
    expect(result.nodeIds).toEqual([]);
    expect(knowledgeNodeCount()).toBe(0);

    const person = await store.findPersonByName("홍길동");
    expect(person).not.toBeNull();
    expect(person!.birthday).toBe("0000년 0월 0일");
    expect((await store.findPersonByNameOrAlias("동글이")).person?.personId).toBe(
      person!.personId,
    );
    expect((await store.findPersonByNameOrAlias("Banjjagi")).person?.personId).toBe(
      person!.personId,
    );
    expect(result.entities).toContainEqual({
      typeName: "person",
      id: person!.personId,
    });
  });

  test("작품 프로필 입력 — work row/속성/identity edge 를 sourceNodeId null 로 저장", async () => {
    const result = await saveTextInput(store, {
      content: "#작품:데못죽 #장르:판타지 #별명:데못죽",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("entity_patch");
    expect(knowledgeNodeCount()).toBe(0);

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    expect(result.entities).toContainEqual({ typeName: "work", id: work!.id });

    const edge = db
      .prepare(
        `SELECT provenance, source_node_id
         FROM entity_concept_edges
         WHERE entity_id = ?
         LIMIT 1`,
      )
      .get(work!.id) as { provenance: string; source_node_id: number | null } | null;
    expect(edge).not.toBeNull();
    expect(edge!.provenance).toBe("user_input");
    expect(edge!.source_node_id).toBeNull();
  });

  test("관계 입력 — entity_relation_edges 도 user_input/null provenance", async () => {
    await saveTextInput(store, {
      content: "#작품:데못죽 #작가:백덕수",
      source: "dashboard:manual",
    });

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    const relation = db
      .prepare(
        `SELECT target_type, relation, provenance, source_node_id
         FROM entity_relation_edges
         WHERE source_id = ? AND relation = 'created_by'
         LIMIT 1`,
      )
      .get(work!.id) as
      | {
          target_type: string;
          relation: string;
          provenance: string;
          source_node_id: number | null;
        }
      | null;

    expect(relation).not.toBeNull();
    expect(relation!.target_type).toBe("person");
    expect(relation!.provenance).toBe("user_input");
    expect(relation!.source_node_id).toBeNull();
    expect(knowledgeNodeCount()).toBe(0);
  });

  test("사람 프로필의 제목만 work 는 후속 #소설/#작가 입력 때 한 작품으로 보강", async () => {
    const first = await saveTextInput(store, {
      content:
        "#사람:백덕수, #직업:소설작가, #작품:데뷔 못 하면 죽는 병 걸림, #작품:괴담에 떨어져도 출근을 해야 하는구나",
      source: "dashboard:manual",
    });
    expect(first.kind).toBe("entity_patch");

    const beforeRows = db
      .query(
        `SELECT entity_id, medium, created_by
         FROM entities
         WHERE type_name = 'work' AND name = '데뷔 못 하면 죽는 병 걸림'`,
      )
      .all() as Array<{ entity_id: string; medium: string | null; created_by: string | null }>;
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]!.medium).toBeNull();
    expect(beforeRows[0]!.created_by).toBeNull();

    const second = await saveTextInput(store, {
      content:
        "#소설:데뷔 못 하면 죽는 병 걸림, #작가:백덕수, #별칭:데못죽, 소설을 3번 이상 정주행 했다.",
      source: "dashboard:manual",
    });
    expect(second.kind).toBe("memory");

    const rows = db
      .query(
        `SELECT entity_id, medium, created_by
         FROM entities
         WHERE type_name = 'work' AND name = '데뷔 못 하면 죽는 병 걸림'`,
      )
      .all() as Array<{ entity_id: string; medium: string | null; created_by: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(beforeRows[0]!.entity_id);
    expect(rows[0]!.medium).toBe("소설");
    expect(rows[0]!.created_by).toBe("백덕수");

    const work = await store.entitiesRepo.get(rows[0]!.entity_id);
    expect(work?.koAliases).toContain("데못죽");
  });

  test("본문 없는 #소설/#작가/#별칭 입력은 작품 패치로 저장하고 경고를 만들지 않는다", async () => {
    const result = await saveTextInput(store, {
      content:
        "#소설:괴담에 떨어져도 출근을 해야 하는구나, #작가:백덕수, #별칭:괴담출근, #별칭:괴출",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("entity_patch");
    expect(result.warnings).toEqual([]);
    expect(knowledgeNodeCount()).toBe(0);

    const rows = db
      .query(
        `SELECT entity_id, medium, created_by
         FROM entities
         WHERE type_name = 'work' AND name = '괴담에 떨어져도 출근을 해야 하는구나'`,
      )
      .all() as Array<{ entity_id: string; medium: string | null; created_by: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.medium).toBe("소설");
    expect(rows[0]!.created_by).toBe("백덕수");
    expect(result.entities).toContainEqual({ typeName: "work", id: rows[0]!.entity_id });

    const author = await store.findPersonByName("백덕수");
    expect(author).not.toBeNull();
    const relation = db
      .prepare(
        `SELECT relation
         FROM entity_relation_edges
         WHERE source_id = ? AND target_id = ?`,
      )
      .get(rows[0]!.entity_id, author!.personId) as { relation: string } | null;
    expect(relation?.relation).toBe("created_by");

    const work = await store.entitiesRepo.get(rows[0]!.entity_id);
    expect(work?.koAliases).toContain("괴담출근");
    expect(work?.koAliases).toContain("괴출");
  });

  test("사용자 추가 타입 — row/column 속성을 글 노드 없이 저장", async () => {
    registerUserLedgerType();

    const result = await saveTextInput(store, {
      content: "#가계부:배달 #배달:돈까스 #금액:17000",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("entity_patch");
    expect(knowledgeNodeCount()).toBe(0);

    const ledger = await store.entitiesRepo.findByName(
      "household_ledger",
      "돈까스",
    );
    expect(ledger).not.toBeNull();
    expect(result.entities).toContainEqual({
      typeName: "household_ledger",
      id: ledger!.id,
    });
    expect(entityAttr(ledger!.id, "금액")).toEqual({
      attr_value: "17000",
      is_column: 1,
    });
  });

  test("본문이 있으면 기존 memory 경로 — 글 노드와 사람 mention 생성", async () => {
    const result = await saveTextInput(store, {
      content: "#사람:홍길동, 오늘 작업했다",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("memory");
    expect(result.originNodeId).not.toBeNull();
    expect(knowledgeNodeCount()).toBe(1);

    const person = await store.findPersonByName("홍길동");
    expect(person).not.toBeNull();
    const mentionCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM node_person_edges
           WHERE node_id = ? AND person_id = ? AND relation = 'mentions'`,
        )
        .get(result.originNodeId!, person!.personId) as { n: number }
    ).n;
    expect(mentionCount).toBe(1);
  });

  test("본문 없는 일정+날짜 입력은 schedule occurrence 노드로 저장", async () => {
    const result = await saveTextInput(store, {
      content: "#일정:침뜸치료, #날짜:2000년 01월 01일",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("memory");
    expect(result.originNodeId).not.toBeNull();
    expect(result.nodeIds).toEqual([result.originNodeId!]);
    expect(knowledgeNodeCount()).toBe(1);

    const node = await store.getNode(result.originNodeId!);
    expect(node?.content).toBe("침뜸치료");
    expect(node?.eventAt).toBe("2000-01-01");
    expect(node?.eventUntil).toBeNull();
    expect(node?.metadata).toMatchObject({
      title: "침뜸치료",
      originalText: "#일정:침뜸치료, #날짜:2000년 01월 01일",
      scheduleOccurrence: true,
      extracted: 1,
      extractedTo: [],
    });

    const schedule = await store.entitiesRepo.findByName("schedule", "침뜸치료");
    expect(schedule).not.toBeNull();
    expect(result.entities).toContainEqual({
      typeName: "schedule",
      id: schedule!.id,
    });
    const attrs = db
      .query("SELECT attr_key FROM entity_attributes WHERE entity_id = ?")
      .all(schedule!.id) as { attr_key: string }[];
    expect(
      attrs.some((row) => row.attr_key === "event_at" || row.attr_key === "날짜"),
    ).toBe(false);
    expect(scheduleOccurrenceRowsForEntity(store, schedule!)).toEqual([
      { key: "침뜸치료", value: "2000-01-01" },
    ]);

    const llmChildren = db
      .query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'llm_extract'")
      .get() as { n: number };
    expect(llmChildren.n).toBe(0);
  });

  test("유사-중복 관문 면제 회귀 고정 — entity_patch/schedule_occurrence 는 관문에 안 걸린다 (T18 qa 권고)", async () => {
    // 면제 근거가 save-input.ts 의 선행 return **순서**뿐이라(관문 안에 타입 검사가
    // 없다) 진입 판정 순서가 바뀌면 조용히 깨진다 — 그 회귀를 이 테스트가 잡는다.
    // 장치: 임계 0 오버라이드 + 기존 기억 1건. 관문이 돌기만 하면 어떤 글이든
    // 기존 기억과의 유사도(bge-m3 는 무관 글도 0.28 이상)가 임계 0 을 넘어 무조건
    // DuplicateMemoryError 가 난다. 즉 "관문을 통과했다"가 아니라 "관문 자체를
    // 안 거쳤다"만 성공할 수 있는 조건이다.
    await saveTextInput(store, {
      content: "면제 확인용으로 미리 저장해 둔 기존 기억",
      source: "dashboard:manual",
    });

    // 대조군: plain 글은 같은 조건에서 실제로 관문에 걸린다 — 이 장치가 무는지 증명.
    await expect(
      saveTextInput(store, {
        content: "기존 기억과 무관한 완전히 새로운 글",
        source: "dashboard:manual",
        duplicateCheck: { threshold: 0 },
      }),
    ).rejects.toThrow(DuplicateMemoryError);

    // entity_patch — 같은 조건에서도 저장이 성공해야 한다(면제 고정).
    const patch = await saveTextInput(store, {
      content: "#사람:홍길동, #별명:동글이",
      source: "dashboard:manual",
      duplicateCheck: { threshold: 0 },
    });
    expect(patch.kind).toBe("entity_patch");
    // 미리 저장한 기존 기억 1건뿐 — entity_patch 는 글 노드를 안 만든다.
    expect(knowledgeNodeCount()).toBe(1);

    // schedule_occurrence — 같은 조건에서도 occurrence 저장이 성공해야 한다(면제 고정).
    const occurrence = await saveTextInput(store, {
      content: "#일정:침뜸치료, #날짜:2000년 01월 01일",
      source: "dashboard:manual",
      duplicateCheck: { threshold: 0 },
    });
    expect(occurrence.kind).toBe("memory");
    expect(occurrence.originNodeId).not.toBeNull();
    const node = await store.getNode(occurrence.originNodeId!);
    expect(node?.metadata.scheduleOccurrence).toBe(true);
  });

  test("본문 있는 일정+날짜 입력은 기존 memory 경로로 원문을 보존", async () => {
    const result = await saveTextInput(store, {
      content: "#일정:치과 #날짜:7월 15일, 정기 검진",
      source: "dashboard:manual",
    });

    expect(result.kind).toBe("memory");
    expect(result.originNodeId).not.toBeNull();
    expect(knowledgeNodeCount()).toBe(1);
    const node = await store.getNode(result.originNodeId!);
    expect(node?.content).toBe("#일정:치과 #날짜:7월 15일, 정기 검진");
    expect(node?.metadata.scheduleOccurrence).toBeUndefined();
  });
});
