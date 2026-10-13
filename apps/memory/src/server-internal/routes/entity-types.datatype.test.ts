/**
 * entity-types.datatype.test.ts — GET /api/entity-types 응답 columns[].dataType 검증 (단계6b T1).
 *
 * 검증 가족:
 *   (a) 코드 종류(intake) 유통기한 칸은 dataType:"date".
 *   (b) 새 종류에 columns slot 칸 + column_types slot(칸키\tnumber/date) 을 더하면 그 칸
 *       dataType 이 "number"/"date" 로 온다(표지 없는 칸은 "text"·글자형 default).
 *   (c) column_types slot 을 안 더하면 칸은 글자형("text")로 온다(정직).
 *
 * 실 SqliteMemoryStore(:memory:) + 실 buildMemoryApi. Mock 0.
 * entity-types.columns.test.ts 의 harness 양식을 그대로 재사용한다.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi, applyClassifyVocabOverrides } from "../../server.ts";
import { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import { mergeConceptVocab } from "../../memory/classify-vocab/merge-classify-vocab.ts";
import {
  loadConceptTypeVocabulary,
  setConceptVocabOverride,
  setEntityTypeOverride,
  clearConceptVocabularyOverrides,
  placementTypeNames,
  type ConceptTypeVocabulary,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

afterEach(() => {
  setEntityTypeOverride([]);
  clearConceptVocabularyOverrides();
  resetClassifierCache();
});

/** 운영 yaml 사전을 다섯 칸(columns 포함)까지 깊은 복제 — 부팅 기준선(conceptVocabYaml) 흉내. */
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
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  repo: ClassifyVocabUserRepo;
  yamlBaseline: ConceptTypeVocabulary;
}

/**
 * entity-types CRUD + classify-vocab CRUD 를 한 app 에서 쓰는 harness.
 * classify-vocab.test.ts 의 부팅 흐름을 미러 — yaml 깊은 복제 기준선 + repo 를 deps 로 넘겨,
 * 새 종류 추가 후 그 종류에 columns·column_types slot 을 더하고 GET 응답 dataType 을 본다.
 * repo·yamlBaseline 을 노출해 재시작 회귀(부팅 초기 주입 재현)가 같은 출처를 본다.
 */
function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const repo = new ClassifyVocabUserRepo(db);

  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  const yamlBaseline = deepCloneVocab(loadConceptTypeVocabulary());
  const merged = mergeConceptVocab(yamlBaseline, repo.listEntries());
  setConceptVocabOverride(merged);
  resetClassifierCache();

  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    classifyVocabUserRepo: repo,
    conceptVocabYaml: yamlBaseline,
  });
  return { app, db, store, repo, yamlBaseline };
}

interface DataTypeColumn {
  key: string;
  label: string;
  dataType: "text" | "number" | "date";
}
interface DataTypeRow {
  typeName: string;
  columns: DataTypeColumn[];
}

async function fetchTypes(app: Hono): Promise<DataTypeRow[]> {
  const res = await app.request("/api/entity-types");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entityTypes: DataTypeRow[] };
  return body.entityTypes;
}

