/**
 * entity-types.delete-guard.test.ts — 새 엔티티 종류 삭제의 고아 방지 + 고아 행에 대한 부팅·재병합 관용.
 *
 * 옛 결함: DELETE /api/entity-types/:typeName 이 entity_types 행만 지워, 그 종류를 가리키는 분류 어휘·가림표·
 * 관계명 행이 고아로 남았다. 다음 서버 시작의 병합(applyClassifyVocabOverrides·mergeRelationVocab)이
 * "등록되지 않은 배치 타입" 으로 throw 해 createMemoryApi 가 끝까지 못 가고 서버가 안 떴다.
 *
 * 고친 것: (1) 라우트가 의존 데이터가 남은 종류 삭제를 409 로 막는다. (2) 불러오는 쪽 병합은 고아 행을
 * 건너뛰고 경고만 남긴다. (3) 쓰기 쪽(분류 어휘·관계명 CRUD)의 미등록 종류 거부는 그대로다.
 *
 * Mock 0: 실제 임시 SQLite + 실제 store·repo·라우트 등록기. 모델 적재 불필요(vocab-cache-preserve 와 같은 harness).
 * "부팅" 은 server.ts 가 하는 호출(applyClassifyVocabOverrides·mergeRelationVocabSkippingOrphans)을 그대로 재현한다.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  isPlacementType,
  loadConceptTypeVocabulary,
  setEntityTypeOverride,
} from "../../memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import {
  resetRelationVocabCache,
  setRelationVocabOverride,
} from "../../memory/entity-relation-vocabulary.ts";
import { mergeRelationVocabSkippingOrphans } from "../../memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../memory/relation-vocab/relation-vocab-loader.ts";
import { RelationNameUserRepo } from "../../memory/relation-vocab/relation-name-user-repo.ts";
import type { MemoryApiDeps } from "../types.ts";
import { registerClassifyVocabRoutes } from "./classify-vocab.ts";
import { registerEntityTypesRoutes } from "./entity-types.ts";
import { registerRelationVocabRoutes } from "./relation-vocab.ts";

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let app: Hono;
let classifyVocabUserRepo: ClassifyVocabUserRepo;
let classifyVocabOverrideRepo: ClassifyVocabOverrideRepo;
let relationNameUserRepo: RelationNameUserRepo;
let conceptVocabYaml: ReturnType<typeof loadConceptTypeVocabulary>;

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const post = (path: string, body: unknown) => app.request(path, jsonInit("POST", body));
const del = (path: string) => app.request(path, { method: "DELETE" });

/** server.ts 부팅이 하는 두 주입을 그대로 재현한다(관계 어휘 → 분류 어휘). */
function bootApply(): void {
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  setRelationVocabOverride(
    mergeRelationVocabSkippingOrphans(loadRelationVocabularySeed(), relationNameUserRepo.listEntries()),
  );
  resetRelationVocabCache();
  applyClassifyVocabOverrides(
    conceptVocabYaml,
    classifyVocabUserRepo.listEntries(),
    classifyVocabOverrideRepo.listOverrides(),
  );
}

function insertEntity(typeName: string, name: string): void {
  db.prepare(
    "INSERT INTO entities (entity_id, type_name, name) VALUES (?, ?, ?)",
  ).run(`ent_${crypto.randomUUID()}`, typeName, name);
}

