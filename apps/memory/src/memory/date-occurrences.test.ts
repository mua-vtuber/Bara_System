/**
 * date-occurrences.test.ts — 일정탭 발생 항목 통합 계산.
 *
 * 실 SqliteMemoryStore(:memory:) + 실제 route/cache 주입 흐름. 임베딩은 이 기능의
 * 관심사가 아니라 AddNodeArgs.embedding fixture 로 고정한다(mock class 0).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "./retriever.ts";
import { ContextAssembler } from "./context-assembler.ts";
import { buildMemoryApi, applyClassifyVocabOverrides } from "../server.ts";
import { ClassifyVocabUserRepo } from "./classify-vocab/classify-vocab-user-repo.ts";
import {
  loadConceptTypeVocabulary,
  placementTypeNames,
  clearConceptVocabularyOverrides,
  setEntityTypeOverride,
  type ConceptTypeVocabulary,
} from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import {
  buildDateOccurrences,
  type DateOccurrenceDeps,
  type DateOccurrenceKind,
} from "./date-occurrences.ts";

function embeddingFixture(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 1;
  return vector;
}

function deepCloneVocab(src: ConceptTypeVocabulary): ConceptTypeVocabulary {
  const clone: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v = src.get(t)!;
    clone.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
      columns: [...(v.columns ?? [])],
    });
  }
  return clone;
}

interface Harness {
  db: Database;
  store: SqliteMemoryStore;
  app: ReturnType<typeof buildMemoryApi>;
}

let h: Harness;

function resetVocabState(): void {
  setEntityTypeOverride([]);
  clearConceptVocabularyOverrides();
  resetClassifierCache();
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const embedder = new Bgem3Embedder();
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const classifyRepo = new ClassifyVocabUserRepo(db);

  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  const yamlBaseline = deepCloneVocab(loadConceptTypeVocabulary());
  applyClassifyVocabOverrides(yamlBaseline, classifyRepo.listEntries());

  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    classifyVocabUserRepo: classifyRepo,
    conceptVocabYaml: yamlBaseline,
  });
  return { db, store, app };
}

function deps(): DateOccurrenceDeps {
  return {
    getAllNodes: (limit?: number) => h.store.getAllNodes(limit),
    listPersons: (options?: { limit?: number }) => h.store.listPersons(options),
    entitiesRepo: h.store.entitiesRepo,
    entityTypeRegistryDb: h.store.entityTypeRegistryDb,
  };
}

async function addEquipmentDateColumn(): Promise<void> {
  const typeRes = await h.app.request("/api/entity-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
  });
  expect(typeRes.status).toBe(201);

  const columnRes = await h.app.request("/api/classify-vocab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
  });
  expect(columnRes.status).toBe(201);

  const typeMarkerRes = await h.app.request("/api/classify-vocab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "구입일\tdate" }),
  });
  expect(typeMarkerRes.status).toBe(201);
}

async function seedOccurrences(): Promise<void> {
  await h.store.addNode({
    content: "치과 예약",
    eventAt: "2026-07-05",
    embedding: embeddingFixture(),
  });
  await h.store.addNode({
    content: "지난 회의",
    eventAt: "2026-06-15",
    embedding: embeddingFixture(),
  });

  const person = await h.store.findOrCreatePersonByName("민수");
  await h.store.updatePersonFacts(person.personId, { birthday: "7월 10일" });

  const milk = await h.store.entitiesRepo.findOrCreateEntity("intake", "우유");
  h.store.entitiesRepo.setAttribute(milk.id, "expires_at", "2026-07-01", true);
  const yogurt = await h.store.entitiesRepo.findOrCreateEntity("intake", "요거트");
  h.store.entitiesRepo.setAttribute(yogurt.id, "expires_at", "2026-06-20", true);
  const butter = await h.store.entitiesRepo.findOrCreateEntity("intake", "버터");
  h.store.entitiesRepo.setAttribute(butter.id, "expires_at", "2026-02-30", true);

  await addEquipmentDateColumn();
  const keyboard = await h.store.entitiesRepo.findOrCreateEntity("equipment", "키보드");
  h.store.entitiesRepo.setAttribute(keyboard.id, "구입일", "2026년 7월 3일", true);
}

describe("buildDateOccurrences", () => {
  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
    resetVocabState();
  });

  test("이벤트 날짜, 생일, date 타입 엔티티 칸을 일정 후보로 모은다", async () => {
    await seedOccurrences();

    const response = await buildDateOccurrences(deps(), {
      now: new Date(2026, 5, 30, 9, 0, 0),
      days: 30,
      pastDays: 30,
      limit: 80,
    });

    expect(response.window).toEqual({
      today: "2026-06-30",
      until: "2026-07-30",
      pastSince: "2026-05-31",
      days: 30,
      pastDays: 30,
    });
    expect(response.upcoming.map((o) => [o.kind, o.role, o.title, o.date, o.columnKey ?? ""])).toEqual([
      ["column_date", "expiration", "우유 유통기한", "2026-07-01", "유통기한"],
      ["column_date", "generic", "키보드 구입일", "2026-07-03", "구입일"],
      ["event", "event", "치과 예약", "2026-07-05", ""],
      ["birthday", "birthday", "민수 생일", "2026-07-10", ""],
    ]);
    expect(response.past.map((o) => [o.kind, o.role, o.title, o.date])).toEqual([
      ["column_date", "expiration", "요거트 유통기한", "2026-06-20"],
      ["event", "event", "지난 회의", "2026-06-15"],
    ]);
    expect([...response.upcoming, ...response.past].some((o) => o.title.includes("버터"))).toBe(false);
  });

  test("scheduleHidden 표시가 켜진 메모는 일정 목록에서 빠지고 다른 메모는 남는다", async () => {
    const hiddenId = await h.store.addNode({
      content: "교훈: 블렌더 정리",
      eventAt: "2026-06-20",
      metadata: { scheduleHidden: true },
      embedding: embeddingFixture(),
    });
    await h.store.addNode({ content: "치과 예약", eventAt: "2026-07-05", embedding: embeddingFixture() });
    await h.store.addNode({
      content: "표시가 false 인 메모", eventAt: "2026-07-06", metadata: { scheduleHidden: false }, embedding: embeddingFixture(),
    });

    const response = await buildDateOccurrences(deps(), { now: new Date(2026, 5, 30, 9, 0, 0), days: 30, pastDays: 30, limit: 80 });

    const titles = [...response.upcoming, ...response.past].map((o) => o.title);
    expect(titles).toContain("치과 예약");
    expect(titles).toContain("표시가 false 인 메모");
    expect(titles.some((t) => t.includes("블렌더"))).toBe(false);
    expect((await h.store.getNode(hiddenId))?.eventAt).toBe("2026-06-20");
  });

  test("일정이 만들어진 원본 메모는 달력에서 빠지고 일정 제목만 남는다", async () => {
    const memoId = await h.store.addNode({
      content: "민수가 7월 3일 결혼한다더라",
      eventAt: "2026-07-03",
      embedding: embeddingFixture(),
    });
    const scheduleId = await h.store.addNode({
      content: "민수 결혼",
      eventAt: "2026-07-03",
      sourceType: "llm_extract",
      metadata: { scheduleOccurrence: true, scheduleSourceNodeId: memoId },
      embedding: embeddingFixture(),
    });
    const now = new Date(2026, 5, 30, 9, 0, 0);
    const kinds = new Set<DateOccurrenceKind>(["event"]);

    const res = await buildDateOccurrences(deps(), { now, kinds });
    expect(res.upcoming.map((o) => o.target.id)).toEqual([scheduleId]);
    expect(res.upcoming[0]!.title).toBe("민수 결혼");

    // 일정 노드가 사라지면(되돌리기) 원본 메모가 다시 보인다.
    h.db.run("DELETE FROM knowledge_nodes WHERE id = ?", [scheduleId]);
    const after = await buildDateOccurrences(deps(), { now, kinds });
    expect(after.upcoming.map((o) => o.target.id)).toEqual([memoId]);
  });

  test("q와 column으로 특정 날짜 칸을 좁힌다", async () => {
    await seedOccurrences();

    const response = await buildDateOccurrences(deps(), {
      now: new Date(2026, 5, 30, 9, 0, 0),
      days: 30,
      pastDays: 30,
      kinds: new Set<DateOccurrenceKind>(["column_date"]),
      q: "우유",
      column: "유통기한",
      limit: 80,
    });

    expect(response.upcoming).toHaveLength(1);
    expect(response.upcoming[0]).toMatchObject({
      kind: "column_date",
      role: "expiration",
      title: "우유 유통기한",
      date: "2026-07-01",
      columnKey: "유통기한",
      originalDateText: "2026-07-01",
    });
    expect(response.past).toEqual([]);
  });

  test("kind=birthday와 days 범위로 한 달 내 생일만 조회한다", async () => {
    await seedOccurrences();

    const response = await buildDateOccurrences(deps(), {
      now: new Date(2026, 5, 30, 9, 0, 0),
      days: 30,
      pastDays: 0,
      kinds: new Set<DateOccurrenceKind>(["birthday"]),
      limit: 80,
    });

    expect(response.upcoming).toEqual([
      expect.objectContaining({
        kind: "birthday",
        role: "birthday",
        title: "민수 생일",
        date: "2026-07-10",
        originalDateText: "7월 10일",
      }),
    ]);
    expect(response.past).toEqual([]);
  });
});
