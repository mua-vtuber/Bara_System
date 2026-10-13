/**
 * entity-placement-loop.test.ts — buildTypeAttributeKeys 항목 동의어 펼침 검증 (단계2 T4)
 * + 새 종류 배치(placeOneUserEntityType·wireEntityPlacement) 통합 검증 (단계3 T4).
 *
 * 앞쪽(순수 함수) — buildTypeAttributeKeys(type) 는 한 타입의 속성 어휘 키(라벨 attributes +
 * 칸 columnLabels)를 소문자 Set 으로 모은다. 단계2 가 여기에 항목 동의어를 펼쳐(대표키가 그
 * 속성 어휘에 들면 그 동의어 키도 속성으로 인식) 서브콘텐츠 분리가 동의어 `#키:값` 도 본다.
 *
 * 뒤쪽(통합·단계3 T4) — 사용자가 화면으로 더한 새 종류(`#장비:키보드`)가 entities 본체 행
 * 생성 + 기존 위계 통로(ensureTypeRootConcept·linkSubcategoryToTypeRoot)로 종류 루트 아래
 * 매달림 + 라벨 속성 저장 + applyEmbedding 까지 가는지 실 SQLite + 실 bge-m3 로 검증한다.
 * 기존 10종 회귀(byte 동일)·새 종류 0개 미진입도 함께 본다.
 *
 * 전역 모듈 캐시(setItemSynonymOverride·setEntityTypeOverride·setConceptVocabOverride)를
 * 쓰므로 afterEach 가 reset 으로 누출을 막는다. mock 0 — 운영 yaml + override fixture(순수
 * Map)·실 SQLite(:memory:)·실 bge-m3 임베딩(CLAUDE.md 테스트 정책).
 */
