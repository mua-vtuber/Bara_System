/**
 * vocab-cache-preserve.test.ts — 종류 CRUD·관계명 CRUD 라우트가 부르는 resetConceptTypeVocabularyCache 가
 * 사용자 분류 어휘 주입분(병합본·항목 동의어 맵·칸 datatype 맵)을 날리지 않는지 확인하는 회귀.
 *
 * 옛 결함: reset 이 병합본(setConceptVocabOverride 가 얹은 yaml + 사용자 행 + 가림표)을 그대로 null 로
 * 돌려, 다음 접근이 yaml 만으로 다시 읽었다 — 종류/관계명을 하나 더하거나 지우면 사용자 분류 어휘가
 * 재시작이나 분류 어휘 CRUD 전까지 조용히 사라졌다.
 *
 * Mock 0: 실제 임시 SQLite 파일 + 실제 store·사전 repo + 실제 라우트 등록기. 모델 적재가 필요 없다 —
 * 종류·관계명 CRUD 는 임베딩을 쓰지 않으므로 적재 안 한 실제 Bgem3Embedder 를 넘긴다. 부팅 주입은
 * 서버가 쓰는 applyClassifyVocabOverrides 를 그대로 호출해 재현한다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ClassifyVocabOverrideRepo } from "../../memory/classify-vocab/classify-vocab-override-repo.ts";
import { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import { applyClassifyVocabOverrides } from "../../memory/classify-vocab/apply-classify-vocab.ts";
import {
  clearConceptVocabularyOverrides,
  getCanonicalItemKey,
  getColumnDataType,
  getTypeColumns,
  getTypeSynonyms,
  loadConceptTypeVocabulary,
  setEntityTypeOverride,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import {
  resetRelationVocabCache,
  setRelationVocabOverride,
} from "../../memory/entity-relation-vocabulary.ts";
import { mergeRelationVocab } from "../../memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../memory/relation-vocab/relation-vocab-loader.ts";
import { RelationNameUserRepo } from "../../memory/relation-vocab/relation-name-user-repo.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerEntityTypesRoutes } from "./entity-types.ts";
import { registerRelationVocabRoutes } from "./relation-vocab.ts";

let dir: string;
let db: Database;
let app: Hono;
let classifyVocabUserRepo: ClassifyVocabUserRepo;
let classifyVocabOverrideRepo: ClassifyVocabOverrideRepo;
let conceptVocabYaml: ReturnType<typeof loadConceptTypeVocabulary>;

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** 부팅이 하는 대로 사용자 분류 어휘 행을 DB 에 넣고 모듈 캐시에 얹는다. */
function bootApplyClassifyVocab(): void {
  applyClassifyVocabOverrides(
    conceptVocabYaml,
    classifyVocabUserRepo.listEntries(),
    classifyVocabOverrideRepo.listOverrides(),
  );
}

/** 사용자 분류 어휘 세 가지(병합본 synonyms·항목 동의어·칸 datatype)가 모두 살아 있는지 단언한다. */
function expectUserClassifyVocabIntact(): void {
  expect(getTypeSynonyms("work")).toContain("회귀분류단어");
  expect(getCanonicalItemKey("work", "갈래")).toBe("장르");
  expect(getTypeColumns("equipment" as never)).toContain("무게");
  expect(getColumnDataType("equipment", "무게")).toBe("number");
}