describe("GET /api/entity-types columns[].dataType", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("코드 종류(intake) 유통기한 칸은 날짜형 dataType:'date'", async () => {
    const types = await fetchTypes(h.app);
    const intake = types.find((t) => t.typeName === "intake");
    expect(intake).toBeDefined();
    expect(intake!.columns).toContainEqual({ key: "유통기한", label: "유통기한", dataType: "date" });
  });

  test("사람 코드 종류는 생일 칸을 날짜형 dataType:'date' 로 내려준다", async () => {
    const types = await fetchTypes(h.app);
    const person = types.find((t) => t.typeName === "person");
    expect(person).toBeDefined();
    expect(person!.columns).toContainEqual({ key: "생일", label: "생일", dataType: "date" });
  });

  test("새 종류 — columns slot 칸 + column_types slot(number) 이면 dataType:'number'", async () => {
    // 새 종류 추가.
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });
    // 그 종류에 '무게' 칸을 columns slot 으로 추가.
    const colRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "무게" }),
    });
    expect(colRes.status).toBe(201);
    // '무게' 칸 datatype 을 number 로 지정(column_types slot·칸키\tnumber 단일 value).
    const dtRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "무게\tnumber" }),
    });
    expect(dtRes.status).toBe(201);

    const types = await fetchTypes(h.app);
    const equipment = types.find((t) => t.typeName === "equipment");
    expect(equipment).toBeDefined();
    expect(equipment!.columns).toContainEqual({ key: "무게", label: "무게", dataType: "number" });
  });

  test("새 종류 — column_types slot 안 더하면 칸은 글자형 dataType:'text'(정직)", async () => {
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });
    const colRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "색상" }),
    });
    expect(colRes.status).toBe(201);

    const types = await fetchTypes(h.app);
    const equipment = types.find((t) => t.typeName === "equipment");
    expect(equipment).toBeDefined();
    expect(equipment!.columns).toContainEqual({ key: "색상", label: "색상", dataType: "text" });
  });

  test("새 종류 — columns slot 칸 + column_types slot(date) 이면 dataType:'date'", async () => {
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });
    await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
    });
    const dtRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "구입일\tdate" }),
    });
    expect(dtRes.status).toBe(201);

    const types = await fetchTypes(h.app);
    const equipment = types.find((t) => t.typeName === "equipment");
    expect(equipment).toBeDefined();
    expect(equipment!.columns).toContainEqual({ key: "구입일", label: "구입일", dataType: "date" });
  });

  test("column_types slot 무효 value(datatype 이 number/date 아님) 는 400", async () => {
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });
    const badRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "무게\ttext" }),
    });
    expect(badRes.status).toBe(400);
  });

  // 재시작 회귀(단계6b 부팅 주입 누락 차단) — 새 종류 + column_types 행이 DB 에 보존된
  // 상태에서 서버를 재시작하면(캐시 비움 → 부팅 초기 주입 재실행), 첫 CRUD 없이도 GET
  // 응답의 그 칸 dataType 이 "number" 로 살아있어야 한다. 부팅 초기 주입이 column_types 를
  // 빠뜨리면(applyClassifyVocabOverrides 에 setColumnTypeOverride 없으면) 이 케이스가 FAIL —
  // 재시작 직후 계산 탭 숫자 칸 드롭다운이 비고 sum/avg 가 안 되는 결함을 고정한다.
  test("재시작 후 column_types datatype 이 첫 CRUD 없이도 보존된다(부팅 초기 주입)", async () => {
    // 1) 새 종류 + 숫자형 칸을 API 로 넣는다(DB classify_vocab_user_entries 에 행이 남는다).
    await h.app.request("/api/entity-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" }),
    });
    await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "무게" }),
    });
    await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "무게\tnumber" }),
    });

    // 2) 재시작 모사 — 모든 모듈 캐시를 비운다(columnTypeMap=null 포함). 이 순간 datatype
    //    맵은 사라지고 DB 의 column_types 행만 남는다(재시작 직후 휘발성 캐시 비움 재현).
    setEntityTypeOverride([]);
    clearConceptVocabularyOverrides();
    resetClassifierCache();

    // 3) 부팅 초기 주입 재실행 — server.ts createMemoryApi 부팅 시퀀스를 미러한다. 새 종류
    //    명부 + 분류 어휘 세 주입(applyClassifyVocabOverrides)을 *첫 CRUD 없이* 다시 얹는다.
    setEntityTypeOverride(h.store.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    applyClassifyVocabOverrides(h.yamlBaseline, h.repo.listEntries());

    // 4) 첫 CRUD 없이 GET 응답의 dataType 이 number 로 살아있어야 한다(부팅 초기 주입 보존).
    const types = await fetchTypes(h.app);
    const equipment = types.find((t) => t.typeName === "equipment");
    expect(equipment).toBeDefined();
    expect(equipment!.columns).toContainEqual({ key: "무게", label: "무게", dataType: "number" });
  });
});