import { test, expect, afterEach, beforeAll, beforeEach, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  buildTypeAttributeKeys,
  placeOneUserEntityType,
  type EntityPlacementResult,
} from "./entity-placement-loop.ts";
import {
  setItemSynonymOverride,
  setEntityTypeOverride,
  setConceptVocabOverride,
  clearConceptVocabularyOverrides,
  loadConceptTypeVocabulary,
  type ConceptTypeVocabulary,
  type ItemSynonymMap,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { resetClassifierCache, classifyEntityTypeDeterministic } from "./entity-type-classifier.ts";
import { wireEntityPlacement } from "./entity-placement-wiring.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";

afterEach(() => {
  clearConceptVocabularyOverrides();
});

function overrideOf(
  type: PlacementTypeName,
  pairs: Array<[alias: string, canonical: string]>,
): ItemSynonymMap {
  const perType = new Map<string, string>();
  for (const [alias, canonical] of pairs) perType.set(alias.toLowerCase(), canonical);
  const m: ItemSynonymMap = new Map();
  m.set(type, perType);
  return m;
}

test("동의어 미등록 시 속성 키 집합은 yaml-only 그대로 — '장르' 있고 '갈래' 없음(회귀 0)", () => {
  const keys = buildTypeAttributeKeys("work");
  expect(keys.has("장르")).toBe(true); // yaml 라벨.
  expect(keys.has("갈래")).toBe(false); // 동의어 미등록.
});

test("'갈래'='장르' 동의어 등록 후 '갈래' 도 work 속성 키로 펼쳐진다", () => {
  setItemSynonymOverride(overrideOf("work", [["갈래", "장르"]]));
  const keys = buildTypeAttributeKeys("work");
  expect(keys.has("장르")).toBe(true); // 대표키.
  expect(keys.has("갈래")).toBe(true); // 펼친 동의어.
});

test("대표키가 속성 어휘 아니면 그 동의어는 안 펼쳐진다(라벨 아닌 동의어 무시)", () => {
  // '엉뚱키' 는 work 속성 어휘 아님 → 그 동의어 '딴말' 도 펼치면 안 됨.
  setItemSynonymOverride(overrideOf("work", [["딴말", "엉뚱키"]]));
  const keys = buildTypeAttributeKeys("work");
  expect(keys.has("딴말")).toBe(false);
});

test("칸(columnLabels) 키도 펼침 대상 — '유통기한' 동의어가 intake 속성 키로 합류", () => {
  // intake 칸 '유통기한' 의 동의어 '소비기한' → 칸 어휘에 들어 펼쳐진다.
  setItemSynonymOverride(overrideOf("intake", [["소비기한", "유통기한"]]));
  const keys = buildTypeAttributeKeys("intake");
  expect(keys.has("유통기한")).toBe(true);
  expect(keys.has("소비기한")).toBe(true);
});

test("person/project 는 8 타입 속성 어휘 없어 항상 빈 집합(동의어 펼침도 0)", () => {
  setItemSynonymOverride(overrideOf("person", [["닉네임", "별명"]]));
  expect(buildTypeAttributeKeys("person").size).toBe(0);
  expect(buildTypeAttributeKeys("project").size).toBe(0);
});

// ── 단계3 T4 — 새 종류 배치(placeOneUserEntityType·wireEntityPlacement) 통합 ──────
//
// 새 종류 "장비"(equipment)를 DB 명부(entity_types)에 등록하고 동적 명부·어휘 캐시에
// 주입한 뒤, `#장비:키보드` 입력이 entities 본체 행 + 위계 사슬 + 라벨 속성 + 임베딩까지
// 가는지 실 SQLite + 실 bge-m3 로 본다. 새 종류 어휘(subcategories·attributes)는
// setConceptVocabOverride 로 주입한다(라우트가 mergeConceptVocab 로 주입하는 통로의 단위
// 등가물 — yaml 파일은 안 건드린다).

describe("새 종류 배치 통합(단계3 T4·실 SQLite·실 bge-m3)", () => {
  let embedder: Bgem3Embedder;
  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
  });

  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", {
      embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"],
    });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    // 동적 명부·어휘·분류기 캐시를 정적 10종으로 되돌린다(전역 누출 차단·2-reset 양식).
    setEntityTypeOverride([]);
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    db.close();
  });

  /**
   * 새 종류 "장비"(equipment·koName '장비')를 DB 명부 + 동적 명부에 등록하고, 그 종류
   * 어휘(subcategories·attributes)를 모듈 캐시에 주입한다(setConceptVocabOverride). 라우트
   * 의 mergeConceptVocab 주입 통로를 단위 테스트가 흉내내는 양식 — yaml 파일은 안 건드린다.
   */
  function registerEquipmentType(
    opts: { subcategories?: string[]; attributes?: string[]; columns?: string[] } = {},
  ): void {
    store.entityTypeRegistryDb.addEntityType({
      typeName: "equipment",
      koName: "장비",
      idPrefix: "eqp_",
    });
    // server 부팅·CRUD 와 같은 순서 — 동적 명부 주입을 yaml 로드·복제 *전* 에 한다.
    setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();
    // 정적 10종 yaml 본체(동적 명부 주입 뒤 재파싱)를 복제해 새 종류 칸을 채운다.
    const yamlVocab = loadConceptTypeVocabulary();
    const merged: ConceptTypeVocabulary = new Map(yamlVocab);
    merged.set("equipment" as PlacementTypeName, {
      synonyms: [],
      subcategories: opts.subcategories ?? [],
      attributes: opts.attributes ?? [],
      // 단계3 T8 — 칸 어휘(columns slot). getTypeColumns 가 이 칸을 읽어 입력 가름에 쓴다.
      columns: opts.columns ?? [],
    });
    setConceptVocabOverride(merged);
    resetClassifierCache();
  }

  test("`#장비:키보드` 단일 배치 — entities 행 생성 + 종류 루트 아래 위계 매달림", async () => {
    registerEquipmentType();
    // 파서 통일(방식 ②·결정 4): 값 경계가 쉼표/줄바꿈/#/줄 끝이라 본문을 바로 붙이면
    // 값이 "키보드 새로 샀다" 로 통째로 삼킨다. 사용자 실데이터 양식대로 쉼표로 본문을
    // 가른다(spec §3.2 — #키:값, 본문) → 값이 "키보드" 로 잘려 배치가 산다.
    const content = "#장비:키보드, 새로 샀다";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });

    const result = await wireEntityPlacement(store, nodeId, content);

    expect(result.entityRowCreated).toBe(true);
    expect(result.entityId).not.toBe(null);

    // entities 본체에 "키보드" equipment 행이 생겼다(범용 본체 단일 출처).
    const ent = await store.entitiesRepo.get(result.entityId!);
    expect(ent).not.toBe(null);
    expect(ent!.typeName).toBe("equipment");
    expect(ent!.name).toBe("키보드");
    expect(ent!.id.startsWith("eqp_")).toBe(true);

    // 위계 — 종류 루트("장비" 개념) → entities 행 parent_of 가 hierarchy_edges 에 생겼다.
    const rootConceptId = await store.findConceptByName("장비");
    expect(rootConceptId).not.toBe(null);
    const children = store.getHierarchyDirectChildren(rootConceptId!.conceptId);
    expect(children).toContain(result.entityId!);
  });

  test("다단계 `#장비:주변기기 #주변기기:로지텍G` — 마지막 분류 단(주변기기) 아래 매달림", async () => {
    registerEquipmentType({ subcategories: ["주변기기"] });
    const content = "#장비:주변기기 #주변기기:로지텍G";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });

    const result = await wireEntityPlacement(store, nodeId, content);

    expect(result.entityRowCreated).toBe(true);
    const ent = await store.entitiesRepo.get(result.entityId!);
    expect(ent!.name).toBe("로지텍G");

    // 마지막 분류 단 "주변기기" 개념 → entities 행 parent_of.
    const subConcept = await store.findConceptByName("주변기기");
    expect(subConcept).not.toBe(null);
    const children = store.getHierarchyDirectChildren(subConcept!.conceptId);
    expect(children).toContain(result.entityId!);
    // 종류 루트 "장비" → "주변기기" 분류 단 parent_of 도 섰다(linkSubcategoryToTypeRoot).
    const root = await store.findConceptByName("장비");
    expect(store.getHierarchyDirectChildren(root!.conceptId)).toContain(
      subConcept!.conceptId,
    );
  });

  test("라벨 속성 — `#색상:검정` 이 entity_attributes 라벨(is_column=0)로 저장", async () => {
    registerEquipmentType({ attributes: ["색상"] });
    const content = "#장비:키보드 #색상:검정";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });

    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.entityRowCreated).toBe(true);
    expect(result.labelsApplied).toBeGreaterThanOrEqual(1);

    const row = db
      .query(
        "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?",
      )
      .get(result.entityId!, "색상") as
      | { attr_value: string; is_column: number }
      | null;
    expect(row).not.toBe(null);
    expect(row!.attr_value).toBe("검정");
    expect(row!.is_column).toBe(0); // T4 는 라벨만(칸 가름은 T8).
  });

  // ── 단계3 T8 — 칸/라벨 입력 가름(getTypeColumns·is_column) ─────────────────

  test("칸 어휘 등록 후 `#구입일:2026-06-01` → is_column=1(칸 색인 포함)", async () => {
    registerEquipmentType({ columns: ["구입일"] });
    const content = "#장비:키보드 #구입일:2026-06-01";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });

    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.entityRowCreated).toBe(true);
    expect(result.columnsApplied).toBeGreaterThanOrEqual(1);

    const row = db
      .query(
        "SELECT attr_value, is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?",
      )
      .get(result.entityId!, "구입일") as
      | { attr_value: string; is_column: number }
      | null;
    expect(row).not.toBe(null);
    expect(row!.attr_value).toBe("2026-06-01");
    expect(row!.is_column).toBe(1); // 칸 어휘라 색인 합성 포함.

    // 합성 텍스트에 칸값이 들어간다(buildCompositeText·검색 1급).
    const composite = store.entitiesRepo.buildCompositeText(result.entityId!);
    expect(composite).toContain("2026-06-01");
  });

  test("같은 입력에서 칸 키(구입일)는 is_column=1·라벨 키(색상)는 is_column=0 로 갈린다", async () => {
    registerEquipmentType({ columns: ["구입일"], attributes: ["색상"] });
    const content = "#장비:키보드 #구입일:2026-06-01 #색상:검정";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });

    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.columnsApplied).toBeGreaterThanOrEqual(1);
    expect(result.labelsApplied).toBeGreaterThanOrEqual(1);

    const col = db
      .query("SELECT is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?")
      .get(result.entityId!, "구입일") as { is_column: number } | null;
    const lbl = db
      .query("SELECT is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?")
      .get(result.entityId!, "색상") as { is_column: number } | null;
    expect(col!.is_column).toBe(1);
    expect(lbl!.is_column).toBe(0);
    // 라벨값(검정)은 합성 텍스트에서 빠진다(칸값만 색인).
    const composite = store.entitiesRepo.buildCompositeText(result.entityId!);
    expect(composite).toContain("2026-06-01");
    expect(composite).not.toContain("검정");
  });

  test("칸 어휘 0개면 모든 속성이 라벨(is_column=0·T4 byte 동일·회귀 0)", async () => {
    // columns 미지정 → getTypeColumns 빈 → 칸 승격 0. '구입일' 도 라벨로 떨어진다.
    registerEquipmentType({ attributes: ["구입일"] });
    const content = "#장비:키보드 #구입일:2026-06-01";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });

    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.columnsApplied).toBe(0);
    expect(result.labelsApplied).toBeGreaterThanOrEqual(1);
    const row = db
      .query("SELECT is_column FROM entity_attributes WHERE entity_id = ? AND attr_key = ?")
      .get(result.entityId!, "구입일") as { is_column: number } | null;
    expect(row!.is_column).toBe(0);
  });

  // ── 결함 B-2 — 입력 칸 가름 정규화 대칭(항목 동의어로 칸 키가 정규화돼도 칸 유지) ──

  test("칸 키('구입일')가 항목 동의어로 다른 대표키('비고')에 묶여도 is_column=1 유지", async () => {
    // 칸 어휘는 '구입일' 인데, 항목 동의어 {대표키:'비고', 동의어:'구입일'} 이 묶이면 입력 키
    // '구입일' 이 '비고' 로 정규화된다. 수정 전엔 정규화 키('비고')만 칸 어휘와 비교해 칸 판정을
    // 빠져나가 라벨로 강등됐다 — 원본 키 '구입일' 도 보게 고쳐 칸 판정이 유지되는지 본다.
    registerEquipmentType({ columns: ["구입일"] });
    setItemSynonymOverride(
      overrideOf("equipment" as PlacementTypeName, [["구입일", "비고"]]),
    );
    try {
      const content = "#장비:키보드 #구입일:2026-06-01";
      const nodeId = await store.addNode({
        content,
        memoryType: "fact",
        sourceType: "user_explicit",
        importance: 0.5,
        confidence: 0.7,
        platform: "",
        author: "",
      });

      const result = await wireEntityPlacement(store, nodeId, content);
      expect(result.columnsApplied).toBeGreaterThanOrEqual(1);
      // 항목 동의어 정규화로 attr_key 는 대표키 '비고' 로 저장되지만, is_column=1 은 유지된다.
      const byCanonical = db
        .query("SELECT attr_key, is_column FROM entity_attributes WHERE entity_id = ? AND is_column = 1")
        .all(result.entityId!) as Array<{ attr_key: string; is_column: number }>;
      expect(byCanonical.length).toBe(1);
      expect(byCanonical[0]!.is_column).toBe(1);
    } finally {
      // 항목 동의어 맵을 빈 맵으로 되돌린다(afterEach 가 안 비우는 전역 캐시 누출 차단).
      setItemSynonymOverride(new Map());
    }
  });

  test("applyEmbedding — 새 종류 행이 entities_vec 에 실제 임베딩으로 적재된다", async () => {
    registerEquipmentType();
    const content = "#장비:키보드";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });
    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.entityRowCreated).toBe(true);
    const cnt = db
      .query("SELECT COUNT(*) AS c FROM entities_vec")
      .get() as { c: number };
    expect(cnt.c).toBe(1);
  });

  test("후보 이름이 분류 단어로 끝나면(`#장비:주변기기`) 행 미생성 + 정직한 경고", async () => {
    registerEquipmentType({ subcategories: ["주변기기"] });
    const content = "#장비:주변기기"; // 사슬이 분류 단어에서 끝남 — 잎 고유명 없음.
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });
    const result = await wireEntityPlacement(store, nodeId, content);
    // "주변기기" 는 분류 단어라 entities 행을 안 만든다(거짓 엔티티 0).
    const cnt = db
      .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'equipment'")
      .get() as { c: number };
    expect(cnt.c).toBe(0);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("placeOneUserEntityType 직접 호출 — explicit 아닌 source 는 자동 배치 차단", async () => {
    registerEquipmentType();
    const nodeId = await store.addNode({
      content: "x",
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });
    const result: EntityPlacementResult = {
      typeName: null,
      subcategory: null,
      hierarchyEdges: 0,
      entityRowCreated: false,
      entityId: null,
      columnsApplied: 0,
      labelsApplied: 0,
      relationEdges: [],
      warnings: [],
    };
    // seed source — 자동 배치 게이트가 막아 행 0(불변식 I1).
    await placeOneUserEntityType(
      store,
      nodeId,
      "키보드",
      {
        typeName: "equipment" as PlacementTypeName,
        subcategory: null,
        confidence: 0.9,
        source: "seed",
        matched: "키보드",
      },
      "키보드",
      result,
    );
    expect(result.entityRowCreated).toBe(false);
    const cnt = db.query("SELECT COUNT(*) AS c FROM entities").get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  test("새 종류 0개여도 정적 work 입력은 범용 본체 entities(type_name='work')에 들어간다", async () => {
    // 단계4 T4 — 전용 테이블(works) 흡수 뒤로는 정적 10종도 범용 본체 entities 단일
    // 출처에 산다. `#작품:데못죽` 도 entities(type_name='work') 한 행을 만든다(옛 전용
    // works 행 거동을 뒤집은 의도된 설계 변경).
    const content = "#작품:데못죽";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });
    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.typeName).toBe("work");
    expect(result.entityRowCreated).toBe(true);
    // 범용 본체 entities 에 work 행 '데못죽' 이 생긴다(단일 출처).
    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBe(null);
    const entCnt = db
      .query("SELECT COUNT(*) AS c FROM entities WHERE type_name = 'work'")
      .get() as { c: number };
    expect(entCnt.c).toBe(1);
  });

  test("기존 분류 단어 회귀 — equipment 미등록이면 `#장비:키보드` 는 새 경로 미진입", async () => {
    // "장비" 종류가 명부에 없으면 type indicator 가 아니라 그룹조차 안 잡힌다(기타 글).
    const content = "#장비:키보드";
    const nodeId = await store.addNode({
      content,
      memoryType: "fact",
      sourceType: "user_explicit",
      importance: 0.5,
      confidence: 0.7,
      platform: "",
      author: "",
    });
    // classifier 도 미등록 키라 기타(none)로 떨어진다(동적 명부 정적 10종만).
    const cls = classifyEntityTypeDeterministic(content);
    expect(cls.typeName).toBe(null);
    const result = await wireEntityPlacement(store, nodeId, content);
    expect(result.entityRowCreated).toBe(false);
    const entCnt = db.query("SELECT COUNT(*) AS c FROM entities").get() as { c: number };
    expect(entCnt.c).toBe(0);
  });
});