beforeEach(() => {
  clearConceptVocabularyOverrides();
  setEntityTypeOverride([]);
  dir = mkdtempSync(join(tmpdir(), "bara-vocab-preserve-"));
  db = openMemoryDatabase(join(dir, "memory.db"), { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, new Bgem3Embedder());
  conceptVocabYaml = structuredClone(loadConceptTypeVocabulary());
  classifyVocabUserRepo = new ClassifyVocabUserRepo(db);
  classifyVocabOverrideRepo = new ClassifyVocabOverrideRepo(db);
  const relationNameUserRepo = new RelationNameUserRepo(db);

  // 부팅 순서 — 종류 명부 → 분류 어휘 → 관계 어휘.
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  store.entityTypeRegistryDb.addEntityType({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" });
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  classifyVocabUserRepo.addEntry({ typeName: "work", slot: "synonyms", value: "회귀분류단어" });
  classifyVocabUserRepo.addEntry({ typeName: "work", slot: "item_synonym", value: "장르\t갈래" });
  classifyVocabUserRepo.addEntry({ typeName: "equipment", slot: "columns", value: "무게" });
  classifyVocabUserRepo.addEntry({ typeName: "equipment", slot: "column_types", value: "무게\tnumber" });
  bootApplyClassifyVocab();
  setRelationVocabOverride(
    mergeRelationVocab(loadRelationVocabularySeed(), relationNameUserRepo.listEntries()),
  );
  resetRelationVocabCache();
  expectUserClassifyVocabIntact();

  app = new Hono();
  const deps = {
    store,
    classifyVocabUserRepo,
    classifyVocabOverrideRepo,
    conceptVocabYaml,
    relationNameUserRepo,
  } as unknown as MemoryApiDeps;
  registerEntityTypesRoutes(app, deps);
  registerRelationVocabRoutes(app, deps);
});

afterEach(() => {
  setEntityTypeOverride([]);
  setRelationVocabOverride(null);
  resetRelationVocabCache();
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("종류 CRUD 라우트 — 사용자 분류 어휘 보존", () => {
  test("새 종류를 더해도 사용자 분류 어휘가 남고, 새 종류는 빈 어휘 칸을 얻는다", async () => {
    const res = await post("/api/entity-types", { typeName: "vehicle", koName: "탈것", idPrefix: "veh_" });
    expect(res.status).toBe(201);
    expectUserClassifyVocabIntact();
    expect(getTypeSynonyms("vehicle" as never)).toEqual([]);
    // 기본 yaml 어휘도 그대로.
    expect(getTypeSynonyms("work")).toContain("창작물");
  });

  test("새 종류를 지워도 사용자 분류 어휘가 남는다", async () => {
    expect((await post("/api/entity-types", { typeName: "vehicle", koName: "탈것" })).status).toBe(201);
    const res = await app.request("/api/entity-types/vehicle", { method: "DELETE" });
    expect(res.status).toBe(200);
    expectUserClassifyVocabIntact();
  });

  test("종류를 더한 뒤 그 종류에 단 어휘 행도 다음 종류 CRUD 에서 살아남는다(병합본이 새 명부로 다시 만들어진다)", async () => {
    expect((await post("/api/entity-types", { typeName: "vehicle", koName: "탈것" })).status).toBe(201);
    classifyVocabUserRepo.addEntry({ typeName: "vehicle", slot: "synonyms", value: "자동차류" });
    bootApplyClassifyVocab();
    expect(getTypeSynonyms("vehicle" as never)).toContain("자동차류");

    expect((await post("/api/entity-types", { typeName: "tool", koName: "도구" })).status).toBe(201);
    expect(getTypeSynonyms("vehicle" as never)).toContain("자동차류");
    expectUserClassifyVocabIntact();
  });

  test("어휘 행이 달린 종류는 지우기가 409 로 거절되고 종류·사용자 분류 어휘가 모두 그대로 남는다", async () => {
    const res = await app.request("/api/entity-types/equipment", { method: "DELETE" });
    expect(res.status).toBe(409);
    // 고아를 만들지 않으려고 종류 행을 지우기 전에 막는다 — 종류도 그 어휘도 전부 살아 있다.
    expect(((await res.json()) as { error: string }).error).toContain("분류 어휘");
    expectUserClassifyVocabIntact();
  });
});

describe("관계명 CRUD 라우트 — 사용자 분류 어휘 보존", () => {
  const relBody = {
    relationKey: "회귀관계",
    relationName: "regression_rel",
    sourceTypes: ["work"],
    targetTypes: ["person"],
    defaultTargetType: "person",
  };

  test("새 관계명을 더해도 사용자 분류 어휘가 남는다", async () => {
    const res = await post("/api/relation-vocab", relBody);
    expect(res.status).toBe(201);
    expectUserClassifyVocabIntact();
  });

  test("새 관계명을 지워도 사용자 분류 어휘가 남는다", async () => {
    expect((await post("/api/relation-vocab", relBody)).status).toBe(201);
    const res = await app.request("/api/relation-vocab/회귀관계", { method: "DELETE" });
    expect(res.status).toBe(200);
    expectUserClassifyVocabIntact();
  });
});