beforeEach(() => {
  clearConceptVocabularyOverrides();
  setEntityTypeOverride([]);
  dir = mkdtempSync(join(tmpdir(), "bara-type-delete-guard-"));
  db = openMemoryDatabase(join(dir, "memory.db"), { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
  conceptVocabYaml = structuredClone(loadConceptTypeVocabulary());
  classifyVocabUserRepo = new ClassifyVocabUserRepo(db);
  classifyVocabOverrideRepo = new ClassifyVocabOverrideRepo(db);
  relationNameUserRepo = new RelationNameUserRepo(db);

  app = new Hono();
  const deps = {
    store,
    classifyVocabUserRepo,
    classifyVocabOverrideRepo,
    conceptVocabYaml,
    relationNameUserRepo,
  } as unknown as MemoryApiDeps;
  registerEntityTypesRoutes(app, deps);
  registerClassifyVocabRoutes(app, deps);
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

describe("DELETE /api/entity-types/:typeName — 의존 데이터가 있으면 409", () => {
  async function addVehicle(): Promise<void> {
    expect((await post("/api/entity-types", { typeName: "vehicle", koName: "탈것", idPrefix: "veh_" })).status).toBe(201);
  }
  const stillRegistered = (): boolean =>
    store.entityTypeRegistryDb.isUserEntityType("vehicle") && isPlacementType("vehicle");

  test("분류 어휘 행이 있으면 409 + 개수·종류 이름을 담은 한국어 메시지, 종류는 그대로 남는다", async () => {
    await addVehicle();
    expect((await post("/api/classify-vocab", { typeName: "vehicle", slot: "synonyms", value: "자동차류" })).status).toBe(201);
    expect((await post("/api/classify-vocab", { typeName: "vehicle", slot: "columns", value: "배기량" })).status).toBe(201);

    const res = await del("/api/entity-types/vehicle");
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("탈것(vehicle)");
    expect(error).toContain("분류 어휘");
    expect(error).toContain("2개");
    expect(stillRegistered()).toBe(true);
    expect(getTypeSynonyms("vehicle" as never)).toContain("자동차류");
  });

  test("분류 어휘 가림표(꺼 둔 기본 어휘)만 있어도 409", async () => {
    await addVehicle();
    // 사용자 종류의 가림표는 라우트가 못 만들 수 있어 repo 로 직접 넣는다(고아·잔여 행 재현).
    classifyVocabOverrideRepo.addOverride({ typeName: "vehicle", slot: "synonyms", value: "탈거리" });
    const res = await del("/api/entity-types/vehicle");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("꺼 둔 기본 어휘");
    expect(stillRegistered()).toBe(true);
  });

  test("관계명이 source 로 쓰든 target·기본 타입으로 쓰든 409", async () => {
    await addVehicle();
    expect(
      (await post("/api/relation-vocab", {
        relationKey: "운전자", relationName: "driven_by",
        sourceTypes: ["vehicle"], targetTypes: ["person"], defaultTargetType: "person",
      })).status,
    ).toBe(201);
    let res = await del("/api/entity-types/vehicle");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("관계명 1개");

    // source 가 아니라 target 쪽에만 쓰이는 관계명도 센다.
    expect((await del("/api/relation-vocab/운전자")).status).toBe(200);
    expect(
      (await post("/api/relation-vocab", {
        relationKey: "탈것주인", relationName: "vehicle_of",
        sourceTypes: ["person"], targetTypes: ["vehicle"], defaultTargetType: "vehicle",
      })).status,
    ).toBe(201);
    res = await del("/api/entity-types/vehicle");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("관계명 1개");
    expect(stillRegistered()).toBe(true);
  });

  test("그 종류의 엔티티가 있으면 409 (사용자 데이터라 연쇄 삭제하지 않고 정리를 요구한다)", async () => {
    await addVehicle();
    insertEntity("vehicle", "붕붕이");
    insertEntity("vehicle", "씽씽이");
    const res = await del("/api/entity-types/vehicle");
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("엔티티 2개");
    expect(stillRegistered()).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name='vehicle'").get() as { n: number }).n).toBe(2);
  });

  test("여러 갈래가 겹치면 메시지에 갈래마다 개수를 모두 적는다", async () => {
    await addVehicle();
    expect((await post("/api/classify-vocab", { typeName: "vehicle", slot: "synonyms", value: "자동차류" })).status).toBe(201);
    insertEntity("vehicle", "붕붕이");
    const { error } = (await (await del("/api/entity-types/vehicle")).json()) as { error: string };
    expect(error).toContain("분류 어휘");
    expect(error).toContain("엔티티 1개");
  });

  test("의존 데이터를 모두 지우면 삭제가 200 으로 통과한다", async () => {
    await addVehicle();
    const created = (await (await post("/api/classify-vocab", { typeName: "vehicle", slot: "synonyms", value: "자동차류" })).json()) as { entry: { id: string } };
    expect((await post("/api/relation-vocab", {
      relationKey: "운전자", relationName: "driven_by",
      sourceTypes: ["vehicle"], targetTypes: ["person"], defaultTargetType: "person",
    })).status).toBe(201);
    insertEntity("vehicle", "붕붕이");
    expect((await del("/api/entity-types/vehicle")).status).toBe(409);

    expect((await del(`/api/classify-vocab/${created.entry.id}`)).status).toBe(200);
    expect((await del("/api/entity-types/vehicle")).status).toBe(409); // 관계명·엔티티가 아직 남음
    expect((await del("/api/relation-vocab/운전자")).status).toBe(200);
    expect((await del("/api/entity-types/vehicle")).status).toBe(409); // 엔티티가 아직 남음
    db.prepare("DELETE FROM entities WHERE type_name = 'vehicle'").run();

    const res = await del("/api/entity-types/vehicle");
    expect(res.status).toBe(200);
    expect(store.entityTypeRegistryDb.isUserEntityType("vehicle")).toBe(false);
    expect(isPlacementType("vehicle")).toBe(false);
  });

  test("다른 종류의 어휘·관계명·엔티티는 이 종류 삭제를 막지 않는다", async () => {
    await addVehicle();
    expect((await post("/api/entity-types", { typeName: "tool", koName: "도구" })).status).toBe(201);
    expect((await post("/api/classify-vocab", { typeName: "tool", slot: "synonyms", value: "연장" })).status).toBe(201);
    insertEntity("tool", "망치");
    expect((await del("/api/entity-types/vehicle")).status).toBe(200);
    expect(getTypeSynonyms("tool" as never)).toContain("연장");
  });

  test("코드 상수 10종 삭제는 기존대로 400, 명부에 없는 종류는 멱등 200", async () => {
    expect((await del("/api/entity-types/work")).status).toBe(400);
    expect((await del("/api/entity-types/never_registered")).status).toBe(200);
  });
});

describe("쓰기 쪽 검증은 그대로 — 미등록 종류 거부", () => {
  test("분류 어휘 추가: 등록 안 된 종류는 400", async () => {
    const res = await post("/api/classify-vocab", { typeName: "ghost", slot: "synonyms", value: "유령" });
    expect(res.status).toBe(400);
    expect(classifyVocabUserRepo.listEntries().some((e) => e.typeName === "ghost")).toBe(false);
  });

  test("관계명 추가: source/target 이 등록 안 된 종류면 400", async () => {
    const res = await post("/api/relation-vocab", {
      relationKey: "유령관계", relationName: "ghost_rel",
      sourceTypes: ["ghost"], targetTypes: ["person"], defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    expect(relationNameUserRepo.listEntries()).toHaveLength(0);
  });
});

describe("이미 고아가 된 행 — 부팅·재병합은 죽지 않고 유효한 행만 적용", () => {
  /** 옛 버전이 만든 상태 — 종류 행 없이 어휘·가림표·관계명 행만 남은 DB 를 직접 재현한다. */
  function seedOrphansAndValidRows(): void {
    classifyVocabUserRepo.addEntry({ typeName: "work", slot: "synonyms", value: "고아공존단어" });
    classifyVocabUserRepo.addEntry({ typeName: "work", slot: "item_synonym", value: "장르\t갈래" });
    classifyVocabUserRepo.addEntry({ typeName: "ghost", slot: "synonyms", value: "유령동의어" });
    classifyVocabUserRepo.addEntry({ typeName: "ghost", slot: "subcategories", value: "유령하위" });
    classifyVocabUserRepo.addEntry({ typeName: "ghost", slot: "item_synonym", value: "대표\t별칭" });
    classifyVocabUserRepo.addEntry({ typeName: "ghost", slot: "columns", value: "무게" });
    classifyVocabUserRepo.addEntry({ typeName: "ghost", slot: "column_types", value: "무게\tnumber" });
    classifyVocabOverrideRepo.addOverride({ typeName: "ghost", slot: "synonyms", value: "아무거나" });
    // 관계명: 유효 1 + 고아 2(source 가 고아 / target 이 고아).
    relationNameUserRepo.addEntry({
      relationKey: "정상관계", relationName: "ok_rel",
      sourceTypes: ["work"], targetTypes: ["person"], defaultTargetType: "person",
    });
    relationNameUserRepo.addEntry({
      relationKey: "고아출발", relationName: "ghost_src",
      sourceTypes: ["ghost"], targetTypes: ["person"], defaultTargetType: "person",
    });
    relationNameUserRepo.addEntry({
      relationKey: "고아도착", relationName: "ghost_dst",
      sourceTypes: ["work"], targetTypes: ["person", "ghost"], defaultTargetType: "person",
    });
  }

  test("부팅 주입이 throw 하지 않고 유효한 행(분류 어휘·항목 동의어·관계명)을 그대로 적용한다", async () => {
    seedOrphansAndValidRows();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => bootApply()).not.toThrow();
      expect(getTypeSynonyms("work")).toContain("고아공존단어");
      expect(getCanonicalItemKey("work", "갈래")).toBe("장르");
      // 고아 행은 어디에도 새지 않는다.
      expect(isPlacementType("ghost")).toBe(false);
      expect(getColumnDataType("ghost", "무게")).not.toBe("number");

      const messages = warn.mock.calls.map((c) => String(c[0]));
      // 분류 어휘: 고아 종류 이름 + 건너뛴 개수(어휘 5·가림표 1).
      const classifyWarn = messages.find((m) => m.includes("'ghost'") && m.includes("분류 어휘"));
      expect(classifyWarn).toBeDefined();
      expect(classifyWarn).toContain("어휘 5개");
      expect(classifyWarn).toContain("가림표 1개");
      // 관계명: 고아 관계 키별로 한 줄씩.
      expect(messages.some((m) => m.includes("관계명 '고아출발'") && m.includes("'ghost'"))).toBe(true);
      expect(messages.some((m) => m.includes("관계명 '고아도착'") && m.includes("'ghost'"))).toBe(true);
      expect(messages.some((m) => m.includes("정상관계"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
    // 관계 어휘: 정상 행만 병합본에 합류했다(고아 두 줄은 빠졌다).
    const listing = (await (await app.request("/api/relation-vocab")).json()) as {
      relationVocab: { relationKey: string }[];
    };
    expect(listing.relationVocab.some((r) => r.relationKey === "정상관계")).toBe(true);
    const warn2 = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const merged = mergeRelationVocabSkippingOrphans(loadRelationVocabularySeed(), relationNameUserRepo.listEntries());
      expect(merged["정상관계"]).toBeDefined();
      expect(merged["고아출발"]).toBeUndefined();
      expect(merged["고아도착"]).toBeUndefined();
    } finally {
      warn2.mockRestore();
    }
  });

  test("고아가 있어도 무관한 종류 CRUD·어휘 추가·관계명 추가가 막히지 않는다", async () => {
    seedOrphansAndValidRows();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      bootApply();
      // 종류 추가(내부 재병합이 고아에 걸리지 않는다).
      expect((await post("/api/entity-types", { typeName: "vehicle", koName: "탈것" })).status).toBe(201);
      // 유효 종류에 어휘 추가(prospective 병합에 고아가 안 끼어든다).
      expect((await post("/api/classify-vocab", { typeName: "vehicle", slot: "synonyms", value: "자동차류" })).status).toBe(201);
      expect(getTypeSynonyms("vehicle" as never)).toContain("자동차류");
      expect(getTypeSynonyms("work")).toContain("고아공존단어");
      // 새 관계명 추가.
      expect((await post("/api/relation-vocab", {
        relationKey: "신규관계", relationName: "new_rel",
        sourceTypes: ["vehicle"], targetTypes: ["person"], defaultTargetType: "person",
      })).status).toBe(201);
    } finally {
      warn.mockRestore();
    }
  });

  test("고아 종류를 같은 이름으로 다시 등록하면 그 행이 다시 적용된다", async () => {
    classifyVocabUserRepo.addEntry({ typeName: "vehicle", slot: "synonyms", value: "자동차류" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      bootApply();
      expect(isPlacementType("vehicle")).toBe(false);
      expect(getTypeColumns("work")).toBeDefined();
      expect((await post("/api/entity-types", { typeName: "vehicle", koName: "탈것" })).status).toBe(201);
      expect(getTypeSynonyms("vehicle" as never)).toContain("자동차류");
    } finally {
      warn.mockRestore();
    }
  });
});
